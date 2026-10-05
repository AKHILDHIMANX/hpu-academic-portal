"""
HPU Academic Portal -- security primitives.

Implemented with the Python standard library only, so the project has no
compiled dependencies and every line can be explained during a viva.

Contents
--------
* PBKDF2-HMAC-SHA256 password hashing with a per-user random salt
* HS256 JSON Web Tokens (sign / verify) -- RFC 7519
* CSRF double-submit protection for state-changing requests
* In-memory sliding-window rate limiter for the login endpoint
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from typing import Any


# ----------------------------------------------------------------------------
# Base64url helpers (RFC 7515 Appendix C)
# ----------------------------------------------------------------------------
def b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64u_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


# ----------------------------------------------------------------------------
# Password hashing
# ----------------------------------------------------------------------------
PBKDF2_ALGORITHM = "sha256"
PBKDF2_DKLEN = 32


def generate_salt() -> str:
    """32 hex characters = 16 bytes of cryptographic randomness."""
    return binascii.hexlify(os.urandom(16)).decode()


def hash_password(password: str, salt: str | None = None, rounds: int = 240_000) -> tuple[str, str]:
    """Return (hash_hex, salt_hex) for the supplied plaintext password."""
    if not isinstance(password, str) or len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    salt_hex = salt or generate_salt()
    derived = hashlib.pbkdf2_hmac(
        PBKDF2_ALGORITHM,
        password.encode("utf-8"),
        binascii.unhexlify(salt_hex),
        rounds,
        dklen=PBKDF2_DKLEN,
    )
    return binascii.hexlify(derived).decode(), salt_hex


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    """Constant-time verification. Never raises on malformed stored values."""
    try:
        candidate, _ = hash_password(password, salt=salt)
    except (ValueError, binascii.Error):
        return False
    return hmac.compare_digest(candidate, password_hash or "")


# ----------------------------------------------------------------------------
# HS256 JSON Web Tokens
# ----------------------------------------------------------------------------
class TokenError(Exception):
    """Raised when a token is malformed, tampered with, or expired."""


def _sign(message: bytes, secret: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).digest()


def encode_jwt(payload: dict[str, Any], secret: str, algorithm: str = "HS256") -> str:
    """Serialise a payload into a compact HS256 JWT."""
    header = {"alg": algorithm, "typ": "JWT"}
    segments = [
        b64u_encode(json.dumps(header, separators=(",", ":"), sort_keys=True).encode()),
        b64u_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()),
    ]
    signing_input = ".".join(segments).encode("ascii")
    segments.append(b64u_encode(_sign(signing_input, secret)))
    return ".".join(segments)


def decode_jwt(token: str, secret: str, verify_exp: bool = True) -> dict[str, Any]:
    """Validate signature and (optionally) expiry. Raises TokenError."""
    if not token or token.count(".") != 2:
        raise TokenError("Malformed token")

    header_b64, payload_b64, signature_b64 = token.split(".")
    try:
        header = json.loads(b64u_decode(header_b64))
        payload = json.loads(b64u_decode(payload_b64))
        signature = b64u_decode(signature_b64)
    except (ValueError, binascii.Error, json.JSONDecodeError) as exc:
        raise TokenError("Unreadable token segments") from exc

    if header.get("alg") != "HS256":
        # Reject "alg": "none" and any algorithm substitution attempt.
        raise TokenError(f"Unsupported algorithm: {header.get('alg')!r}")

    expected = _sign(f"{header_b64}.{payload_b64}".encode("ascii"), secret)
    if not hmac.compare_digest(signature, expected):
        raise TokenError("Signature verification failed")

    now = int(time.time())
    if verify_exp:
        if "exp" in payload and now >= int(payload["exp"]):
            raise TokenError("Token expired")
        if "nbf" in payload and now < int(payload["nbf"]):
            raise TokenError("Token not yet valid")
        if "iat" in payload and now + 60 < int(payload["iat"]):
            raise TokenError("Token issued in the future")

    return payload


def new_jti() -> str:
    return secrets.token_urlsafe(18)


# ----------------------------------------------------------------------------
# CSRF double-submit
# ----------------------------------------------------------------------------
def is_valid_csrf(request, config) -> bool:
    """State-changing requests must carry the agreed custom header.

    A custom header cannot be added by a cross-origin HTML form or a simple
    CORS request, so its presence proves the call was made by our own JS.
    """
    return (request.headers.get(config["CSRF_HEADER"], "")
            == config["CSRF_VALUE"])


# ----------------------------------------------------------------------------
# Rate limiting (per client key, sliding window)
# ----------------------------------------------------------------------------
class RateLimiter:
    """Thread-safe fixed-window limiter. Sufficient for a single-node demo."""

    def __init__(self, limit: int = 12, window: int = 300) -> None:
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int, int]:
        """Return (allowed, remaining, retry_after_seconds)."""
        now = time.time()
        with self._lock:
            bucket = self._hits[key]
            while bucket and now - bucket[0] > self.window:
                bucket.popleft()

            if len(bucket) >= self.limit:
                retry_after = int(self.window - (now - bucket[0])) + 1
                return False, 0, max(retry_after, 1)

            bucket.append(now)
            return True, self.limit - len(bucket), 0

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def prune(self) -> None:
        """Drop idle buckets so a long-running server does not grow unbounded."""
        now = time.time()
        with self._lock:
            for key in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                del self._hits[key]


# Shared instances
login_limiter = RateLimiter(limit=12, window=300)
write_limiter = RateLimiter(limit=240, window=60)
