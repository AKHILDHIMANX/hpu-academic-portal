# HPU Academic Portal

A role-based Learning Management System for Himachal Pradesh University, Shimla.
Three portals — **Student**, **Faculty** and **Admin Console** — served from a
single Flask process, backed by Oracle PL/SQL (with a zero-install SQLite mirror
for local demos).

The codebase is deliberately dependency-light and hand-written so every design
decision can be read, traced and defended in a viva.

---

## Quick start

```bash
python3 backend/app.py
```

Then open **<http://127.0.0.1:5050>**.

There is no build step and no `npm install`. The first boot creates
`backend/data/hpu_portal.sqlite3`, executes `database/schema_sqlite.sql`, loads
`database/seed.sql` and generates the 22 seeded PDFs. Subsequent boots reuse the
database, so all edits survive a restart.

Requires Python 3.11+ and Flask:

```bash
pip install -r backend/requirements.txt
```

### Demo accounts

| Role | Email | Password | Lands on | Notes |
| --- | --- | --- | --- | --- |
| Student | `akhil.dhiman@hpu.ac.in` | `student123` | `/` | Roll `HPU-CS-2023-882`, 6 subjects, CGPA 9.50 |
| Faculty | `prof.rsthakur@hpu.ac.in` | `teacher123` | `/teacher` | `F-CS-02`, allocated CS-601 & CS-606 |
| Admin | `admin@hpu.ac.in` | `admin123` | `/admin` | Full operational console |

The student also signs in with the roll number (`HPU-CS-2023-882`) in place of
the email. Every account is listed on the login page — click a card to fill the
form.

Passwords are stored as PBKDF2-HMAC-SHA256 (240,000 rounds) with a per-user
salt. The pre-computed hashes are baked into `database/seed.sql`, which is why
the demo credentials work on a completely fresh database.

---

## Project layout

Exactly three top-level folders, as required.

```
hpulms/
├── frontend/          HTML + CSS + vanilla JS only. No frameworks, no bundler.
│   ├── index.html         student portal shell
│   ├── teacher.html       faculty portal shell
│   ├── admin.html         admin console shell
│   ├── login.html         sign-in page
│   ├── 404.html           not-found page
│   └── assets/
│       ├── css/            tokens · base · components · portals
│       └── js/
│           ├── app.js      shared shell: guard, rail, tabs, theme, drawers
│           ├── login.js    sign-in flow
│           ├── core/       api · auth · ui · format · charts · motion · theme
│           └── pages/      student.js · teacher.js · admin.js
│
├── backend/           Python only.
│   ├── app.py             app factory, static serving, page gating, CSP
│   ├── wsgi.py            production entry point
│   ├── config.py          environment-driven settings
│   ├── seed.py            first-boot schema + seed runner
│   ├── core/              security · errors · validators · grading · decorators
│   ├── db/                engine (SQLite / Oracle) + repositories
│   ├── services/          audit trail writer
│   ├── api/               auth · academic · student · worksheets · teacher · admin · files
│   ├── scripts/           build_assets.py — generates the seeded PDFs
│   ├── assets/files/      22 generated PDFs (syllabus, PYQs, notes, templates)
│   ├── tests/test_api.py  144-assertion end-to-end suite
│   └── data/              SQLite database (created on first boot)
│
└── database/          PL/SQL.
    ├── schema.sql         canonical Oracle DDL — tables, indexes, package,
    │                      triggers, views, seed
    ├── schema_sqlite.sql  runtime mirror with 1:1 column parity
    └── seed.sql           shared seed data
```

Roughly 6,700 lines of Python, 7,100 of JavaScript, 3,400 of CSS and 1,300 of
SQL.

---

## Architecture

### One process, one origin

Flask serves both the JSON API and the static frontend, so the session cookie is
`httpOnly` + `SameSite=Lax` and there is **no CORS handshake and no preflight**.
Opening the site and calling the API are the same request pipeline.

### The request path

```
browser ──▶ app.py  ──▶ before_request   CSRF header, rate limit, session decode
                     ──▶ blueprint       @require_roles(...) gate
                     ──▶ repository      parameterised SQL only
                     ──▶ service         audit trail on every mutation
                     ──▶ core/responses   uniform JSON envelope
```

No SQL string is ever built by concatenating user input. Every query in
`backend/db/repositories/` is parameterised.

### RBAC is enforced on the server

`@require_roles("ADMIN")` sits on the blueprint route, and the role is read from
the database at login — a client-supplied `role` field is ignored entirely. Page
gating happens in `_guard()` inside `app.py`, which redirects an
unauthenticated visitor to `/login` and a wrong-role visitor to their own
portal **before** any HTML is sent. The JavaScript guards are defence in depth,
never the lock.

---

## Security

Everything here is standard library only, so each decision is auditable in the
source rather than hidden behind a dependency.

| Concern | Implementation |
| --- | --- |
| Password storage | `hashlib.pbkdf2_hmac('sha256', …)`, 240,000 rounds, 16-byte per-user salt |
| Session token | Hand-rolled HS256 JWT (`core/security.py`) with `jti`, `iat`, `exp` |
| Cookie | `hpu_session` — `httpOnly`, `SameSite=Lax`, `Secure` in production |
| CSRF | Every state-changing request must carry `X-HPU-REQUEST: hpu-portal` |
| Brute force | Sliding-window rate limiter on writes and on the login route |
| Logout | Revokes the `jti` server-side in `hpu_auth_session` |
| Password change | Increments `token_version`, invalidating every other session |
| XSS | All interpolated values pass through `esc()`; CSP has no `unsafe-eval` |
| SQL injection | Parameterised statements throughout |

`public_profile()` never returns a password hash or salt — the original build
leaked plaintext credentials through `/api/auth/current`; that endpoint no longer
exists.

The JWT secret falls back to a development key with a loud startup warning. Set
`HPU_SECRET_KEY` for anything real.

### Content Security Policy

```
script-src  'self' 'unsafe-inline' https://cdn.jsdelivr.net
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net
font-src    'self' https://fonts.gstatic.com data:
img-src     'self' data: blob:
```

Also sent: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: same-origin`.

---

## Frontend

No framework, no build step. Plain ES modules loaded natively by the browser.

- **Design tokens** — `tokens.css` defines one complete theme system per theme.
  Switching themes never breaks contrast because each is hand-tuned rather than
  generated by rotating a hue.
- **Themes** — Noir · Graphite · HDR · Cream · Alabaster. All monochrome: pure
  black, graphite, maximum-contrast white, warm cream, cool alabaster. Accent is
  pure white on dark and pure black on light. State colours are deliberately
  low-chroma. Grade colours are a *lightness ramp* — brighter means better — so a
  monochrome grade chart still reads as achievement.
- **No flash of wrong theme** — a tiny inline script in each page's `<head>`
  reads `localStorage` and sets `data-theme` before first paint.
- **Charts** — hand-rolled dependency-free SVG in `core/charts.js`: line, area,
  bar, donut, sparkline and progress rings. Series colours are read from CSS
  custom properties, and generated colours respect a per-theme `--chart-sat` so
  they stay desaturated.
- **Fonts** — Fraunces (display), Plus Jakarta Sans (UI), JetBrains Mono (data).
- **Motion** — a single `core/motion.js` observer drives reveal-on-scroll and
  counters, respecting `prefers-reduced-motion`.
- **Smooth scrolling** — native `scroll-behavior: smooth`, with the header
  scroll-progress bar and anchor offsets handled in CSS.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `?` | Shortcut sheet |
| `g` then `1`–`9` | Jump to the nth section |
| `t` | Cycle theme |
| `Esc` | Close the topmost overlay |

---

## The three portals

**Student** — attendance overall and per subject with a "lectures you may skip"
allowance, marks entry book, CGPA/SGPA history, grade distribution, standing
against the department curve, subject-wise breakdown, worksheet submission with
deadline countdowns, exam schedule, notices and the document vault.

**Faculty** — class rosters, attendance register, a marks-entry grid with live
grade calculation and running totals, worksheet publishing with submission
tracking, a grading queue, per-course analytics (class average, grade
distribution, defaulters), circulars and the vault.

**Admin Console** — command centre KPIs, a searchable student directory with
status filters, sorting, CSV export and bulk selection, faculty and curriculum
administration, worksheet administration including deadline extension, the
immutable audit trail, an RBAC permission matrix and system maintenance.

### Grading

Grade letters and points live in the `hpu_grade_scale` table and are resolved in
`backend/core/grading.py`, so the rule is data, not code:

| Grade | Range | Points | Classification |
| --- | --- | --- | --- |
| O | 90–100 | 10.0 | Outstanding |
| A+ | 80–89.99 | 9.0 | Excellent |
| A | 70–79.99 | 8.0 | Very Good |
| B+ | 60–69.99 | 7.0 | Good |
| B | 50–59.99 | 6.0 | Satisfactory |
| C | 45–49.99 | 5.0 | Average |
| P | 40–44.99 | 4.0 | Pass |
| F | below 40 | 0.0 | Fail |

Change a row in `hpu_grade_scale` and every chart, chip and CGPA recalculates.

---

## Database

`database/schema.sql` is the canonical **Oracle PL/SQL** definition: 18 tables,
16 sequences, 9 indexes, the `HPU_PORTAL_PKG` package (including the
`UPDATE_STUDENT_STATUS` and `UNLOCK_ATTENDANCE_PORTAL` procedures required by the
university syllabus), 4 triggers and 6 views.

For local demos the app runs `database/schema_sqlite.sql` instead — a mirror with
**1:1 column parity** so the same repositories and the same SQL work on both
engines.

```bash
HPU_DB_ENGINE=oracle HPU_ORACLE_USER=hpu HPU_ORACLE_PASSWORD=secret \
HPU_ORACLE_DSN=dbhost:1521/XEPDB1 python3 backend/app.py
```

See **[`database/README.md`](database/README.md)** for the Oracle deployment
procedure.

---

## Testing

```bash
python3 backend/tests/test_api.py
```

144 assertions across authentication, RBAC, session lifecycle, password
management, academic endpoints, admin operations, audit logging and file
delivery — including negative cases: CSRF rejection, cross-role denial, path
traversal attempts and validation failures. The suite restores anything it mutates.

---

## Regenerating assets

The 22 PDFs in `backend/assets/files/` are generated, not committed binaries:

```bash
python3 backend/scripts/build_assets.py
```

---

## Configuration

All optional; sensible defaults apply.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HPU_PORT` | `5050` | HTTP port |
| `HPU_SECRET_KEY` | dev key | JWT signing secret |
| `HPU_DB_ENGINE` | `sqlite` | `sqlite` or `oracle` |
| `HPU_SQLITE_PATH` | `backend/data/hpu_portal.sqlite3` | SQLite file location |
| `HPU_ORACLE_USER` | `hpu` | Oracle schema user |
| `HPU_ORACLE_PASSWORD` | — | Oracle password |
| `HPU_ORACLE_DSN` | `127.0.0.1:1521/XEPDB1` | Oracle connect descriptor |

---

## Responsive behaviour

| Width | Layout |
| --- | --- |
| ≥ 1280px | Full rail + content |
| 1025–1279px | Rail visible, tab strip hidden |
| 768–1024px | Rail collapses to icons; tab strip becomes the section label |
| < 768px | Off-canvas rail behind a scrim, bottom bar, single-column grids |

Tables scroll horizontally rather than squashing; charts resize via
`ResizeObserver`; the login page drops its aside panel below 1000px.

---

## Troubleshooting

**Port already in use** — `HPU_PORT=5051 python3 backend/app.py`

**Want a clean database** — stop the server, delete
`backend/data/hpu_portal.sqlite3`, restart. It rebuilds and reseeds itself.

**Signed out unexpectedly** — the JWT secret is regenerated when
`HPU_SECRET_KEY` is unset, so restarting the server invalidates old tokens. Set
`HPU_SECRET_KEY` to keep sessions across restarts.

**Stale CSS or JS** — hard-reload. During development the Werkzeug reloader is
active; assets are served with normal caching headers.
