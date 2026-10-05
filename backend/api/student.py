"""Student Portal endpoints. Every route is bound to the signed-in roll number,
so a student can only ever read their own records -- the roll number is never
accepted from the client."""

from __future__ import annotations

from flask import Blueprint, g, request

from ..core.decorators import current_principal, require_auth, require_roles
from ..core.errors import AuthorizationError
from ..core.grading import (
    ATTENDANCE_SAFE,
    ATTENDANCE_WARNING,
    academic_status,
)
from ..core.responses import ok
from ..core.validators import clamp_int
from ..db.repositories.academic import (
    AttendanceRepository,
    CourseRepository,
    StudentRepository,
)
from ..db.repositories.content import ContentRepository, WorksheetRepository

bp = Blueprint("student", __name__, url_prefix="/api/student")


def _my_student_id() -> int:
    student_id = g.db.scalar(
        "SELECT student_id FROM hpu_student WHERE roll_no = ?",
        (g.principal["user_code"],),
    )
    if not student_id:
        raise AuthorizationError("No student record is linked to this account.")
    return int(student_id)


@bp.get("/profile")
@require_roles("STUDENT")
def profile():
    students = StudentRepository(g.db)
    record = students.profile(g.principal["user_code"])
    if not record:
        raise AuthorizationError("No student record is linked to this account.")
    return ok({"student": record})


@bp.get("/attendance")
@require_roles("STUDENT")
def attendance():
    roll_no = g.principal["user_code"]
    data = StudentRepository(g.db).aggregate_attendance(roll_no)
    lock = g.db.scalar(
        "SELECT attendance_lock FROM hpu_student WHERE roll_no = ?", (roll_no,)
    )
    data["portal_locked"] = bool(int(lock or 0))

    # What-if planner: how many lectures can be skipped and stay above 75%.
    overall = data["overall"]
    held = overall["total_lectures"]
    attended = overall["attended_lectures"]
    required = int(held * 0.75)
    remaining = max(required - attended, 0)
    future_total = 0
    data["projection"] = {
        "lectures_may_skip": max(remaining, 0),
        "buffer_percentage": round((held - attended - required) * 100 / held, 1)
        if held else 0.0,
        "safe_if_all_present": (
            round((attended + 1) * 100 / (held + 1), 1) >= ATTENDANCE_SAFE
        ) if held else True,
        "status_now": overall["status"],
        "threshold": ATTENDANCE_SAFE,
        "warning_threshold": ATTENDANCE_WARNING,
    }
    return ok({"attendance": data})


@bp.get("/attendance/sessions")
@require_roles("STUDENT")
def attendance_sessions():
    roll_no = g.principal["user_code"]
    # Optional course filter; omitting it returns every session the student was
    # enrolled in, which is what the student's session log renders.
    course_code = request.args.get("course", "").strip()
    # Scoped to this student's enrolments -- not every session in the department --
    # and optionally narrowed to one course.
    params = [roll_no]
    course_clause = ""
    if course_code:
        course_clause = "AND c.course_code = ?"
        params.append(course_code.upper())

    rows = g.db.query(
        f"""
        SELECT s.session_id, s.session_date, s.slot,
               s.present_count, s.absent_count, s.total_students,
               t.full_name AS marked_by,
               c.course_code, c.course_name
          FROM hpu_attendance_session s
          JOIN hpu_course c ON c.course_id = s.course_id
          LEFT JOIN hpu_teacher t ON t.teacher_id = s.teacher_id
          JOIN hpu_enrollment e ON e.course_id = c.course_id
                              AND e.student_id = (
                                    SELECT student_id FROM hpu_student
                                     WHERE roll_no = ?
                                  )
          {course_clause}
         GROUP BY s.session_id
         ORDER BY s.session_date DESC, s.session_id DESC
         LIMIT 20
        """,
        tuple(params),
    )
    # Note: hpu_attendance_session stores cohort counts, not per-student flags, so
    # the honest figure here is class attendance for that slot. The student's own
    # standing comes from /student/attendance.
    for row in rows:
        row["percentage"] = round(
            row["present_count"] * 100 / row["total_students"], 1
        ) if row["total_students"] else 0.0
    return ok({"sessions": rows})


@bp.get("/transcript")
@require_roles("STUDENT")
def transcript():
    data = StudentRepository(g.db).transcript(g.principal["user_code"])
    return ok({"transcript": data})


@bp.get("/gpa")
@require_roles("STUDENT")
def gpa():
    roll_no = g.principal["user_code"]
    data = StudentRepository(g.db).transcript(roll_no)
    courses = data["courses"]

    semester_history = []
    semesters = sorted({int(c["semester"] or 0) for c in courses if c["grade_point"] is not None})
    for semester in semesters:
        rows = [c for c in courses
                if int(c["semester"] or 0) == semester and c["grade_point"] is not None]
        credits = sum(int(r["credits"]) for r in rows)
        weighted = sum(float(r["grade_point"]) * int(r["credits"]) for r in rows)
        percent = sum(float(r["total_marks"] or 0) for r in rows)
        semester_history.append({
            "semester": semester,
            "sgpa": round(weighted / credits, 2) if credits else 0.0,
            "credits": credits,
            "average_percent": round(percent / len(rows), 1) if rows else 0.0,
            "courses": len(rows),
        })

    distribution = {}
    for row in courses:
        letter = row["grade_letter"] or "N/A"
        distribution[letter] = distribution.get(letter, 0) + 1

    return ok({
        "gpa": {
            "cgpa": data["cgpa"],
            "sgpa": data["sgpa"],
            "credits_earned": data["credits_earned"],
            "credits_registered": sum(int(c["credits"] or 0) for c in courses),
            "history": semester_history,
            "distribution": distribution,
            "standing": (
                "EXCELLENT" if data["cgpa"] >= 8.5 else
                "VERY GOOD" if data["cgpa"] >= 7.5 else
                "GOOD" if data["cgpa"] >= 6.5 else
                "SATISFACTORY" if data["cgpa"] >= 5.5 else "NEEDS IMPROVEMENT"
            ),
        }
    })


@bp.get("/dashboard")
@require_roles("STUDENT")
def dashboard():
    """One aggregated call so the portal paints in a single round trip."""
    roll_no = g.principal["user_code"]
    db = g.db
    students = StudentRepository(g.db)
    content = ContentRepository(g.db)

    record = students.profile(roll_no)
    attendance = students.aggregate_attendance(roll_no)
    marks = students.transcript(roll_no)

    worksheets = WorksheetRepository(g.db).list_worksheets(student_id=_my_student_id())
    pending = [
        w for w in worksheets if w.get("my_status") == "NOT SUBMITTED"
    ]
    graded = [
        w for w in worksheets if w.get("my_status") == "CHECKED & GRADED"
    ]
    worksheet_marks = [
        w["my_marks"] for w in graded if w.get("my_marks") is not None
    ]
    worksheet_average = (
        round(sum(worksheet_marks) / len(worksheet_marks), 2) if worksheet_marks else None
    )

    attendance_overall = attendance["overall"]
    grade_rows = [c for c in marks["courses"] if c["grade_point"] is not None]
    weakest = min(grade_rows, key=lambda r: float(r["total_marks"] or 0), default=None)
    strongest = max(grade_rows, key=lambda r: float(r["total_marks"] or 0), default=None)

    next_exam = g.db.query(
        """
        SELECT course_code, subject_name, exam_date, exam_day, start_time, end_time, venue
          FROM hpu_exam_schedule
         ORDER BY exam_date ASC LIMIT 3
        """
    )

    return ok({
        "student": record,
        "attendance": attendance,
        "transcript": marks,
        "summary": {
            "roll_no": record["roll_no"],
            "reg_no": record["reg_no"],
            "semester": record["semester"],
            "batch_code": record["batch_code"],
            "academic_status": record["academic_status"],
            "portal_access": record["portal_access"],
            "overall_attendance": attendance_overall["percentage"],
            "attendance_status": attendance_overall["status"],
            "classes_to_skip": attendance_overall["classes_to_skip"],
            "cgpa": marks["cgpa"],
            "sgpa": marks["sgpa"],
            "credits_earned": marks["credits_earned"],
            "worksheets_total": len(worksheets),
            "worksheets_pending": len(pending),
            "worksheets_graded": len(graded),
            "worksheet_average": worksheet_average,
            "subjects": len(attendance["subjects"]),
            "weakest_course": weakest["course_code"] if weakest else None,
            "strongest_course": strongest["course_code"] if strongest else None,
        },
        "upcoming_exams": next_exam,
        "worksheets": worksheets,
        "risk": {
            "attendance_below_threshold": attendance_overall["percentage"] < ATTENDANCE_SAFE,
            "failing_subjects": [
                c["course_code"] for c in grade_rows if float(c["grade_point"] or 0) < 4
            ],
            "pending_worksheets": [w["title"] for w in pending],
        },
    })