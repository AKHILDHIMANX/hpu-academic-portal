"""Faculty Portal endpoints.

Every route resolves the teaching allocation from the signed-in faculty code,
so a teacher can only punch attendance, grade scripts or publish notices for
courses that are actually allocated to them.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from flask import Blueprint, g, request

from ..core.decorators import require_roles
from ..core.errors import AuthorizationError, ValidationError
from ..core.responses import ok
from ..core.validators import (
    clamp_int,
    optional_text,
    require_choice,
    require_code,
    require_date,
    require_float,
    require_int,
    require_text,
)
from ..db.repositories.academic import (
    AttendanceRepository,
    MarkRepository,
    StudentRepository,
    TeacherRepository,
)
from ..db.repositories.content import ContentRepository, WorksheetRepository
from ..services.audit import record_event

bp = Blueprint("teacher", __name__, url_prefix="/api/teacher")

VALID_SLOTS = [
    "09:00 AM - 10:00 AM", "10:00 AM - 11:00 AM", "11:15 AM - 12:15 PM",
    "12:15 PM - 01:15 PM", "02:00 PM - 03:00 PM", "03:00 PM - 04:00 PM",
    "02:00 PM - 05:00 PM",
]


def _my_allocations() -> list[dict]:
    return TeacherRepository(g.db).allocations(g.principal["user_code"])


def _assert_teaches(course_code: str) -> None:
    codes = {row["course_code"] for row in _my_allocations()}
    if (course_code or "").upper() not in codes:
        raise AuthorizationError(
            "You are not allocated to that course. Contact the department office."
        )


@bp.get("/overview")
@require_roles("TEACHER")
def overview():
    db = g.db
    faculty_code = g.principal["user_code"]
    teacher = TeacherRepository(db).get_by_code(faculty_code)
    allocations = _my_allocations()
    worksheets = WorksheetRepository(db).teacher_summary(faculty_code)
    queue = WorksheetRepository(db).queue(
        [row["course_code"] for row in allocations]
    )
    sessions = AttendanceRepository(db).sessions(limit=8)

    today = date.today().isoformat()
    upcoming = db.query(
        """
        SELECT course_code, subject_name, exam_date, exam_day, start_time, venue
          FROM hpu_exam_schedule
         WHERE exam_date >= ?
         ORDER BY exam_date ASC LIMIT 4
        """,
        (today,),
    )

    deadline = teacher.get("grading_deadline") if teacher else None
    days_left = None
    if deadline:
        try:
            days_left = (datetime.fromisoformat(str(deadline)) - datetime.now()).days
        except ValueError:
            days_left = None

    return ok({
        "profile": {
            **(teacher or {}),
            "full_name": (teacher or {}).get("full_name", g.principal["full_name"]).title(),
            "initials": _initials(teacher.get("full_name", "") if teacher else ""),
            "grading_deadline": deadline,
            "days_to_deadline": days_left,
        },
        "kpis": {
            "courses": len(allocations),
            "students": sum(int(row["total_students"] or 0) for row in allocations),
            "credits": sum(int(row["credits"] or 0) for row in allocations),
            "pending_evaluations": len(queue),
            "worksheets": len(worksheets["worksheets"]),
            "sessions_punched": len(sessions),
        },
        "allocations": allocations,
        "worksheets": worksheets["worksheets"],
        "recent_sessions": sessions,
        "upcoming_exams": upcoming,
        "warning": {
            "level": (teacher or {}).get("warning_count", 0) and "WATCH" or "CLEAR",
            "count": int((teacher or {}).get("warning_count") or 0),
            "deadline": deadline,
            "days_to_deadline": days_left,
        },
    })


@bp.get("/classes")
@require_roles("TEACHER")
def classes():
    return ok({"classes": _my_allocations()})


@bp.get("/roster")
@require_roles("TEACHER")
def roster():
    course_code = require_code(request.args, "course", label="Course code") \
        if request.args.get("course") else ""
    if not course_code:
        allocations = _my_allocations()
        if not allocations:
            return ok({"roster": {}})
        course_code = allocations[0]["course_code"]

    _assert_teaches(course_code)
    data = AttendanceRepository(g.db).class_sheet(course_code)
    if not data:
        raise ValidationError("That course has no enrolled batch yet.")

    attended = sum(1 for s in data["students"] if s["percentage"] >= 75)
    at_risk = sum(1 for s in data["students"] if s["percentage"] < 65)
    data["summary"] = {
        "present_safe": attended,
        "at_risk": at_risk,
        "average": round(
            sum(s["percentage"] for s in data["students"]) / max(len(data["students"]), 1), 1
        ),
        "locked": sum(1 for s in data["students"] if s["portal_access"] == "LOCKED"),
    }
    data["slots"] = VALID_SLOTS
    return ok({"roster": data})


@bp.post("/attendance/punch")
@require_roles("TEACHER")
def punch_attendance():
    data = request.get_json(silent=True) or {}
    course_code = require_code(data, "course_code", label="Course code")
    _assert_teaches(course_code)

    session_date = require_date(data, "session_date", label="Session date")
    if session_date > date.today().isoformat():
        raise ValidationError("You cannot punch attendance for a future date.",
                              {"session_date": "future date"})

    slot = optional_text(data, "slot") or VALID_SLOTS[1]
    if slot not in VALID_SLOTS:
        raise ValidationError("Select a valid lecture slot.", {"slot": "unknown slot"})

    records = data.get("records")
    if not isinstance(records, list) or not records:
        raise ValidationError("Mark at least one student before saving.",
                              {"records": "required"})

    cleaned = []
    seen = set()
    for record in records:
        roll_no = require_code(record, "roll_no", label="Roll number")
        status = require_choice(record, "status", {"P", "A", "L"}, label="Attendance")
        if roll_no in seen:
            continue
        seen.add(roll_no)
        cleaned.append({"roll_no": roll_no, "status": status})

    repository = AttendanceRepository(g.db)
    sheet = repository.class_sheet(course_code)
    valid_rolls = {row["roll_no"] for row in sheet["students"]}
    unknown = sorted({r["roll_no"] for r in cleaned} - valid_rolls)
    if unknown:
        raise ValidationError(
            "These roll numbers are not enrolled in this course: "
            + ", ".join(unknown[:5]),
            {"records": "not enrolled"},
        )

    result = repository.punch(course_code, session_date, slot,
                              g.principal["user_code"], cleaned)

    record_event(
        action="ATTENDANCE_PUNCH",
        target=f"{course_code} / {session_date}",
        details=(
            f"{result['present_count']} PRESENT, {result['absent_count']} ABSENT, "
            f"{result['late_count']} LATE ({result['percentage']}%) — {slot}"
        ),
        principal=g.principal,
    )
    return ok({"session": result,
               "message": f"Attendance saved for {course_code} on {session_date}."}, 201)


@bp.get("/attendance/sessions")
@require_roles("TEACHER")
def sessions():
    course_code = request.args.get("course", "") or None
    if course_code:
        _assert_teaches(course_code)
    return ok({
        "sessions": AttendanceRepository(g.db).sessions(
            course_code=course_code,
            limit=clamp_int(request.args.get("limit"), 1, 100, 30),
        )
    })


@bp.get("/attendance/trend")
@require_roles("TEACHER")
def trend():
    course_code = require_code(request.args, "course", label="Course code")
    _assert_teaches(course_code)
    return ok({"trend": AttendanceRepository(g.db).course_trend(course_code)})


@bp.get("/worksheets")
@require_roles("TEACHER")
def worksheets():
    repo = WorksheetRepository(g.db)
    course_code = request.args.get("course", "") or None
    if course_code:
        _assert_teaches(course_code)

    summary = repo.teacher_summary(g.principal["user_code"])
    if course_code:
        summary["worksheets"] = [
            w for w in summary["worksheets"] if w["course_code"] == course_code.upper()
        ]

    selected = course_code or (
        summary["worksheets"][0]["course_code"] if summary["worksheets"] else None
    )
    detail = []
    if selected:
        for worksheet in summary["worksheets"]:
            if worksheet["course_code"] != selected:
                continue
            detail.append({
                **worksheet,
                "submissions": repo.submissions_for_worksheet(worksheet["worksheet_id"]),
            })

    return ok({
        "summary": summary,
        "course_code": selected,
        "detail": detail,
        "queue": repo.queue([row["course_code"] for row in _my_allocations()]),
    })


@bp.post("/worksheets")
@require_roles("TEACHER")
def create_worksheet():
    data = request.get_json(silent=True) or {}
    course_code = require_code(data, "course_code", label="Course code")
    _assert_teaches(course_code)

    title = require_text(data, "title", label="Worksheet title", max_length=240)
    batch_code = optional_text(data, "batch_code") or "CSE-2023-BATCH-A"
    max_marks = require_float(data, "max_marks", minimum=1, maximum=100,
                              label="Maximum marks")
    deadline = require_date(data, "deadline_date", label="Deadline")

    worksheet_id = WorksheetRepository(g.db).create({
        "course_code": course_code,
        "title": title,
        "batch_code": batch_code,
        "max_marks": max_marks,
        "deadline_date": f"{deadline} 23:59:00",
        "created_by": g.principal["full_name"].upper(),
    })

    record_event(
        action="WORKSHEET_PUBLISHED",
        target=f"{course_code} / {title}",
        details=f"DEADLINE {deadline}, MAX MARKS {max_marks}",
        principal=g.principal,
    )
    return ok({"worksheet_id": worksheet_id,
               "message": f"“{title}” published for {course_code}."}, 201)


@bp.post("/worksheets/<int:worksheet_id>/grade")
@require_roles("TEACHER")
def grade_submission(worksheet_id: int):
    data = request.get_json(silent=True) or {}
    repo = WorksheetRepository(g.db)
    worksheet = repo.get(worksheet_id)
    if not worksheet:
        raise ValidationError("Worksheet not found.")
    _assert_teaches(worksheet["course_code"])

    submission_id = require_int(data, "submission_id", minimum=1,
                                label="Submission reference")
    obtained = require_float(data, "obtained_marks", minimum=0,
                             maximum=float(worksheet["max_marks"]),
                             label="Obtained marks")
    remarks = optional_text(data, "remarks") or "ANSWER SCRIPT EVALUATED."

    if not repo.grade(submission_id, obtained, remarks, g.principal["full_name"].upper()):
        raise ValidationError("That submission record no longer exists.")

    record_event(
        action="WORKSHEET_GRADED",
        target=f"{worksheet['course_code']} / WS-{worksheet_id}",
        details=f"AWARDED {obtained} / {worksheet['max_marks']} — {remarks[:120]}",
        principal=g.principal,
    )
    return ok({"message": f"Recorded {obtained} / {worksheet['max_marks']}.",
               "worksheet_id": worksheet_id})


@bp.get("/marks")
@require_roles("TEACHER")
def marks_sheet():
    course_code = require_code(request.args, "course", label="Course code")
    _assert_teaches(course_code)
    rows = MarkRepository(g.db).for_course(course_code)
    graded = [r for r in rows if r["grade_letter"]]
    return ok({
        "course_code": course_code.upper(),
        "rows": rows,
        "summary": {
            "graded": len(graded),
            "ungraded": len(rows) - len(graded),
            "average": round(sum(float(r["total_marks"]) for r in graded) / len(graded), 1)
            if graded else 0.0,
            "highest": max((float(r["total_marks"]) for r in graded), default=0.0),
            "lowest": min((float(r["total_marks"]) for r in graded), default=0.0),
        },
        "maxima": {"internal": 20, "midterm": 30, "endterm": 50},
    })


@bp.post("/marks")
@require_roles("TEACHER")
def save_marks():
    data = request.get_json(silent=True) or {}
    course_code = require_code(data, "course_code", label="Course code")
    _assert_teaches(course_code)

    student_id = require_int(data, "student_id", minimum=1, label="Student reference")
    internal = require_float(data, "internal_marks", minimum=0, maximum=20,
                             label="Internal marks")
    midterm = require_float(data, "midterm_marks", minimum=0, maximum=30,
                            label="Mid-term marks")
    endterm = require_float(data, "endterm_marks", minimum=0, maximum=50,
                            label="End-term marks")

    course_id = g.db.scalar(
        "SELECT course_id FROM hpu_course WHERE course_code = ?", (course_code,)
    )
    if not course_id:
        raise ValidationError("Unknown course code.")
    enrolled = g.db.scalar(
        "SELECT COUNT(*) FROM hpu_enrollment WHERE student_id = ? AND course_id = ?",
        (student_id, course_id),
    )
    if not enrolled:
        raise ValidationError("That student is not enrolled in this course.")

    result = MarkRepository(g.db).save(
        student_id, int(course_id), internal, midterm, endterm,
        g.principal["full_name"].upper(),
    )
    record_event(
        action="COLLEGIA_MARKS_COMMITTED",
        target=f"{course_code} / STUDENT {student_id}",
        details=(f"TOTAL {result['total']} → GRADE {result['grade_letter']} "
                 f"({result['grade_point']} POINT)"),
        principal=g.principal,
    )
    return ok({"marks": result,
               "message": f"Marks committed — grade {result['grade_letter']}."})


@bp.post("/notices")
@require_roles("TEACHER")
def publish_notice():
    data = request.get_json(silent=True) or {}
    category = require_choice(
        data, "category",
        {"ACADEMIC CIRCULAR", "ASSIGNMENT", "LAB INSTRUCTIONS",
         "ATTENDANCE", "EXAM DATE SHEET", "GENERAL"},
        label="Category",
    )
    title = require_text(data, "title", label="Notice title", max_length=240)
    summary = require_text(data, "summary", label="Notice body", max_length=600)

    notice_id = ContentRepository(g.db).publish_notice(
        category, title, summary, g.principal["full_name"].upper()
    )
    record_event(
        action="NOTICE_PUBLISHED",
        target=f"{category} / {title}",
        details=summary[:200],
        principal=g.principal,
    )
    return ok({"notice_id": notice_id,
               "message": "Notice published to every portal."}, 201)


@bp.get("/analytics")
@require_roles("TEACHER")
def analytics():
    db = g.db
    allocations = _my_allocations()
    codes = [row["course_code"] for row in allocations]

    per_course = []
    for row in allocations:
        sheet = AttendanceRepository(db).class_sheet(row["course_code"])
        students = sheet["students"]
        percentages = [s["percentage"] for s in students]
        per_course.append({
            "course_code": row["course_code"],
            "course_name": row["course_name"],
            "students": len(students),
            "average_attendance": round(sum(percentages) / len(percentages), 1)
            if percentages else 0.0,
            "below_75": sum(1 for p in percentages if p < 75),
            "below_65": sum(1 for p in percentages if p < 65),
            "trend": AttendanceRepository(db).course_trend(row["course_code"]),
        })

    marks = MarkRepository(db)
    placeholders = ", ".join("?" for _ in codes) if codes else "''"
    params = codes or []

    return ok({
        "analytics": {
            "per_course": per_course,
            "grade_distribution": marks.grade_distribution(),
            "subject_performance": marks.subject_performance(),
            "toppers": marks.toppers(6),
            "defaulters": marks.defaulters(6),
            "sessions": AttendanceRepository(db).sessions(limit=14),
            "evaluation_queue": WorksheetRepository(db).queue(codes),
            "totals": {
                "students": sum(row["students"] for row in per_course),
                "below_75": sum(row["below_75"] for row in per_course),
                "below_65": sum(row["below_65"] for row in per_course),
            },
        }
    })


def _initials(name: str) -> str:
    letters = [word[0].upper() for word in str(name or "").split() if word]
    return ("".join(letters) or "FA")[:2]