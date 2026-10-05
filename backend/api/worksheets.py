"""Worksheet endpoints: student uploads and the shared template library."""

from __future__ import annotations

import os
import time

from flask import Blueprint, current_app, g, request, send_from_directory

from ..core.decorators import require_auth, require_roles
from ..core.errors import FileValidationError, NotFoundError, ValidationError
from ..core.responses import ok
from ..core.validators import require_int
from ..db.repositories.content import ContentRepository, WorksheetRepository
from ..services.audit import record_event

bp = Blueprint("worksheets", __name__, url_prefix="/api/worksheets")


def _my_student_id() -> int:
    student_id = g.db.scalar(
        "SELECT student_id FROM hpu_student WHERE roll_no = ?",
        (g.principal["user_code"],),
    )
    if not student_id:
        raise ValidationError("No student record is linked to this account.")
    return int(student_id)


@bp.get("")
@require_roles("STUDENT", "TEACHER", "ADMIN")
def list_worksheets():
    repo = WorksheetRepository(g.db)
    student_id = _my_student_id() if g.principal["role"] == "STUDENT" else None
    return ok({
        "worksheets": repo.list_worksheets(
            course_code=request.args.get("course"),
            student_id=student_id,
        ),
        "templates": ContentRepository(g.db).library(category="TEMPLATE"),
    })


@bp.post("/upload")
@require_roles("STUDENT")
def upload():
    """Accept a PDF answer script for one worksheet."""
    worksheet_id = require_int(
        request.form, "worksheet_id", minimum=1, label="Worksheet"
    )
    upload_file = request.files.get("file")
    if upload_file is None or not upload_file.filename:
        raise FileValidationError("Select a PDF file before uploading.")

    config = current_app.config
    extension = os.path.splitext(upload_file.filename)[1].lower()
    if extension not in config["ALLOWED_UPLOAD_EXTENSIONS"]:
        raise FileValidationError(
            "Only PDF submissions are accepted.",
            {"file": f"{extension or 'unknown'} rejected"},
        )

    worksheet = WorksheetRepository(g.db).get(worksheet_id)
    if not worksheet:
        raise NotFoundError("Worksheet")
    if not int(worksheet["is_active"]):
        raise ValidationError("This worksheet is no longer accepting submissions.")

    original = upload_file.filename
    raw = upload_file.read(config["MAX_UPLOAD_BYTES"] + 1)
    if len(raw) > config["MAX_UPLOAD_BYTES"]:
        raise FileValidationError(
            f"File exceeds the {config['MAX_UPLOAD_BYTES'] // (1024 * 1024)} MB limit.",
            {"file": "too large"},
        )
    if not raw.startswith(b"%PDF"):
        raise FileValidationError(
            "That file is not a readable PDF.", {"file": "invalid content"}
        )

    roll_no = g.principal["user_code"].replace("/", "-")
    stored_name = f"{roll_no}_WS{worksheet_id}_{int(time.time())}.pdf"
    target = os.path.join(config["UPLOAD_DIR"], stored_name)
    with open(target, "wb") as handle:
        handle.write(raw)

    result = WorksheetRepository(g.db).upsert_submission(
        worksheet_id, _my_student_id(), stored_name
    )

    record_event(
        action="WORKSHEET_SUBMITTED",
        target=f"{worksheet['course_code']} / {worksheet_id}",
        details=f"{original} ({len(raw):,} bytes) stored as {stored_name}",
        principal=g.principal,
    )
    return ok({
        "submission": result,
        "message": f"Answer script uploaded for {worksheet['course_code']}.",
    }, status=201)


@bp.get("/<int:worksheet_id>/mine")
@require_roles("STUDENT")
def my_submission(worksheet_id: int):
    submission = WorksheetRepository(g.db).submission(worksheet_id, _my_student_id())
    return ok({"submission": submission})


@bp.get("/<int:worksheet_id>/download/<path:stored_name>")
@require_auth
def download_submission(worksheet_id: int, stored_name: str):
    """Serve an answer script, but only to its owner or the evaluating staff."""
    if g.principal["role"] == "STUDENT":
        submission = WorksheetRepository(g.db).submission(worksheet_id, _my_student_id())
        if not submission or submission["submitted_file"] != stored_name:
            raise NotFoundError("Submission")
    return send_from_directory(
        current_app.config["UPLOAD_DIR"], stored_name, as_attachment=True
    )