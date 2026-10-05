"""Academic repositories: students, teachers, courses, attendance and marks."""

from __future__ import annotations

from ...core.grading import (
    academic_status as derive_academic_status,
    attendance_status as derive_attendance_status,
    percentage,
    resolve_grade,
)


def _grade_scale(db) -> list[dict]:
    rows = db.query(
        "SELECT grade_letter, min_percent, max_percent, grade_point, classification "
        "FROM hpu_grade_scale ORDER BY min_percent DESC"
    )
    return [
        {
            "grade_letter": r["grade_letter"],
            "min_percent": float(r["min_percent"]),
            "max_percent": float(r["max_percent"]),
            "grade_point": float(r["grade_point"]),
            "classification": r["classification"],
        }
        for r in rows
    ] or None


# =============================================================================
#  COURSES
# =============================================================================
class CourseRepository:
    def __init__(self, db) -> None:
        self.db = db

    def list_all(self) -> list[dict]:
        import json

        rows = self.db.query(
            """
            SELECT c.course_id, c.course_code, c.course_name, c.credits, c.semester,
                   c.syllabus_file, c.topics,
                   t.full_name AS instructor, t.faculty_code, t.email AS instructor_email,
                   t.office_location AS instructor_office, t.cabin_status,
                   (SELECT COUNT(*) FROM hpu_enrollment e WHERE e.course_id = c.course_id)
                       AS enrolled_count
              FROM hpu_course c
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
             ORDER BY c.course_code
            """
        )
        for row in rows:
            try:
                row["topics"] = json.loads(row.get("topics") or "[]")
            except (ValueError, TypeError):
                row["topics"] = []
        return rows

    def get_by_code(self, code: str) -> dict | None:
        for course in self.list_all():
            if course["course_code"] == (code or "").upper():
                return course
        return None

    def resolve_id(self, code: str) -> int | None:
        return self.db.scalar(
            "SELECT course_id FROM hpu_course WHERE course_code = ?", ((code or "").upper(),)
        )

    def create(self, data: dict) -> int:
        import json

        return self.db.insert_returning_id(
            """
            INSERT INTO hpu_course (course_code, course_name, credits, semester,
                                    department, instructor_id, syllabus_file, topics)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["course_code"], data["course_name"], data["credits"], data["semester"],
                data.get("department", "DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING"),
                data.get("instructor_id"), data.get("syllabus_file"),
                json.dumps(data.get("topics") or []),
            ),
        )


# =============================================================================
#  STUDENTS
# =============================================================================
class StudentRepository:
    def __init__(self, db) -> None:
        self.db = db

    # -- read ----------------------------------------------------------------
    def profile(self, roll_no: str) -> dict | None:
        row = self.db.query_one(
            """
            SELECT s.*, u.last_login_at, u.created_at AS account_created_at
              FROM hpu_student s
              LEFT JOIN hpu_user_auth u ON u.user_code = s.roll_no
             WHERE s.roll_no = ?
            """,
            (roll_no,),
        )
        if not row:
            return None
        row["full_name"] = f"{row['first_name']} {row['last_name']}".title()
        row["initials"] = _initials(row["first_name"], row["last_name"])
        row["portal_access"] = "UNLOCKED" if not int(row["attendance_lock"]) else "LOCKED"
        return row

    def get(self, student_id: int) -> dict | None:
        row = self.db.query_one(
            "SELECT * FROM hpu_student WHERE student_id = ?", (student_id,)
        )
        if row:
            row["full_name"] = f"{row['first_name']} {row['last_name']}".title()
            row["initials"] = _initials(row["first_name"], row["last_name"])
            row["portal_access"] = (
                "LOCKED" if int(row["attendance_lock"]) else "UNLOCKED"
            )
        return row

    def get_by_roll(self, roll_no: str) -> dict | None:
        return self.db.query_one("SELECT * FROM hpu_student WHERE roll_no = ?", (roll_no,))

    def directory(self, *, search: str = "", status: str = "", batch: str = "",
                  sort: str = "roll_no", direction: str = "asc",
                  page: int = 1, per_page: int = 25) -> dict:
        """Paginated, filtered, searchable student directory (admin + teacher)."""
        where: list[str] = ["1 = 1"]
        params: list = []

        if search:
            needle = f"%{search.lower()}%"
            where.append(
                "(LOWER(s.roll_no) LIKE ? OR LOWER(s.reg_no) LIKE ? "
                "OR LOWER(s.first_name) LIKE ? OR LOWER(s.last_name) LIKE ? "
                "OR LOWER(s.email) LIKE ?)"
            )
            params.extend([needle] * 5)
        if status and status.upper() != "ALL":
            where.append("s.academic_status = ?")
            params.append(status.upper())
        if batch:
            where.append("s.batch_code = ?")
            params.append(batch)

        # These are column names in the *derived* table, so they must stay
        # unprefixed -- ORDER BY runs outside the subquery.
        allowed_sort = {
            "roll_no": "roll_no", "name": "full_name",
            "attendance": "overall_attendance", "status": "academic_status",
            "last_login": "last_login", "reg_no": "reg_no", "semester": "semester",
        }
        order_column = allowed_sort.get(sort, "roll_no")
        order_direction = "DESC" if str(direction).lower() == "desc" else "ASC"

        base = f"""
            SELECT s.student_id, s.roll_no, s.reg_no,
                   s.first_name || ' ' || s.last_name AS full_name,
                   s.email, s.phone, s.batch_code, s.semester, s.academic_status,
                   CASE WHEN s.attendance_lock = 1 THEN 'LOCKED' ELSE 'UNLOCKED' END
                       AS portal_access,
                   u.last_login_at,
                   ROUND(AVG(CASE WHEN a.total_lectures > 0
                                   THEN a.attended_lectures * 100.0 / a.total_lectures
                                   END), 1) AS overall_attendance,
                   (SELECT COUNT(*) FROM hpu_enrollment e WHERE e.student_id = s.student_id)
                       AS course_count
              FROM hpu_student s
              LEFT JOIN hpu_attendance a ON a.student_id = s.student_id
              LEFT JOIN hpu_user_auth u ON u.user_code = s.roll_no
             WHERE {' AND '.join(where)}
             GROUP BY s.student_id, s.roll_no, s.reg_no, s.first_name, s.last_name,
                      s.email, s.phone, s.batch_code, s.semester, s.academic_status,
                      s.attendance_lock, u.last_login_at
        """
        total = int(
            self.db.scalar(f"SELECT COUNT(*) FROM ({base})", params, default=0) or 0
        )

        rows = self.db.query(
            f"""
            SELECT * FROM ({base}) AS directory
             ORDER BY {order_column} {order_direction}, roll_no ASC
             LIMIT ? OFFSET ?
            """,
            [*params, per_page, (page - 1) * per_page],
        )
        for row in rows:
            att = row.get("overall_attendance")
            row["overall_attendance"] = float(att) if att is not None else 0.0
            row["attendance_status"] = derive_attendance_status(row["overall_attendance"])
            row["full_name"] = row["full_name"].title()
            row["initials"] = _initials(
                row["full_name"].split(" ")[0], " ".join(row["full_name"].split(" ")[1:])
            )

        return {
            "rows": rows,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": max((total + per_page - 1) // per_page, 1),
            "counts": self.status_counts(),
        }

    def status_counts(self) -> dict:
        rows = self.db.query(
            "SELECT academic_status, COUNT(*) AS total FROM hpu_student GROUP BY 1"
        )
        counts = {"ALL": 0, "ACTIVE": 0, "DETAINED": 0, "SUSPENDED": 0}
        for row in rows:
            counts[row["academic_status"]] = int(row["total"])
            counts["ALL"] += int(row["total"])
        return counts

    def batches(self) -> list[str]:
        rows = self.db.query(
            "SELECT DISTINCT batch_code FROM hpu_student ORDER BY batch_code"
        )
        return [r["batch_code"] for r in rows]

    def count(self) -> int:
        return int(self.db.scalar("SELECT COUNT(*) FROM hpu_student", default=0) or 0)

    # -- write ---------------------------------------------------------------
    def create(self, data: dict, password_hash: str, password_salt: str) -> int:
        student_id = self.db.insert_returning_id(
            """
            INSERT INTO hpu_student
                (roll_no, reg_no, first_name, last_name, email, phone,
                 semester, batch_code, academic_status, attendance_lock, advisor, avatar_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL)
            """,
            (
                data["roll_no"], data["reg_no"], data["first_name"], data["last_name"],
                data["email"], data.get("phone"), data.get("semester", 6),
                data.get("batch_code", "CSE-2023-BATCH-A"),
                1 if data.get("attendance_lock") else 0,
                data.get("advisor") or "DR. P.K. SHARMA (HOD CSE)",
            ),
        )
        self.db.execute(
            """
            INSERT INTO hpu_user_auth
                (user_code, email, phone, password_hash, password_salt, role, full_name)
            VALUES (?, ?, ?, ?, ?, 'STUDENT', ?)
            """,
            (
                data["roll_no"], data["email"], data.get("phone"),
                password_hash, password_salt,
                f"{data['first_name']} {data['last_name']}".upper(),
            ),
        )
        self._enroll_in_batch_courses(student_id, data.get("batch_code", "CSE-2023-BATCH-A"))
        return student_id

    def _enroll_in_batch_courses(self, student_id: int, batch_code: str) -> None:
        rows = self.db.query(
            """
            SELECT DISTINCT c.course_id FROM hpu_course c
              JOIN hpu_teacher_allocation a ON a.course_id = c.course_id
             WHERE a.batch_code = ?
            """,
            (batch_code,),
        )
        for row in rows:
            self.db.execute(
                "INSERT OR IGNORE INTO hpu_enrollment (student_id, course_id) VALUES (?, ?)",
                (student_id, row["course_id"]),
            )

    def update_status(self, student_id: int, status: str) -> dict | None:
        self.db.execute(
            "UPDATE hpu_student SET academic_status = ? WHERE student_id = ?",
            (status, student_id),
        )
        return self.get(student_id)

    def set_attendance_lock(self, student_id: int, unlocked: bool) -> dict | None:
        self.db.execute(
            "UPDATE hpu_student SET attendance_lock = ? WHERE student_id = ?",
            (0 if unlocked else 1, student_id),
        )
        return self.get(student_id)

    def delete(self, student_id: int) -> bool:
        affected = self.db.execute("DELETE FROM hpu_student WHERE student_id = ?", (student_id,))
        return affected > 0

    # -- analytics -----------------------------------------------------------
    def aggregate_attendance(self, roll_no: str) -> dict:
        rows = self.db.query(
            """
            SELECT c.course_code, c.course_name, c.credits,
                   t.full_name AS faculty,
                   a.total_lectures, a.attended_lectures, a.last_session_date
              FROM hpu_enrollment e
              JOIN hpu_course  c ON c.course_id = e.course_id
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
              LEFT JOIN hpu_attendance a
                     ON a.student_id = e.student_id AND a.course_id = e.course_id
             WHERE e.student_id = (SELECT student_id FROM hpu_student WHERE roll_no = ?)
             ORDER BY c.course_code
            """,
            (roll_no,),
        )
        subjects = []
        for row in rows:
            total = int(row["total_lectures"] or 0)
            attended = int(row["attended_lectures"] or 0)
            pct = percentage(attended, total)
            subjects.append({
                **row,
                "total_lectures": total,
                "attended_lectures": attended,
                "percentage": pct,
                "status": derive_attendance_status(pct),
                "can_skip": max(0, int(total * 0.75 - attended)),
            })
        attended_total = sum(s["attended_lectures"] for s in subjects)
        conducted_total = sum(s["total_lectures"] for s in subjects)
        overall = percentage(attended_total, conducted_total)
        return {
            "subjects": subjects,
            "overall": {
                "attended_lectures": attended_total,
                "total_lectures": conducted_total,
                "percentage": overall,
                "status": derive_attendance_status(overall),
                "required_percentage": 75.0,
                "minimum_to_appear": int(conducted_total * 0.75),
                "classes_to_skip": max(0, int(conducted_total * 0.75) - attended_total),
            },
        }

    def transcript(self, roll_no: str) -> dict:
        scale = _grade_scale(self.db)
        rows = self.db.query(
            """
            SELECT c.course_code, c.course_name, c.credits, c.semester,
                   t.full_name AS instructor,
                   m.internal_marks, m.midterm_marks, m.endterm_marks,
                   m.total_marks, m.grade_letter, m.grade_point, m.updated_at
              FROM hpu_enrollment e
              JOIN hpu_course c ON c.course_id = e.course_id
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
              LEFT JOIN hpu_mark m ON m.student_id = e.student_id AND m.course_id = e.course_id
             WHERE e.student_id = (SELECT student_id FROM hpu_student WHERE roll_no = ?)
             ORDER BY c.semester, c.course_code
            """,
            (roll_no,),
        )
        graded = [r for r in rows if r["grade_point"] is not None]
        credits_earned = sum(int(r["credits"]) for r in graded if float(r["grade_point"]) > 0)

        weighted = sum(float(r["grade_point"]) * int(r["credits"]) for r in graded)
        credits_counted = sum(int(r["credits"]) for r in graded)
        cgpa = round(weighted / credits_counted, 2) if credits_counted else 0.0
        current = [r for r in graded if int(r["semester"]) == 6]
        sgpa = round(
            sum(float(r["grade_point"]) * int(r["credits"]) for r in current)
            / max(sum(int(r["credits"]) for r in current), 1),
            2,
        ) if current else 0.0

        return {
            "courses": rows,
            "cgpa": cgpa,
            "sgpa": sgpa,
            "credits_earned": credits_earned,
            "scale": scale or [],
        }


# =============================================================================
#  TEACHERS
# =============================================================================
class TeacherRepository:
    def __init__(self, db) -> None:
        self.db = db

    def directory(self) -> list[dict]:
        rows = self.db.query(
            """
            SELECT t.teacher_id, t.faculty_code, t.full_name, t.designation,
                   t.department, t.specialization, t.email, t.phone,
                   t.office_location, t.office_hours, t.cabin_status,
                   t.grading_deadline, t.warning_count, t.weekly_hours,
                   (SELECT COUNT(DISTINCT a.course_id) FROM hpu_teacher_allocation a
                     WHERE a.teacher_id = t.teacher_id) AS course_count,
                   (SELECT GROUP_CONCAT(DISTINCT c.course_code) FROM hpu_teacher_allocation a
                      JOIN hpu_course c ON c.course_id = a.course_id
                     WHERE a.teacher_id = t.teacher_id) AS course_codes,
                   (SELECT GROUP_CONCAT(DISTINCT a.batch_code) FROM hpu_teacher_allocation a
                     WHERE a.teacher_id = t.teacher_id) AS batch_codes
              FROM hpu_teacher t
             ORDER BY t.faculty_code
            """
        )
        for row in rows:
            row["full_name"] = row["full_name"].title()
            row["initials"] = _initials(row["full_name"])
            row["warning_level"] = (
                "CLEAR" if int(row["warning_count"] or 0) == 0
                else "WATCH" if int(row["warning_count"]) == 1
                else "CRITICAL"
            )
        return rows

    def get(self, teacher_id: int) -> dict | None:
        return self.db.query_one("SELECT * FROM hpu_teacher WHERE teacher_id = ?", (teacher_id,))

    def get_by_code(self, faculty_code: str) -> dict | None:
        return self.db.query_one(
            "SELECT * FROM hpu_teacher WHERE faculty_code = ?", (faculty_code,)
        )

    def allocations(self, faculty_code: str) -> list[dict]:
        return self.db.query(
            """
            SELECT c.course_id, c.course_code, c.course_name, c.credits, c.semester,
                   a.batch_code, a.academic_year,
                   (SELECT COUNT(*) FROM hpu_enrollment e WHERE e.course_id = c.course_id)
                       AS total_students
              FROM hpu_teacher_allocation a
              JOIN hpu_course  c ON c.course_id  = a.course_id
              JOIN hpu_teacher t ON t.teacher_id = a.teacher_id
             WHERE t.faculty_code = ?
             ORDER BY c.course_code
            """,
            (faculty_code,),
        )

    def count(self) -> int:
        return int(self.db.scalar("SELECT COUNT(*) FROM hpu_teacher", default=0) or 0)

    def create(self, data: dict, password_hash: str, password_salt: str) -> int:
        teacher_id = self.db.insert_returning_id(
            """
            INSERT INTO hpu_teacher
                (faculty_code, full_name, designation, department, specialization,
                 email, phone, office_location, office_hours, cabin_status,
                 grading_deadline, warning_count, weekly_hours)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                data["faculty_code"], data["full_name"].upper(), data["designation"],
                data.get("department", "DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING"),
                data.get("specialization"), data["email"], data.get("phone"),
                data.get("office_location"), data.get("office_hours"),
                data.get("cabin_status", "ON CAMPUS"), data.get("grading_deadline"),
                data.get("weekly_hours", 0),
            ),
        )
        self.db.execute(
            """
            INSERT INTO hpu_user_auth
                (user_code, email, phone, password_hash, password_salt, role, full_name)
            VALUES (?, ?, ?, ?, ?, 'TEACHER', ?)
            """,
            (data["faculty_code"], data["email"], data.get("phone"),
             password_hash, password_salt, data["full_name"].upper()),
        )
        return teacher_id

    def set_warning_count(self, teacher_id: int, count: int) -> dict | None:
        self.db.execute(
            "UPDATE hpu_teacher SET warning_count = ? WHERE teacher_id = ?", (count, teacher_id)
        )
        return self.get(teacher_id)

    def set_grading_deadline(self, teacher_id: int, deadline: str) -> dict | None:
        self.db.execute(
            "UPDATE hpu_teacher SET grading_deadline = ? WHERE teacher_id = ?",
            (deadline, teacher_id),
        )
        return self.get(teacher_id)


# =============================================================================
#  ATTENDANCE
# =============================================================================
class AttendanceRepository:
    def __init__(self, db) -> None:
        self.db = db

    def class_sheet(self, course_code: str) -> dict:
        course = self.db.query_one(
            """
            SELECT c.course_id, c.course_code, c.course_name, c.credits, c.semester,
                   t.full_name AS instructor, a.batch_code
              FROM hpu_course c
              LEFT JOIN hpu_teacher t ON t.teacher_id = c.instructor_id
              LEFT JOIN hpu_teacher_allocation a ON a.course_id = c.course_id
             WHERE c.course_code = ?
             LIMIT 1
            """,
            ((course_code or "").upper(),),
        )
        if not course:
            return {}

        students = self.db.query(
            """
            SELECT s.student_id, s.roll_no, s.reg_no,
                   s.first_name || ' ' || s.last_name AS full_name,
                   s.email, s.academic_status,
                   s.attendance_lock,
                   COALESCE(att.attended_lectures, 0) AS attended_lectures,
                   COALESCE(att.total_lectures, 0)    AS total_lectures,
                   att.last_session_date
              FROM hpu_enrollment e
              JOIN hpu_student s ON s.student_id = e.student_id
              LEFT JOIN hpu_attendance att
                     ON att.student_id = e.student_id AND att.course_id = e.course_id
             WHERE e.course_id = ?
             ORDER BY s.roll_no
            """,
            (course["course_id"],),
        )
        for row in students:
            total = int(row["total_lectures"] or 0)
            attended = int(row["attended_lectures"] or 0)
            pct = percentage(attended, total)
            row["full_name"] = row["full_name"].title()
            row["percentage"] = pct
            row["attendance_status"] = derive_attendance_status(pct)
            row["initials"] = _initials(row["full_name"])
            row["portal_access"] = "LOCKED" if int(row["attendance_lock"]) else "UNLOCKED"

        return {
            "course": {
                "course_id": course["course_id"],
                "code": course["course_code"],
                "name": course["course_name"],
                "credits": course["credits"],
                "semester": course["semester"],
                "instructor": course["instructor"],
                "batch_code": course["batch_code"],
            },
            "students": students,
            "total_students": len(students),
        }

    def sessions(self, course_code: str | None = None, limit: int = 25) -> list[dict]:
        if course_code:
            rows = self.db.query(
                """
                SELECT s.session_id, s.session_date, s.slot, s.batch_code,
                       s.total_students, s.present_count, s.absent_count,
                       s.late_count, s.is_revised, s.created_at,
                       c.course_code, c.course_name, t.full_name AS marked_by
                  FROM hpu_attendance_session s
                  JOIN hpu_course c ON c.course_id = s.course_id
                  LEFT JOIN hpu_teacher t ON t.teacher_id = s.teacher_id
                 WHERE c.course_code = ?
                 ORDER BY s.session_date DESC, s.session_id DESC
                 LIMIT ?
                """,
                ((course_code or "").upper(), limit),
            )
        else:
            rows = self.db.query(
                """
                SELECT s.session_id, s.session_date, s.slot, s.batch_code,
                       s.total_students, s.present_count, s.absent_count,
                       s.late_count, s.is_revised, s.created_at,
                       c.course_code, c.course_name, t.full_name AS marked_by
                  FROM hpu_attendance_session s
                  JOIN hpu_course c ON c.course_id = s.course_id
                  LEFT JOIN hpu_teacher t ON t.teacher_id = s.teacher_id
                 ORDER BY s.session_date DESC, s.session_id DESC
                 LIMIT ?
                """,
                (limit,),
            )
        for row in rows:
            row["percentage"] = percentage(row["present_count"], row["total_students"])
            row["session_label"] = f"SES-{row['course_code']}-{row['session_id']}"
        return rows

    def punch(self, course_code: str, session_date: str, slot: str,
              faculty_code: str, records: list[dict]) -> dict:
        """Apply one lecture punch. `records` = [{roll_no, status}] with
        status in P / A / L (present / absent / late)."""
        course_id = self.db.scalar(
            "SELECT course_id FROM hpu_course WHERE course_code = ?", ((course_code or "").upper(),)
        )
        if not course_id:
            raise ValueError("Unknown course code")

        teacher_id = self.db.scalar(
            "SELECT teacher_id FROM hpu_teacher WHERE faculty_code = ?", (faculty_code,)
        )
        batch_code = self.db.scalar(
            "SELECT batch_code FROM hpu_teacher_allocation WHERE course_id = ? LIMIT 1",
            (course_id,),
        ) or "CSE-2023-BATCH-A"

        present = sum(1 for r in records if r["status"] in ("P", "L"))
        absent = sum(1 for r in records if r["status"] == "A")
        late = sum(1 for r in records if r["status"] == "L")

        for record in records:
            roll_no = record["roll_no"]
            status = record["status"]
            self.db.execute(
                """
                INSERT INTO hpu_attendance
                    (student_id, course_id, total_lectures, attended_lectures,
                     last_session_date, last_updated)
                SELECT s.student_id, ?, 1, ?, ?, datetime('now')
                  FROM hpu_student s
                  JOIN hpu_enrollment e
                    ON e.student_id = s.student_id AND e.course_id = ?
                 WHERE s.roll_no = ?
                ON CONFLICT (student_id, course_id) DO UPDATE SET
                    total_lectures    = hpu_attendance.total_lectures + 1,
                    attended_lectures = hpu_attendance.attended_lectures + ?,
                    last_session_date = excluded.last_session_date,
                    last_updated      = datetime('now')
                """,
                (course_id, 1 if status in ("P", "L") else 0, session_date,
                 course_id, roll_no, 1 if status in ("P", "L") else 0),
            )

        session_id = self.db.insert_returning_id(
            """
            INSERT INTO hpu_attendance_session
                (course_id, teacher_id, session_date, slot, batch_code,
                 total_students, present_count, absent_count, late_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (course_id, teacher_id, session_date, slot, batch_code,
             len(records), present, absent, late),
        )
        self.db.commit()
        return {
            "session_id": session_id,
            "session_label": f"SES-{course_code.upper()}-{session_id}",
            "present_count": present,
            "absent_count": absent,
            "late_count": late,
            "total_students": len(records),
            "percentage": percentage(present, len(records)),
        }

    def course_trend(self, course_code: str, limit: int = 12) -> list[dict]:
        rows = self.db.query(
            """
            SELECT s.session_date, s.present_count, s.absent_count, s.total_students
              FROM hpu_attendance_session s
              JOIN hpu_course c ON c.course_id = s.course_id
             WHERE c.course_code = ?
             ORDER BY s.session_date ASC, s.session_id ASC
             LIMIT ?
            """,
            ((course_code or "").upper(), limit),
        )
        return [
            {
                "date": r["session_date"],
                "present": r["present_count"],
                "absent": r["absent_count"],
                "total": r["total_students"],
                "percentage": percentage(r["present_count"], r["total_students"]),
            }
            for r in rows
        ]


# =============================================================================
#  MARKS
# =============================================================================
class MarkRepository:
    def __init__(self, db) -> None:
        self.db = db

    def save(self, student_id: int, course_id: int, internal: float, midterm: float,
             endterm: float, updated_by: str) -> dict:
        """Upsert marks and derive total / grade exactly as TRG_MARK_BEFORE_INSERT_UPDATE."""
        scale = _grade_scale(self.db)
        total = round(internal + midterm + endterm, 2)
        grade, point = resolve_grade(total, scale)

        self.db.execute(
            """
            INSERT INTO hpu_mark
                (student_id, course_id, internal_marks, midterm_marks, endterm_marks,
                 total_marks, grade_letter, grade_point, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT (student_id, course_id) DO UPDATE SET
                internal_marks = excluded.internal_marks,
                midterm_marks  = excluded.midterm_marks,
                endterm_marks  = excluded.endterm_marks,
                total_marks    = excluded.total_marks,
                grade_letter   = excluded.grade_letter,
                grade_point    = excluded.grade_point,
                updated_by     = excluded.updated_by,
                updated_at     = datetime('now')
            """,
            (student_id, course_id, internal, midterm, endterm, total, grade, point, updated_by),
        )
        self.db.commit()
        return {
            "student_id": student_id, "course_id": course_id,
            "internal": internal, "midterm": midterm, "endterm": endterm,
            "total": total, "grade_letter": grade, "grade_point": point,
        }

    def for_course(self, course_code: str) -> list[dict]:
        rows = self.db.query(
            """
            SELECT s.student_id, s.roll_no, s.first_name || ' ' || s.last_name AS full_name,
                   m.internal_marks, m.midterm_marks, m.endterm_marks,
                   m.total_marks, m.grade_letter, m.grade_point
              FROM hpu_course c
              JOIN hpu_enrollment e ON e.course_id = c.course_id
              JOIN hpu_student   s ON s.student_id = e.student_id
              LEFT JOIN hpu_mark m ON m.student_id = s.student_id AND m.course_id = c.course_id
             WHERE c.course_code = ?
             ORDER BY s.roll_no
            """,
            ((course_code or "").upper(),),
        )
        for row in rows:
            row["full_name"] = row["full_name"].title()
            row["initials"] = _initials(row["full_name"])
        return rows

    def grade_distribution(self, course_code: str | None = None) -> list[dict]:
        if course_code:
            rows = self.db.query(
                """
                SELECT m.grade_letter AS grade, COUNT(*) AS total
                  FROM hpu_mark m JOIN hpu_course c ON c.course_id = m.course_id
                 WHERE c.course_code = ?
                 GROUP BY m.grade_letter
                """,
                ((course_code or "").upper(),),
            )
        else:
            rows = self.db.query(
                "SELECT grade_letter AS grade, COUNT(*) AS total FROM hpu_mark GROUP BY 1"
            )
        counts = {r["grade"]: int(r["total"]) for r in rows}
        scale = _grade_scale(self.db) or []
        return [
            {
                "grade": row["grade_letter"],
                "total": counts.get(row["grade_letter"], 0),
                "grade_point": row["grade_point"],
                "classification": row["classification"],
            }
            for row in scale
        ]

    def subject_performance(self) -> list[dict]:
        rows = self.db.query(
            """
            SELECT c.course_code, c.course_name, c.credits,
                   COUNT(m.mark_id) AS graded,
                   ROUND(AVG(m.total_marks), 1) AS average,
                   ROUND(AVG(m.grade_point), 2) AS average_point,
                   MAX(m.total_marks) AS highest,
                   MIN(m.total_marks) AS lowest
              FROM hpu_course c
              JOIN hpu_enrollment e ON e.course_id = c.course_id
              LEFT JOIN hpu_mark m ON m.course_id = c.course_id
             GROUP BY c.course_id, c.course_code, c.course_name, c.credits
             ORDER BY c.course_code
            """
        )
        for row in rows:
            row["average"] = float(row["average"] or 0)
            row["average_point"] = float(row["average_point"] or 0)
        return rows

    def toppers(self, limit: int = 5) -> list[dict]:
        rows = self.db.query(
            """
            SELECT s.roll_no, s.first_name || ' ' || s.last_name AS full_name,
                   ROUND(SUM(m.grade_point * c.credits) / SUM(c.credits), 2) AS cgpa,
                   COUNT(m.mark_id) AS courses,
                   SUM(CASE WHEN m.grade_point < 5 THEN 1 ELSE 0 END) AS fail_count
              FROM hpu_mark m
              JOIN hpu_student s ON s.student_id = m.student_id
              JOIN hpu_course  c ON c.course_id  = m.course_id
             GROUP BY s.student_id, s.roll_no, s.first_name, s.last_name
            HAVING courses > 0
             ORDER BY cgpa DESC
             LIMIT ?
            """,
            (limit,),
        )
        for row in rows:
            row["full_name"] = row["full_name"].title()
            row["initials"] = _initials(row["full_name"])
        return rows

    def defaulters(self, limit: int = 10) -> list[dict]:
        rows = self.db.query(
            """
            SELECT s.roll_no, s.first_name || ' ' || s.last_name AS full_name,
                   s.academic_status,
                   ROUND(SUM(m.grade_point * c.credits) / SUM(c.credits), 2) AS cgpa,
                   ROUND(MIN(m.total_marks), 1) AS weakest
              FROM hpu_mark m
              JOIN hpu_student s ON s.student_id = m.student_id
              JOIN hpu_course  c ON c.course_id  = m.course_id
             GROUP BY s.student_id, s.roll_no, s.first_name, s.last_name, s.academic_status
            HAVING cgpa < 7.0
             ORDER BY cgpa ASC
             LIMIT ?
            """,
            (limit,),
        )
        for row in rows:
            row["full_name"] = row["full_name"].title()
            row["initials"] = _initials(row["full_name"])
        return rows

    def auto_status_proposals(self) -> list[dict]:
        """Students whose stored academic_status disagrees with their attendance."""
        rows = self.db.query(
            """
            SELECT s.student_id, s.roll_no, s.first_name || ' ' || s.last_name AS full_name,
                   s.academic_status,
                   ROUND(AVG(CASE WHEN a.total_lectures > 0
                                   THEN a.attended_lectures * 100.0 / a.total_lectures END), 1)
                       AS attendance
              FROM hpu_student s
              JOIN hpu_attendance a ON a.student_id = s.student_id
             GROUP BY s.student_id, s.roll_no, s.first_name, s.last_name, s.academic_status
            """
        )
        proposals = []
        for row in rows:
            expected = derive_academic_status(float(row["attendance"] or 0))
            if expected != row["academic_status"]:
                proposals.append({
                    **row,
                    "full_name": row["full_name"].title(),
                    "suggested_status": expected,
                })
        return proposals


def _initials(*parts: str) -> str:
    letters = []
    for part in parts:
        for word in str(part or "").split():
            if word:
                letters.append(word[0].upper())
    return ("".join(letters) or "HPU")[:2]
