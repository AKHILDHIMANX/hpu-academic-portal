"""Small validation helpers -- deliberately dependency-free and explicit."""

from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime

from .errors import ValidationError

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.IGNORECASE)
PHONE_RE = re.compile(r"^[+()\d][\d\s\-()]{6,19}$")
CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{1,39}$")
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._\- ]")


def normalise(value: str | None) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).strip()
    return re.sub(r"\s+", " ", text)


def require_text(data: dict, field: str, *, label: str | None = None,
                 max_length: int = 200, min_length: int = 1) -> str:
    value = normalise(data.get(field))
    name = label or field.replace("_", " ")
    if len(value) < min_length:
        raise ValidationError(f"{name.capitalize()} is required.", {field: "required"})
    if len(value) > max_length:
        raise ValidationError(
            f"{name.capitalize()} must be at most {max_length} characters.",
            {field: f"max {max_length} characters"},
        )
    return value


def optional_text(data: dict, field: str, *, max_length: int = 500) -> str | None:
    value = normalise(data.get(field))
    if not value:
        return None
    if len(value) > max_length:
        raise ValidationError(
            f"{field.replace('_', ' ').capitalize()} must be at most {max_length} characters."
        )
    return value


def require_email(data: dict, field: str = "email", *, label: str = "Email") -> str:
    value = normalise(data.get(field)).lower()
    if not EMAIL_RE.match(value):
        raise ValidationError(f"{label} must be a valid address.", {field: "invalid"})
    return value


def optional_phone(data: dict, field: str = "phone") -> str | None:
    value = normalise(data.get(field))
    if not value:
        return None
    if not PHONE_RE.match(value):
        raise ValidationError("Phone number format is not recognised.", {field: "invalid"})
    return value


def require_code(data: dict, field: str, *, label: str) -> str:
    value = normalise(data.get(field)).upper()
    if not CODE_RE.match(value):
        raise ValidationError(
            f"{label} may only contain letters, digits, dot, dash or underscore.",
            {field: "invalid"},
        )
    return value


def require_int(data: dict, field: str, *, minimum: int | None = None,
                maximum: int | None = None, label: str | None = None) -> int:
    raw = data.get(field)
    name = label or field.replace("_", " ")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{name.capitalize()} must be a whole number.",
                              {field: "invalid"}) from None
    if minimum is not None and value < minimum:
        raise ValidationError(f"{name.capitalize()} must be at least {minimum}.",
                              {field: f"min {minimum}"})
    if maximum is not None and value > maximum:
        raise ValidationError(f"{name.capitalize()} must not exceed {maximum}.",
                              {field: f"max {maximum}"})
    return value


def require_float(data: dict, field: str, *, minimum: float | None = None,
                  maximum: float | None = None, label: str | None = None) -> float:
    raw = data.get(field)
    name = label or field.replace("_", " ")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{name.capitalize()} must be a number.",
                              {field: "invalid"}) from None
    if minimum is not None and value < minimum:
        raise ValidationError(f"{name.capitalize()} must be at least {minimum}.",
                              {field: f"min {minimum}"})
    if maximum is not None and value > maximum:
        raise ValidationError(
            f"{name.capitalize()} must not exceed {maximum}.", {field: f"max {maximum}"}
        )
    return round(value, 2)


def require_choice(data: dict, field: str, choices: set[str] | list[str],
                   *, label: str | None = None) -> str:
    value = normalise(data.get(field)).upper()
    allowed = {str(c).upper() for c in choices}
    name = label or field.replace("_", " ")
    if value not in allowed:
        raise ValidationError(
            f"{name.capitalize()} must be one of: {', '.join(sorted(allowed))}.",
            {field: "invalid choice"},
        )
    return value


def require_date(data: dict, field: str, *, label: str | None = None) -> str:
    """Return an ISO ``YYYY-MM-DD`` string."""
    value = normalise(data.get(field))
    name = label or field.replace("_", " ")
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValidationError(f"{name.capitalize()} must be a valid date.",
                          {field: "expected YYYY-MM-DD"})


def safe_filename(name: str, *, fallback: str = "document") -> str:
    """Strip directories and dangerous characters from an uploaded name."""
    base = (name or "").replace("\\", "/").split("/")[-1]
    base = SAFE_FILENAME_RE.sub("_", base).strip(" .")
    return base[:120] or fallback


def clamp_int(value, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def as_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def iso(value) -> str | None:
    """Normalise anything date-like into an ISO string."""
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)
