/* =============================================================================
   pages/teacher.js — the faculty portal.
   -----------------------------------------------------------------------------
   This is the operational surface: punch attendance, enter marks, grade
   worksheets, publish circulars and read class analytics. Every write is
   validated server-side; the client mirrors those rules so the user gets
   instant feedback instead of a 422.
   ========================================================================== */

import { Api, downloadFrom } from '../core/api.js';
import { state, panel, setPanel } from '../app.js';
import {
  qs, qsa, on, toast, icon, esc, table, chip, bar, kv, statTile,
  emptyState, loader, openModal, withBusy, formData, confirmDialog,
} from '../core/ui.js';
import {
  num, pct, gpa, fmtDate, fmtDateShort, fmtRelative, toneFor, initials,
  daysUntil, urgency, attendanceBand, n2,
} from '../core/format.js';
import {
  lineChart, barChart, donutChart, progressRing, animateRings, cssVar,
} from '../core/charts.js';
import { refresh as refreshMotion } from '../core/motion.js';

const charts = [];
const killCharts = () => { while (charts.length) charts.pop()?.destroy?.(); };

/* Per-course working state so switching classes keeps the user's edits. */
const session = {
  course: null,
  classes: [],
  roster: null,
  marks: null,
  worksheets: null,
  pendingMarks: new Map(),
  punch: { date: '', slot: '', marks: new Map() },
};

function courseSelect(host) {
  const options = session.classes.map((c) => `
    <option value="${esc(c.course_code)}" ${c.course_code === session.course ? 'selected' : ''}>
      ${esc(c.course_code)} — ${esc(c.course_name)} (${num(c.total_students)} students)
    </option>`).join('');
  host.innerHTML = `<label class="field field--fluid" style="--fluid:280px">
    <span class="field__label">Active course</span>
    <select class="select" data-course-select>${options}</select>
  </label>`;
  const select = qs('[data-course-select]', host);
  select?.addEventListener('change', () => selectCourse(select.value));
}

async function selectCourse(code) {
  session.course = code;
  session.roster = null;
  session.marks = null;
  session.worksheets = null;
  session.pendingMarks.clear();
  session.punch.marks.clear();
  renderCourseViews();
  await loadCourse();
}

async function loadCourse() {
  if (!session.course) return;
  const code = session.course;
  const [roster, marks, worksheets] = await Promise.all([
    Api.teacherRoster(code).catch(() => null),
    Api.teacherMarks(code).catch(() => null),
    Api.teacherWorksheets(code).catch(() => null),
  ]);
  if (session.course !== code) return; // a newer selection won
  session.roster = roster?.roster ?? null;
  session.marks = marks ?? null;
  session.worksheets = worksheets ?? null;
  renderCourseViews();
  drawCourseCharts();
}

/* ============================================================ overview === */

function overviewPanel(data) {
  const k = data.kpis ?? {};
  const w = data.warning ?? {};
  const profile = data.profile ?? {};

  return `
    <section class="hero" data-reveal>
      <div>
        <p class="eyebrow">${esc(profile.faculty_code ?? '')} · ${esc(profile.designation ?? '')}</p>
        <h1 class="hero__greeting">Welcome back, <em>${esc(profile.full_name ?? 'Faculty')}</em>.</h1>
        <p class="hero__sub">
          You teach <strong>${num(k.courses)} courses</strong> to
          <strong>${num(k.students)} students</strong>.
          ${k.pending_evaluations ? `<strong>${num(k.pending_evaluations)} worksheets</strong> await evaluation.` : 'No evaluations are pending.'}
        </p>
        <div class="hero__chips">
          ${chip(w.level === 'URGENT' ? 'DEADLINE URGENT' : `DEADLINE ${esc(w.level ?? 'CLEAR')}`,
            w.level === 'URGENT' ? 'danger' : w.level === 'WATCH' ? 'warning' : 'success', { dot: true })}
          ${chip(`${num(k.sessions_punched)} SESSIONS PUNCHED`, 'accent')}
          ${chip(profile.cabin_status ?? 'ON CAMPUS', toneFor(profile.cabin_status), { dot: true })}
        </div>
      </div>
      <div class="hero__rings">
        ${progressRing({
          value: Math.min((w.days_to_deadline ?? 30) / 30, 1) * 100, size: 138, thickness: 12,
          color: cssVar(w.level === 'URGENT' ? '--danger' : w.level === 'WATCH' ? '--warning' : '--success'),
          caption: 'DAYS TO DEADLINE', figure: String(w.days_to_deadline ?? '—'), id: 'ring-deadline',
        })}
        ${progressRing({
          value: Math.min((k.worksheets ?? 0) ? (k.pending_evaluations / Math.max(k.worksheets, 1)) * 100 : 0, 100),
          size: 138, thickness: 12, color: cssVar('--accent'),
          caption: 'EVAL BACKLOG', figure: num(k.pending_evaluations ?? 0), id: 'ring-backlog',
        })}
      </div>
    </section>

    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Courses', icon: icon('book', 13), value: num(k.courses),
        tone: 'var(--accent-soft)', meta: `${num(k.credits ?? 0)} credit hours` })}
      ${statTile({ label: 'Students', icon: icon('users', 13), value: num(k.students),
        tone: 'var(--secondary-soft)', meta: 'Unique across allocations' })}
      ${statTile({ label: 'Sessions punched', icon: icon('checkCircle', 13),
        value: num(k.sessions_punched), tone: 'var(--success-soft)',
        meta: 'Attendance records created' })}
      ${statTile({ label: 'Pending evaluations', icon: icon('file', 13),
        value: num(k.pending_evaluations), tone: 'var(--warning-soft)',
        meta: `${num(k.worksheets ?? 0)} worksheets published` })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <h3 class="card__title">Your allocations</h3>
        </header>
        <div class="card__body stack stack-s">
          ${(data.allocations ?? []).map((a) => `
            <button class="card card--pad-s card--hover" type="button" data-pick-course="${esc(a.course_code)}"
                    style="text-align:left;display:grid;gap:6px">
              <div class="cluster cluster-between">
                <span class="mono text-accent" style="font-weight:700">${esc(a.course_code)}</span>
                ${chip(`SEM ${a.semester}`, 'ghost')}
              </div>
              <p style="font-weight:700;font-size:var(--step--1)">${esc(a.course_name)}</p>
              <div class="cluster cluster-s">
                ${chip(`${num(a.credits)} CR`, 'accent')}
                ${chip(`${num(a.total_students)} STUDENTS`, 'info')}
                ${chip(a.batch_code ?? '', 'ghost')}
              </div>
            </button>`).join('')}
        </div>
      </article>

      <div class="stack">
        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Recent attendance sessions</h3>
          </header>
          <div class="card__body">
            ${table({
              columns: [
                { key: 'session_date', label: 'Date', header: true,
                  render: (r) => `<div><span class="mono">${esc(fmtDateShort(r.session_date))}</span>
                    <span class="faint" style="font-size:.62rem;display:block">${esc(r.slot ?? '')}</span></div>` },
                { key: 'course_code', label: 'Course',
                  render: (r) => `<span class="mono text-accent">${esc(r.course_code)}</span>` },
                { key: 'percentage', label: 'Present %', align: 'right',
                  render: (r) => {
                    const b = attendanceBand(r.percentage);
                    return `<span class="mono text-${b}">${pct(r.percentage, 1)}</span>`;
                  } },
                { key: 'absent_count', label: 'Absent', align: 'right',
                  render: (r) => `<span class="mono dim">${num(r.absent_count)}</span>` },
              ],
              rows: data.recent_sessions ?? [],
              rowKey: (r) => r.session_id,
              empty: 'No sessions punched yet',
            })}
          </div>
        </article>

        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Evaluation queue</h3>
          </header>
          <div class="card__body">
            ${(data.worksheets ?? []).length ? (data.worksheets ?? []).map((w) => {
              const rate = w.submission_rate ?? 0;
              const b = attendanceBand(rate);
              return `
                <div class="att-row">
                  <div style="min-width:0">
                    <p class="att-row__name truncate">${esc(w.title)}</p>
                    <p class="att-row__meta">${esc(w.course_code)} ·
                      ${num(w.submitted)}/${num(w.total_students)} submitted ·
                      avg ${num(w.average_marks ?? 0)}</p>
                  </div>
                  <div style="text-align:right">
                    <span class="att-row__figure text-${b}">${pct(rate, 0)}</span>
                  </div>
                  <div class="att-row__bar">${bar(rate, { tone: b })}</div>
                </div>`;
            }).join('') : emptyState({ title: 'Nothing to evaluate', icon: 'check' })}
          </div>
        </article>
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Teaching schedule</h3>
          <p class="card__sub">Office hours and grading deadline</p>
        </div>
      </header>
      <div class="card__body grid grid-3">
        ${kv('Office', profile.office_location ?? '—')}
        ${kv('Office hours', profile.office_hours ?? '—')}
        ${kv('Grading deadline', fmtDate(profile.grading_deadline, { withDay: true }))}
        ${kv('Department', profile.department ?? '—')}
        ${kv('Email', profile.email ?? '—')}
        ${kv('Courses this term', num(k.courses ?? 0))}
      </div>
    </section>`;
}

/* =========================================================== attendance == */

function attendancePanel() {
  const roster = session.roster;
  const slots = roster?.slots ?? [];
  const students = roster?.students ?? [];
  const summary = roster?.summary ?? {};

  if (!roster) {
    return `<div class="card">${loader('Loading roster')}</div>`;
  }

  const marked = session.punch.marks.size;

  return `
    <div class="punch-toolbar" data-reveal>
      <div data-course-select-host style="display:contents"></div>

      <label class="field field--fluid" style="--fluid:170px">
        <span class="field__label">Session date</span>
        <input class="input" type="date" data-punch-date max="${esc(new Date().toISOString().slice(0, 10))}"
               value="${esc(session.punch.date)}">
      </label>

      <label class="field field--fluid" style="--fluid:210px">
        <span class="field__label">Slot</span>
        <select class="select" data-punch-slot>
          <option value="">Select a slot</option>
          ${slots.map((s) => `<option value="${esc(s)}" ${
            s === session.punch.slot ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>

      <div class="cluster cluster-s" style="margin-left:auto">
        <button class="btn btn--secondary btn--sm" type="button" data-mark-all="P">
          Mark all present</button>
        <button class="btn btn--ghost btn--sm" type="button" data-mark-all="A">
          Clear all</button>
        <button class="btn btn--primary" type="button" data-submit-punch
                ${marked === 0 ? 'disabled' : ''}>
          ${icon('save')} Commit ${marked} record${marked === 1 ? '' : 's'}
        </button>
      </div>
    </div>

    <section class="grid grid-4" style="margin-bottom:var(--space-m)">
      ${statTile({ label: 'On roster', icon: icon('users', 13), value: num(summary.total_students ?? students.length),
        tone: 'var(--accent-soft)', meta: `${esc(roster.course?.code ?? '')} · ${esc(roster.course?.batch_code ?? '')}` })}
      ${statTile({ label: 'Marked now', icon: icon('checkCircle', 13), value: num(marked),
        tone: 'var(--success-soft)', meta: 'In this punch session' })}
      ${statTile({ label: 'Present', icon: icon('checkCircle', 13),
        value: num([...session.punch.marks.values()].filter((m) => m === 'P').length),
        tone: 'var(--success-soft)', meta: 'Awaiting commit' })}
      ${statTile({ label: 'Absent / late', icon: icon('alert', 13),
        value: num([...session.punch.marks.values()].filter((m) => m !== 'P').length),
        tone: 'var(--danger-soft)', meta: 'Awaiting commit' })}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">${esc(roster.course?.name ?? '')}</h3>
          <p class="card__sub">Tap P, A or L on each student. Nothing is saved until you commit.</p>
        </div>
        <span class="chip chip--ghost" data-roster-count>${num(students.length)} STUDENTS</span>
      </header>
      <div class="card__body">
        <div class="punch-grid" data-punch-grid>
          ${students.map((s) => {
            const current = session.punch.marks.get(s.roll_no);
            return `
              <div class="punch-card" data-roll="${esc(s.roll_no)}">
                <span class="avatar" style="width:32px;height:32px;font-size:.7rem">
                  ${esc(s.initials ?? initials(s.first_name, s.last_name))}</span>
                <span class="punch-card__info">
                  <span class="punch-card__name">${esc(s.full_name)}</span>
                  <span class="punch-card__roll">${esc(s.roll_no)}</span>
                </span>
                <span class="mark-toggle" role="group" aria-label="Attendance for ${esc(s.full_name)}">
                  ${['P', 'A', 'L'].map((m) => `
                    <button type="button" data-mark="${m}" data-roll="${esc(s.roll_no)}"
                            aria-pressed="${current === m}"
                            aria-label="${m === 'P' ? 'Present' : m === 'A' ? 'Absent' : 'Late'}">
                      ${m}</button>`).join('')}
                </span>
              </div>`;
          }).join('')}
        </div>
        ${students.length ? '' : emptyState({ title: 'No students enrolled',
          text: 'This course has no enrolments yet.' })}
      </div>
    </section>

    <section class="card" style="margin-top:var(--space-l)" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Attendance trend</h3>
          <p class="card__sub">Class attendance percentage by session date</p>
        </div>
      </header>
      <div class="card__body" data-chart="trend"></div>
    </section>

    <section class="card" style="margin-top:var(--space-l)" data-reveal>
      <header class="card__head">
        <h3 class="card__title">Punched sessions</h3>
      </header>
      <div class="card__body" data-session-log>${loader('Loading session log')}</div>
    </section>`;
}

/* ================================================================= marks == */

function marksPanel() {
  const marks = session.marks;
  if (!marks) return `<div class="card">${loader('Loading marks sheet')}</div>`;

  const rows = marks.rows ?? [];
  const max = marks.maxima ?? {};
  const summary = marks.summary ?? {};
  const dirty = session.pendingMarks.size;

  return `
    <div class="punch-toolbar" data-reveal>
      <div data-course-select-host style="display:contents"></div>
      <div class="cluster cluster-s" style="margin-left:auto">
        <span class="chip chip--ghost">MAX ${num(max.internal)}/${num(max.midterm)}/${num(max.endterm)}</span>
        ${dirty ? `<span class="chip chip--warning">${dirty} UNSAVED</span>` : ''}
        <button class="btn btn--primary" type="button" data-save-marks ${dirty ? '' : 'disabled'}>
          ${icon('save')} Save ${dirty || ''} change${dirty === 1 ? '' : 's'}
        </button>
      </div>
    </div>

    <section class="grid grid-4" style="margin-bottom:var(--space-m)">
      ${statTile({ label: 'Class average', icon: icon('trend', 13), value: pct(summary.average ?? 0),
        tone: 'var(--accent-soft)', meta: 'Aggregate of all subjects' })}
      ${statTile({ label: 'Highest', icon: icon('award', 13), value: num(summary.highest ?? 0),
        tone: 'var(--success-soft)', meta: 'Total marks' })}
      ${statTile({ label: 'Lowest', icon: icon('alert', 13), value: num(summary.lowest ?? 0),
        tone: 'var(--danger-soft)', meta: 'Total marks' })}
      ${statTile({ label: 'Ungraded', icon: icon('file', 13), value: num(summary.ungraded ?? 0),
        tone: 'var(--warning-soft)', meta: `${num(summary.graded ?? 0)} graded` })}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Marks sheet</h3>
          <p class="card__sub">Grades are derived server-side from the HPU scale — edit the three
            components and the grade updates instantly.</p>
        </div>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'roll_no', label: 'Roll', header: true,
              render: (r) => `<div class="cluster cluster-s">
                <span class="avatar" style="width:30px;height:30px;font-size:.66rem">${esc(r.initials ?? '??')}</span>
                <span><span style="display:block;font-size:var(--step--1)">${esc(r.full_name)}</span>
                <span class="mono faint" style="font-size:.62rem">${esc(r.roll_no)}</span></span></div>` },
            { key: 'internal_marks', label: `Internal /${max.internal}`, align: 'right',
              render: (r) => `<input class="grade-input" type="number" step="0.1"
                min="0" max="${max.internal}" value="${r.internal_marks ?? ''}"
                data-student="${r.student_id}" data-component="internal_marks"
                aria-label="Internal marks for ${esc(r.full_name)}">` },
            { key: 'midterm_marks', label: `Midterm /${max.midterm}`, align: 'right',
              render: (r) => `<input class="grade-input" type="number" step="0.1"
                min="0" max="${max.midterm}" value="${r.midterm_marks ?? ''}"
                data-student="${r.student_id}" data-component="midterm_marks"
                aria-label="Midterm marks for ${esc(r.full_name)}">` },
            { key: 'endterm_marks', label: `Endterm /${max.endterm}`, align: 'right',
              render: (r) => `<input class="grade-input" type="number" step="0.1"
                min="0" max="${max.endterm}" value="${r.endterm_marks ?? ''}"
                data-student="${r.student_id}" data-component="endterm_marks"
                aria-label="Endterm marks for ${esc(r.full_name)}">` },
            { key: 'total_marks', label: 'Total', align: 'right',
              render: (r) => `<span class="mono" style="font-weight:700"
                data-total="${r.student_id}">${num(r.total_marks ?? 0)}</span>` },
            { key: 'grade_letter', label: 'Grade', align: 'right',
              render: (r) => `<span class="chip chip--grade" data-live-grade="${r.student_id}"
                data-grade="${esc(r.grade_letter ?? '—')}">${esc(r.grade_letter ?? '—')}</span>` },
            { key: 'save', label: '', align: 'right',
              render: (r) => `<button class="btn btn--ghost btn--icon btn--sm" type="button"
                data-save-one="${r.student_id}" aria-label="Save marks for ${esc(r.full_name)}">
                ${icon('save')}</button>` },
          ],
          rows,
          rowKey: (r) => r.student_id,
          empty: 'No students on this roster',
        })}
      </div>
    </section>`;
}

/* =========================================================== worksheets == */

function worksheetsPanel() {
  const data = session.worksheets;
  if (!data) return `<div class="card">${loader('Loading worksheets')}</div>`;

  const detail = data.detail ?? [];
  const queue = data.queue ?? [];

  return `
    <div class="punch-toolbar" data-reveal>
      <div data-course-select-host style="display:contents"></div>
      <div class="cluster cluster-s" style="margin-left:auto">
        <button class="btn btn--secondary" type="button" data-new-worksheet>
          ${icon('plus')} Publish worksheet
        </button>
      </div>
    </div>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      ${detail.map((w) => {
        const rate = w.submission_rate ?? 0;
        const b = attendanceBand(rate);
        return `
          <article class="card card--hover" data-reveal>
            <header class="card__head">
              <div style="min-width:0">
                <p class="mono text-accent" style="font-size:.64rem;letter-spacing:.14em">
                  ${esc(w.course_code)} · ${num(w.max_marks)} MARKS</p>
                <h3 class="card__title card__title--sm" style="margin-top:4px">${esc(w.title)}</h3>
              </div>
              ${chip(urgency(w.deadline_date).label, urgency(w.deadline_date).tone)}
            </header>
            <div class="card__body stack stack-s">
              <div class="att-row">
                <div>
                  <p class="att-row__name">Submission rate</p>
                  <p class="att-row__meta">${num(w.submitted)} of ${num(w.total_students)} students</p>
                </div>
                <span class="att-row__figure text-${b}">${pct(rate, 0)}</span>
                <div class="att-row__bar">${bar(rate, { tone: b })}</div>
              </div>
              <div class="cluster cluster-s">
                ${chip(`${num(w.graded)} GRADED`, 'success')}
                ${chip(`${num(w.pending)} PENDING`, w.pending ? 'warning' : 'ghost')}
                ${chip(`AVG ${num(w.average_marks ?? 0)}`, 'ghost')}
              </div>
            </div>
            <footer class="card__foot">
              <button class="btn btn--soft btn--sm" type="button"
                      data-open-submissions="${w.worksheet_id}">
                ${icon('users')} Review submissions
              </button>
            </footer>
          </article>`;
      }).join('')}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Evaluation queue</h3>
          <p class="card__sub">Submissions waiting to be graded, oldest first</p>
        </div>
        <span class="chip chip--${queue.length ? 'warning' : 'success'}">${num(queue.length)} PENDING</span>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'student_id', label: 'Student', header: true,
              render: (r) => `<div class="cluster cluster-s">
                <span class="avatar" style="width:30px;height:30px;font-size:.66rem">
                  ${esc(initials(...String(r.full_name ?? ' ').split(' ')))}</span>
                <span><span style="display:block;font-size:var(--step--1)">${esc(r.full_name)}</span>
                <span class="mono faint" style="font-size:.62rem">${esc(r.roll_no)}</span></span></div>` },
            { key: 'title', label: 'Worksheet', header: true,
              render: (r) => `<div><span class="clamp-2" style="display:block">${esc(r.title)}</span>
                <span class="mono faint" style="font-size:.62rem">${esc(r.course_code)}</span></div>` },
            { key: 'submitted_at', label: 'Submitted',
              render: (r) => `<div><span class="mono" style="font-size:.7rem">${esc(fmtDateShort(r.submitted_at))}</span>
                <span class="faint" style="font-size:.62rem;display:block">${esc(fmtRelative(r.submitted_at))}</span></div>` },
            { key: 'evaluation_status', label: 'Status',
              render: (r) => chip(r.evaluation_status, toneFor(r.evaluation_status), { dot: true }) },
            { key: 'max_marks', label: 'Max', align: 'right',
              render: (r) => `<span class="mono dim">${num(r.max_marks)}</span>` },
            { key: 'grade', label: '', align: 'right',
              render: (r) => `<button class="btn btn--soft btn--sm" type="button"
                data-grade-sub="${r.submission_id}" data-worksheet="${r.worksheet_id}"
                data-max="${num(r.max_marks)}"
                data-title="${esc(r.title)}" data-student="${esc(r.full_name)}">
                ${icon('edit')} Grade</button>` },
          ],
          rows: queue,
          rowKey: (r) => r.submission_id,
          empty: 'Nothing to grade — the queue is clear',
        })}
      </div>
    </section>`;
}

/* ============================================================ analytics == */

function analyticsPanel(data) {
  const a = data.analytics ?? {};
  // The API splits this two ways: `per_course` is attendance (yours only),
  // `subject_performance` is marks across the whole batch. Keep them apart.
  const perCourse = a.per_course ?? [];
  const subjects = a.subject_performance ?? [];
  const ranked = [...subjects].sort((x, y) => n2(y.average) - n2(x.average));
  const best = ranked[0] ?? null;
  const worst = ranked[ranked.length - 1] ?? null;

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Defaulters', icon: icon('alert', 13), value: num((a.defaulters ?? []).length),
        tone: 'var(--danger-soft)', meta: 'Below 5 grade point or 40% in a subject' })}
      ${statTile({ label: 'Classes analysed', icon: icon('book', 13), value: num(subjects.length),
        tone: 'var(--accent-soft)', meta: 'Subjects with published marks' })}
      ${statTile({ label: 'Best performing course', icon: icon('award', 13),
        value: esc(best?.course_code ?? '—'),
        tone: 'var(--success-soft)', meta: best ? `${pct(n2(best.average), 1)} class average` : 'No marks yet' })}
      ${statTile({ label: 'Weakest course', icon: icon('trend', 13),
        value: esc(worst?.course_code ?? '—'),
        tone: 'var(--warning-soft)', meta: worst ? `${pct(n2(worst.average), 1)} class average` : 'No marks yet' })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Average by course</h3>
            <p class="card__sub">Class average across every graded component</p>
          </div>
        </header>
        <div class="card__body" data-chart="course-avg"></div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Students by performance band</h3>
            <p class="card__sub">Mark entries by letter grade</p>
          </div>
        </header>
        <div class="card__body" data-chart="bands"></div>
      </article>
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <h3 class="card__title">Subject performance</h3>
        </header>
        <div class="card__body">
          ${table({
            columns: [
              { key: 'course_code', label: 'Course', header: true,
                render: (r) => `<div><span class="mono">${esc(r.course_code)}</span>
                  <span class="mono faint" style="font-size:.62rem;display:block">${esc(r.course_name ?? '')}</span></div>` },
              { key: 'average', label: 'Average', align: 'right',
                render: (r) => `<span class="mono">${pct(n2(r.average), 1)}</span>` },
              { key: 'average_point', label: 'Avg point', align: 'right',
                render: (r) => `<span class="mono dim">${gpa(r.average_point)}</span>` },
              { key: 'lowest', label: 'Low', align: 'right',
                render: (r) => `<span class="mono text-danger">${pct(n2(r.lowest), 1)}</span>` },
              { key: 'highest', label: 'High', align: 'right',
                render: (r) => `<span class="mono">${pct(n2(r.highest), 1)}</span>` },
            ],
            rows: subjects,
            rowKey: (r) => r.course_code,
            empty: 'No marks published yet',
          })}
        </div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Attendance by course</h3>
            <p class="card__sub">Your allocations only</p>
          </div>
        </header>
        <div class="card__body">
          ${table({
            columns: [
              { key: 'course_code', label: 'Course', header: true,
                render: (r) => `<div><span class="mono">${esc(r.course_code)}</span>
                  <span class="mono faint" style="font-size:.62rem;display:block">${esc(r.course_name ?? '')}</span></div>` },
              { key: 'average_attendance', label: 'Average', align: 'right',
                render: (r) => `<span class="mono">${pct(n2(r.average_attendance), 1)}</span>` },
              { key: 'students', label: 'Students', align: 'right',
                render: (r) => `<span class="mono dim">${num(r.students)}</span>` },
              { key: 'below_75', label: '< 75%', align: 'right',
                render: (r) => `<span class="mono ${n2(r.below_75) > 0 ? 'text-warning' : 'faint'}">${num(r.below_75)}</span>` },
              { key: 'below_65', label: '< 65%', align: 'right',
                render: (r) => `<span class="mono ${n2(r.below_65) > 0 ? 'text-danger' : 'faint'}">${num(r.below_65)}</span>` },
            ],
            rows: perCourse,
            rowKey: (r) => r.course_code,
            empty: 'No courses allocated',
          })}
        </div>
      </article>
    </section>

    <section class="card" style="margin-bottom:var(--space-l)" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Defaulters</h3>
          <p class="card__sub">Students below the passing threshold — contact them before the deadline</p>
        </div>
        <span class="chip chip--danger">${num((a.defaulters ?? []).length)} STUDENTS</span>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'roll_no', label: 'Roll', header: true,
              render: (r) => `<span class="mono">${esc(r.roll_no)}</span>` },
            { key: 'full_name', label: 'Student', header: true,
              render: (r) => `<div class="cluster cluster-s">
                <span class="avatar" style="width:30px;height:30px;font-size:.66rem">${esc(r.initials ?? '??')}</span>
                <span>${esc(r.full_name)}</span></div>` },
            { key: 'cgpa', label: 'CGPA', align: 'right',
              render: (r) => `<span class="mono ${r.cgpa < 5 ? 'text-danger' : ''}">${gpa(r.cgpa)}</span>` },
            { key: 'weakest', label: 'Weakest subject', align: 'right',
              render: (r) => `<span class="mono text-danger">${num(r.weakest)}%</span>` },
            { key: 'academic_status', label: 'Status',
              render: (r) => chip(r.academic_status, toneFor(r.academic_status), { dot: true }) },
          ],
          rows: a.defaulters ?? [],
          rowKey: (r) => r.roll_no,
          empty: 'No defaulters — the whole class is above the threshold',
        })}
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <h3 class="card__title">Per-course detail</h3>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Course', header: true,
              render: (r) => `<div><span class="mono text-accent">${esc(r.course_code)}</span>
                <span class="faint" style="font-size:.64rem;display:block">${esc(r.course_name ?? '')}</span></div>` },
            { key: 'students', label: 'Students', align: 'right',
              render: (r) => `<span class="mono">${num(r.students)}</span>` },
            { key: 'average', label: 'Average', align: 'right',
              render: (r) => `<span class="mono">${pct(r.average ?? 0)}</span>` },
            { key: 'highest', label: 'Highest', align: 'right',
              render: (r) => `<span class="mono text-success">${num(r.highest)}</span>` },
            { key: 'lowest', label: 'Lowest', align: 'right',
              render: (r) => `<span class="mono text-danger">${num(r.lowest)}</span>` },
            { key: 'fail_count', label: 'Fails', align: 'right',
              render: (r) => `<span class="mono ${r.fail_count ? 'text-danger' : ''}">${num(r.fail_count)}</span>` },
          ],
          rows: perCourse,
          rowKey: (r) => r.course_code,
          empty: 'No marks recorded yet',
        })}
      </div>
    </section>`;
}

/* ============================================================== notices == */

function noticesPanel(data) {
  const notices = data.notices ?? [];

  return `
    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Publish a circular</h3>
          <p class="card__sub">Visible to every student in the portal immediately</p>
        </div>
      </header>
      <div class="card__body">
        <form id="noticeForm" class="stack stack-s">
          <div class="grid grid-2">
            <label class="field">
              <span class="field__label">Category</span>
              <select class="select" name="category">
                <option value="ACADEMIC CIRCULAR">Academic circular</option>
                <option value="ASSIGNMENT">Assignment</option>
                <option value="EXAM DATE SHEET">Exam date sheet</option>
                <option value="RESULT">Result</option>
                <option value="GENERAL">General</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">Title</span>
              <input class="input" name="title" maxlength="160" required
                     placeholder="e.g. Worksheet 05 published for CS-601">
            </label>
          </div>
          <label class="field">
            <span class="field__label">Summary</span>
            <textarea class="textarea" name="summary" maxlength="1200" required
                      placeholder="Write the announcement body students should read."></textarea>
          </label>
          <div class="cluster cluster-end">
            <button class="btn btn--primary" type="submit">${icon('bell')} Publish circular</button>
          </div>
        </form>
      </div>
    </section>

    <section class="card" style="margin-top:var(--space-l)" data-reveal>
      <header class="card__head">
        <h3 class="card__title">Live circulars</h3>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'title', label: 'Title', header: true,
              render: (r) => `<div><span style="display:block">${esc(r.title)}</span>
                <span class="clamp-2 faint" style="font-size:.66rem">${esc(r.summary)}</span></div>` },
            { key: 'category', label: 'Category',
              render: (r) => chip(r.category, 'accent') },
            { key: 'is_pinned', label: 'Pinned',
              render: (r) => (r.is_pinned ? chip('PINNED', 'brand') : '<span class="faint">—</span>') },
            { key: 'issued_on', label: 'Issued',
              render: (r) => `<span class="mono" style="font-size:.7rem">${esc(fmtDateShort(r.issued_on))}</span>` },
          ],
          rows: notices,
          rowKey: (r) => r.notice_id,
          empty: 'No circulars published',
        })}
      </div>
    </section>`;
}

/* =========================================================== modal flows = */

/** Single entry point for the grade action, wherever the button lives. */
function gradeFrom(button) {
  openGradingModal({
    submissionId: button.dataset.gradeSub,
    worksheetId: button.dataset.worksheet,
    maxMarks: button.dataset.max,
    title: button.dataset.title,
    studentName: button.dataset.student,
  });
}

function openGradingModal({ submissionId, worksheetId, maxMarks, title, studentName }) {
  openModal({
    title: 'Grade submission',
    subtitle: `${title} · ${studentName}`,
    body: `
      <form id="gradeForm" class="stack stack-s">
        <label class="field">
          <span class="field__label">Marks obtained (out of ${num(maxMarks)})</span>
          <input class="input" type="number" name="obtained_marks" min="0" max="${maxMarks}"
                 step="0.5" required autofocus placeholder="0">
          <span class="field__hint">The server refuses anything above the maximum.</span>
        </label>
        <label class="field">
          <span class="field__label">Remarks</span>
          <textarea class="textarea" name="remarks" maxlength="500"
                    placeholder="Feedback shown to the student"></textarea>
        </label>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>${icon('check')} Submit grade</button>`,
    onMount(backdrop, close) {
      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const data = formData(qs('#gradeForm', backdrop), { numbers: ['obtained_marks'] });
        if (data.obtained_marks === '' || data.obtained_marks === undefined) {
          toast('Enter the marks obtained.', { type: 'warning' });
          return;
        }
        await withBusy(event.currentTarget, async () => {
          try {
            await Api.teacherGradeWorksheet(worksheetId, {
              submission_id: Number(submissionId),
              obtained_marks: data.obtained_marks,
              remarks: data.remarks ?? '',
            });
            toast('Grade recorded.', { type: 'success' });
            close();
            await loadCourse();
          } catch (error) {
            toast(error.message, { type: 'error', title: 'Grading failed' });
          }
        });
      });
    },
  });
}

function openNewWorksheetModal() {
  openModal({
    title: 'Publish worksheet',
    subtitle: 'Attached to a course for the whole batch',
    body: `
      <form id="wsNewForm" class="stack stack-s">
        <label class="field">
          <span class="field__label">Title</span>
          <input class="input" name="title" maxlength="180" required
                 placeholder="WORKSHEET 05: INDEXING & QUERY OPTIMISATION">
        </label>
        <div class="grid grid-2">
          <label class="field">
            <span class="field__label">Maximum marks</span>
            <input class="input" type="number" name="max_marks" value="20" min="1" max="100" required>
          </label>
          <label class="field">
            <span class="field__label">Deadline</span>
            <input class="input" type="date" name="deadline_date" required
                   min="${esc(new Date().toISOString().slice(0, 10))}">
          </label>
        </div>
        <p class="field__hint">Students see it immediately and can upload a PDF answer sheet.</p>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>${icon('plus')} Publish</button>`,
    onMount(backdrop, close) {
      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const data = formData(qs('#wsNewForm', backdrop), { numbers: ['max_marks'] });
        if (!data.title) { toast('A title is required.', { type: 'warning' }); return; }
        await withBusy(event.currentTarget, async () => {
          try {
            await Api.teacherCreateWorksheet({ ...data, course_code: session.course });
            toast('Worksheet published to the batch.', { type: 'success' });
            close();
            await loadCourse();
          } catch (error) {
            toast(error.message, { type: 'error', title: 'Could not publish' });
          }
        });
      });
    },
  });
}

function openSubmissionsModal(worksheetId) {
  session.pendingWorksheetId = worksheetId;
  const detail = session.worksheets?.detail?.find((d) => String(d.worksheet_id) === String(worksheetId));
  if (!detail) return;

  openModal({
    title: detail.title,
    subtitle: `${num(detail.submitted)} submissions · avg ${num(detail.average_marks ?? 0)} of ${num(detail.max_marks)}`,
    wide: true,
    tall: true,
    body: table({
      columns: [
        { key: 'full_name', label: 'Student', header: true,
          render: (r) => `<div><span style="display:block">${esc(r.full_name)}</span>
            <span class="mono faint" style="font-size:.62rem">${esc(r.roll_no ?? r.email ?? '')}</span></div>` },
        { key: 'submitted_at', label: 'Submitted',
          render: (r) => `<span class="mono" style="font-size:.7rem">${esc(fmtDateShort(r.submitted_at))}</span>` },
        { key: 'evaluation_status', label: 'Status',
          render: (r) => chip(r.evaluation_status ?? '—', toneFor(r.evaluation_status ?? '—')) },
        { key: 'obtained_marks', label: 'Marks', align: 'right',
          render: (r) => `<span class="mono" style="font-weight:700">${
            r.obtained_marks === null || r.obtained_marks === undefined ? '—' : num(r.obtained_marks)}</span>` },
        { key: 'remarks', label: 'Remarks',
          render: (r) => `<span class="clamp-2 faint" style="font-size:.68rem">${esc(r.remarks ?? '—')}</span>` },
        { key: 'act', label: '', align: 'right',
          render: (r) => (r.submission_id ? `
            <button class="btn btn--soft btn--sm" type="button" data-grade-sub="${r.submission_id}"
              data-worksheet="${detail.worksheet_id}" data-max="${num(detail.max_marks)}"
              data-title="${esc(detail.title)}"
              data-student="${esc(r.full_name)}">${icon('edit')} Grade</button>` : '') },
      ],
      rows: detail.submissions ?? [],
      rowKey: (r, i) => r.submission_id ?? `row-${i}`,
      empty: 'Nobody has submitted yet',
    }),
    footer: '<button class="btn btn--secondary" type="button" data-close>Close</button>',
  });
}

/* ============================================================== wiring == */

function updatePunchButton() {
  const button = qs('[data-submit-punch]');
  if (!button) return;
  const count = session.punch.marks.size;
  button.disabled = count === 0;
  button.innerHTML = `${icon('save')} Commit ${count} record${count === 1 ? '' : 's'}`;
}

function renderCourseViews() {
  setPanel('attendance', attendancePanel());
  setPanel('marks', marksPanel());
  setPanel('worksheets', worksheetsPanel());
  ['attendance', 'marks', 'worksheets'].forEach((id) => {
    const host = qs(`[data-course-select-host]`, panel(id) ?? document);
    if (host) courseSelect(host.parentElement);
  });
  refreshMotion(document);
}

async function commitPunch() {
  const date = qs('[data-punch-date]')?.value;
  const slot = qs('[data-punch-slot]')?.value;
  if (!date || !slot) {
    toast('Pick a date and a slot first.', { type: 'warning' });
    return;
  }
  const records = [...session.punch.marks.entries()]
    .map(([roll_no, status]) => ({ roll_no, status }));
  if (!records.length) return;

  try {
    const result = await Api.teacherPunch({
      course_code: session.course, session_date: date, slot, records,
    });
    const s = result.session ?? {};
    toast(`Saved ${num(s.present_count ?? 0)} present, ${num(s.absent_count ?? 0)} absent.`,
      { type: 'success', title: 'Attendance committed' });
    session.punch.marks.clear();
    await loadCourse();
    loadTrend();
  } catch (error) {
    toast(error.message, { type: 'error', title: 'Punch rejected' });
  }
}

async function saveMarks(studentIds) {
  const ids = studentIds ?? [...session.pendingMarks.keys()];
  if (!ids.length) return;

  const marks = session.marks;
  const max = marks.maxima ?? {};
  let saved = 0;

  for (const id of ids) {
    const row = marks.rows.find((r) => String(r.student_id) === String(id));
    const edits = session.pendingMarks.get(String(id));
    if (!row || !edits) continue;
    try {
      await Api.teacherSaveMark({
        course_code: session.course,
        student_id: Number(id),
        internal_marks: Number(edits.internal_marks ?? row.internal_marks ?? 0),
        midterm_marks: Number(edits.midterm_marks ?? row.midterm_marks ?? 0),
        endterm_marks: Number(edits.endterm_marks ?? row.endterm_marks ?? 0),
      });
      saved += 1;
      session.pendingMarks.delete(String(id));
    } catch (error) {
      toast(error.message, { type: 'error', title: 'Marks not saved' });
    }
  }

  if (saved) {
    toast(`${saved} record${saved === 1 ? '' : 's'} saved. Grades recomputed.`,
      { type: 'success', title: 'Marks committed' });
    await loadCourse();
  } else {
    toast('Nothing could be saved.', { type: 'warning' });
  }
}

function gradeFor(total) {
  const pctv = n2(total);
  if (pctv >= 90) return 'O';
  if (pctv >= 80) return 'A+';
  if (pctv >= 70) return 'A';
  if (pctv >= 60) return 'B+';
  if (pctv >= 50) return 'B';
  if (pctv >= 45) return 'C';
  if (pctv >= 40) return 'P';
  return 'F';
}

function wireGlobal(root) {
  // Course selection anywhere.
  on(root, 'change', '[data-course-select]', (event, select) => selectCourse(select.value));
  on(root, 'click', '[data-pick-course]', (event, button) => selectCourse(button.dataset.pickCourse));

  // Punch interactions.
  on(root, 'click', '[data-mark]', (event, button) => {
    const roll = button.dataset.roll;
    const mark = button.dataset.mark;
    const active = button.getAttribute('aria-pressed') === 'true';
    session.punch.marks.delete(roll);
    if (!active) session.punch.marks.set(roll, mark);
    qsa(`[data-roll="${CSS.escape(roll)}"] [data-mark]`).forEach((b) => {
      b.setAttribute('aria-pressed', 'false');
    });
    if (!active) button.setAttribute('aria-pressed', 'true');
    updatePunchButton();
  });

  on(root, 'input', '[data-punch-date]', (event, input) => { session.punch.date = input.value; });
  on(root, 'change', '[data-punch-slot]', (event, select) => { session.punch.slot = select.value; });

  on(root, 'click', '[data-mark-all]', (event, button) => {
    const mark = button.dataset.markAll;
    const students = session.roster?.students ?? [];
    session.punch.marks.clear();
    if (mark === 'P') students.forEach((s) => session.punch.marks.set(s.roll_no, 'P'));
    qsa('[data-roll] [data-mark]').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.mark === mark ? 'true' : 'false');
    });
    updatePunchButton();
  });

  on(root, 'click', '[data-submit-punch]', (event, button) =>
    withBusy(button, commitPunch));

  // Marks inputs.
  on(root, 'input', '[data-component]', (event, input) => {
    const id = input.dataset.student;
    const key = id;
    const existing = session.pendingMarks.get(key) ?? {};
    const value = input.value === '' ? '' : Number(input.value);
    existing[input.dataset.component] = value;
    session.pendingMarks.set(key, existing);

    const max = Number(input.max);
    const bad = value !== '' && (value < 0 || value > max);
    input.classList.toggle('is-invalid', bad);
    input.classList.toggle('is-dirty', !bad);

    // Live total + grade feedback.
    const row = session.marks.rows.find((r) => String(r.student_id) === id);
    if (row) {
      const pick = (component) => {
        const pending = session.pendingMarks.get(id)?.[component];
        return pending !== undefined && pending !== '' ? Number(pending)
          : Number(row[component] ?? 0);
      };
      const total = pick('internal_marks') + pick('midterm_marks') + pick('endterm_marks');
      const totalCell = qs(`[data-total="${id}"]`);
      if (totalCell) totalCell.textContent = num(total);
      const chipCell = qs(`[data-live-grade="${id}"]`);
      if (chipCell) {
        const grade = gradeFor(total);
        chipCell.textContent = grade;
        chipCell.dataset.grade = grade;
      }
    }

    qs('[data-save-marks]')?.toggleAttribute('disabled', session.pendingMarks.size === 0);
  });

  on(root, 'click', '[data-save-one]', (event, button) =>
    withBusy(button, () => saveMarks([button.dataset.saveOne])));
  on(root, 'click', '[data-save-marks]', (event, button) =>
    withBusy(button, () => saveMarks()));

  // Worksheet flows. Grade buttons live both in the panel and in the
  // submissions modal, so one helper is bound at two scopes and a click can
  // only ever reach it once.
  on(root, 'click', '[data-grade-sub]', (event, button) => {
    if (button.closest('.modal-backdrop, .drawer-backdrop')) return;
    gradeFrom(button);
  });

  on(root, 'click', '[data-open-submissions]', (event, button) =>
    openSubmissionsModal(button.dataset.openSubmissions));
  on(root, 'click', '[data-new-worksheet]', openNewWorksheetModal);

  // Circular publishing.
  on(root, 'submit', '#noticeForm', async (event, form) => {
    event.preventDefault();
    const data = formData(form);
    const submit = qs('[type="submit"]', form);
    await withBusy(submit, async () => {
      try {
        await Api.teacherNotice(data);
        form.reset();
        toast('Circular published to every student.', { type: 'success' });
        const notices = await Api.notices();
        setPanel('notices', noticesPanel(notices));
        refreshMotion(document);
      } catch (error) {
        toast(error.message, { type: 'error', title: 'Could not publish' });
      }
    });
  });

  // Submissions modal shares the same grade button handler.
  on(document, 'click', '[data-grade-sub]', (event, button) => {
    if (!button.closest('.modal-backdrop, .drawer-backdrop')) return;
    gradeFrom(button);
  });
}

async function loadTrend() {
  if (!session.course) return;
  const host = qs('[data-chart="trend"]', panel('attendance') ?? document);
  if (!host) return;
  try {
    const { trend = [] } = await Api.teacherTrend(session.course);
    const sorted = trend.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!sorted.length) { host.innerHTML = emptyState({ title: 'No trend yet' }); return; }
    killCharts();
    charts.push(lineChart(host, {
      labels: sorted.map((t) => fmtDateShort(t.date)),
      series: [{ name: 'Attendance', values: sorted.map((t) => n2(t.percentage)) }],
      height: 230, yMax: 100, uid: `trend-${session.course}`,
      formatValue: (v) => `${n2(v).toFixed(0)}%`,
      ariaLabel: 'Class attendance trend',
    }));
  } catch {
    host.innerHTML = emptyState({ title: 'Trend unavailable' });
  }
}

async function loadSessionLog() {
  if (!session.course) return;
  const host = qs('[data-session-log]', panel('attendance') ?? document);
  if (!host) return;
  try {
    const { sessions = [] } = await Api.teacherSessions(session.course);
    host.innerHTML = table({
      columns: [
        { key: 'session_date', label: 'Date', header: true,
          render: (r) => `<div><span class="mono">${esc(fmtDate(r.session_date))}</span>
            <span class="mono faint" style="font-size:.62rem;display:block">${esc(r.slot ?? '')}</span></div>` },
        { key: 'present_count', label: 'Present', align: 'right',
          render: (r) => `<span class="mono text-success">${num(r.present_count)}</span>` },
        { key: 'absent_count', label: 'Absent', align: 'right',
          render: (r) => `<span class="mono text-danger">${num(r.absent_count)}</span>` },
        { key: 'late_count', label: 'Late', align: 'right',
          render: (r) => `<span class="mono text-warning">${num(r.late_count)}</span>` },
        { key: 'percentage', label: 'Percent', align: 'right',
          render: (r) => `<span class="mono">${pct(r.percentage, 1)}</span>` },
        { key: 'is_revised', label: 'Rev',
          render: (r) => (r.is_revised ? chip('REVISED', 'warning') : '<span class="faint">—</span>') },
        { key: 'marked_by', label: 'Marked by',
          render: (r) => `<span class="faint" style="font-size:.7rem">${esc(r.marked_by ?? '')}</span>` },
      ],
      rows: sessions,
      rowKey: (r) => r.session_id,
      empty: 'No sessions for this course',
    });
    refreshMotion(host);
  } catch {
    host.innerHTML = emptyState({ title: 'Could not load sessions' });
  }
}

function drawCourseCharts() {
  if (!session.course) return;
  loadTrend();
  loadSessionLog();
}

function drawAnalytics(analytics) {
  const a = analytics.analytics ?? {};
  const subjects = a.subject_performance ?? [];
  const bands = a.grade_distribution ?? [];

  const avgHost = qs('[data-chart="course-avg"]');
  if (avgHost) {
    charts.push(barChart(avgHost, {
      labels: subjects.map((c) => c.course_code),
      values: subjects.map((c) => n2(c.average)),
      height: 220, valueLabel: 'Class average', formatValue: (v) => `${n2(v).toFixed(0)}%`,
      yMax: 100, ariaLabel: 'Average by course',
    }));
  }

  const bandHost = qs('[data-chart="bands"]');
  if (bandHost) {
    const GRADE_VARS = ['--grade-o', '--grade-ap', '--grade-a', '--grade-b',
      '--grade-c', '--grade-p', '--grade-f'];
    const slices = bands
      .filter((b) => n2(b.total) > 0)
      .map((b, i) => ({
        label: `Grade ${b.grade}`,
        value: n2(b.total),
        color: cssVar(GRADE_VARS[i] ?? '--accent'),
      }));
    charts.push(donutChart(bandHost, {
      data: slices.length ? slices : [{ label: 'No marks yet', value: 1, color: cssVar('--line-strong') }],
      size: 186, thickness: 22, centreLabel: 'ENTRIES',
      ariaLabel: 'Grade distribution',
    }));
  }

  animateRings(document);
  refreshMotion(document);
}

/* ================================================================ init == */

export async function init() {
  const [overview, classes] = await Promise.all([
    Api.teacherOverview(),
    Api.teacherClasses(),
  ]);

  state.cache.teacherOverview = overview;
  session.classes = classes.classes ?? [];
  session.course = session.classes[0]?.course_code ?? null;

  setPanel('overview', overviewPanel(overview));
  setPanel('analytics', `<div class="card">${loader('Running analytics')}</div>`);
  setPanel('notices', `<div class="card">${loader('Loading circulars')}</div>`);

  renderCourseViews();

  // Course-dependent panels.
  const [roster, marks, worksheets] = await Promise.all([
    session.course ? Api.teacherRoster(session.course).catch(() => null) : null,
    session.course ? Api.teacherMarks(session.course).catch(() => null) : null,
    session.course ? Api.teacherWorksheets(session.course).catch(() => null) : null,
  ]);
  session.roster = roster?.roster ?? null;
  session.marks = marks ?? null;
  session.worksheets = worksheets ?? null;
  renderCourseViews();
  drawCourseCharts();

  const [notices, analytics] = await Promise.all([
    Api.notices(),
    Api.teacherAnalytics(),
  ]);
  setPanel('notices', noticesPanel(notices));
  setPanel('analytics', analyticsPanel(analytics));
  drawAnalytics(analytics);

  wireGlobal(document);
  refreshMotion(document);
  animateRings(document);
}

export { session as teacherSession };