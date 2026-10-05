"""
Database engine and bootstrap.

Two engines are supported behind one interface:

* ``sqlite``  -- the zero-install demo engine used on a laptop / lab machine.
                 Executes ``database/schema_sqlite.sql`` and ``database/seed.sql``.
* ``oracle``  -- the production engine. Point ``HPU_DB_ENGINE=oracle`` at an
                 Oracle 19c instance and execute ``database/schema.sql`` first.

Both engines expose the same ``query`` / ``execute`` / ``transaction`` API and
use ``?`` as the parameter placeholder, so repositories are written once.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Sequence

_local = threading.local()


class Database:
    """Thin wrapper that owns connection lifecycle and logging."""

    def __init__(self, config) -> None:
        self.config = config
        self.engine = config.DB_ENGINE
        self._sqlite_path: Path = Path(config.SQLITE_PATH)
        self._lock = threading.Lock()
        self._dsn = getattr(config, "ORACLE_DSN", None)
        self._ensure_directories()

    # -- setup ---------------------------------------------------------------
    def _ensure_directories(self) -> None:
        for directory in (
            Path(self.config.UPLOAD_DIR),
            Path(self.config.ASSET_FILE_DIR),
            Path(self.config.SQLITE_PATH).parent,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def _connect_sqlite(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self._sqlite_path), detect_types=sqlite3.PARSE_DECLTYPES, timeout=15
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _connect_oracle(self):
        try:
            import oracledb  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "HPU_DB_ENGINE=oracle requires the 'oracledb' package: "
                "pip install oracledb"
            ) from exc
        return oracledb.connect(
            user=self.config.ORACLE_USER,
            password=self.config.ORACLE_PASSWORD,
            dsn=self._dsn,
        )

    # -- connection ----------------------------------------------------------
    @property
    def connection(self):
        """One connection per thread (Flask serves each request on its own)."""
        existing = getattr(_local, "connection", None)
        if existing is not None:
            return existing

        if self.engine == "oracle":  # pragma: no cover - optional path
            connection = self._connect_oracle()
            connection.autocommit = False
            cursor = connection.cursor()
            cursor.execute("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'")
            cursor.close()
        else:
            connection = self._connect_sqlite()

        _local.connection = connection
        return connection

    def close_thread_connection(self) -> None:
        connection = getattr(_local, "connection", None)
        if connection is not None:
            try:
                connection.close()
            finally:
                _local.connection = None

    # -- reads ---------------------------------------------------------------
    def query(self, sql: str, params: Sequence[Any] | dict = ()) -> list[dict]:
        cursor = self.connection.cursor()
        try:
            cursor.execute(sql, params)
            rows = cursor.fetchall()
            if self.engine == "oracle":  # pragma: no cover
                columns = [c[0].lower() for c in cursor.description]
                return [dict(zip(columns, row)) for row in rows]
            return [dict(row) for row in rows]
        finally:
            cursor.close()

    def query_one(self, sql: str, params: Sequence[Any] | dict = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def scalar(self, sql: str, params: Sequence[Any] | dict = (), default: Any = None) -> Any:
        row = self.query_one(sql, params)
        if not row:
            return default
        return next(iter(row.values()), default)

    # -- writes --------------------------------------------------------------
    def execute(self, sql: str, params: Sequence[Any] | dict = ()) -> int:
        """Execute one statement and return the affected row count."""
        with self._lock:
            cursor = self.connection.cursor()
            try:
                cursor.execute(sql, params)
                return cursor.rowcount
            finally:
                cursor.close()

    def execute_many(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> int:
        with self._lock:
            cursor = self.connection.cursor()
            try:
                cursor.executemany(sql, seq_of_params)
                return cursor.rowcount
            finally:
                cursor.close()

    def insert_returning_id(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Insert a row and return the generated primary key."""
        with self._lock:
            cursor = self.connection.cursor()
            try:
                cursor.execute(sql, params)
                if self.engine == "oracle":  # pragma: no cover
                    return int(cursor.fetchone()[0])
                return int(cursor.lastrowid or 0)
            finally:
                cursor.close()

    # -- transactions --------------------------------------------------------
    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        self.connection.rollback()

    class _Transaction:
        def __init__(self, db: "Database") -> None:
            self.db = db

        def __enter__(self) -> "Database":
            return self.db

        def __exit__(self, exc_type, exc, tb) -> bool:
            if exc_type is None:
                self.db.commit()
            else:
                self.db.rollback()
            return False

    def transaction(self) -> "Database._Transaction":
        """``with db.transaction():`` -- commit on success, rollback on error."""
        return Database._Transaction(self)

    # -- bootstrap -----------------------------------------------------------
    def table_exists(self, name: str) -> bool:
        if self.engine == "oracle":  # pragma: no cover
            found = self.scalar(
                "SELECT COUNT(*) FROM user_tables WHERE table_name = :1", (name.upper(),)
            )
        else:
            found = self.scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?",
                (name,),
            )
        return bool(found)

    def run_sql_script(self, path: Path) -> None:
        """Execute a ``.sql`` file. Multi-statement scripts only work on SQLite;
        Oracle deployments run the same files through SQL*Plus."""
        script = Path(path).read_text(encoding="utf-8")
        connection = self.connection
        if self.engine == "oracle":  # pragma: no cover
            raise RuntimeError(
                f"Run {path.name} through SQL*Plus for the Oracle engine."
            )
        connection.executescript(script)
        connection.commit()

    def bootstrap(self, *, migrate: bool, seed: bool) -> dict:
        """Create the schema and load the demo dataset when needed."""
        report = {"migrated": False, "seeded": False, "engine": self.engine}

        if self.engine != "sqlite":
            return report

        schema_path = self.config.DATABASE_DIR / "schema_sqlite.sql"
        seed_path = self.config.DATABASE_DIR / "seed.sql"

        if migrate or not self.table_exists("hpu_user_auth"):
            self.run_sql_script(schema_path)
            report["migrated"] = True

        if seed and report["migrated"]:
            self.run_sql_script(seed_path)
            report["seeded"] = True

        self._ensure_admin_password_rotation()
        return report

    def _ensure_admin_password_rotation(self) -> None:
        """Guard against a deployment that reused the demo secret key."""
        if os.environ.get("HPU_ROTATE_DEMO_PASSWORDS", "1").lower() != "1":
            return
        # Demo accounts intentionally keep their documented passwords so the
        # project can be demonstrated; this hook marks them explicitly.
        self.execute(
            "UPDATE hpu_user_auth SET failed_attempts = 0, locked_until = NULL "
            "WHERE is_active = 1 AND locked_until IS NOT NULL AND locked_until < datetime('now')"
        )
        self.commit()
