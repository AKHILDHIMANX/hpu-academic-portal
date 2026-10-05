# Database — HPU Academic Portal

Two definitions of the same relational model, plus the seed data.

| File | Engine | Role |
| --- | --- | --- |
| `schema.sql` | Oracle 12c+ (PL/SQL) | **Canonical.** Deployed by the DBA to the production cluster. |
| `schema_sqlite.sql` | SQLite 3 | **Runtime mirror.** Executed automatically by the backend on first boot. |
| `seed.sql` | both | Demo dataset: 24 students, 6 faculty, 6 courses, a full term of attendance, marks, worksheets and audit rows. |

The two schema files are kept at **1:1 column parity** — same table names, same
column names, same order, same constraints — so the repositories in
`backend/db/repositories/` run unmodified against either engine. If you change
one, change the other.

---

## The model

18 tables across six concerns.

**Authentication** — `hpu_user_auth` (identity, role, PBKDF2 hash + salt, token
version), `hpu_auth_session` (issued JWTs, revocable by `jti`).

**People** — `hpu_student`, `hpu_teacher`.

**Academics** — `hpu_course`, `hpu_enrollment`, `hpu_teacher_allocation` (which
faculty owns which course), `hpu_attendance_session` (when a class met),
`hpu_attendance` (who was present), `hpu_exam_schedule`.

**Assessment** — `hpu_mark`, `hpu_grade_scale`, `hpu_worksheet`,
`hpu_worksheet_submission`.

**Content** — `hpu_e_library`, `hpu_pyq_paper`, `hpu_notice`.

**Audit** — `hpu_audit_log`.

### Referential integrity worth knowing

- `hpu_enrollment` is the join between a student and a course, and it carries the
  component scores (`internal_marks`, `midterm_marks`, `endterm_marks`). A
  student's CGPA is a credit-weighted average over these rows.
- `hpu_teacher_allocation` gates faculty access. A teacher calling
  `/api/teacher/roster?course=CS-603` without an allocation gets 403 even with a
  valid session — that check is in SQL, not in the UI.
- `hpu_audit_log` is append-only. `TRG_AUDIT_APPEND_ONLY` raises on `UPDATE` and
  `DELETE`.

---

## Grade scale as data

`hpu_grade_scale` holds the boundaries so the university can change a cutoff
without a code deploy:

| grade_letter | min_percent | max_percent | grade_point | classification |
| --- | --- | --- | --- | --- |
| O | 90.00 | 100.00 | 10.0 | OUTSTANDING |
| A+ | 80.00 | 89.99 | 9.0 | EXCELLENT |
| A | 70.00 | 79.99 | 8.0 | VERY GOOD |
| B+ | 60.00 | 69.99 | 7.0 | GOOD |
| B | 50.00 | 59.99 | 6.0 | SATISFACTORY |
| C | 45.00 | 49.99 | 5.0 | AVERAGE |
| P | 40.00 | 44.99 | 4.0 | PASS |
| F | 0.00 | 39.99 | 0.0 | FAIL |

`backend/core/grading.py` reads this table and caches it per request cycle, with
a hardcoded copy as a fallback. Both the Python and the PL/SQL implementations
resolve grades identically — `FN_COMPUTE_GRADE` in the package mirrors
`resolve_grade()`.

---

## Business rules enforced in the database

These are the two procedures the university syllabus requires, plus the rest of
the write surface. All writes go through `HPU_PORTAL_PKG` so validation lives in
one place.

| Object | Purpose |
| --- | --- |
| `HPU_PORTAL_PKG` | Package: 4 functions, 6 procedures |
| `FN_COMPUTE_GRADE(total)` | Percentage → grade letter |
| `FN_COMPUTE_POINT(total)` | Percentage → grade point |
| `FN_ATTENDANCE_STATUS(pct)` | `SAFE` / `WARNING` / `CRITICAL` |
| `FN_ACADEMIC_STATUS(pct)` | `ACTIVE` / `DETAINED` / `SUSPENDED` |
| `UPDATE_STUDENT_STATUS(roll, status)` | **Syllabus-mandated.** Changes standing and audits it. |
| `UNLOCK_ATTENDANCE_PORTAL(roll, unlock)` | **Syllabus-mandated.** Releases the attendance lock and audits it. |
| `PUNCH_ATTENDANCE(...)` | Records a session with present/absent per student. |
| `GRADE_WORKSHEET(...)` | Marks a submission and recomputes the grade. |
| `COMMIT_COLLEGIA_MARKS(...)` | Freezes a term's marks for publication. |
| `PUBLISH_NOTICE(...)` | Publishes a circular. |

### Triggers

| Trigger | Enforces |
| --- | --- |
| `TRG_MARK_BEFORE_INSERT_UPDATE` | Component marks are non-negative and within the maximum. |
| `TRG_SUBMISSION_BEFORE_INSERT_UPDATE` | Obtained marks cannot exceed the worksheet maximum. |
| `TRG_ATTENDANCE_CAP` | A student cannot be marked more than once per session. |
| `TRG_AUDIT_APPEND_ONLY` | The audit log rejects `UPDATE` and `DELETE`. |

### Views

`V_ATTENDANCE_SUMMARY`, `V_TRANSCRIPT`, `V_CLASS_SHEET`,
`V_PENDING_EVALUATIONS`, `V_STUDENT_DIRECTORY`, `V_FACULTY_DIRECTORY` — the read
models the portal and the examiner's reports run against.

---

## Deploying to Oracle

Tested against Oracle 19c and 21c.

### 1. Create the schema user

```sql
CREATE USER HPU IDENTIFIED BY "choose-a-strong-password";
GRANT CONNECT, RESOURCE TO HPU;
GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE,
      CREATE VIEW, CREATE TRIGGER, CREATE PROCEDURE TO HPU;
GRANT UNLIMITED TABLESPACE TO HPU;   -- or a quota
```

### 2. Run the schema

`schema.sql` begins with an order-safe drop utility, so it is re-runnable.

```bash
sqlplus hpu/'choose-a-strong-password'@HPU-CLUSTER-SHIMLA-01 @database/schema.sql
```

Or in SQL Developer / SQLcl: open `schema.sql` and run as script (F5).

Watch for `ORA-00955` (name already used) — the drop block should have cleared
it; if a run was interrupted, re-run the whole file.

### 3. Load the seed (optional — skip on production)

```bash
sqlplus hpu/... @database/seed.sql
```

### 4. Verify

```sql
SELECT COUNT(*) FROM hpu_student;        -- 24
SELECT COUNT(*) FROM hpu_enrollment;     -- 144
SELECT COUNT(*) FROM hpu_attendance;     -- 144
SELECT COUNT(*) FROM hpu_mark;           -- 144

-- No mark should be left without a resolved grade.
SELECT COUNT(*) FROM hpu_mark WHERE grade_letter IS NULL;   -- 0

-- The package compiles and grades correctly.
SELECT HPU_PORTAL_PKG.FN_COMPUTE_GRADE(92.4) FROM dual;     -- O
SELECT HPU_PORTAL_PKG.FN_COMPUTE_GRADE(37.0) FROM dual;     -- F

SELECT object_name, object_type, status
  FROM user_objects
 WHERE status <> 'VALID';                                  -- 0 rows
```

### 5. Point the backend at it

```bash
pip install oracledb

export HPU_DB_ENGINE=oracle
export HPU_ORACLE_USER=hpu
export HPU_ORACLE_PASSWORD='choose-a-strong-password'
export HPU_ORACLE_DSN=HPU-CLUSTER-SHIMLA-01:1521/XEPDB1

python3 backend/app.py
```

The repositories detect the engine from `HPU_DB_ENGINE` and rebind their
placeholders — Oracle uses `:1` style binds, SQLite uses `?`, and `db/engine.py`
translates. Application SQL is written once.

---

## Working on the schema locally

The SQLite mirror needs no Oracle installation:

```bash
rm backend/data/hpu_portal.sqlite3      # optional: force a clean rebuild
python3 backend/app.py                  # recreates + reseeds automatically
```

Inspect it directly:

```bash
sqlite3 backend/data/hpu_portal.sqlite3
sqlite> .tables
sqlite> SELECT roll_no, full_name, cgpa, academic_status FROM hpu_student
   ...> WHERE cgpa > 9 ORDER BY cgpa DESC;
```

`schema_sqlite.sql` executes on first boot only. To pick up an edit to the
schema, delete the database file and restart.

### Keeping the two in sync

When you add a column:

1. Add it to `database/schema.sql` in the same position it should occupy.
2. Add it to `database/schema_sqlite.sql` in the **same position** with the
   closest SQLite type (`NUMBER(7,2)` → `REAL`, `VARCHAR2(60)` → `TEXT`,
   `CLOB` → `TEXT`, `DATE` → `TEXT` holding `YYYY-MM-DD HH:MM:SS`).
3. Update the `INSERT` in `seed.sql` if it is affected.
4. Restart the app and run `python3 backend/tests/test_api.py` — 144 assertions
   must still pass.

---

## Notes on the demo data

- The three demo accounts have PBKDF2 hashes and salts baked into `seed.sql`, so
  they authenticate on any fresh database without a hashing step at seed time.
- `akhil.dhiman@hpu.ac.in` (roll `HPU-CS-2023-882`, `student_id` **2**) is the
  student behind the dashboard screenshots: 211/234 lectures = 90.2%, CGPA 9.50.
- `hpu_student` student_id 1 is deliberately a different record, so the admin
  directory's first row is not the demo student.
- Two students sit below the threshold on purpose so the defaulter and
  short-attendance features have something to show: one `DETAINED`, one
  `SUSPENDED`.
- The primary demo student cannot be deleted — the admin API returns 422 to
  protect the walkthrough account.
