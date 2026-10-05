"""Service layer: audit trail, telemetry and notification assembly."""

from __future__ import annotations

import logging

from flask import current_app, g, has_app_context

logger = logging.getLogger("hpu.audit")


def record_event(*, action: str, target: str | None = None,
                 details: str | None = None, severity: str = "INFO",
                 principal: dict | None = None) -> None:
    """
    Append an immutable audit entry.

    Audit failures are logged but never raised: losing an audit row must not
    fail the business operation that produced it.
    """
    if not has_app_context():
        return
    db = g.get("db")
    if db is None:
        return

    if principal is None:
        principal = getattr(g, "principal", None) or {}

    from ..core.decorators import client_ip
    from ..db.repositories.content import AuditRepository

    try:
        AuditRepository(db).append(
            actor_role=principal.get("role", "SYSTEM"),
            actor_name=principal.get("full_name", "SYSTEM"),
            actor_code=principal.get("user_code"),
            action=action.upper(),
            target=(target or "")[:240] or None,
            details=(details or "")[:600] or None,
            ip_address=client_ip(),
            severity=severity if severity in {"INFO", "WARNING", "SECURITY", "CRITICAL"} else "INFO",
        )
        db.commit()
    except Exception:  # pragma: no cover - defensive
        logger.exception("Unable to write audit entry for %s", action)


def system_event(action: str, *, target: str | None = None,
                 details: str | None = None, severity: str = "INFO") -> None:
    record_event(
        action=action,
        target=target,
        details=details,
        severity=severity,
        principal={"role": "SYSTEM", "full_name": "POLICY ENGINE",
                   "user_code": None},
    )