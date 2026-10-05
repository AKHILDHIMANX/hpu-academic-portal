"""Read-only academic endpoints shared by all three portals."""

from __future__ import annotations

from flask import Blueprint, g, request

from ..core.decorators import require_auth
from ..core.responses import ok
from ..core.validators import clamp_int
from ..db.repositories.academic import CourseRepository, StudentRepository, TeacherRepository
from ..db.repositories.content import ContentRepository

bp = Blueprint("academic", __name__, url_prefix="/api")


@bp.get("/courses")
@require_auth
def courses():
    return ok({"courses": CourseRepository(g.db).list_all()})


@bp.get("/courses/<course_code>")
@require_auth
def course_detail(course_code: str):
    course = CourseRepository(g.db).get_by_code(course_code)
    if not course:
        return ok({"course": None})
    return ok({"course": course})


@bp.get("/pyq")
@require_auth
def pyq():
    repo = ContentRepository(g.db)
    return ok({
        "papers": repo.pyq_papers(
            course_code=request.args.get("course", ""),
            search=request.args.get("q", ""),
        )
    })


@bp.get("/elibrary")
@require_auth
def elibrary():
    repo = ContentRepository(g.db)
    return ok({
        "items": repo.library(
            category=request.args.get("category", ""),
            subject=request.args.get("subject", ""),
            search=request.args.get("q", ""),
        ),
        "facets": repo.library_facets(),
    })


@bp.get("/notices")
@require_auth
def notices():
    repo = ContentRepository(g.db)
    return ok({
        "notices": repo.notices(
            limit=clamp_int(request.args.get("limit"), 1, 200, 50),
            category=request.args.get("category", ""),
        ),
        "categories": repo.notice_categories(),
    })


@bp.get("/datesheet")
@require_auth
def datesheet():
    return ok({"datesheet": ContentRepository(g.db).datesheet()})


@bp.get("/faculty")
@require_auth
def faculty():
    return ok({"faculty": TeacherRepository(g.db).directory()})


@bp.get("/grade-scale")
@require_auth
def grade_scale():
    rows = g.db.query(
        "SELECT grade_letter, min_percent, max_percent, grade_point, classification "
        "FROM hpu_grade_scale ORDER BY min_percent DESC"
    )
    return ok({"scale": rows, "attendance_threshold": 75})


@bp.get("/notifications")
@require_auth
def notifications():
    principal = g.principal
    return ok({"notifications": ContentRepository(g.db).notifications(principal)})


@bp.get("/student/<roll_no>/public")
@require_auth
def public_student_card(roll_no: str):
    """A read-only identity card for a classmate (used by the faculty roster)."""
    profile = StudentRepository(g.db).profile(roll_no)
    if not profile:
        return ok({"student": None})
    profile.pop("email", None)
    return ok({"student": profile})