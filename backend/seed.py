"""
CLI entry point for managing the portal database.

    python backend/seed.py --status     # report what is loaded
    python backend/seed.py --reset      # drop, recreate and reload everything
    python backend/seed.py --hash admin123
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR.parent))

from backend.config import load_config          # noqa: E402
from backend.core.security import hash_password  # noqa: E402
from backend.db import Database                 # noqa: E402


def report(database: Database) -> None:
    tables = [
        ("hpu_student", "students"),
        ("hpu_teacher", "faculty"),
        ("hpu_course", "courses"),
        ("hpu_enrollment", "enrollments"),
        ("hpu_attendance", "attendance rows"),
        ("hpu_mark", "marks rows"),
        ("hpu_worksheet", "worksheets"),
        ("hpu_worksheet_submission", "submissions"),
        ("hpu_pyq_paper", "PYQ papers"),
        ("hpu_e_library", "library items"),
        ("hpu_notice", "notices"),
        ("hpu_audit_log", "audit entries"),
        ("hpu_auth_session", "auth sessions"),
    ]
    print(f"engine  : {database.engine}")
    print(f"location: {getattr(database.config, 'SQLITE_PATH', '-')}")
    print("-" * 44)
    for table, label in tables:
        if not database.table_exists(table):
            print(f"  {label:<18} (table absent)")
            continue
        count = database.scalar(f"SELECT COUNT(*) FROM {table}", default=0)
        print(f"  {label:<18} {int(count or 0):>8}")
    print("-" * 44)
    print("ok" if database.table_exists("hpu_student") else "not initialised")


def main() -> int:
    parser = argparse.ArgumentParser(description="HPU portal database utility")
    parser.add_argument("--reset", action="store_true",
                        help="drop and rebuild the schema, then reload the seed data")
    parser.add_argument("--status", action="store_true",
                        help="print a table census (default)")
    parser.add_argument("--hash", metavar="PASSWORD",
                        help="print a PBKDF2 hash + salt for a new password")
    args = parser.parse_args()

    config = load_config()
    database = Database(config)

    if args.hash:
        rounds = config.PBKDF2_ROUNDS
        digest, salt = hash_password(args.hash, rounds=rounds)
        print(f"rounds : {rounds}")
        print(f"salt   : {salt}")
        print(f"hash   : {digest}")
        return 0

    if args.reset:
        if getattr(database, "engine", "sqlite") == "sqlite":
            path = Path(config.SQLITE_PATH)
            if path.exists():
                path.unlink()
                for suffix in ("-wal", "-shm"):
                    extra = Path(str(path) + suffix)
                    if extra.exists():
                        extra.unlink()
                print(f"removed {path}")
        bootstrap = database.bootstrap(migrate=True, seed=True)
        print(f"migrated={bootstrap['migrated']}  seeded={bootstrap['seeded']}")

    report(database)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())