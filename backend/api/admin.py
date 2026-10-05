"""Admin Console endpoints.

This is the operational surface: roster management, faculty oversight, course
administration, the immutable audit trail and a CSV export. The two procedures
required by the university syllabus -- UPDATE_STUDENT_STATUS and
UNLOCK_ATTENDANCE_PORTAL -- are exposed here and mirrored one-to-one by the
PL/SQL package in database/schema.sql.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from flask import Blueprint, Response, current_app, g, request

from ..core.decorators import require_roles
from ..core.errors import ConflictError, NotFoundError, ValidationError
from ..core.grading import ATTENDANCE_SAFE
from ..core.responses import ok
from ..core.security import hash_password
from ..core.validators import (
    as_bool,
    clamp_int,
    optional_phone,
    optional_text,
    require_choice,
    require_code,
    require_date,
    require_email,
    require_float,
    require_int,
    require_text,
)
from ..db.repositories.academic import (
    CourseRepository,
    MarkRepository,
    StudentRepository,
    TeacherRepository,
)
from ..db.repositories.content import (
    AuditRepository,
    ContentRepository,
    WorksheetRepository,
)
from ..db.repositories.users import UserRepository
from ..services.audit import record_event

bp = Blueprint("admin", __name__, url_prefix="/api/admin")


# =============================================================================
#  DASHBOARD
# =============================================================================
@bp.get("/overview")
@require_roles("ADMIN")
def overview():
    db = g.db
    students = StudentRepository(db)
    teachers = TeacherRepository(db)
    marks = MarkRepository(db)
    audit = AuditRepository(db)
    content = ContentRepository(db)

    counts = students.status_counts()
    directory = students.directory(per_page=5)
    faculty = teachers.directory()

    attendance_rows = db.query(
        """
        SELECT s.roll_no, s.student_id,
               s.first_name || ' ' || s.last_name AS full_name,
               s.academic_status, s.attendance_lock,
               SUM(a.attended_lectures) AS attended, SUM(a.total_lectures) AS total
          FROM hpu_student s
          JOIN hpu_attendance a ON a.student_id = s.student_id
         GROUP BY s.student_id, s.roll_no, s.first_name, s.last_name,
                  s.academic_status, s.attendance_lock
        """
    )
    at_risk = []
    for row in attendance_rows:
        total = int(row["total"] or 0)
        pct = round(int(row["attended"] or 0) * 100 / total, 1) if total else 0.0
        if pct < 75:
            at_risk.append({
                **row,
                "attendance": pct,
                "full_name": row["full_name"].title(),
                "below_threshold_by": round(75 - pct, 1),
                "portal_access": "LOCKED" if int(row["attendance_lock"]) else "UNLOCKED",
            })
    at_risk.sort(key=lambda r: r["attendance"])

    login_rows = db.query(
        """
        SELECT role, COUNT(*) AS total,
               SUM(CASE WHEN last_login_at IS NOT NULL THEN 1 ELSE 0 END) AS ever_logged,
               MAX(last_login_at) AS last_seen
          FROM hpu_user_auth WHERE is_active = 1 GROUP BY role
        """
    )

    return ok({
        "overview": {
            "kpis": {
                "students": counts.get("ALL", 0),
                "active": counts.get("ACTIVE", 0),
                "detained": counts.get("DETAINED", 0),
                "suspended": counts.get("SUSPENDED", 0),
                "faculty": teachers.count(),
                "courses": int(db.scalar("SELECT COUNT(*) FROM hpu_course", default=0) or 0),
                "worksheets": int(db.scalar(
                    "SELECT COUNT(*) FROM hpu_worksheet WHERE is_active = 1", default=0) or 0),
                "submissions": int(db.scalar(
                    "SELECT COUNT(*) FROM hpu_worksheet_submission", default=0) or 0),
                "locked_portals": int(db.scalar(
                    "SELECT COUNT(*) FROM hpu_student WHERE attendance_lock = 1",
                    default=0) or 0),
                "active_sessions": int(db.scalar(
                    "SELECT COUNT(*) FROM hpu_auth_session WHERE revoked_at IS NULL "
                    "AND expires_at > datetime('now')", default=0) or 0),
                "audit_entries": audit.stats()["total"],
            },
            "status_counts": counts,
            "batches": students.batches(),
            "at_risk": at_risk[:8],
            "at_risk_total": len(at_risk),
            "recent_students": directory["rows"],
            "faculty": faculty,
            "faculty_warnings": [f for f in faculty if int(f["warning_count"] or 0) > 0],
            "audit": audit.recent(10),
            "audit_stats": audit.stats(),
            "grade_distribution": marks.grade_distribution(),
            "subject_performance": marks.subject_performance(),
            "toppers": marks.toppers(5),
            "status_proposals": marks.auto_status_proposals(),
            "login_activity": login_rows,
            "notices": content.notices(limit=5),
            "thresholds": {"attendance_required": ATTENDANCE_SAFE},
        }
    })


# =============================================================================
#  STUDENT DIRECTORY
# =============================================================================
@bp.get("/students")
@require_roles("ADMIN", "TEACHER")
def directory():
    page = clamp_int(request.args.get("page"), 1, 10000, 1)
    per_page = clamp_int(request.args.get("per_page"), 5, 200, default_page_size())
    data = StudentRepository(g.db).directory(
        search=request.args.get("q", "").strip(),
        status=request.args.get("status", ""),
        batch=request.args.get("batch", ""),
        sort=request.args.get("sort", "roll_no"),
        direction=request.args.get("dir", "asc"),
        page=page,
        per_page=per_page,
    )
    return ok({"directory": data})


def default_page_size() -> int:
    return current_app.config["DEFAULT_PAGE_SIZE"]


@bp.post("/students")
@require_roles("ADMIN")
def register_student():
    data = request.get_json(silent=True) or {}

    first_name = require_text(data, "first_name", label="First name", max_length=60)
    last_name = require_text(data, "last_name", label="Last name", max_length=60)
    roll_no = require_code(data, "roll_no", label="Roll number")
    reg_no = require_code(data, "reg_no", label="Registration number")
    email = require_email(data, "email")
    phone = optional_phone(data, "phone")
    semester = require_int(data, "semester", minimum=1, maximum=10,
                           label="Semester")
    batch_code = optional_text(data, "batch_code") or "CSE-2023-BATCH-A"
    password = data.get("password") or f"{roll_no.split('-')[-1]}@hpu"

    repo = StudentRepository(g.db)
    if repo.get_by_roll(roll_no):
        raise ConflictError(f"Roll number {roll_no} is already registered.")
    if g.db.scalar("SELECT COUNT(*) FROM hpu_student WHERE email = ?", (email,)):
        raise ConflictError("That email address is already registered.")
    if g.db.scalar("SELECT COUNT(*) FROM hpu_student WHERE reg_no = ?", (reg_no,)):
        raise ConflictError("That registration number is already in use.")

    digest, salt = hash_password(password, rounds=current_app.config["PBKDF2_ROUNDS"])
    student_id = repo.create({
        "roll_no": roll_no, "reg_no": reg_no,
        "first_name": first_name.upper(), "last_name": last_name.upper(),
        "email": email, "phone": phone, "semester": semester,
        "batch_code": batch_code,
        "attendance_lock": as_bool(data.get("attendance_lock"), True),
    }, digest, salt)

    record_event(
        action="STUDENT_REGISTERED",
        target=f"{roll_no} / {first_name.title()} {last_name.title()}",
        details=f"BATCH {batch_code}, SEMESTER {semester}, ENROLLED IN ALLOCATED COURSES",
        principal=g.principal,
    )
    return ok({"student_id": student_id,
               "message": f"{first_name.title()} {last_name.title()} registered."}, 201)


@bp.patch("/students/<int:student_id>")
@require_roles("ADMIN")
def update_student(student_id: int):
    """Maps to HPU_PORTAL_PKG.UPDATE_STUDENT_STATUS + UNLOCK_ATTENDANCE_PORTAL."""
    data = request.get_json(silent=True) or {}
    repo = StudentRepository(g.db)
    current = repo.get(student_id)
    if not current:
        raise NotFoundError("Student")

    changes = []

    if "academic_status" in data:
        status = require_choice(
            data, "academic_status", {"ACTIVE", "DETAINED", "SUSPENDED"},
            label="Academic status",
        )
        if status != current["academic_status"]:
            repo.update_status(student_id, status)
            changes.append(f"ACADEMIC STATUS → {status}")
            record_event(
                action="STUDENT_STATUS_UPDATE",
                target=f"{current['roll_no']} / {current['full_name'].upper()}",
                details=f"ACADEMIC_STATUS SET TO {status}",
                severity="WARNING" if status != "ACTIVE" else "INFO",
                principal=g.principal,
            )

    if "attendance_lock" in data:
        unlocked = as_bool(data["attendance_lock"], False)
        if bool(unlocked) != (not int(current["attendance_lock"])):
            repo.set_attendance_lock(student_id, unlocked)
            changes.append(f"PORTAL {'UNLOCKED' if unlocked else 'LOCKED'}")
            record_event(
                action="PORTAL_UNLOCK" if unlocked else "PORTAL_LOCK",
                target=f"{current['roll_no']} / {current['full_name'].upper()}",
                details=f"ATTENDANCE PORTAL {'UNLOCKED' if unlocked else 'LOCKED'}",
                severity="WARNING" if not unlocked else "INFO",
                principal=g.principal,
            )

    if not changes:
        raise ValidationError("No recognised change was supplied.")

    return ok({
        "student": repo.get(student_id),
        "message": "Updated: " + "; ".join(changes).lower(),
    })


@bp.post("/students/bulk")
@require_roles("ADMIN")
def bulk_students():
    data = request.get_json(silent=True) or {}
    ids = data.get("student_ids")
    action = require_choice(
        data, "action",
        {"ACTIVATE", "DETAIN", "SUSPEND", "LOCK", "UNLOCK", "UNLOCK_ALL"},
        label="Bulk action",
    )
    if not isinstance(ids, list) or not ids:
        raise ValidationError("Select at least one student.", {"student_ids": "required"})

    repo = StudentRepository(g.db)
    applied = []
    for raw_id in ids[:500]:
        try:
            student_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        student = repo.get(student_id)
        if not student:
            continue
        if action == "ACTIVATE":
            repo.update_status(student_id, "ACTIVE")
        elif action == "DETAIN":
            repo.update_status(student_id, "DETAINED")
        elif action == "SUSPEND":
            repo.update_status(student_id, "SUSPENDED")
        elif action in ("LOCK", "UNLOCK_ALL"):
            repo.set_attendance_lock(student_id, False)
        elif action == "UNLOCK":
            repo.set_attendance_lock(student_id, True)
        applied.append(student["roll_no"])

    record_event(
        action="BULK_ACTION",
        target=f"{action} / {len(applied)} STUDENT(S)",
        details=", ".join(applied[:20]) + ("…" if len(applied) > 20 else ""),
        severity="WARNING" if action in {"DETAIN", "SUSPEND", "LOCK"} else "INFO",
        principal=g.principal,
    )
    return ok({"applied": len(applied), "message": f"{action} applied to {len(applied)} record(s)."})


@bp.delete("/students/<int:student_id>")
@require_roles("ADMIN")
def delete_student(student_id: int):
    repo = StudentRepository(g.db)
    student = repo.get(student_id)
    if not student:
        raise NotFoundError("Student")
    if student_id == 1:
        raise ValidationError("The primary demo student record cannot be deleted.")
    repo.delete(student_id)
    record_event(
        action="STUDENT_DELETED",
        target=f"{student['roll_no']} / {student['full_name'].upper()}",
        details="STUDENT RECORD AND CASCADE DATA REMOVED",
        severity="CRITICAL",
        principal=g.principal,
    )
    return ok({"message": f"{student['full_name']} removed from the register."})


@bp.get("/export/students.csv")
@require_roles("ADMIN")
def export_students():
    import csv
    import io

    rows = StudentRepository(g.db).directory(per_page=500, page=1)["rows"]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "ROLL_NO", "REG_NO", "FULL_NAME", "EMAIL", "PHONE", "SEMESTER",
        "BATCH", "ACADEMIC_STATUS", "OVERALL_ATTENDANCE_%", "PORTAL_ACCESS",
        "LAST_LOGIN",
    ])
    for row in rows:
        writer.writerow([
            row["roll_no"], row["reg_no"], row["full_name"], row["email"],
            row["phone"] or "", row["semester"], row["batch_code"],
            row["academic_status"], row["overall_attendance"],
            row["portal_access"], row["last_login_at"] or "NEVER",
        ])

    record_event(action="DATA_EXPORT", target="STUDENT DIRECTORY CSV",
                 details=f"{len(rows)} ROWS EXPORTED", severity="WARNING",
                 principal=g.principal)

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="hpu-students-{stamp}.csv"'
        },
    )


# =============================================================================
#  FACULTY
# =============================================================================
@bp.get("/teachers")
@require_roles("ADMIN")
def faculty_list():
    return ok({"faculty": TeacherRepository(g.db).directory()})


@bp.post("/teachers")
@require_roles("ADMIN")
def register_teacher():
    data = request.get_json(silent=True) or {}
    faculty_code = require_code(data, "faculty_code", label="Faculty code")
    full_name = require_text(data, "full_name", label="Full name", max_length=120)
    designation = require_text(data, "designation", label="Designation", max_length=120)
    email = require_email(data, "email")
    phone = optional_phone(data, "phone")
    specialization = optional_text(data, "specialization", max_length=200)
    office_location = optional_text(data, "office_location", max_length=120)
    office_hours = optional_text(data, "office_hours", max_length=80)
    weekly_hours = require_int(data, "weekly_hours", minimum=0, maximum=40,
                               label="Weekly hours")
    password = data.get("password") or f"{faculty_code}@hpu"

    if g.db.scalar("SELECT COUNT(*) FROM hpu_teacher WHERE faculty_code = ?",
                   (faculty_code,)):
        raise ConflictError(f"Faculty code {faculty_code} already exists.")
    if g.db.scalar("SELECT COUNT(*) FROM hpu_teacher WHERE email = ?", (email,)):
        raise ConflictError("That email address is already registered.")

    digest, salt = hash_password(password, rounds=current_app.config["PBKDF2_ROUNDS"])
    teacher_id = TeacherRepository(g.db).create({
        "faculty_code": faculty_code, "full_name": full_name.upper(),
        "designation": designation.upper(), "email": email, "phone": phone,
        "specialization": specialization, "office_location": office_location,
        "office_hours": office_hours, "weekly_hours": weekly_hours,
    }, digest, salt)

    record_event(
        action="FACULTY_REGISTERED",
        target=f"{faculty_code} / {full_name.upper()}",
        details=f"{designation.upper()}, {weekly_hours} WEEKLY HOURS",
        principal=g.principal,
    )
    return ok({"teacher_id": teacher_id,
               "message": f"{full_name.title()} added to the faculty register."}, 201)


@bp.patch("/teachers/<int:teacher_id>")
@require_roles("ADMIN")
def update_teacher(teacher_id: int):
    data = request.get_json(silent=True) or {}
    repo = TeacherRepository(g.db)
    teacher = repo.get(teacher_id)
    if not teacher:
        raise NotFoundError("Faculty member")

    changes = []
    if "warning_count" in data:
        count = require_int(data, "warning_count", minimum=0, maximum=9,
                            label="Warning count")
        if count != int(teacher["warning_count"] or 0):
            repo.set_warning_count(teacher_id, count)
            changes.append(f"WARNINGS → {count}")
            record_event(action="FACULTY_WARNING",
                         target=f"{teacher['faculty_code']} / {teacher['full_name'].upper()}",
                         details=f"WARNING COUNT SET TO {count}",
                         severity="WARNING" if count else "INFO",
                         principal=g.principal)

    if "grading_deadline" in data:
        deadline = optional_text(data, "grading_deadline", max_length=40)
        repo.set_grading_deadline(teacher_id, deadline)
        changes.append(f"DEADLINE → {deadline or 'cleared'}")
        record_event(action="FACULTY_DEADLINE",
                     target=f"{teacher['faculty_code']} / {teacher['full_name'].upper()}",
                     details=f"GRADING DEADLINE SET TO {deadline or 'NONE'}",
                     principal=g.principal)

    if not changes:
        raise ValidationError("No recognised change was supplied.")
    return ok({"teacher": repo.get(teacher_id),
               "message": "Updated: " + "; ".join(changes).lower()})


# =============================================================================
#  COURSES
# =============================================================================
@bp.get("/courses")
@require_roles("ADMIN", "TEACHER", "STUDENT")
def courses():
    return ok({"courses": CourseRepository(g.db).list_all()})


@bp.post("/courses")
@require_roles("ADMIN")
def create_course():
    data = request.get_json(silent=True) or {}
    course_code = require_code(data, "course_code", label="Course code")
    course_name = require_text(data, "course_name", label="Course name", max_length=180)
    credits = require_int(data, "credits", minimum=1, maximum=10, label="Credits")
    semester = require_int(data, "semester", minimum=1, maximum=10, label="Semester")
    faculty_code = optional_text(data, "faculty_code") or None

    instructor_id = None
    if faculty_code:
        instructor_id = g.db.scalar(
            "SELECT teacher_id FROM hpu_teacher WHERE faculty_code = ?",
            (faculty_code.upper(),),
        )
        if not instructor_id:
            raise ValidationError("Unknown faculty code.", {"faculty_code": "not found"})

    if g.db.scalar("SELECT COUNT(*) FROM hpu_course WHERE course_code = ?",
                   (course_code.upper(),)):
        raise ConflictError(f"Course {course_code.upper()} already exists.")

    course_id = CourseRepository(g.db).create({
        "course_code": course_code.upper(), "course_name": course_name.upper(),
        "credits": credits, "semester": semester, "instructor_id": instructor_id,
        "topics": data.get("topics") or [],
    })

    record_event(
        action="COURSE_CREATED",
        target=course_code.upper(),
        details=f"{course_name.upper()} · {credits} CREDITS · SEMESTER {semester}",
        principal=g.principal,
    )
    return ok({"course_id": course_id,
               "message": f"{course_code.upper()} added to the curriculum."}, 201)


# =============================================================================
#  WORKSHEET ADMINISTRATION
# =============================================================================
@bp.get("/worksheets")
@require_roles("ADMIN")
def worksheets():
    return ok({"worksheets": WorksheetRepository(g.db).list_worksheets()})


@bp.patch("/worksheets/<int:worksheet_id>")
@require_roles("ADMIN")
def set_worksheet_active(worksheet_id: int):
    data = request.get_json(silent=True) or {}
    repo = WorksheetRepository(g.db)
    worksheet = repo.get(worksheet_id)
    if not worksheet:
        raise NotFoundError("Worksheet")
    active = as_bool(data.get("is_active"), True)
    repo.set_active(worksheet_id, active)
    record_event(
        action="WORKSHEET_TOGGLED",
        target=f"{worksheet['course_code']} / {worksheet_id}",
        details=f"{'REOPENED' if active else 'CLOSED'} FOR SUBMISSIONS",
        severity="WARNING" if not active else "INFO",
        principal=g.principal,
    )
    return ok({"message": f"Worksheet {'reopened' if active else 'closed'}."})


@bp.patch("/worksheets/<int:worksheet_id>/deadline")
@require_roles("ADMIN")
def extend_worksheet_deadline(worksheet_id: int):
    """Move a submission deadline. Audited because students are relying on it."""
    data = request.get_json(silent=True) or {}
    deadline = require_date(data, "deadline_date", label="New deadline")
    repo = WorksheetRepository(g.db)
    worksheet = repo.get(worksheet_id)
    if not worksheet:
        raise NotFoundError("Worksheet")

    previous = worksheet["deadline_date"]
    if not repo.set_deadline(worksheet_id, deadline):
        raise NotFoundError("Worksheet")

    record_event(
        action="DEADLINE_EXTENDED",
        target=f"{worksheet['course_code']} / {worksheet_id}",
        details=f"DEADLINE {previous} -> {deadline} ({worksheet['title']})",
        severity="WARNING",
        principal=g.principal,
    )
    return ok({
        "message": "Deadline updated.",
        "worksheet_id": worksheet_id,
        "previous_deadline": previous,
        "deadline_date": deadline,
    })


# =============================================================================
#  NOTICES
# =============================================================================
@bp.post("/notices")
@require_roles("ADMIN")
def publish_notice():
    data = request.get_json(silent=True) or {}
    category = require_choice(
        data, "category",
        {"ACADEMIC CIRCULAR", "EXAM DATE SHEET", "ATTENDANCE", "LIBRARY",
         "LAB INSTRUCTIONS", "RESULT", "GENERAL"},
        label="Category",
    )
    title = require_text(data, "title", label="Title", max_length=240)
    summary = require_text(data, "summary", label="Summary", max_length=600)
    pinned = as_bool(data.get("is_pinned"), False)

    notice_id = ContentRepository(g.db).publish_notice(
        category, title, summary, g.principal["full_name"].upper(), pinned
    )
    record_event(action="NOTICE_PUBLISHED", target=f"{category} / {title}",
                 details=summary[:200], principal=g.principal)
    return ok({"notice_id": notice_id,
               "message": "Gazette notification published."}, 201)


@bp.patch("/notices/<int:notice_id>/pin")
@require_roles("ADMIN")
def pin_notice(notice_id: int):
    pinned = ContentRepository(g.db).toggle_pin(notice_id)
    if pinned is None:
        raise NotFoundError("Notice")
    record_event(action="NOTICE_PINNED" if pinned else "NOTICE_UNPINNED",
                 target=str(notice_id), principal=g.principal)
    return ok({"is_pinned": pinned})


@bp.delete("/notices/<int:notice_id>")
@require_roles("ADMIN")
def delete_notice(notice_id: int):
    if not ContentRepository(g.db).delete_notice(notice_id):
        raise NotFoundError("Notice")
    record_event(action="NOTICE_WITHDRAWN", target=str(notice_id),
                 severity="WARNING", principal=g.principal)
    return ok({"message": "Notification withdrawn."})


# =============================================================================
#  AUDIT
# =============================================================================
@bp.get("/audit")
@require_roles("ADMIN")
def audit_log():
    return ok({
        "audit": AuditRepository(g.db).search(
            search=request.args.get("q", "").strip(),
            action=request.args.get("action", ""),
            severity=request.args.get("severity", ""),
            actor_role=request.args.get("actor_role", ""),
            page=clamp_int(request.args.get("page"), 1, 10000, 1),
            per_page=clamp_int(request.args.get("per_page"), 10, 200,
                               default_page_size()),
        )
    })


# =============================================================================
#  SYSTEM
# =============================================================================
@bp.get("/permissions")
@require_roles("ADMIN")
def permissions():
    """Role/permission matrix rendered in the admin console."""
    matrix = [
        ("View own attendance & transcript",      "FULL", "READ", "READ"),
        ("Submit worksheet answer scripts",       "FULL", "—", "—"),
        ("Punch attendance for allocated course", "—",    "FULL", "OVERRIDE"),
        ("Grade answer scripts",                  "—",    "FULL", "OVERRIDE"),
        ("Commit collegia marks",                 "—",    "FULL", "OVERRIDE"),
        ("Publish gazette notices",               "—",    "DEPT", "FULL"),
        ("View whole-batch roster",               "SELF", "READ", "FULL"),
        ("Change academic status",                "—",    "—", "FULL"),
        ("Lock / unlock attendance portal",       "—",    "—", "FULL"),
        ("Register students & faculty",           "—",    "—", "FULL"),
        ("Create courses & worksheets",           "—",    "COURSE", "FULL"),
        ("Read immutable audit trail",            "OWN",  "OWN", "FULL"),
        ("Export register as CSV",                "—",    "—", "FULL"),
        ("Rotate any account password",           "—",    "—", "FULL"),
    ]
    return ok({
        "matrix": [
            {"capability": c, "student": s, "teacher": t, "admin": a}
            for c, s, t, a in matrix
        ],
        "legend": {
            "FULL": "Full control", "READ": "Read only", "OWN": "Own records only",
            "SELF": "Own records only", "DEPT": "Allocated courses",
            "COURSE": "Allocated courses", "OVERRIDE": "Any course (override)",
            "—": "Not permitted",
        },
    })


@bp.post("/maintenance")
@require_roles("ADMIN")
def maintenance():
    """Housekeeping: purge expired sessions and report the resulting state."""
    purged = UserRepository(g.db).purge_expired_sessions()
    db = g.db
    active = int(db.scalar(
        "SELECT COUNT(*) FROM hpu_auth_session WHERE revoked_at IS NULL "
        "AND expires_at > datetime('now')", default=0) or 0
    )
    record_event(action="MAINTENANCE", target="SESSION STORE",
                 details=f"{purged} EXPIRED SESSION(S) PURGED, {active} ACTIVE",
                 principal=g.principal)
    return ok({"purged": purged, "active_sessions": active,
               "message": f"Purged {purged} expired session(s); {active} still active."})


@bp.post("/commit")
@require_roles("ADMIN")
def commit_database():
    """Mimics the DBA COMMIT that finalises a semester's evaluation cycle."""
    db = g.db
    with db.transaction():
        counts = {
            "students": int(db.scalar("SELECT COUNT(*) FROM hpu_student", default=0) or 0),
            "teachers": int(db.scalar("SELECT COUNT(*) FROM hpu_teacher", default=0) or 0),
            "attendance": int(db.scalar("SELECT COUNT(*) FROM hpu_attendance", default=0) or 0),
            "marks": int(db.scalar("SELECT COUNT(*) FROM hpu_mark", default=0) or 0),
            "worksheets": int(db.scalar("SELECT COUNT(*) FROM hpu_worksheet", default=0) or 0),
            "submissions": int(db.scalar("SELECT COUNT(*) FROM hpu_worksheet_submission",
                                         default=0) or 0),
            "audit": int(db.scalar("SELECT COUNT(*) FROM hpu_audit_log", default=0) or 0),
        }

    message = optional_text(request.get_json(silent=True) or {}, "message") or \
        "SEMESTER VI EVALUATION CYCLE FINALISED"

    record_event(action="DATABASE_COMMIT", target="TRANSACTION WORKSPACE",
                 details=f"{message} — {counts['students']} STUDENTS, {counts['marks']} MARKS",
                 principal=g.principal)

    return ok({
        "counts": counts,
        "committed_at": datetime.now().isoformat(" ", "seconds"),
        "reference": f"COMMIT-{datetime.now():%Y%m%d%H%M%S}",
        "message": "Transaction committed. The audit entry is now immutable.",
    })