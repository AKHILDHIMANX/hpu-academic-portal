#!/usr/bin/env python3
"""
HPU Academic Portal -- application entry point.

Run it:

    pip install -r backend/requirements.txt
    python backend/app.py

Then open http://127.0.0.1:5050

The Flask process serves BOTH the JSON API and the static frontend, which puts
the browser on the same origin as the API. That is what allows the session
token to live in an httpOnly cookie (unreadable by JavaScript) instead of
localStorage, where any XSS payload could steal it.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

# Make `backend` importable when this file is executed directly.
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR.parent))

from flask import Flask, g, jsonify, redirect, request, send_from_directory  # noqa: E402

from backend.api import BLUEPRINTS  # noqa: E402
from backend.config import load_config  # noqa: E402
from backend.core.decorators import load_principal  # noqa: E402
from backend.core.errors import register_error_handlers  # noqa: E402
from backend.core.security import login_limiter, write_limiter  # noqa: E402
from backend.db import Database  # noqa: E402

logger = logging.getLogger("hpu")

PORTAL_HOME = {
    "STUDENT": "index.html",
    "TEACHER": "teacher.html",
    "ADMIN": "admin.html",
}

PAGE_FOR_ROLE = {
    "/": "STUDENT",
    "/teacher": "TEACHER",
    "/admin": "ADMIN",
}


def create_app(config=None) -> Flask:
    config = config or load_config()

    app = Flask(
        __name__,
        static_folder=None,          # we mount our own routes for full control
    )
    app.config.from_object(config)

    database = Database(config)
    app.extensions["hpu_db"] = database

    bootstrap = database.bootstrap(
        migrate=app.config["AUTO_MIGRATE"], seed=app.config["AUTO_SEED"]
    )
    if bootstrap["migrated"]:
        logger.info("Schema created from database/schema_sqlite.sql")
    if bootstrap["seeded"]:
        logger.info("Demo dataset loaded from database/seed.sql")
    app.extensions["hpu_bootstrap"] = bootstrap

    # ---------------------------------------------------------------- hooks
    @app.before_request
    def _open_connection() -> None:
        g.db = database

    @app.teardown_appcontext
    def _close_connection(_exc) -> None:
        g.pop("db", None)

    # -------------------------------------------------------------- security
    @app.after_request
    def _security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com "
            "https://cdn.jsdelivr.net; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data: blob:; "
            "connect-src 'self'; "
            "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
        )
        if app.config["COOKIE_SECURE"]:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response

    @app.before_request
    def _sweep_rate_limiters() -> None:
        if request.path == "/api/auth/login":
            login_limiter.prune()
        write_limiter.prune()

    register_error_handlers(app)

    for blueprint in BLUEPRINTS:
        app.register_blueprint(blueprint)

    # ---------------------------------------------------------------- health
    @app.get("/api/health")
    def health():
        db = g.db
        counts = {
            table: int(db.scalar(f"SELECT COUNT(*) FROM {table}", default=0) or 0)
            for table in (
                "hpu_student", "hpu_teacher", "hpu_course", "hpu_attendance",
                "hpu_mark", "hpu_worksheet", "hpu_worksheet_submission",
                "hpu_audit_log",
            )
        }
        return jsonify({
            "ok": True,
            "service": "hpu-academic-portal",
            "database": {"engine": db.engine, "seeded": bootstrap["seeded"],
                         "migrated": bootstrap["migrated"]},
            "counts": counts,
        })

    @app.get("/api")
    def api_index():
        return jsonify({
            "ok": True,
            "service": "HPU Academic Portal API",
            "documentation": "See backend/api/*.py for the full endpoint map.",
            "endpoints": sorted(
                f"{sorted(r.methods - {'HEAD', 'OPTIONS'})[0]} {r.rule}"
                for r in app.url_map.iter_rules() if r.rule.startswith("/api")
            ),
        })

    # ----------------------------------------------------------- frontend
    frontend = Path(app.config["FRONTEND_DIR"])

    def _serve_page(filename: str):
        return send_from_directory(frontend, filename)

    @app.get("/login")
    def login_page():
        try:
            principal = load_principal()
        except Exception:
            principal = None
        if principal:
            return redirect(PORTAL_HOME[principal["role"]], code=302)
        return _serve_page("login.html")

    @app.get("/")
    @app.get("/index.html")
    def student_portal():
        return _guard("STUDENT", "index.html")

    @app.get("/teacher")
    @app.get("/teacher.html")
    def teacher_portal():
        return _guard("TEACHER", "teacher.html")

    @app.get("/admin")
    @app.get("/admin.html")
    def admin_portal():
        return _guard("ADMIN", "admin.html")

    def _guard(required_role: str, filename: str):
        """Server-side page gate -- the JS guard is defence in depth, not the lock."""
        try:
            principal = load_principal()
        except Exception:
            principal = None

        if principal is None:
            if request.path.startswith("/api"):
                return jsonify({"ok": False, "error": "UNAUTHENTICATED",
                                "message": "Sign in to continue."}), 401
            return redirect(f"/login?next={request.path}", code=302)

        if principal["role"] != required_role:
            if request.path.startswith("/api"):
                return jsonify({
                    "ok": False, "error": "FORBIDDEN",
                    "message": "This portal is reserved for another role.",
                }), 403
            return redirect(PORTAL_HOME[principal["role"]], code=302)

        return _serve_page(filename)

    @app.get("/assets/<path:subpath>")
    def frontend_assets(subpath: str):
        return send_from_directory(frontend / "assets", subpath)

    @app.get("/media/<path:subpath>")
    def frontend_media(subpath: str):
        return send_from_directory(frontend, subpath)

    @app.get("/favicon.ico")
    def favicon():
        candidate = frontend / "hpu-logo.png"
        if candidate.is_file():
            return send_from_directory(frontend, "hpu-logo.png")
        return ("", 404)

    @app.errorhandler(404)
    def _page_not_found(_exc):
        if request.path.startswith("/api"):
            return jsonify({"ok": False, "error": "NOT_FOUND",
                            "message": "Unknown endpoint."}), 404
        custom = frontend / "404.html"
        if custom.is_file():
            response = send_from_directory(frontend, "404.html")
            response.status_code = 404
            return response
        return ("Not found", 404)

    return app


app = create_app()


if __name__ == "__main__":
    config = app.config
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    banner = f"""
╭──────────────────────────────────────────────────────────────╮
│  HIMACHAL PRADESH UNIVERSITY · ACADEMIC PORTAL               │
│  Flask · SQLite/Oracle · Vanilla HTML/CSS/JS                  │
├──────────────────────────────────────────────────────────────┤
│  Sign in at   http://127.0.0.1:{config['PORT']:<5}                 │
│  Engine       {config['DB_ENGINE']:<10} ({config['SQLITE_PATH'].name})     │
│  Seeded       {str(app.extensions['hpu_bootstrap']['seeded']):<10}                      │
├──────────────────────────────────────────────────────────────┤
│  student   akhil.dhiman@hpu.ac.in   /  student123            │
│  faculty   prof.rsthakur@hpu.ac.in  /  teacher123            │
│  admin     admin@hpu.ac.in          /  admin123              │
╰──────────────────────────────────────────────────────────────╯
"""
    print(banner)
    app.run(host=config["HOST"], port=config["PORT"], debug=config["DEBUG"],
            threaded=True)