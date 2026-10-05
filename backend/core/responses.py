"""Uniform JSON response helpers so every endpoint answers the same shape."""

from __future__ import annotations

from flask import jsonify

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def ok(payload: dict | None = None, status: int = 200, **extra):
    """Build a real Response object so callers can still set cookies/headers."""
    body = {"ok": True}
    if payload:
        body.update(payload)
    body.update(extra)
    response = jsonify(body)
    response.status_code = status
    return response


def created(payload: dict | None = None, **extra):
    return ok(payload, status=201, **extra)


def fail(message: str, error: str = "BAD_REQUEST", status: int = 400, **extra):
    body = {"ok": False, "error": error, "message": message}
    body.update(extra)
    return jsonify(body), status