"""Repository layer -- every SQL statement in the project lives here.

Keeping SQL out of the HTTP layer means the SQL can be reviewed, and swapped
between the SQLite demo engine and Oracle, in exactly one place.
"""

from .academic import (
    AttendanceRepository,
    CourseRepository,
    MarkRepository,
    StudentRepository,
    TeacherRepository,
)
from .content import AuditRepository, ContentRepository, WorksheetRepository
from .users import UserRepository, authenticate

__all__ = [
    "AttendanceRepository",
    "AuditRepository",
    "ContentRepository",
    "CourseRepository",
    "MarkRepository",
    "StudentRepository",
    "TeacherRepository",
    "UserRepository",
    "WorksheetRepository",
    "authenticate",
]