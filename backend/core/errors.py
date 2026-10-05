"""Structured API errors and Flask error handlers."""

from __future__ import annotations

from flask import jsonify


class ApiError(Exception):
    """Base class for every error the API deliberately returns."""

    status_code = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str, *, code: str | None = None,
                 status_code: int | None = None, **extra) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.extra = extra

    def to_dict(self) -> dict:
        payload = {"ok": False, "error": self.code, "message": self.message}
        payload.update(self.extra)
        return payload


class ValidationError(ApiError):
    status_code = 422
    code = "VALIDATION_ERROR"

    def __init__(self, message: str, fields: dict | None = None) -> None:
        super().__init__(message, fields=fields or {})


class AuthenticationError(ApiError):
    status_code = 401
    code = "UNAUTHENTICATED"


class AuthorizationError(ApiError):
    status_code = 403
    code = "FORBIDDEN"

    def __init__(self, message: str = "Your role does not permit this operation.",
                 **extra) -> None:
        super().__init__(message, **extra)


class NotFoundError(ApiError):
    status_code = 404
    code = "NOT_FOUND"

    def __init__(self, resource: str = "Resource") -> None:
        super().__init__(f"{resource} was not found.")


class ConflictError(ApiError):
    status_code = 409
    code = "CONFLICT"


class RateLimitError(ApiError):
    status_code = 429
    code = "RATE_LIMITED"

    def __init__(self, retry_after: int) -> None:
        super().__init__(
            "Too many requests. Please slow down and try again shortly.",
            retry_after=retry_after,
        )
        self.retry_after = retry_after


class FileValidationError(ValidationError):
    code = "FILE_REJECTED"


def register_error_handlers(app) -> None:
    """Attach JSON handlers so the frontend always receives a predictable body."""

    @app.errorhandler(ApiError)
    def _api_error(exc: ApiError):
        response = jsonify(exc.to_dict())
        response.status_code = exc.status_code
        if isinstance(exc, RateLimitError):
            response.headers["Retry-After"] = str(exc.retry_after)
        return response

    @app.errorhandler(404)
    def _not_found(_exc):
        return jsonify({"ok": False, "error": "NOT_FOUND",
                        "message": "The requested endpoint does not exist."}), 404

    @app.errorhandler(405)
    def _method_not_allowed(_exc):
        return jsonify({"ok": False, "error": "METHOD_NOT_ALLOWED",
                        "message": "That HTTP method is not allowed here."}), 405

    @app.errorhandler(413)
    def _too_large(_exc):
        return jsonify({"ok": False, "error": "PAYLOAD_TOO_LARGE",
                        "message": "The uploaded file exceeds the permitted size."}), 413

    @app.errorhandler(Exception)
    def _unhandled(exc: Exception):
        app.logger.exception("Unhandled server error")
        return jsonify({"ok": False, "error": "INTERNAL_ERROR",
                        "message": "An unexpected server error occurred."}), 500
