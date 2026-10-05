#!/usr/bin/env python3
"""WSGI entry point for production servers.

    gunicorn --workers 4 --threads 2 'backend.wsgi:application'
    uwsgi --http :5050 --module backend.wsgi:application
"""

from __future__ import annotations

from backend.app import app as application

__all__ = ["application"]

if __name__ == "__main__":
    application.run()