"""File delivery for seeded assets and uploaded answer scripts."""

from __future__ import annotations

import os

from flask import Blueprint, current_app, g, request, send_from_directory

from ..core.decorators import require_auth
from ..core.errors import NotFoundError, ValidationError
from ..core.responses import ok
from ..db.repositories.content import ContentRepository
from ..services.audit import record_event

bp = Blueprint("files", __name__, url_prefix="/api/files")


def _safe(name: str) -> str:
    """Reject any attempt to escape the assets directory."""
    cleaned = os.path.basename((name or "").strip())
    if not cleaned or cleaned in (".", ".."):
        raise ValidationError("Invalid file reference.")
    return cleaned


@bp.get("/library/<path:name>")
@require_auth
def library_file(name: str):
    filename = _safe(name)
    directory = current_app.config["ASSET_FILE_DIR"]
    if not os.path.isfile(os.path.join(directory, filename)):
        raise NotFoundError("File")
    return send_from_directory(directory, filename, as_attachment=False)


@bp.get("/download/<path:name>")
@require_auth
def download(name: str):
    filename = _safe(name)
    directory = current_app.config["ASSET_FILE_DIR"]
    if not os.path.isfile(os.path.join(directory, filename)):
        raise NotFoundError("File")
    return send_from_directory(directory, filename, as_attachment=True)


@bp.post("/pyq/<int:paper_id>/download")
@require_auth
def pyq_download(paper_id: int):
    paper = g.db.query_one(
        "SELECT paper_id, course_code, subject_name, year, file_url "
        "FROM hpu_pyq_paper WHERE paper_id = ?",
        (paper_id,),
    )
    if not paper:
        raise NotFoundError("Question paper")

    ContentRepository(g.db).increment_download(paper_id)
    record_event(
        action="PYQ_DOWNLOADED",
        target=f"{paper['course_code']} / {paper['year']}",
        details=f"{paper['subject_name']}",
        principal=g.principal,
    )
    directory = current_app.config["ASSET_FILE_DIR"]
    filename = _safe(paper["file_url"])
    if not os.path.isfile(os.path.join(directory, filename)):
        raise NotFoundError("Question paper file")
    return send_from_directory(directory, filename, as_attachment=True)


@bp.get("/manifest")
@require_auth
def manifest():
    """Which seeded assets actually exist on disk (used by the UI)."""
    directory = current_app.config["ASSET_FILE_DIR"]
    available = {}
    if os.path.isdir(directory):
        available = {
            name: os.path.getsize(os.path.join(directory, name))
            for name in sorted(os.listdir(directory))
            if os.path.isfile(os.path.join(directory, name))
        }
    return ok({"assets": available})