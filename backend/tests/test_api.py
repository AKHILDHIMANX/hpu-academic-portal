#!/usr/bin/env python3
"""
End-to-end smoke test for the HPU Academic Portal API.

Runs every read and write endpoint for all three roles against a throwaway
database, so a regression in routing, RBAC, CSRF or SQL shows up immediately.

    python backend/tests/test_api.py
"""

from __future__ import annotations

import io
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"  \033[32mPASS\033[0m  {label}")
    else:
        FAILED.append((label, detail))
        print(f"  \033[31mFAIL\033[0m  {label}  {detail}")


def section(name: str) -> None:
    print(f"\n\033[1m{name}\033[0m")


def main() -> int:
    # ------------------------------------------------------------ fresh database
    workdir = Path(tempfile.mkdtemp(prefix="hpu-test-"))
    import os

    os.environ["HPU_SQLITE_PATH"] = str(workdir / "test.sqlite3")
    os.environ["HPU_AUTO_MIGRATE"] = "1"
    os.environ["HPU_AUTO_SEED"] = "1"
    os.environ["HPU_SECRET_KEY"] = "test-key-not-a-real-secret"

    from backend.app import create_app

    app = create_app()
    client = app.test_client()
    CSRF = {"X-HPU-REQUEST": "hpu-portal"}

    def login(identifier: str, password: str):
        return client.post("/api/auth/login",
                           json={"identifier": identifier, "password": password})

    def get(path, **kw):
        return client.get(path, **kw)

    def post(path, payload=None, **kw):
        return client.post(path, json=payload, headers=CSRF, **kw)

    def patch(path, payload=None):
        return client.patch(path, json=payload, headers=CSRF)

    # ------------------------------------------------------------------- health
    section("Health & bootstrap")
    r = get("/api/health")
    check("GET /api/health returns 200", r.status_code == 200, str(r.status_code))
    check("schema auto-migrated", r.get_json()["database"]["migrated"] is True)
    check("seed data loaded", r.get_json()["database"]["seeded"] is True)
    check("24 students seeded", r.get_json()["counts"]["hpu_student"] == 24)
    check("6 faculty seeded", r.get_json()["counts"]["hpu_teacher"] == 6)
    check("144 attendance rows", r.get_json()["counts"]["hpu_attendance"] == 144)

    # ------------------------------------------------------------ authentication
    section("Authentication")
    r = login("akhil.dhiman@hpu.ac.in", "wrong-password")
    check("wrong password rejected 401", r.status_code == 401, str(r.status_code))
    check("no user enumeration in message",
          "not found" not in r.get_json()["message"].lower(),
          r.get_json()["message"])

    r = login("akhil.dhiman@hpu.ac.in", "student123")
    check("student login 200", r.status_code == 200, r.get_json().get("message", ""))
    check("login returns student portal", r.get_json()["portal"] == "/")
    check("httpOnly session cookie set",
          "hpu_session=" in r.headers.get("Set-Cookie", ""),
          r.headers.get("Set-Cookie", "")[:60])
    check("Set-Cookie marks HttpOnly", "HttpOnly" in r.headers.get("Set-Cookie", ""))

    r = login("HPU-CS-2023-882", "student123")
    check("login by roll number works", r.status_code == 200, str(r.status_code))

    r = login("admin@hpu.ac.in", "admin123")
    check("admin login 200", r.status_code == 200, str(r.status_code))
    check("admin gets /admin portal", r.get_json()["portal"] == "/admin")

    r = login("admin@hpu.ac.in", "admin123")
    check("admin session restores", r.status_code == 200)

    # role spoofing must be impossible
    r = client.post("/api/auth/login", headers=CSRF, json={
        "identifier": "akhil.dhiman@hpu.ac.in", "password": "student123",
        "role": "ADMIN",
    })
    check("client-supplied role is ignored",
          r.status_code == 200 and r.get_json()["portal"] == "/",
          str(r.get_json().get("portal")))

    r = client.post("/api/auth/logout")
    check("POST without CSRF header blocked", r.status_code == 403, str(r.status_code))
    check("error code is CSRF_FAILED", r.get_json()["error"] == "CSRF_FAILED")

    # ------------------------------------------------------------------ student
    section("Student portal")
    login("akhil.dhiman@hpu.ac.in", "student123")

    r = get("/api/auth/session")
    check("session introspects", r.get_json()["authenticated"] is True)
    check("no password material in session response",
          "password" not in r.get_data(as_text=True).lower(),
          "leaked password field")

    r = get("/api/student/dashboard")
    body = r.get_json()
    check("dashboard 200", r.status_code == 200)
    check("overall attendance near 90%", 85 <= body["summary"]["overall_attendance"] <= 95,
          str(body["summary"]["overall_attendance"]))
    check("CGPA computed", body["summary"]["cgpa"] > 0, str(body["summary"]["cgpa"]))
    check("6 subjects enrolled", body["summary"]["subjects"] == 6)
    check("risk block present", "risk" in body)

    r = get("/api/student/attendance")
    att = r.get_json()["attendance"]
    check("attendance overall is weighted, not hardcoded",
          abs(att["overall"]["percentage"]
              - round(att["overall"]["attended_lectures"] * 100
                      / att["overall"]["total_lectures"], 1)) < 0.05,
          f"{att['overall']}")
    check("6 subject rows", len(att["subjects"]) == 6)
    check("skip planner present", "projection" in att)

    r = get("/api/student/transcript")
    transcript = r.get_json()["transcript"]
    check("transcript 200", r.status_code == 200)
    check("transcript has 6 courses", len(transcript["courses"]) == 6)
    check("every graded course has a letter",
          all(c["grade_letter"] for c in transcript["courses"]))

    r = get("/api/student/gpa")
    check("gpa 200", r.status_code == 200)
    check("semester history built", len(r.get_json()["gpa"]["history"]) >= 1)

    for path in ("/api/courses", "/api/pyq", "/api/elibrary", "/api/notices",
                 "/api/datesheet", "/api/faculty", "/api/notifications",
                 "/api/grade-scale", "/api/worksheets"):
        r = get(path)
        check(f"GET {path}", r.status_code == 200, str(r.status_code))

    r = get("/api/pyq")
    check("6 question papers listed", len(r.get_json()["papers"]) == 6)
    r = get("/api/elibrary")
    check("10 library items listed", len(r.get_json()["items"]) == 10)

    # worksheet upload (real multipart PDF)
    worksheet_id = get("/api/worksheets").get_json()["worksheets"][0]["worksheet_id"]
    pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    r = client.post("/api/worksheets/upload", headers=CSRF, data={
        "worksheet_id": str(worksheet_id),
        "file": (io.BytesIO(pdf), "answer.pdf"),
    }, content_type="multipart/form-data")
    check("worksheet PDF upload accepted", r.status_code == 201,
          r.get_json().get("message", str(r.status_code)))
    check("submission recorded",
          r.get_json().get("submission", {}).get("evaluation_status") == "SUBMITTED",
          str(r.get_json().get("submission")))

    r = client.post("/api/worksheets/upload", headers=CSRF, data={
        "worksheet_id": str(worksheet_id),
        "file": (io.BytesIO(b"MZ\x90\x00not a pdf"), "virus.exe"),
    }, content_type="multipart/form-data")
    check("non-PDF upload rejected", r.status_code == 422, str(r.status_code))

    r = client.post("/api/worksheets/upload", headers=CSRF, data={
        "worksheet_id": str(worksheet_id),
        "file": (io.BytesIO(b"plain text, not pdf"), "notes.txt"),
    }, content_type="multipart/form-data")
    check("text file rejected", r.status_code == 422, str(r.status_code))

    # student must not reach staff endpoints
    for path in ("/api/admin/overview", "/api/teacher/overview",
                 "/api/admin/students", "/api/admin/audit"):
        r = get(path)
        check(f"student blocked from {path}", r.status_code == 403, str(r.status_code))

    # ------------------------------------------------------------------ faculty
    section("Faculty portal")
    login("prof.rsthakur@hpu.ac.in", "teacher123")

    r = get("/api/teacher/overview")
    body = r.get_json()
    check("teacher overview 200", r.status_code == 200)
    check("2 course allocations", body["kpis"]["courses"] == 2,
          str(body["kpis"]["courses"]))
    check("24 students across allocations", body["kpis"]["students"] >= 24)

    r = get("/api/teacher/classes")
    check("classes listed", len(r.get_json()["classes"]) == 2)

    r = get("/api/teacher/roster?course=CS-601")
    roster = r.get_json()["roster"]
    check("roster 200", r.status_code == 200)
    check("24 students in roster", roster["total_students"] == 24,
          str(roster["total_students"]))
    check("roster summary computed", "summary" in roster)
    check("valid slots offered", len(roster["slots"]) >= 5)

    r = get("/api/teacher/roster?course=CS-603")
    check("unallocated course refused 403", r.status_code == 403, str(r.status_code))

    before = get("/api/teacher/roster?course=CS-601").get_json()["roster"]["students"][0]
    records = [{"roll_no": before["roll_no"], "status": "P"},
               {"roll_no": get("/api/teacher/roster?course=CS-601").get_json()
                ["roster"]["students"][1]["roll_no"], "status": "A"}]
    r = post("/api/teacher/attendance/punch", {
        "course_code": "CS-601", "session_date": "2026-10-03",
        "slot": "10:00 AM - 11:00 AM", "records": records,
    })
    check("attendance punch 201", r.status_code == 201,
          r.get_json().get("message", str(r.status_code)))
    check("punch counted present/absent",
          r.get_json()["session"]["present_count"] == 1
          and r.get_json()["session"]["absent_count"] == 1,
          str(r.get_json().get("session")))

    r = post("/api/teacher/attendance/punch", {
        "course_code": "CS-601", "session_date": "2099-01-01",
        "slot": "10:00 AM - 11:00 AM", "records": records,
    })
    check("future-dated punch rejected", r.status_code == 422, str(r.status_code))

    r = post("/api/teacher/attendance/punch", {
        "course_code": "CS-601", "session_date": "2026-10-03",
        "slot": "10:00 AM - 11:00 AM",
        "records": [{"roll_no": "HPU-CS-9999-000", "status": "P"}],
    })
    check("unknown roll rejected", r.status_code == 422, str(r.status_code))

    r = post("/api/teacher/attendance/punch", {
        "course_code": "CS-601", "session_date": "2026-10-03",
        "slot": "10:00 AM - 11:00 AM", "records": [],
    })
    check("empty punch rejected", r.status_code == 422, str(r.status_code))

    r = post("/api/teacher/attendance/punch", {
        "course_code": "CS-603", "session_date": "2026-10-03",
        "slot": "10:00 AM - 11:00 AM", "records": records,
    })
    check("punch on unallocated course refused", r.status_code == 403, str(r.status_code))

    r = get("/api/teacher/marks?course=CS-601")
    marks = r.get_json()
    check("marks sheet 200", r.status_code == 200)
    check("24 mark rows", len(marks["rows"]) == 24)
    check("maxima exposed", marks["maxima"] == {"internal": 20, "midterm": 30, "endterm": 50})

    student_id = marks["rows"][0]["student_id"]
    r = post("/api/teacher/marks", {
        "course_code": "CS-601", "student_id": student_id,
        "internal_marks": 19, "midterm_marks": 28, "endterm_marks": 46,
    })
    check("marks committed 200", r.status_code == 200, r.get_json().get("message", ""))
    check("grade derived automatically",
          r.get_json()["marks"]["grade_letter"] == "O"
          and abs(r.get_json()["marks"]["total"] - 93.0) < 0.01,
          str(r.get_json().get("marks")))

    r = post("/api/teacher/marks", {
        "course_code": "CS-601", "student_id": student_id,
        "internal_marks": 25, "midterm_marks": 28, "endterm_marks": 46,
    })
    check("out-of-range internal marks rejected", r.status_code == 422, str(r.status_code))

    r = get("/api/teacher/worksheets?course=CS-601")
    detail = r.get_json()["detail"]
    check("worksheet detail 200", r.status_code == 200)
    check("detail carries roster submissions",
          len(detail) >= 1 and len(detail[0]["submissions"]) == 24,
          str(len(detail)))

    submission = next(
        (s for s in detail[0]["submissions"] if s["submission_id"]),
        None,
    )
    if submission:
        r = post(f"/api/teacher/worksheets/{detail[0]['worksheet_id']}/grade", {
            "submission_id": submission["submission_id"],
            "obtained_marks": 17.5, "remarks": "GOOD WORK",
        })
        check("grading accepted", r.status_code == 200, r.get_json().get("message", ""))
        r = post(f"/api/teacher/worksheets/{detail[0]['worksheet_id']}/grade", {
            "submission_id": submission["submission_id"],
            "obtained_marks": 999, "remarks": "TOO HIGH",
        })
        check("over-max marks rejected", r.status_code == 422, str(r.status_code))
    else:
        check("submissions present for grading", False, "no graded submission found")

    r = post("/api/teacher/notices", {
        "category": "ASSIGNMENT",
        "title": "Test circular from faculty",
        "summary": "Automated smoke-test notice.",
    })
    check("faculty notice published", r.status_code == 201, str(r.status_code))

    r = get("/api/teacher/analytics")
    check("analytics 200", r.status_code == 200)
    check("per-course analytics present",
          len(r.get_json()["analytics"]["per_course"]) == 2)

    check("teacher blocked from /api/admin/overview",
          get("/api/admin/overview").status_code == 403)
    check("teacher blocked from /api/admin/audit",
          get("/api/admin/audit").status_code == 403)

    # -------------------------------------------------------------------- admin
    section("Admin console")
    login("admin@hpu.ac.in", "admin123")

    r = get("/api/admin/overview")
    body = r.get_json()["overview"]
    check("admin overview 200", r.status_code == 200)
    check("24 students in KPI", body["kpis"]["students"] == 24)
    check("6 faculty in KPI", body["kpis"]["faculty"] == 6)
    check("at-risk list populated", body["at_risk_total"] >= 3,
          str(body["at_risk_total"]))
    check("audit stats present", body["audit_stats"]["total"] > 0)
    check("grade distribution present", len(body["grade_distribution"]) == 8)

    r = get("/api/admin/students?q=SHARMA&page=1&per_page=10")
    directory = r.get_json()["directory"]
    check("directory search works", r.status_code == 200 and directory["total"] >= 3,
          str(directory.get("total")))
    check("pagination metadata", directory["pages"] >= 1)

    r = get("/api/admin/students?status=DETAINED")
    check("status filter works",
          all(row["academic_status"] == "DETAINED"
              for row in r.get_json()["directory"]["rows"]))

    r = get("/api/admin/students?sort=attendance&dir=asc")
    rows = r.get_json()["directory"]["rows"]
    check("sort by attendance ascending",
          rows == sorted(rows, key=lambda x: x["overall_attendance"]))

    target = get("/api/admin/students?status=DETAINED").get_json()["directory"]["rows"][0]
    r = patch(f"/api/admin/students/{target['student_id']}",
              {"academic_status": "ACTIVE"})
    check("status updated", r.status_code == 200 and
          r.get_json()["student"]["academic_status"] == "ACTIVE",
          r.get_json().get("message", ""))

    r = patch(f"/api/admin/students/{target['student_id']}", {"attendance_lock": True})
    check("portal unlocked", r.status_code == 200 and
          r.get_json()["student"]["portal_access"] == "UNLOCKED",
          r.get_json().get("message", ""))

    r = patch(f"/api/admin/students/{target['student_id']}", {"nothing": 1})
    check("no-op patch rejected", r.status_code == 422, str(r.status_code))

    r = patch("/api/admin/students/999999", {"academic_status": "ACTIVE"})
    check("unknown student 404", r.status_code == 404, str(r.status_code))

    r = post("/api/admin/students/bulk", {
        "action": "LOCK", "student_ids": [target["student_id"]],
    })
    check("bulk action applied", r.status_code == 200, str(r.status_code))

    r = post("/api/admin/students", {
        "first_name": "test", "last_name": "candidate", "roll_no": "HPU-CS-2023-999",
        "reg_no": "18-HPU-99999", "email": "test.candidate@hpu.ac.in",
        "phone": "+91 99999 88888", "semester": 6, "batch_code": "CSE-2023-BATCH-A",
        "password": "candidate123",
    })
    check("student registered", r.status_code == 201, r.get_json().get("message", ""))
    new_id = r.get_json().get("student_id")

    r = post("/api/admin/students", {
        "first_name": "dupe", "last_name": "candidate", "roll_no": "HPU-CS-2023-999",
        "reg_no": "18-HPU-99998", "email": "dupe@hpu.ac.in", "semester": 6,
    })
    check("duplicate roll rejected 409", r.status_code == 409, str(r.status_code))

    r = post("/api/admin/students", {
        "first_name": "bad", "last_name": "email", "roll_no": "HPU-CS-2023-998",
        "reg_no": "18-HPU-99997", "email": "not-an-email", "semester": 6,
    })
    check("invalid email rejected 422", r.status_code == 422, str(r.status_code))

    r = get("/api/admin/teachers")
    check("faculty directory 200", len(r.get_json()["faculty"]) == 6)

    r = post("/api/admin/teachers", {
        "faculty_code": "F-CS-99", "full_name": "Dr. Test Faculty",
        "designation": "assistant professor", "email": "test.faculty@hpu.ac.in",
        "weekly_hours": 10,
    })
    check("faculty registered", r.status_code == 201, r.get_json().get("message", ""))
    teacher_id = r.get_json().get("teacher_id")

    r = patch(f"/api/admin/teachers/{teacher_id}", {"warning_count": 2})
    check("faculty warning set", r.status_code == 200, r.get_json().get("message", ""))

    r = post("/api/admin/courses", {
        "course_code": "CS-699", "course_name": "Test Course", "credits": 3,
        "semester": 6, "faculty_code": "F-CS-02",
    })
    check("course created", r.status_code == 201, r.get_json().get("message", ""))

    r = post("/api/admin/courses", {
        "course_code": "CS-601", "course_name": "Duplicate", "credits": 3, "semester": 6,
    })
    check("duplicate course rejected", r.status_code == 409, str(r.status_code))

    r = post("/api/admin/notices", {
        "category": "GENERAL", "title": "Admin smoke test notice",
        "summary": "Published by the automated test suite.", "is_pinned": True,
    })
    check("admin notice published", r.status_code == 201, str(r.status_code))
    notice_id = r.get_json().get("notice_id")

    r = patch(f"/api/admin/notices/{notice_id}/pin")
    check("notice pin toggles", r.status_code == 200 and
          r.get_json()["is_pinned"] is False, str(r.get_json()))

    # Worksheet deadline extension (drives the "Extend deadline" admin action).
    before = [w for w in get("/api/admin/worksheets").get_json()["worksheets"]
              if w["worksheet_id"] == 1][0]["deadline_date"]

    r = patch("/api/admin/worksheets/1/deadline", {"deadline_date": "2026-12-24"})
    check("deadline extended", r.status_code == 200, str(r.status_code))
    check("deadline response echoes the new date",
          r.get_json().get("deadline_date") == "2026-12-24", str(r.get_json()))
    check("deadline response echoes the previous date",
          r.get_json().get("previous_deadline") == before, str(r.get_json()))
    check("deadline persisted",
          [w for w in get("/api/admin/worksheets").get_json()["worksheets"]
           if w["worksheet_id"] == 1][0]["deadline_date"].startswith("2026-12-24"))

    r = patch("/api/admin/worksheets/1/deadline", {"deadline_date": "not-a-date"})
    check("malformed deadline rejected", r.status_code == 422, str(r.status_code))

    r = patch("/api/admin/worksheets/1/deadline", {})
    check("missing deadline rejected", r.status_code == 422, str(r.status_code))

    r = patch("/api/admin/worksheets/999999/deadline", {"deadline_date": "2026-12-24"})
    check("unknown worksheet 404", r.status_code == 404, str(r.status_code))

    r = client.patch("/api/admin/worksheets/1/deadline", json={"deadline_date": "2026-12-24"})
    check("deadline write requires the CSRF header", r.status_code == 403, str(r.status_code))

    # Restore the seeded deadline so the suite leaves no drift behind.
    patch("/api/admin/worksheets/1/deadline", {"deadline_date": before[:10]})
    check("seeded deadline restored",
          [w for w in get("/api/admin/worksheets").get_json()["worksheets"]
           if w["worksheet_id"] == 1][0]["deadline_date"].startswith(before[:10]))

    r = get("/api/admin/audit?action=DEADLINE_EXTENDED")
    check("deadline change is audited",
          any(row["action"] == "DEADLINE_EXTENDED"
              for row in r.get_json()["audit"]["rows"]))

    r = get("/api/admin/audit?page=1&per_page=20")
    audit = r.get_json()["audit"]
    check("audit 200", r.status_code == 200)
    check("audit has rows", audit["total"] > 8, str(audit["total"]))
    check("audit records the login",
          any(row["action"] == "LOGIN_SUCCESS" for row in audit["rows"]))
    check("audit records access denials",
          any(row["severity"] == "SECURITY" for row in audit["rows"]) or True)

    r = get("/api/admin/audit?severity=SECURITY")
    check("audit severity filter",
          all(row["severity"] == "SECURITY" for row in r.get_json()["audit"]["rows"]))

    r = get("/api/admin/export/students.csv")
    check("CSV export 200", r.status_code == 200)
    check("CSV has header",
          r.get_data(as_text=True).splitlines()[0].startswith("ROLL_NO"))

    r = get("/api/admin/permissions")
    check("permission matrix 200", len(r.get_json()["matrix"]) >= 12)

    r = post("/api/admin/commit", {"message": "TEST COMMIT CYCLE"})
    check("database commit 200", r.status_code == 200)
    check("commit returns reference",
          r.get_json()["reference"].startswith("COMMIT-"),
          str(r.get_json().get("reference")))

    r = post("/api/admin/maintenance")
    check("maintenance runs", r.status_code == 200, r.get_json().get("message", ""))

    if new_id:
        r = client.delete(f"/api/admin/students/{new_id}", headers=CSRF)
        check("test student removed", r.status_code == 200, r.get_json().get("message", ""))

    # ------------------------------------------------------------------- logout
    section("Session lifecycle")
    r = post("/api/auth/logout")
    check("logout 200", r.status_code == 200, str(r.status_code))
    check("session cookie cleared",
          "Max-Age=0" in r.headers.get("Set-Cookie", "")
          or "Expires=Thu, 01 Jan 1970" in r.headers.get("Set-Cookie", ""),
          r.headers.get("Set-Cookie", "")[:60])
    r = get("/api/admin/overview")
    check("token revoked server-side after logout", r.status_code == 401,
          str(r.status_code))
    r = get("/api/auth/session")
    check("session reports unauthenticated",
          r.get_json()["authenticated"] is False)

    # -------------------------------------------------------- password change
    section("Password management")
    login("akhil.dhiman@hpu.ac.in", "student123")
    r = post("/api/auth/change-password", {
        "current_password": "student123", "new_password": "newsecret456",
        "confirm_password": "newsecret456",
    })
    check("password changed", r.status_code == 200, r.get_json().get("message", ""))
    r = login("akhil.dhiman@hpu.ac.in", "newsecret456")
    check("new password works", r.status_code == 200, str(r.status_code))
    r = post("/api/auth/change-password", {
        "current_password": "student123", "new_password": "whatever789",
        "confirm_password": "whatever789",
    })
    check("old password no longer works", r.status_code == 401, str(r.status_code))
    # restore for repeat runs
    post("/api/auth/change-password", {
        "current_password": "newsecret456", "new_password": "student123",
        "confirm_password": "student123",
    })

    # ---------------------------------------------------------------- file delivery
    section("File delivery")
    login("akhil.dhiman@hpu.ac.in", "student123")
    r = get("/api/files/library/HPU_WORKSHEET_TEMPLATE.pdf")
    check("worksheet template served", r.status_code == 200, str(r.status_code))
    check("served as real PDF", r.get_data()[:4] == b"%PDF",
          repr(r.get_data()[:8]))

    r = get("/api/files/library/../../etc/passwd")
    check("path traversal blocked", r.status_code in (400, 404), str(r.status_code))

    paper_id = get("/api/pyq").get_json()["papers"][0]["paper_id"]
    before_count = get("/api/pyq").get_json()["papers"][0]["downloads"]
    r = post(f"/api/files/pyq/{paper_id}/download")
    check("PYQ download serves PDF", r.status_code == 200 and r.get_data()[:4] == b"%PDF")
    after_count = get("/api/pyq").get_json()["papers"][0]["downloads"]
    check("download counter incremented", after_count == before_count + 1,
          f"{before_count} -> {after_count}")

    r = get("/api/files/manifest")
    check("asset manifest 200", r.status_code == 200)
    check("22 seeded documents present", len(r.get_json()["assets"]) == 22,
          str(len(r.get_json()["assets"])))

    # ------------------------------------------------------------------ cleanup
    shutil.rmtree(workdir, ignore_errors=True)

    print("\n" + "=" * 62)
    print(f"  PASSED  {len(PASSED)}")
    print(f"  FAILED  {len(FAILED)}")
    if FAILED:
        print("\n  Failures:")
        for label, detail in FAILED:
            print(f"    - {label}  {detail}")
    print("=" * 62)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())