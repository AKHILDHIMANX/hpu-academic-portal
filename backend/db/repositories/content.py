"""
Content repositories: worksheets, previous-year papers, e-library, notices,
exam schedule and the append-only audit trail.
"""

from __future__ import annotations

import json

from ...core.grading import percentage


# =============================================================================
#  WORKSHEETS + SUBMISSIONS
# =============================================================================
class WorksheetRepository:
    def __init__(self, db) -> None:
        self.db = db

    # -- worksheets ----------------------------------------------------------
    def list_worksheets(self, *, course_code: str | None = None,
                        student_id: int | None = None) -> list[dict]:
        """Worksheets decorated with the calling student's submission state."""
        where = ["w.is_active = 1"]
        params: list = []
        if course_code:
            where.append("w.course_code = ?")
            params.append(course_code.upper())

        rows = self.db.query(
            f"""
            SELECT w.worksheet_id, w.course_code, w.title, w.batch_code, w.max_marks,
                   w.deadline_date, w.attachment_url, w.created_by, w.created_at,
                   c.course_name, c.credits,
                   t.full_name AS faculty,
                   (SELECT COUNT(*) FROM hpu_enrollment e WHERE e.course_id = c.course_id)
                       AS total_students,
                   (SELECT COUNT(*) FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = w.worksheet_id) AS submitted_count,
                   (SELECT COUNT(*) FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = w.worksheet_id
                       AND sub.evaluation_status = 'CHECKED & GRADED') AS graded_count
              FROM hpu_worksheet w
              JOIN hpu_course  c ON c.course_code = w.course_code
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
             WHERE {' AND '.join(where)}
             ORDER BY w.deadline_date ASC
            """,
            params,
        )

        if student_id:
            for row in rows:
                submission = self.db.query_one(
                    """
                    SELECT sub.* FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = ? AND sub.student_id = ?
                    """,
                    (row["worksheet_id"], student_id),
                )
                row["my_submission"] = submission
                row["my_status"] = submission["evaluation_status"] if submission else "NOT SUBMITTED"
                row["my_marks"] = submission["obtained_marks"] if submission else None
                row["my_remarks"] = submission["teacher_remarks"] if submission else None
                row["my_file"] = submission["submitted_file"] if submission else None
        return rows

    def get(self, worksheet_id: int) -> dict | None:
        return self.db.query_one(
            """
            SELECT w.*, c.course_name, c.credits, t.full_name AS faculty
              FROM hpu_worksheet w
              JOIN hpu_course c ON c.course_code = w.course_code
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
             WHERE w.worksheet_id = ?
            """,
            (worksheet_id,),
        )

    def create(self, data: dict) -> int:
        return self.db.insert_returning_id(
            """
            INSERT INTO hpu_worksheet
                (course_code, title, batch_code, max_marks, deadline_date,
                 attachment_url, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["course_code"].upper(), data["title"], data["batch_code"],
                data["max_marks"], data["deadline_date"],
                data.get("attachment_url") or "HPU_WORKSHEET_TEMPLATE.pdf",
                data.get("created_by", "FACULTY"),
            ),
        )

    def set_active(self, worksheet_id: int, active: bool) -> bool:
        return self.db.execute(
            "UPDATE hpu_worksheet SET is_active = ? WHERE worksheet_id = ?",
            (1 if active else 0, worksheet_id),
        ) > 0

    def set_deadline(self, worksheet_id: int, deadline: str) -> bool:
        return self.db.execute(
            "UPDATE hpu_worksheet SET deadline_date = ? WHERE worksheet_id = ?",
            (deadline, worksheet_id),
        ) > 0

    def delete(self, worksheet_id: int) -> bool:
        return self.db.execute(
            "DELETE FROM hpu_worksheet WHERE worksheet_id = ?", (worksheet_id,)
        ) > 0

    # -- submissions ---------------------------------------------------------
    def submissions_for_worksheet(self, worksheet_id: int) -> list[dict]:
        rows = self.db.query(
            """
            SELECT s.student_id, s.roll_no, s.reg_no,
                   s.first_name || ' ' || s.last_name AS full_name, s.email,
                   COALESCE(sub.submission_id, 0) AS submission_id,
                   COALESCE(sub.submitted_file, '') AS submitted_file,
                   COALESCE(sub.submitted_at, '') AS submitted_at,
                   COALESCE(sub.evaluation_status, 'NOT SUBMITTED') AS evaluation_status,
                   sub.obtained_marks, sub.teacher_remarks,
                   sub.evaluated_by, sub.evaluated_at
              FROM hpu_worksheet w
              JOIN hpu_course c ON c.course_code = w.course_code
              JOIN hpu_enrollment e ON e.course_id = c.course_id
              JOIN hpu_student   s ON s.student_id = e.student_id
              LEFT JOIN hpu_worksheet_submission sub
                     ON sub.worksheet_id = w.worksheet_id AND sub.student_id = s.student_id
             WHERE w.worksheet_id = ?
             ORDER BY s.roll_no
            """,
            (worksheet_id,),
        )
        for row in rows:
            row["full_name"] = row["full_name"].title()
            letter = (row["full_name"].split(" ")[0] or "?")[0].upper()
            surname = (row["full_name"].split(" ")[-1] or "?")[0].upper()
            row["initials"] = f"{letter}{surname}"
        return rows

    def upsert_submission(self, worksheet_id: int, student_id: int,
                          stored_name: str, marks: float | None = None,
                          remarks: str | None = None) -> dict:
        """Insert or replace a student's answer script for a worksheet."""
        worksheet = self.get(worksheet_id)
        if not worksheet:
            raise ValueError("Worksheet not found")

        if marks is not None:
            marks = round(float(marks), 2)
            if marks < 0 or marks > float(worksheet["max_marks"]):
                raise ValueError(
                    f"Marks must be between 0 and {worksheet['max_marks']}"
                )

        existing = self.db.query_one(
            "SELECT submission_id FROM hpu_worksheet_submission "
            "WHERE worksheet_id = ? AND student_id = ?",
            (worksheet_id, student_id),
        )

        if existing:
            self.db.execute(
                """
                UPDATE hpu_worksheet_submission
                   SET submitted_file = ?, submitted_at = datetime('now'),
                       evaluation_status = CASE WHEN ? IS NULL
                           THEN 'SUBMITTED' ELSE 'CHECKED & GRADED' END,
                       obtained_marks  = COALESCE(?, obtained_marks),
                       teacher_remarks = COALESCE(?, teacher_remarks),
                       evaluated_by    = CASE WHEN ? IS NULL THEN evaluated_by ELSE ? END,
                       evaluated_at    = CASE WHEN ? IS NULL THEN evaluated_at
                                              ELSE datetime('now') END
                 WHERE worksheet_id = ? AND student_id = ?
                """,
                (stored_name, marks, marks, remarks, marks, marks, marks,
                 worksheet_id, student_id),
            )
        else:
            self.db.execute(
                """
                INSERT INTO hpu_worksheet_submission
                    (worksheet_id, student_id, submitted_file, evaluation_status,
                     obtained_marks, teacher_remarks, evaluated_by, evaluated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    worksheet_id, student_id, stored_name,
                    "CHECKED & GRADED" if marks is not None else "SUBMITTED",
                    marks, remarks,
                    None if marks is None else "FACULTY",
                    None if marks is None else "now",
                ),
            )
        self.db.commit()
        return self.submission(worksheet_id, student_id) or {}

    def submission(self, worksheet_id: int, student_id: int) -> dict | None:
        return self.db.query_one(
            "SELECT * FROM hpu_worksheet_submission "
            "WHERE worksheet_id = ? AND student_id = ?",
            (worksheet_id, student_id),
        )

    def grade(self, submission_id: int, obtained: float, remarks: str,
              evaluator: str) -> bool:
        affected = self.db.execute(
            """
            UPDATE hpu_worksheet_submission
               SET obtained_marks = ?, teacher_remarks = ?, evaluated_by = ?,
                   evaluated_at = datetime('now'), evaluation_status = 'CHECKED & GRADED'
             WHERE submission_id = ?
            """,
            (round(float(obtained), 2), remarks, evaluator, submission_id),
        )
        self.db.commit()
        return affected > 0

    def queue(self, faculty_course_codes: list[str] | None = None) -> list[dict]:
        where = ["sub.evaluation_status IN ('SUBMITTED', 'UNDER EVALUATION')"]
        params: list = []
        if faculty_course_codes is not None:
            if not faculty_course_codes:
                return []
            placeholders = ", ".join("?" for _ in faculty_course_codes)
            where.append(f"w.course_code IN ({placeholders})")
            params.extend(faculty_course_codes)

        return self.db.query(
            f"""
            SELECT sub.submission_id, sub.submitted_at, sub.evaluation_status,
                   w.worksheet_id, w.title, w.course_code, c.course_name, w.max_marks,
                   w.deadline_date, t.full_name AS faculty,
                   s.student_id, s.roll_no,
                   s.first_name || ' ' || s.last_name AS full_name
              FROM hpu_worksheet_submission sub
              JOIN hpu_worksheet w ON w.worksheet_id = sub.worksheet_id
              JOIN hpu_course  c ON c.course_code   = w.course_code
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
              JOIN hpu_student   s ON s.student_id   = sub.student_id
             WHERE {' AND '.join(where)}
             ORDER BY w.deadline_date ASC, sub.submitted_at ASC
            """,
            params,
        )

    def teacher_summary(self, faculty_code: str) -> dict:
        rows = self.db.query(
            """
            SELECT w.worksheet_id, w.title, w.course_code, c.course_name, w.max_marks,
                   w.deadline_date, w.batch_code,
                   (SELECT COUNT(*) FROM hpu_enrollment e WHERE e.course_id = c.course_id)
                       AS total_students,
                   (SELECT COUNT(*) FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = w.worksheet_id) AS submitted,
                   (SELECT COUNT(*) FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = w.worksheet_id
                       AND sub.evaluation_status = 'CHECKED & GRADED') AS graded,
                   (SELECT ROUND(AVG(sub.obtained_marks), 2) FROM hpu_worksheet_submission sub
                     WHERE sub.worksheet_id = w.worksheet_id) AS average_marks
              FROM hpu_worksheet w
              JOIN hpu_course c ON c.course_code = w.course_code
             WHERE c.instructor_id = (SELECT teacher_id FROM hpu_teacher
                                        WHERE faculty_code = ?)
               AND w.is_active = 1
             ORDER BY w.deadline_date ASC
            """,
            (faculty_code,),
        )
        for row in rows:
            row["submission_rate"] = percentage(row["submitted"], row["total_students"])
            row["average_percentage"] = (
                round(row["average_marks"] * 100 / row["max_marks"], 1)
                if row["average_marks"] is not None and row["max_marks"]
                else None
            )
            row["pending"] = max(int(row["submitted"] or 0) - int(row["graded"] or 0), 0)
        return {"worksheets": rows}


# =============================================================================
#  CONTENT: PYQ / E-LIBRARY / NOTICES / EXAM SCHEDULE
# =============================================================================
class ContentRepository:
    def __init__(self, db) -> None:
        self.db = db

    # -- previous year questions --------------------------------------------
    def pyq_papers(self, *, course_code: str | None = None,
                   search: str = "") -> list[dict]:
        where = ["1 = 1"]
        params: list = []
        if course_code:
            where.append("course_code = ?")
            params.append(course_code.upper())
        if search:
            where.append("LOWER(subject_name) LIKE ?")
            params.append(f"%{search.lower()}%")
        return self.db.query(
            f"""
            SELECT paper_id, course_code, subject_name, year, exam_type, file_url,
                   downloads, uploaded_by
              FROM hpu_pyq_paper
             WHERE {' AND '.join(where)}
             ORDER BY course_code, year DESC
            """,
            params,
        )

    def increment_download(self, paper_id: int) -> None:
        self.db.execute(
            "UPDATE hpu_pyq_paper SET downloads = downloads + 1 WHERE paper_id = ?",
            (paper_id,),
        )
        self.db.commit()

    # -- e-library -----------------------------------------------------------
    def library(self, *, category: str = "", subject: str = "",
                search: str = "") -> list[dict]:
        where = ["1 = 1"]
        params: list = []
        if category and category.upper() != "ALL":
            where.append("category = ?")
            params.append(category.upper())
        if subject and subject.upper() != "ALL":
            where.append("subject = ?")
            params.append(subject.upper())
        if search:
            needle = f"%{search.lower()}%"
            where.append(
                "(LOWER(title) LIKE ? OR LOWER(authors) LIKE ? OR LOWER(description) LIKE ?)"
            )
            params.extend([needle] * 3)
        return self.db.query(
            f"""
            SELECT library_id, title, authors, category, subject, publisher,
                   file_url, page_count, rating, description
              FROM hpu_e_library
             WHERE {' AND '.join(where)}
             ORDER BY category, title
            """,
            params,
        )

    def library_facets(self) -> dict:
        categories = self.db.query(
            "SELECT category, COUNT(*) AS total FROM hpu_e_library GROUP BY 1 ORDER BY 1"
        )
        subjects = self.db.query(
            "SELECT subject, COUNT(*) AS total FROM hpu_e_library GROUP BY 1 ORDER BY 1"
        )
        return {"categories": categories, "subjects": subjects}

    # -- notices -------------------------------------------------------------
    def notices(self, *, limit: int = 50, category: str = "") -> list[dict]:
        params: list = []
        where = "1 = 1"
        if category and category.upper() != "ALL":
            where = "category = ?"
            params.append(category.upper())
        rows = self.db.query(
            f"""
            SELECT notice_id, issued_on, category, title, summary, issued_by, is_pinned
              FROM hpu_notice
             WHERE {where}
             ORDER BY is_pinned DESC, issued_on DESC
             LIMIT ?
            """,
            [*params, limit],
        )
        for row in rows:
            row["is_pinned"] = bool(row["is_pinned"])
        return rows

    def notice_categories(self) -> list[str]:
        rows = self.db.query("SELECT DISTINCT category FROM hpu_notice ORDER BY category")
        return [r["category"] for r in rows]

    def publish_notice(self, category: str, title: str, summary: str,
                       issued_by: str, pinned: bool = False) -> int:
        notice_id = self.db.insert_returning_id(
            """
            INSERT INTO hpu_notice
                (issued_on, category, title, summary, issued_by, is_pinned)
            VALUES (date('now'), ?, ?, ?, ?, ?)
            """,
            (category.upper(), title, summary, issued_by, 1 if pinned else 0),
        )
        self.db.commit()
        return notice_id

    def toggle_pin(self, notice_id: int) -> bool | None:
        current = self.db.scalar(
            "SELECT is_pinned FROM hpu_notice WHERE notice_id = ?", (notice_id,)
        )
        if current is None:
            return None
        self.db.execute(
            "UPDATE hpu_notice SET is_pinned = ? WHERE notice_id = ?",
            (0 if int(current) else 1, notice_id),
        )
        self.db.commit()
        return not bool(int(current))

    def delete_notice(self, notice_id: int) -> bool:
        affected = self.db.execute(
            "DELETE FROM hpu_notice WHERE notice_id = ?", (notice_id,)
        )
        self.db.commit()
        return affected > 0

    # -- exam schedule -------------------------------------------------------
    def datesheet(self) -> dict:
        rows = self.db.query(
            """
            SELECT schedule_id, notification_no, course_code, subject_name,
                   exam_date, exam_day, start_time, end_time, venue, exam_type
              FROM hpu_exam_schedule
             ORDER BY exam_date ASC
            """
        )
        return {
            "notification_no": rows[0]["notification_no"] if rows else None,
            "rows": rows,
            "theory_count": sum(1 for r in rows if r["exam_type"] == "THEORY"),
            "practical_count": sum(1 for r in rows if r["exam_type"] != "THEORY"),
        }

    # -- notifications -------------------------------------------------------
    def notifications(self, principal: dict) -> list[dict]:
        """A unified, role-aware notification feed assembled from live tables."""
        items: list[dict] = []
        role = principal["role"]

        for notice in self.notices(limit=12):
            items.append({
                "id": f"notice-{notice['notice_id']}",
                "kind": "NOTICE",
                "severity": "INFO",
                "title": notice["title"],
                "body": notice["summary"],
                "meta": notice["category"],
                "timestamp": notice["issued_on"],
                "link": "#notices",
                "read": False,
            })

        if role == "TEACHER":
            pending = self.db.query(
                """
                SELECT w.title, w.course_code, w.deadline_date,
                       COUNT(sub.submission_id) AS pending
                  FROM hpu_worksheet w
                  JOIN hpu_course c ON c.course_code = w.course_code
                  LEFT JOIN hpu_worksheet_submission sub
                         ON sub.worksheet_id = w.worksheet_id
                        AND sub.evaluation_status IN ('SUBMITTED', 'UNDER EVALUATION')
                 WHERE c.instructor_id = (SELECT teacher_id FROM hpu_teacher
                                           WHERE faculty_code = ?)
                 GROUP BY w.worksheet_id, w.title, w.course_code, w.deadline_date
                HAVING pending > 0
                """,
                (principal["user_code"],),
            )
            for row in pending:
                items.append({
                    "id": f"eval-{row['course_code']}-{row['title'][:12]}",
                    "kind": "EVALUATION",
                    "severity": "WARNING",
                    "title": f"{row['pending']} answer script(s) awaiting evaluation",
                    "body": f"{row['course_code']} — {row['title']}",
                    "meta": row["deadline_date"],
                    "timestamp": row["deadline_date"],
                    "link": "#worksheets",
                    "read": False,
                })

        if role == "ADMIN":
            for row in self.db.query(
                """
                SELECT s.roll_no, s.first_name || ' ' || s.last_name AS full_name,
                       ROUND(AVG(CASE WHEN a.total_lectures > 0
                               THEN a.attended_lectures * 100.0 / a.total_lectures END), 1)
                           AS pct
                  FROM hpu_student s
                  JOIN hpu_attendance a ON a.student_id = s.student_id
                 GROUP BY s.student_id, s.roll_no, s.first_name, s.last_name
                HAVING pct < 65
                """
            ):
                items.append({
                    "id": f"risk-{row['roll_no']}",
                    "kind": "ATTENDANCE_RISK",
                    "severity": "CRITICAL",
                    "title": f"{row['full_name'].title()} at {row['pct']}% attendance",
                    "body": "Below the 65% critical threshold — review detention status.",
                    "meta": row["roll_no"],
                    "timestamp": None,
                    "link": "#directory",
                    "read": False,
                })

            for row in self.db.query(
                """
                SELECT t.faculty_code, t.full_name, t.grading_deadline, t.warning_count
                  FROM hpu_teacher t
                 WHERE t.warning_count > 0
                 ORDER BY t.warning_count DESC
                """
            ):
                items.append({
                    "id": f"faculty-{row['faculty_code']}",
                    "kind": "FACULTY_WARNING",
                    "severity": "WARNING",
                    "title": f"{row['full_name'].title()} carries {row['warning_count']} warning(s)",
                    "body": "Evaluation backlog past the departmental grading deadline.",
                    "meta": row["grading_deadline"] or "no deadline set",
                    "timestamp": row["grading_deadline"],
                    "link": "#faculty",
                    "read": False,
                })

        if role == "STUDENT":
            rows = self.db.query(
                """
                SELECT w.title, w.course_code, w.max_marks, w.deadline_date,
                       COALESCE(sub.evaluation_status, 'NOT SUBMITTED') AS status
                  FROM hpu_worksheet w
                  JOIN hpu_course c ON c.course_code = w.course_code
                  JOIN hpu_enrollment e ON e.course_id = c.course_id
                  LEFT JOIN hpu_worksheet_submission sub
                         ON sub.worksheet_id = w.worksheet_id
                        AND sub.student_id = e.student_id
                 WHERE e.student_id = (SELECT student_id FROM hpu_student WHERE roll_no = ?)
                   AND w.is_active = 1
                 ORDER BY w.deadline_date ASC
                """,
                (principal["user_code"],),
            )
            for row in rows:
                severity = "CRITICAL" if row["status"] == "NOT SUBMITTED" else "INFO"
                items.append({
                    "id": f"worksheet-{row['course_code']}-{row['title'][:12]}",
                    "kind": "WORKSHEET",
                    "severity": severity,
                    "title": (
                        f"{row['course_code']} worksheet not yet submitted"
                        if row["status"] == "NOT SUBMITTED"
                        else f"{row['course_code']} worksheet {row['status'].lower()}"
                    ),
                    "body": row["title"],
                    "meta": f"due {row['deadline_date']} · {row['max_marks']} marks",
                    "timestamp": row["deadline_date"],
                    "link": "#worksheets",
                    "read": False,
                })

        return items[:24]


# =============================================================================
#  AUDIT LOG -- append only (mirrors TRG_AUDIT_APPEND_ONLY)
# =============================================================================
class AuditRepository:
    def __init__(self, db) -> None:
        self.db = db

    def append(self, *, actor_role: str, actor_name: str, actor_code: str,
               action: str, target: str, details: str, ip_address: str,
               severity: str = "INFO") -> int:
        return self.db.insert_returning_id(
            """
            INSERT INTO hpu_audit_log
                (actor_role, actor_name, actor_code, action, target, details,
                 ip_address, severity, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (actor_role, actor_name, actor_code, action, target, details,
             ip_address, severity),
        )

    def search(self, *, search: str = "", action: str = "", severity: str = "",
               actor_role: str = "", page: int = 1, per_page: int = 25) -> dict:
        where = ["1 = 1"]
        params: list = []
        if search:
            needle = f"%{search.lower()}%"
            where.append(
                "(LOWER(action) LIKE ? OR LOWER(target) LIKE ? "
                "OR LOWER(details) LIKE ? OR LOWER(actor_name) LIKE ?)"
            )
            params.extend([needle] * 4)
        if action and action.upper() != "ALL":
            where.append("action = ?")
            params.append(action.upper())
        if severity and severity.upper() != "ALL":
            where.append("severity = ?")
            params.append(severity.upper())
        if actor_role and actor_role.upper() != "ALL":
            where.append("actor_role = ?")
            params.append(actor_role.upper())

        clause = " AND ".join(where)
        total = int(
            self.db.scalar(f"SELECT COUNT(*) FROM hpu_audit_log WHERE {clause}",
                           params, default=0) or 0
        )
        rows = self.db.query(
            f"""
            SELECT log_id, actor_role, actor_name, actor_code, action, target,
                   details, ip_address, severity, created_at
              FROM hpu_audit_log
             WHERE {clause}
             ORDER BY log_id DESC
             LIMIT ? OFFSET ?
            """,
            [*params, per_page, (page - 1) * per_page],
        )
        return {
            "rows": rows,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": max((total + per_page - 1) // per_page, 1),
            "actions": self.actions(),
            "severity_counts": self.severity_counts(),
        }

    def actions(self) -> list[str]:
        return [r["action"] for r in
                self.db.query("SELECT DISTINCT action FROM hpu_audit_log ORDER BY action")]

    def severity_counts(self) -> dict:
        rows = self.db.query(
            "SELECT severity, COUNT(*) AS total FROM hpu_audit_log GROUP BY 1"
        )
        counts = {"INFO": 0, "WARNING": 0, "SECURITY": 0, "CRITICAL": 0}
        for row in rows:
            counts[row["severity"]] = int(row["total"])
        return counts

    def recent(self, limit: int = 12) -> list[dict]:
        return self.db.query(
            "SELECT log_id, actor_role, actor_name, actor_code, action, target, "
            "details, severity, created_at FROM hpu_audit_log "
            "ORDER BY log_id DESC LIMIT ?",
            (limit,),
        )

    def stats(self) -> dict:
        row = self.db.query_one(
            """
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT actor_code) AS distinct_actors,
                   MAX(created_at) AS last_entry
              FROM hpu_audit_log
            """
        ) or {}
        return {
            "total": int(row.get("total") or 0),
            "distinct_actors": int(row.get("distinct_actors") or 0),
            "last_entry": row.get("last_entry"),
            **self.severity_counts(),
        }