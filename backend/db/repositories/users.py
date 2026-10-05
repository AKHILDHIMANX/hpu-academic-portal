"""Authentication repository -- identity resolution, sessions and lockout."""

from __future__ import annotations

from datetime import datetime, timedelta

from ...core import security
from ...core.errors import AuthenticationError


class UserRepository:
    def __init__(self, db) -> None:
        self.db = db

    # -- lookups -------------------------------------------------------------
    def find_by_identifier(self, identifier: str) -> dict | None:
        """Resolve a login identifier: e-mail, roll number or faculty code.

        The ROLE is never taken from the request -- it is read from the stored
        record so a client cannot select which account it wants to become.
        """
        needle = (identifier or "").strip().lower()
        if not needle:
            return None
        return self.db.query_one(
            """
            SELECT user_id, user_code, email, phone, password_hash, password_salt,
                   role, full_name, is_active, token_version, failed_attempts,
                   locked_until, last_login_at, created_at
              FROM hpu_user_auth
             WHERE LOWER(user_code) = ? OR LOWER(email) = ?
            """,
            (needle, needle),
        )

    def find_by_code(self, user_code: str) -> dict | None:
        return self.db.query_one(
            "SELECT * FROM hpu_user_auth WHERE user_code = ?", (user_code,)
        )

    def public_profile(self, user_code: str) -> dict | None:
        """Role-specific profile used to render the portal identity card."""
        user = self.find_by_code(user_code)
        if not user:
            return None
        role = user["role"]

        if role == "STUDENT":
            detail = self.db.query_one(
                """
                SELECT s.student_id, s.roll_no, s.reg_no, s.first_name, s.last_name,
                       s.email, s.phone, s.department, s.course, s.semester,
                       s.batch_code, s.academic_status, s.attendance_lock,
                       s.advisor, s.avatar_url
                  FROM hpu_student s
                 WHERE s.roll_no = ?
                """,
                (user_code,),
            )
        elif role == "TEACHER":
            detail = self.db.query_one(
                """
                SELECT t.teacher_id, t.faculty_code, t.full_name, t.designation,
                       t.department, t.specialization, t.email, t.phone,
                       t.office_location, t.office_hours, t.cabin_status,
                       t.grading_deadline, t.warning_count, t.weekly_hours
                  FROM hpu_teacher t
                 WHERE t.faculty_code = ?
                """,
                (user_code,),
            )
        else:
            detail = self.db.query_one(
                """
                SELECT a.user_id, a.user_code, a.email, a.phone, a.full_name
                  FROM hpu_user_auth a WHERE a.user_code = ?
                """,
                (user_code,),
            )

        return {
            "role": role,
            "user_code": user["user_code"],
            "full_name": user["full_name"],
            "email": user["email"],
            "last_login_at": user["last_login_at"],
            "created_at": user["created_at"],
            "detail": detail or {},
        }

    # -- login ---------------------------------------------------------------
    def register_failed_attempt(self, user_code: str, max_attempts: int,
                                lockout_minutes: int) -> int:
        user = self.find_by_code(user_code)
        if not user:
            return 0
        attempts = int(user["failed_attempts"] or 0) + 1
        locked_until = user["locked_until"]
        if attempts >= max_attempts:
            locked_until = (datetime.now() + timedelta(minutes=lockout_minutes)).isoformat(" ")
        self.db.execute(
            "UPDATE hpu_user_auth SET failed_attempts = ?, locked_until = ? WHERE user_code = ?",
            (attempts, locked_until, user_code),
        )
        self.db.commit()
        return attempts

    def is_locked(self, user: dict) -> bool:
        if not user.get("locked_until"):
            return False
        try:
            locked_until = datetime.fromisoformat(str(user["locked_until"]))
        except ValueError:
            return False
        return locked_until > datetime.now()

    def register_success(self, user_code: str) -> None:
        self.db.execute(
            "UPDATE hpu_user_auth SET failed_attempts = 0, locked_until = NULL, "
            "last_login_at = datetime('now') WHERE user_code = ?",
            (user_code,),
        )
        self.db.commit()

    # -- password management -------------------------------------------------
    def set_password(self, user_code: str, password: str, rounds: int) -> None:
        digest, salt = security.hash_password(password, rounds=rounds)
        self.db.execute(
            "UPDATE hpu_user_auth SET password_hash = ?, password_salt = ?, "
            "token_version = token_version + 1, failed_attempts = 0, locked_until = NULL "
            "WHERE user_code = ?",
            (digest, salt, user_code),
        )
        self.db.commit()

    # -- session registry ----------------------------------------------------
    def create_session(self, jti: str, user_code: str, expires_at: str,
                       user_agent: str, ip: str) -> None:
        self.db.execute(
            """
            INSERT INTO hpu_auth_session (session_id, user_code, issued_at, expires_at,
                                          user_agent, ip_address)
            VALUES (?, ?, datetime('now'), ?, ?, ?)
            """,
            (jti, user_code, expires_at, (user_agent or "")[:200], (ip or "")[:60]),
        )
        self.db.commit()

    def is_session_active(self, jti: str, user_code: str) -> bool:
        row = self.db.query_one(
            """
            SELECT s.session_id
              FROM hpu_auth_session s
              JOIN hpu_user_auth u ON u.user_code = s.user_code
             WHERE s.session_id = ?
               AND s.user_code = ?
               AND s.revoked_at IS NULL
               AND s.expires_at > datetime('now')
               AND u.is_active = 1
            """,
            (jti, user_code),
        )
        return row is not None

    def revoke_session(self, jti: str) -> None:
        self.db.execute(
            "UPDATE hpu_auth_session SET revoked_at = datetime('now') WHERE session_id = ?",
            (jti,),
        )
        self.db.commit()

    def revoke_all_sessions(self, user_code: str) -> int:
        count = self.db.execute(
            "UPDATE hpu_auth_session SET revoked_at = datetime('now') "
            "WHERE user_code = ? AND revoked_at IS NULL",
            (user_code,),
        )
        self.db.commit()
        return count

    def purge_expired_sessions(self) -> int:
        count = self.db.execute(
            "DELETE FROM hpu_auth_session WHERE expires_at <= datetime('now', '-1 day')"
        )
        self.db.commit()
        return count

    # -- token minting -------------------------------------------------------
    def issue_token(self, user: dict, config) -> tuple[str, dict]:
        """Return (jwt, claims). The jti is registered so logout truly revokes."""
        now = datetime.now()
        expires_at = now + timedelta(seconds=config["TOKEN_TTL_SECONDS"])
        jti = security.new_jti()
        claims = {
            "sub": user["user_code"],
            "role": user["role"],
            "name": user["full_name"],
            "email": user["email"],
            "tv": int(user["token_version"] or 1),
            "jti": jti,
            "iat": int(now.timestamp()),
            "nbf": int(now.timestamp()) - 5,
            "exp": int(expires_at.timestamp()),
            "iss": "hpu.academic.portal",
        }
        token = security.encode_jwt(claims, config["SECRET_KEY"])
        self.create_session(jti, user["user_code"], expires_at.isoformat(" "), "", "")
        return token, claims


def authenticate(db, identifier: str, password: str, config) -> dict:
    """Validate credentials and return the matching user row."""
    repo = UserRepository(db)
    user = repo.find_by_identifier(identifier)

    if not user:
        # Constant-ish work even for unknown users to avoid user enumeration.
        security.hash_password(password or "x", rounds=50_000)
        raise AuthenticationError("Invalid credentials. Please check and try again.")

    if not int(user.get("is_active", 1)):
        raise AuthenticationError("This account has been deactivated. Contact the administrator.")

    if repo.is_locked(user):
        raise AuthenticationError(
            "Account temporarily locked after repeated failed attempts. Try again later."
        )

    if not security.verify_password(
        password or "", user["password_hash"], user["password_salt"]
    ):
        attempts = repo.register_failed_attempt(
            user["user_code"], config["MAX_FAILED_LOGINS"], config["LOCKOUT_MINUTES"]
        )
        remaining = max(config["MAX_FAILED_LOGINS"] - attempts, 0)
        message = "Invalid credentials. Please check and try again."
        if 0 < remaining <= 2:
            message += f" {remaining} attempt(s) remaining before lockout."
        raise AuthenticationError(message)

    repo.register_success(user["user_code"])
    user["failed_attempts"] = 0
    return user
