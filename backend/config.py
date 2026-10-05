"""
HPU Academic Portal -- application configuration.

Every setting can be overridden through environment variables so the same code
runs unchanged on a laptop, a lab machine and the Oracle production cluster.
"""

from __future__ import annotations

import os
from pathlib import Path

# Project root = .../hpulms
ROOT_DIR = Path(__file__).resolve().parent.parent
DATABASE_DIR = ROOT_DIR / "database"
FRONTEND_DIR = ROOT_DIR / "frontend"
BACKEND_DIR = ROOT_DIR / "backend"


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    """Base configuration -- safe defaults for local development."""

    # -- Flask ---------------------------------------------------------------
    SECRET_KEY = os.environ.get(
        "HPU_SECRET_KEY", "hpu-academic-portal-dev-key-change-in-production"
    )
    JSON_SORT_KEYS = False

    # -- Server --------------------------------------------------------------
    HOST = os.environ.get("HPU_HOST", "127.0.0.1")
    PORT = int(os.environ.get("HPU_PORT", os.environ.get("PORT", "5050")))
    DEBUG = _as_bool(os.environ.get("HPU_DEBUG"), not bool(os.environ.get("VERCEL")))

    # -- Storage paths -------------------------------------------------------
    ROOT_DIR = ROOT_DIR
    DATABASE_DIR = DATABASE_DIR
    FRONTEND_DIR = FRONTEND_DIR
    BACKEND_DIR = BACKEND_DIR
    UPLOAD_DIR = Path(
        os.environ.get(
            "HPU_UPLOAD_DIR",
            "/tmp/hpu_uploads" if os.environ.get("VERCEL") else BACKEND_DIR / "uploads",
        )
    )
    ASSET_FILE_DIR = Path(
        os.environ.get("HPU_ASSET_DIR", BACKEND_DIR / "assets" / "files")
    )

    # -- Database engine -----------------------------------------------------
    # "sqlite"  -> zero-install demo engine, executes database/schema_sqlite.sql
    # "oracle"   -> production engine, requires the `oracledb` package + DSN
    DB_ENGINE = os.environ.get("HPU_DB_ENGINE", "sqlite").strip().lower()
    SQLITE_PATH = Path(
        os.environ.get(
            "HPU_SQLITE_PATH",
            "/tmp/hpu_portal.sqlite3"
            if os.environ.get("VERCEL")
            else BACKEND_DIR / "data" / "hpu_portal.sqlite3",
        )
    )
    ORACLE_USER = os.environ.get("HPU_ORACLE_USER", "hpu")
    ORACLE_PASSWORD = os.environ.get("HPU_ORACLE_PASSWORD", "")
    ORACLE_DSN = os.environ.get("HPU_ORACLE_DSN", "127.0.0.1:1521/XEPDB1")
    AUTO_MIGRATE = _as_bool(os.environ.get("HPU_AUTO_MIGRATE"), True)
    AUTO_SEED = _as_bool(os.environ.get("HPU_AUTO_SEED"), True)

    # -- Authentication ------------------------------------------------------
    TOKEN_TTL_SECONDS = int(os.environ.get("HPU_TOKEN_TTL", str(60 * 60 * 8)))
    COOKIE_NAME = "hpu_session"
    COOKIE_SECURE = _as_bool(
        os.environ.get("HPU_COOKIE_SECURE"), bool(os.environ.get("VERCEL"))
    )
    COOKIE_SAMESITE = os.environ.get("HPU_COOKIE_SAMESITE", "Lax")
    CSRF_HEADER = "X-HPU-REQUEST"
    CSRF_VALUE = "hpu-portal"
    PBKDF2_ROUNDS = int(os.environ.get("HPU_PBKDF2_ROUNDS", "240000"))
    MAX_FAILED_LOGINS = 5
    LOCKOUT_MINUTES = 10
    MAX_UPLOAD_BYTES = int(os.environ.get("HPU_MAX_UPLOAD_MB", "8")) * 1024 * 1024
    ALLOWED_UPLOAD_EXTENSIONS = {".pdf"}

    # -- CORS (only needed when the frontend is served by a separate server) --
    CORS_ORIGINS = [
        o.strip()
        for o in os.environ.get("HPU_CORS_ORIGINS", "").split(",")
        if o.strip()
    ]

    # -- Pagination ----------------------------------------------------------
    DEFAULT_PAGE_SIZE = 25
    MAX_PAGE_SIZE = 200

    @classmethod
    def as_dict(cls) -> dict:
        return {
            k: v
            for k, v in vars(cls).items()
            if k.isupper() and not k.startswith("_")
        }


class ProductionConfig(Config):
    """Hardened overrides used when HPU_ENV=production."""

    DEBUG = False
    COOKIE_SECURE = True
    AUTO_SEED = False
    DB_ENGINE = "oracle"


def load_config() -> type[Config]:
    env = os.environ.get("HPU_ENV", "development").strip().lower()
    return ProductionConfig if env == "production" else Config
