"""Vercel serverless entry point for the HPU Academic Portal.

Vercel's Python runtime imports ``app`` from this module and adapts Flask to
serverless invocations. It also picks up dependencies from the repository
root ``requirements.txt``.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_SRC = ROOT / "backend"
for path in (str(ROOT), str(BACKEND_SRC)):
    if path not in sys.path:
        sys.path.insert(0, path)

from app import app  # noqa: E402 -- backend/app.py

__all__ = ["app"]
