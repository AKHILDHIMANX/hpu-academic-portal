"""Authentication endpoints.

Security model
--------------
* The client sends only ``identifier`` + ``password``. The role is looked up
  server-side, so a browser cannot ask to become an administrator.
* Passwords are PBKDF2-HMAC-SHA256 (240k rounds) with a per-user salt.
* On success an HS256 JWT is minted and stored in an httpOnly, SameSite=Lax
  cookie *and* registered in ``hpu_auth_session``, so logout genuinely revokes
  the token server-side instead of merely clearing client state.
"""

from __future__ import annotations

from flask import Blueprint, current_app, g, request

from ..core.decorators import client_ip, require_auth
from ..core.errors import AuthenticationError, RateLimitError, ValidationError
from ..core.responses import ok
from ..core.security import login_limiter
from ..core.validators import require_text
from ..db.repositories.users import UserRepository, authenticate
from ..services.audit import record_event

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

DEMO_ACCOUNTS = [
    {
        "role": "STUDENT",
        "label": "Student Portal",
        "identifier": "akhil.dhiman@hpu.ac.in",
        "password": "student123",
        "name": "Akhil Dhiman",
        "hint": "HPU-CS-2023-882 · Semester VI, CSE",
    },
    {
        "role": "TEACHER",
        "label": "Faculty Portal",
        "identifier": "prof.rsthakur@hpu.ac.in",
        "password": "teacher123",
        "name": "Prof. R.S. Thakur",
        "hint": "F-CS-02 · Chief Examiner, CSE",
    },
    {
        "role": "ADMIN",
        "label": "Admin Console",
        "identifier": "admin@hpu.ac.in",
        "password": "admin123",
        "name": "System Administrator",
        "hint": "ADMIN · Examination & Records",
    },
]

PORTAL_FOR_ROLE = {"STUDENT": "/", "TEACHER": "/teacher", "ADMIN": "/admin"}


def _issue_session(user: dict):
    """Mint the JWT and register its jti so logout can revoke it server-side."""
    users = UserRepository(g.db)
    token, claims = users.issue_token(user, current_app.config)
    # Refresh the registration row with the real client fingerprint.
    g.db.execute(
        "UPDATE hpu_auth_session SET user_agent = ?, ip_address = ? WHERE session_id = ?",
        (request.headers.get("User-Agent", "")[:200], client_ip(), claims["jti"]),
    )
    g.db.commit()
    profile = users.public_profile(user["user_code"])
    return token, claims, profile


@bp.get("/demo-accounts")
def demo_accounts():
    """Advertised demo identities so the sign-in screen can offer quick access."""
    return ok({"accounts": DEMO_ACCOUNTS})


@bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    identifier = require_text(data, "identifier", label="Email or roll number", max_length=120)
    password = require_text(data, "password", label="Password", max_length=200, min_length=4)

    ip = client_ip()
    allowed, _, retry_after = login_limiter.check(f"login:{ip}")
    if not allowed:
        raise RateLimitError(retry_after)

    user = authenticate(g.db, identifier, password, current_app.config)

    # Password is correct -> clear the per-IP throttle for this client.
    login_limiter.reset(f"login:{ip}")

    token, claims, profile = _issue_session(user)

    response = ok({
        "user": profile,
        "claims": {
            "sub": claims["sub"], "role": claims["role"], "name": claims["name"],
            "iat": claims["iat"], "exp": claims["exp"], "jti": claims["jti"],
        },
        "portal": PORTAL_FOR_ROLE.get(user["role"], "/"),
        "expires_in": current_app.config["TOKEN_TTL_SECONDS"],
    })

    config = current_app.config
    response.set_cookie(
        config["COOKIE_NAME"],
        token,
        max_age=config["TOKEN_TTL_SECONDS"],
        httponly=True,           # unreadable from JavaScript -> blunts XSS theft
        secure=config["COOKIE_SECURE"],
        samesite=config["COOKIE_SAMESITE"],
        path="/",
    )
    # Readable mirror for the "inspected token" panel in the admin console.
    response.set_cookie("hpu_session_readable", token, max_age=config["TOKEN_TTL_SECONDS"],
                        httponly=False, secure=config["COOKIE_SECURE"],
                        samesite=config["COOKIE_SAMESITE"], path="/")

    record_event(
        action="LOGIN_SUCCESS",
        target=user["user_code"],
        details=f"{user['role']} SESSION ESTABLISHED FROM {ip}",
        principal={"role": user["role"], "full_name": user["full_name"],
                   "user_code": user["user_code"]},
    )
    return response


@bp.post("/logout")
@require_auth
def logout():
    principal = g.principal
    users = UserRepository(g.db)
    users.revoke_session(principal["jti"])

    record_event(
        action="LOGOUT",
        target=principal["user_code"],
        details="SESSION TOKEN REVOKED SERVER-SIDE",
        principal=principal,
    )

    config = current_app.config
    response = ok({"message": "Signed out successfully."})
    for cookie in (config["COOKIE_NAME"], "hpu_session_readable"):
        response.set_cookie(cookie, "", expires=0, path="/")
    return response


@bp.get("/session")
def session_state():
    """Introspection endpoint used by the frontend bootstrap.

    Never returns password material -- only the resolved principal.
    """
    from ..core.decorators import load_principal
    from ..core.errors import ApiError

    try:
        principal = load_principal()
    except ApiError as exc:
        return ok({"authenticated": False, "user": None,
                   "message": exc.message})

    users = UserRepository(g.db)
    profile = users.public_profile(principal["user_code"])
    claims = principal["claims"]
    return ok({
        "authenticated": True,
        "user": profile,
        "portal": PORTAL_FOR_ROLE.get(principal["role"], "/"),
        "token": {
            "jti": claims.get("jti"),
            "issued_at": claims.get("iat"),
            "expires_at": claims.get("exp"),
            "token_version": principal["token_version"],
        },
    })


@bp.post("/change-password")
@require_auth
def change_password():
    from ..core.security import verify_password

    data = request.get_json(silent=True) or {}
    current = require_text(data, "current_password", label="Current password", max_length=200)
    new = require_text(data, "new_password", label="New password",
                       max_length=200, min_length=8)
    confirm = data.get("confirm_password")

    if confirm is not None and new != str(confirm):
        raise ValidationError("The two new passwords do not match.",
                              {"confirm_password": "mismatch"})
    if current == new:
        raise ValidationError("The new password must differ from the current one.",
                              {"new_password": "must differ"})

    users = UserRepository(g.db)
    user = users.find_by_code(g.principal["user_code"])
    if not user or not verify_password(current, user["password_hash"], user["password_salt"]):
        record_event(
            action="PASSWORD_CHANGE_DENIED",
            target=g.principal["user_code"],
            details="CURRENT PASSWORD DID NOT MATCH",
            severity="SECURITY",
            principal=g.principal,
        )
        raise AuthenticationError("Your current password is incorrect.")

    users.set_password(g.principal["user_code"], new, current_app.config["PBKDF2_ROUNDS"])
    # token_version was bumped -> force a clean re-authentication everywhere.
    users.revoke_all_sessions(g.principal["user_code"])

    record_event(
        action="PASSWORD_CHANGED",
        target=g.principal["user_code"],
        details="PASSWORD UPDATED; ALL EXISTING SESSIONS REVOKED",
        severity="SECURITY",
        principal=g.principal,
    )

    config = current_app.config
    response = ok({"message": "Password updated. Please sign in again."})
    for cookie in (config["COOKIE_NAME"], "hpu_session_readable"):
        response.set_cookie(cookie, "", expires=0, path="/")
    return response