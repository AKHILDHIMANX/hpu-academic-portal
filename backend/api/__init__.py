"""API blueprints."""

from . import academic, admin, auth, files, student, teacher, worksheets

BLUEPRINTS = (
    auth.bp,
    student.bp,
    academic.bp,
    worksheets.bp,
    teacher.bp,
    admin.bp,
    files.bp,
)

__all__ = ["BLUEPRINTS"]