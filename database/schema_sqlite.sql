-- =============================================================================
--  HPU ACADEMIC PORTAL -- RUNTIME MIRROR SCHEMA (SQLite 3)
-- =============================================================================
--  WHY THIS FILE EXISTS
--  --------------------
--  schema.sql is the canonical Oracle/PL/SQL production definition. Oracle
--  cannot be assumed on a laptop or a college lab machine, so the Python
--  backend executes this mirror instead. Every table and every column name here
--  matches schema.sql exactly, and every CHECK constraint mirrors the Oracle one.
--  The repositories in backend/db/repositories/ are written once against this
--  shape, so switching to Oracle is a connection-string change.
--
--  Lifecycle:
--    * The file is executed once, automatically, the first time the backend
--      starts against a fresh database file (see backend/db/engine.py).
--    * It is destructive only for tables that already exist in the target file.
--    * seed.sql is executed immediately afterwards.
--
--  Keep in sync with schema.sql. If you add a column here, add it there too.
-- =============================================================================

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS hpu_audit_log;
DROP TABLE IF EXISTS hpu_auth_session;
DROP TABLE IF EXISTS hpu_attendance_session;
DROP TABLE IF EXISTS hpu_worksheet_submission;
DROP TABLE IF EXISTS hpu_worksheet;
DROP TABLE IF EXISTS hpu_e_library;
DROP TABLE IF EXISTS hpu_exam_schedule;
DROP TABLE IF EXISTS hpu_pyq_paper;
DROP TABLE IF EXISTS hpu_notice;
DROP TABLE IF EXISTS hpu_mark;
DROP TABLE IF EXISTS hpu_attendance;
DROP TABLE IF EXISTS hpu_enrollment;
DROP TABLE IF EXISTS hpu_teacher_allocation;
DROP TABLE IF EXISTS hpu_course;
DROP TABLE IF EXISTS hpu_teacher;
DROP TABLE IF EXISTS hpu_student;
DROP TABLE IF EXISTS hpu_user_auth;
DROP TABLE IF EXISTS hpu_grade_scale;

-- ---------------------------------------------------------------- grade scale
CREATE TABLE hpu_grade_scale (
    grade_letter    TEXT    PRIMARY KEY,
    min_percent     REAL    NOT NULL,
    max_percent     REAL    NOT NULL,
    grade_point     REAL    NOT NULL,
    classification  TEXT    NOT NULL,
    CHECK (min_percent <= max_percent)
);

-- ------------------------------------------------------------ authentication
CREATE TABLE hpu_user_auth (
    user_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_code       TEXT    NOT NULL UNIQUE,          -- roll no / faculty code / admin id
    email           TEXT    NOT NULL UNIQUE,
    password_hash   TEXT    NOT NULL,                -- pbkdf2_hmac('sha256', 240000)
    password_salt   TEXT    NOT NULL,
    role            TEXT    NOT NULL CHECK (role IN ('STUDENT', 'TEACHER', 'ADMIN')),
    full_name       TEXT    NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    token_version   INTEGER NOT NULL DEFAULT 1,      -- bump to revoke every token
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    last_login_at   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    phone           TEXT
);

-- ------------------------------------------------------------------ students
CREATE TABLE hpu_student (
    student_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_no         TEXT    NOT NULL UNIQUE,
    reg_no          TEXT    NOT NULL UNIQUE,
    first_name      TEXT    NOT NULL,
    last_name       TEXT    NOT NULL,
    email           TEXT    NOT NULL UNIQUE,
    phone           TEXT,
    department      TEXT    NOT NULL DEFAULT 'DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING',
    course          TEXT    NOT NULL DEFAULT 'B.TECH COMPUTER SCIENCE & ENGINEERING',
    semester        INTEGER NOT NULL DEFAULT 6,
    batch_code      TEXT    NOT NULL DEFAULT 'CSE-2023-BATCH-A',
    academic_status TEXT    NOT NULL DEFAULT 'ACTIVE'
                          CHECK (academic_status IN ('ACTIVE', 'DETAINED', 'SUSPENDED')),
    attendance_lock INTEGER NOT NULL DEFAULT 1 CHECK (attendance_lock IN (0, 1)),
    advisor         TEXT    NOT NULL DEFAULT 'DR. P.K. SHARMA (HOD CSE)',
    avatar_url      TEXT    DEFAULT 'akhil-dhiman.jpg',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------ teachers
CREATE TABLE hpu_teacher (
    teacher_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    faculty_code     TEXT    NOT NULL UNIQUE,
    full_name        TEXT    NOT NULL,
    designation      TEXT    NOT NULL,
    department       TEXT    NOT NULL DEFAULT 'DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING',
    specialization   TEXT,
    email            TEXT    NOT NULL UNIQUE,
    phone            TEXT,
    office_location  TEXT,
    office_hours     TEXT,
    cabin_status     TEXT    DEFAULT 'ON CAMPUS',
    grading_deadline TEXT,
    warning_count    INTEGER NOT NULL DEFAULT 0,
    weekly_hours     INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------- courses
CREATE TABLE hpu_course (
    course_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    course_code    TEXT    NOT NULL UNIQUE,
    course_name    TEXT    NOT NULL,
    credits        INTEGER NOT NULL,
    semester       INTEGER NOT NULL,
    department     TEXT    NOT NULL DEFAULT 'DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING',
    instructor_id  INTEGER REFERENCES hpu_teacher (teacher_id) ON DELETE SET NULL,
    syllabus_file  TEXT,
    topics         TEXT    NOT NULL DEFAULT '[]'      -- JSON array of syllabus topics
);

-- --------------------------------------------------- teacher -> course/batch
CREATE TABLE hpu_teacher_allocation (
    allocation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id    INTEGER NOT NULL REFERENCES hpu_teacher (teacher_id) ON DELETE CASCADE,
    course_id     INTEGER NOT NULL REFERENCES hpu_course  (course_id)  ON DELETE CASCADE,
    batch_code    TEXT    NOT NULL,
    semester      INTEGER NOT NULL,
    academic_year TEXT    NOT NULL DEFAULT '2023-2024',
    UNIQUE (teacher_id, course_id, batch_code)
);

-- --------------------------------------------------------------- enrollments
CREATE TABLE hpu_enrollment (
    enrollment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES hpu_student (student_id) ON DELETE CASCADE,
    course_id     INTEGER NOT NULL REFERENCES hpu_course  (course_id)  ON DELETE CASCADE,
    enrolled_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, course_id)
);

-- ------------------------------------ attendance (per student, per course)
CREATE TABLE hpu_attendance (
    attendance_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id        INTEGER NOT NULL REFERENCES hpu_student (student_id) ON DELETE CASCADE,
    course_id         INTEGER NOT NULL REFERENCES hpu_course  (course_id)  ON DELETE CASCADE,
    total_lectures    INTEGER NOT NULL DEFAULT 0,
    attended_lectures INTEGER NOT NULL DEFAULT 0,
    last_session_date TEXT,
    last_updated      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, course_id),
    CHECK (attended_lectures >= 0 AND attended_lectures <= total_lectures)
);

-- ------------------------------- attendance sessions (lecture punch history)
CREATE TABLE hpu_attendance_session (
    session_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id      INTEGER NOT NULL REFERENCES hpu_course  (course_id)  ON DELETE CASCADE,
    teacher_id     INTEGER REFERENCES hpu_teacher (teacher_id) ON DELETE SET NULL,
    session_date   TEXT    NOT NULL,
    slot           TEXT    NOT NULL,
    batch_code     TEXT    NOT NULL,
    total_students INTEGER NOT NULL,
    present_count  INTEGER NOT NULL,
    absent_count   INTEGER NOT NULL,
    late_count     INTEGER NOT NULL DEFAULT 0,
    is_revised     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- collegia marks
CREATE TABLE hpu_mark (
    mark_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id     INTEGER NOT NULL REFERENCES hpu_student (student_id) ON DELETE CASCADE,
    course_id      INTEGER NOT NULL REFERENCES hpu_course  (course_id)  ON DELETE CASCADE,
    internal_marks REAL    NOT NULL DEFAULT 0 CHECK (internal_marks BETWEEN 0 AND 20),
    midterm_marks  REAL    NOT NULL DEFAULT 0 CHECK (midterm_marks  BETWEEN 0 AND 30),
    endterm_marks  REAL    NOT NULL DEFAULT 0 CHECK (endterm_marks  BETWEEN 0 AND 50),
    total_marks    REAL    NOT NULL DEFAULT 0,
    grade_letter   TEXT,
    grade_point    REAL,
    updated_by     TEXT,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, course_id)
);

-- ------------------------------------------------ previous year question papers
CREATE TABLE hpu_pyq_paper (
    paper_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    course_code  TEXT    NOT NULL,
    subject_name TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    exam_type    TEXT    NOT NULL DEFAULT 'END-TERM FINAL',
    file_url     TEXT    NOT NULL,
    downloads    INTEGER NOT NULL DEFAULT 0,
    uploaded_by  TEXT    NOT NULL DEFAULT 'HPU EXAMINATION CELL'
);

-- ------------------------------------------------------------- exam schedule
CREATE TABLE hpu_exam_schedule (
    schedule_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_no TEXT,
    course_code    TEXT    NOT NULL,
    subject_name   TEXT    NOT NULL,
    exam_date      TEXT    NOT NULL,
    exam_day       TEXT    NOT NULL,
    start_time     TEXT    NOT NULL,
    end_time       TEXT    NOT NULL,
    venue          TEXT    NOT NULL,
    exam_type      TEXT    NOT NULL DEFAULT 'THEORY'
);

-- ----------------------------------------------------------------- worksheets
CREATE TABLE hpu_worksheet (
    worksheet_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    course_code    TEXT    NOT NULL REFERENCES hpu_course (course_code) ON DELETE CASCADE,
    title          TEXT    NOT NULL,
    batch_code     TEXT    NOT NULL,
    max_marks      REAL    NOT NULL DEFAULT 20,
    deadline_date  TEXT    NOT NULL,
    attachment_url TEXT,
    created_by     TEXT    NOT NULL DEFAULT 'FACULTY',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    is_active      INTEGER NOT NULL DEFAULT 1
);

-- ----------------------------------------------------- worksheet submissions
CREATE TABLE hpu_worksheet_submission (
    submission_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    worksheet_id      INTEGER NOT NULL REFERENCES hpu_worksheet (worksheet_id) ON DELETE CASCADE,
    student_id        INTEGER NOT NULL REFERENCES hpu_student   (student_id)   ON DELETE CASCADE,
    submitted_file    TEXT    NOT NULL,
    submitted_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    evaluation_status TEXT    NOT NULL DEFAULT 'SUBMITTED'
                               CHECK (evaluation_status IN
                                      ('NOT SUBMITTED', 'SUBMITTED', 'UNDER EVALUATION',
                                       'CHECKED & GRADED', 'LATE SUBMISSION')),
    obtained_marks    REAL,
    teacher_remarks   TEXT,
    evaluated_by      TEXT,
    evaluated_at      TEXT,
    UNIQUE (worksheet_id, student_id)
);

-- --------------------------------------------------------------- e-library
CREATE TABLE hpu_e_library (
    library_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    authors     TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    subject     TEXT    NOT NULL,
    publisher   TEXT,
    file_url    TEXT    NOT NULL,
    page_count  INTEGER,
    rating      REAL    NOT NULL DEFAULT 0,
    description TEXT
);

-- ----------------------------------------------------- notices / gazette
CREATE TABLE hpu_notice (
    notice_id INTEGER PRIMARY KEY AUTOINCREMENT,
    issued_on TEXT    NOT NULL,
    category  TEXT    NOT NULL,
    title     TEXT    NOT NULL,
    summary   TEXT    NOT NULL,
    issued_by TEXT    NOT NULL DEFAULT 'HPU ADMINISTRATOR',
    is_pinned INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------- auth sessions (server-side token registry)
CREATE TABLE hpu_auth_session (
    session_id TEXT PRIMARY KEY,                       -- JWT "jti"
    user_code  TEXT NOT NULL REFERENCES hpu_user_auth (user_code) ON DELETE CASCADE,
    issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    revoked_at TEXT
);

-- ---------------------------- audit log (append-only, mirrors TRG_AUDIT_APPEND_ONLY)
CREATE TABLE hpu_audit_log (
    log_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_role TEXT,
    actor_name TEXT,
    actor_code TEXT,
    action     TEXT    NOT NULL,
    target     TEXT,
    details    TEXT,
    ip_address TEXT,
    severity   TEXT    NOT NULL DEFAULT 'INFO'
                       CHECK (severity IN ('INFO', 'WARNING', 'SECURITY', 'CRITICAL')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON hpu_audit_log
BEGIN
    SELECT RAISE(ABORT, 'hpu_audit_log is append-only and cannot be modified');
END;

-- ---------------------------------------------------------------- indexes
CREATE INDEX ix_student_batch      ON hpu_student (batch_code, academic_status);
CREATE INDEX ix_enroll_course      ON hpu_enrollment (course_id);
CREATE INDEX ix_attendance_course  ON hpu_attendance (course_id);
CREATE INDEX ix_session_course     ON hpu_attendance_session (course_id, session_date DESC);
CREATE INDEX ix_mark_course        ON hpu_mark (course_id);
CREATE INDEX ix_submission_ws      ON hpu_worksheet_submission (worksheet_id, evaluation_status);
CREATE INDEX ix_audit_action       ON hpu_audit_log (action, created_at DESC);
CREATE INDEX ix_audit_time         ON hpu_audit_log (created_at DESC);
CREATE INDEX ix_notice_date        ON hpu_notice (issued_on DESC);
CREATE INDEX ix_session_expiry     ON hpu_auth_session (expires_at);
