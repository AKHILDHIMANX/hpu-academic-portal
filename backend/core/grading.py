"""Grading policy helpers.

The grade scale lives in ``hpu_grade_scale`` so the university can change a
boundary without touching code; this module caches it per request-cycle and
exposes the same derivation the PL/SQL package performs on the real cluster.
"""

from __future__ import annotations

# Used when the scale table has not been seeded yet.
FALLBACK_SCALE = [
    {"grade_letter": "O",  "min_percent": 90.0, "max_percent": 100.0, "grade_point": 10.0, "classification": "OUTSTANDING"},
    {"grade_letter": "A+", "min_percent": 80.0, "max_percent": 89.99, "grade_point": 9.0,  "classification": "EXCELLENT"},
    {"grade_letter": "A",  "min_percent": 70.0, "max_percent": 79.99, "grade_point": 8.0,  "classification": "VERY GOOD"},
    {"grade_letter": "B+", "min_percent": 60.0, "max_percent": 69.99, "grade_point": 7.0,  "classification": "GOOD"},
    {"grade_letter": "B",  "min_percent": 50.0, "max_percent": 59.99, "grade_point": 6.0,  "classification": "SATISFACTORY"},
    {"grade_letter": "C",  "min_percent": 45.0, "max_percent": 49.99, "grade_point": 5.0,  "classification": "AVERAGE"},
    {"grade_letter": "P",  "min_percent": 40.0, "max_percent": 44.99, "grade_point": 4.0,  "classification": "PASS"},
    {"grade_letter": "F",  "min_percent": 0.0,  "max_percent": 39.99, "grade_point": 0.0,  "classification": "FAIL"},
]

ATTENDANCE_SAFE = 75.0
ATTENDANCE_WARNING = 65.0


def resolve_grade(total: float, scale: list[dict] | None = None) -> tuple[str, float]:
    """Map a 0-100 total onto (letter, grade point)."""
    for row in scale or FALLBACK_SCALE:
        if row["min_percent"] <= total <= row["max_percent"]:
            return row["grade_letter"], float(row["grade_point"])
    # Floating point edge: 89.995 rounding into a gap.
    for row in scale or FALLBACK_SCALE:
        if row["min_percent"] <= total <= row["max_percent"] + 0.01:
            return row["grade_letter"], float(row["grade_point"])
    return "F", 0.0


def attendance_status(percentage: float) -> str:
    if percentage >= ATTENDANCE_SAFE:
        return "SAFE"
    if percentage >= ATTENDANCE_WARNING:
        return "WARNING"
    return "CRITICAL"


def academic_status(percentage: float) -> str:
    """Mirrors FN_ACADEMIC_STATUS in HPU_PORTAL_PKG."""
    if percentage >= ATTENDANCE_SAFE:
        return "ACTIVE"
    if percentage >= 50.0:
        return "DETAINED"
    return "SUSPENDED"


def percentage(numerator: float, denominator: float, digits: int = 1) -> float:
    if not denominator:
        return 0.0
    return round((float(numerator) / float(denominator)) * 100.0, digits)


def gpa_from_rows(rows: list[dict]) -> tuple[float, float, float, int]:
    """
    Compute (cgpa, sgpa, credits_earned, credits_counted) from transcript rows.

    CGPA is credit-weighted across every course; SGPA is credit-weighted for the
    latest semester present in the data.
    """
    if not rows:
        return 0.0, 0.0, 0.0, 0

    weighted = 0.0
    credits = 0
    for row in rows:
        point = float(row.get("grade_point") or 0.0)
        credit = float(row.get("credits") or 0)
        weighted += point * credit
        credits += int(credit)
    cgpa = round(weighted / credits, 2) if credits else 0.0

    latest_semester = max(int(r.get("semester") or 0) for r in rows)
    current = [r for r in rows if int(r.get("semester") or 0) == latest_semester]
    c_weighted = sum(float(r.get("grade_point") or 0) * float(r.get("credits") or 0) for r in current)
    c_credits = sum(int(r.get("credits") or 0) for r in current)
    sgpa = round(c_weighted / c_credits, 2) if c_credits else 0.0

    return cgpa, sgpa, float(credits), c_credits
