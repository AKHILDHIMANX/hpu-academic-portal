"""Access-control decorators.

The role is always read from the signed token that the server issued -- never
from the request body, query string or a header the browser controls. That is
the fix for the original flaw where the client posted ``role`` and the server
used it to decide which credential set to verify.
"""

from __future__ import annotations

import functools
import time
from datetime import datetime, timedelta

from flask import current_app, g, request

from .errors import AuthenticationError, AuthorizationError, RateLimitError
from .security import (
    TokenError,
    decode_jwt,
    is_valid_csrf,
    login_limiter,
    write_limiter,
)


def client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:60]
    return (request.remote_addr or "127.0.0.1")[:60]


def _token_from_request() -> str | None:
    # 1. HttpOnly cookie (same-origin browser sessions -- preferred)
    cookie = request.cookies.get(current_app.config["COOKIE_NAME"])
    if cookie:
        return cookie
    # 2. Authorization: Bearer (curl / API clients / Postman during a viva)
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def current_principal() -> dict | None:
    return getattr(g, "principal", None)


def load_principal() -> dict:
    """Resolve, verify and register the caller's identity. Raises if invalid."""
    from ..db.repositories.users import UserRepository

    token = _token_from_request()
    if not token:
        raise AuthenticationError("Sign in to continue.")

    try:
        claims = decode_jwt(token, current_app.config["SECRET_KEY"])
    except TokenError as exc:
        raise AuthenticationError(f"Your session is no longer valid ({exc}).") from exc

    db = g.db
    users = UserRepository(db)
    user = users.find_by_code(claims.get("sub", ""))
    if not user:
        raise AuthenticationError("The account linked to this session no longer exists.")
    if not int(user.get("is_active", 1)):
        raise AuthenticationError("This account has been deactivated.")
    if int(user.get("token_version", 1)) != int(claims.get("tv", 1)):
        raise AuthenticationError("Session invalidated. Please sign in again.")
    if not users.is_session_active(claims.get("jti", ""), claims["sub"]):
        raise AuthenticationError("Your session has expired or was signed out.")

    return {
        "user_code": user["user_code"],
        "role": user["role"],
        "full_name": user["full_name"],
        "email": user["email"],
        "token_version": int(user["token_version"]),
        "jti": claims.get("jti", ""),
        "claims": claims,
    }


def require_auth(view):
    """Reject anonymous callers. Also enforces CSRF + write rate limits."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if not is_valid_csrf(request, current_app.config):
                from .errors import ApiError

                raise ApiError(
                    "Missing or invalid request signature header.",
                    code="CSRF_FAILED",
                    status_code=403,
                )
            allowed, _, retry_after = write_limiter.check(client_ip())
            if not allowed:
                raise RateLimitError(retry_after)

        g.principal = load_principal()
        return view(*args, **kwargs)

    return wrapper


def require_roles(*roles):
    """Restrict an endpoint to one or more roles."""
    allowed = {r.upper() for r in roles}

    def decorator(view):
        @functools.wraps(view)
        @require_auth
        def wrapper(*args, **kwargs):
            principal = current_principal()
            if principal["role"] not in allowed:
                from .errors import ApiError
                from ..services.audit import record_event

                record_event(
                    action="ACCESS_DENIED",
                    target=f"{request.method} {request.path}",
                    details=(
                        f"{principal['role']} ROLE ATTEMPTED AN OPERATION RESERVED FOR "
                        f"{'/'.join(sorted(allowed))}"
                    ),
                    severity="SECURITY",
                    principal=principal,
                )
                raise AuthorizationError(
                    "This area is restricted to "
                    f"{', '.join(r.title() for r in sorted(allowed))} accounts."
                )
            return view(*args, **kwargs)

        return wrapper

    return decorator


def audit(action: str, *, severity: str = "INFO"):
    """Record an audit entry after a successful mutating call."""

    def decorator(view):
        @functools.wraps(view)
        def wrapper(*args, **kwargs):
            result = view(*args, **kwargs)
            from ..services.audit import record_event

            record_event(
                action=action,
                target=kwargs.get("identifier") or request.path,
                details=f"{request.method} {request.path}",
                severity=severity,
                principal=current_principal(),
            )
            return result

        return wrapper

    return decorator


def enforce_rate_limit(key: str, *, limit: int = 12, window: int = 300):
    """Sliding-window guard used by the login endpoint."""

    def decorator(view):
        @functools.wraps(view)
        def wrapper(*args, **kwargs):
            allowed, _, retry_after = login_limiter.check(key)
            if not allowed:
                raise RateLimitError(retry_after)
            return view(*args, **kwargs)

        return decorator

    return decorator