/* =============================================================================
   pages/student.js — the student portal.
   Seven panels, all fed by the same /api/student/* + shared academic endpoints.
   Data is fetched once and cached in the shell state; each panel renders from
   the cache so switching tabs is instant after the first paint.
   ========================================================================== */

import { Api, downloadFrom, downloadPyq } from '../core/api.js';
import { state, panel, setPanel } from '../app.js';
import {
  qs, qsa, on, toast, icon, table, chip, bar, kv, statTile,
  emptyState, loader, openModal, withBusy,
} from '../core/ui.js';
import {
  esc, n2, num, pct, gpa, fmtDate, fmtDateShort, fmtRelative, toneFor, initials,
  attendanceBand, daysUntil, urgency, upper,
} from '../core/format.js';
import {
  lineChart, donutChart, barChart, progressRing, animateRings, sparkline, palette, cssVar,
} from '../core/charts.js';
import { refresh as refreshMotion } from '../core/motion.js';

const charts = [];

function killCharts() {
  while (charts.length) charts.pop()?.destroy?.();
}

const greet = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
};

/* ============================================================ overview === */

function overviewPanel(dash) {
  const s = dash.summary ?? {};
  const stu = dash.student ?? {};
  const att = dash.attendance?.overall ?? {};
  const threshold = att.required_percentage ?? 75;
  const band = attendanceBand(att.percentage, threshold);

  const pending = dash.worksheets?.filter((w) => !w.my_status) ?? [];
  const firstName = String(stu.first_name ?? '').split(' ')[0];

  return `
    <section class="hero" data-reveal>
      <div>
        <p class="eyebrow">SEMESTER ${esc(stu.semester ?? '—')} · ${esc(stu.batch_code ?? '')}</p>
        <h1 class="hero__greeting">${greet()}, <em>${esc(firstName || 'Student')}</em>.</h1>
        <p class="hero__sub">
          You have <strong>${num(att.attended_lectures)} of ${num(att.total_lectures)}</strong>
          lectures recorded. ${pending.length
            ? `<strong>${pending.length}</strong> worksheet${pending.length > 1 ? 's are' : ' is'} still awaiting submission.`
            : 'Every worksheet has been submitted.'}
        </p>
        <div class="hero__chips">
          ${chip(stu.academic_status ?? 'ACTIVE', toneFor(stu.academic_status), { dot: true })}
          ${chip(`CGPA ${gpa(s.cgpa)}`, 'accent')}
          ${chip(`REG ${stu.reg_no ?? '—'}`)}
          ${stu.portal_access === 'LOCKED'
            ? chip('PORTAL LOCKED', 'danger', { dot: true })
            : chip('PORTAL ACTIVE', 'success')}
        </div>
      </div>

      <div class="hero__rings">
        ${progressRing({
          value: att.percentage ?? 0, size: 138, thickness: 12,
          color: cssVar(band === 'success' ? '--success' : band === 'warning' ? '--warning' : '--danger'),
          caption: 'ATTENDANCE', figure: pct(att.percentage, 1), id: 'ring-att',
        })}
        ${progressRing({
          value: (s.cgpa ?? 0) * 10, size: 138, thickness: 12,
          color: cssVar('--accent'), caption: 'CGPA / 10', figure: gpa(s.cgpa), id: 'ring-cgpa',
        })}
      </div>
    </section>

    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({
        label: 'Overall attendance', icon: icon('checkCircle', 13),
        value: pct(att.percentage, 1), tone: cssVar(`--${band}`, null) ? `var(--${band}-soft)` : '',
        meta: `${num(att.attended_lectures)} / ${num(att.total_lectures)} lectures`,
        trend: { dir: att.classes_to_skip > 0 ? 'up' : 'flat',
          text: att.classes_to_skip > 0 ? `${att.classes_to_skip} skippable` : 'NO BUFFER' },
      })}
      ${statTile({
        label: 'Semester GPA', icon: icon('award', 13),
        value: gpa(s.sgpa), tone: 'var(--accent-soft)',
        meta: `${num(s.credits_earned)} credits earned`,
      })}
      ${statTile({
        label: 'Worksheets', icon: icon('file', 13),
        value: num(s.worksheets_graded ?? 0),
        unit: `/ ${num(s.worksheets_total ?? 0)}`,
        tone: 'var(--secondary-soft)',
        meta: `${num(s.worksheets_pending ?? 0)} pending · avg ${num(s.worksheet_average ?? 0)}`,
      })}
      ${statTile({
        label: 'Strongest subject', icon: icon('trend', 13),
        value: esc(s.strongest_course ?? '—'), tone: 'var(--success-soft)',
        meta: s.weakest_course ? `Weakest ${esc(s.weakest_course)}` : '',
      })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Attendance by subject</h3>
            <p class="card__sub">Required minimum is ${esc(threshold)}%</p>
          </div>
          <a class="btn btn--ghost btn--sm" href="#attendance">Open detail</a>
        </header>
        <div class="card__body" data-subject-bars>
          ${(dash.attendance?.subjects ?? []).map((row) => {
            const b = attendanceBand(row.percentage, threshold);
            return `
              <div class="att-row">
                <div style="min-width:0">
                  <p class="att-row__name truncate">${esc(row.course_code)} · ${esc(row.course_name)}</p>
                  <p class="att-row__meta">${num(row.attended_lectures)}/${num(row.total_lectures)}
                    · ${esc(row.faculty ?? '')}</p>
                </div>
                <div style="text-align:right">
                  <span class="att-row__figure text-${b}">${pct(row.percentage, 1)}</span>
                </div>
                <div class="att-row__bar">${bar(row.percentage, { tone: b })}</div>
              </div>`;
          }).join('') || emptyState({ title: 'No attendance recorded' })}
        </div>
      </article>

      <div class="stack">
        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Upcoming examinations</h3>
            <a class="btn btn--ghost btn--sm" href="#notices">All circulars</a>
          </header>
          <div class="card__body">
            ${(dash.upcoming_exams ?? []).length ? `
              <div class="timeline">
                ${dash.upcoming_exams.map((ex) => {
                  const days = daysUntil(ex.exam_date);
                  return `
                    <article class="timeline__item">
                      <div class="cluster cluster-s" style="margin-bottom:3px">
                        ${chip(`${days} DAYS`, days <= 7 ? 'warning' : 'info')}
                        ${chip(ex.exam_type ?? 'THEORY', 'ghost')}
                      </div>
                      <p style="font-weight:700;font-size:var(--step--1)">
                        ${esc(ex.subject_name ?? ex.course_code)}</p>
                      <p class="mono faint" style="font-size:0.66rem;margin-top:3px">
                        ${esc(fmtDate(ex.exam_date, { withDay: true }))} ·
                        ${esc(ex.start_time ?? '')}–${esc(ex.end_time ?? '')}
                      </p>
                      <p class="dim" style="font-size:var(--step--2);margin-top:2px">
                        ${esc(ex.venue ?? 'VENUE TO BE ANNOUNCED')}</p>
                    </article>`;
                }).join('')}
              </div>`
              : emptyState({ title: 'No exams scheduled', icon: 'calendar' })}
          </div>
        </article>

        <article class="card card--accent" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Action required</h3>
          </header>
          <div class="card__body stack stack-s">
            ${pending.length ? pending.map((w) => {
              const u = urgency(w.deadline_date);
              return `
                <div class="cluster cluster-between" style="gap:var(--space-s)">
                  <div style="min-width:0">
                    <p class="truncate" style="font-weight:700;font-size:var(--step--1)">${esc(w.title)}</p>
                    <p class="mono faint" style="font-size:0.64rem">${esc(w.course_code)} ·
                      ${u.label}</p>
                  </div>
                  <button class="btn btn--soft btn--sm" type="button" data-goto-worksheets>
                    Upload</button>
                </div>`;
            }).join('') : `<p class="soft" style="font-size:var(--step--1)">
              ${icon('checkCircle')} You are fully up to date. Nothing needs your attention.</p>`}
            ${dash.risk?.failing_subjects?.length ? `
              <p class="text-danger" style="font-size:var(--step--2)">
                ${icon('alert')} Failing in: ${esc(dash.risk.failing_subjects.join(', '))}</p>` : ''}
          </div>
        </article>
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Latest results</h3>
          <p class="card__sub">Credits and grade points are computed by the PL/SQL grade scale</p>
        </div>
        <a class="btn btn--secondary btn--sm" href="#results">Full transcript</a>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Code', header: true,
              render: (r) => `<span class="mono text-accent">${esc(r.course_code)}</span>` },
            { key: 'course_name', label: 'Subject', header: true,
              render: (r) => `<div><span class="truncate" style="display:block">${esc(r.course_name)}</span>
                <span class="faint" style="font-size:0.66rem">${esc(r.instructor ?? '')}</span></div>` },
            { key: 'total_marks', label: 'Total', align: 'right',
              render: (r) => `<span class="mono">${num(r.total_marks)}</span>` },
            { key: 'credits', label: 'Cr', align: 'right',
              render: (r) => `<span class="mono dim">${num(r.credits)}</span>` },
            { key: 'grade_letter', label: 'Grade', align: 'right',
              render: (r) => `<span class="chip chip--grade" data-grade="${esc(r.grade_letter)}">
                ${esc(r.grade_letter)}</span>` },
            { key: 'grade_point', label: 'GP', align: 'right',
              render: (r) => `<span class="mono">${gpa(r.grade_point)}</span>` },
          ],
          rows: (dash.transcript?.courses ?? []).slice(0, 6),
          rowKey: (r) => r.course_code,
          empty: 'No graded subjects yet',
        })}
      </div>
    </section>`;
}

/* =========================================================== attendance == */

function attendancePanel(data) {
  const att = data.attendance ?? {};
  const o = att.overall ?? {};
  const proj = att.projection ?? {};
  const threshold = o.required_percentage ?? 75;

  return `
    ${att.portal_locked ? `
      <div class="auth-alert" style="margin-bottom:var(--space-m)" data-reveal>
        ${icon('lock')}<span>Your portal access is currently locked by the administration because of
        low attendance. Academic records remain visible but submissions are disabled.</span>
      </div>` : ''}

    <section class="grid grid-3" style="margin-bottom:var(--space-l)" data-reveal>
      ${statTile({
        label: 'Classes attended', icon: icon('checkCircle', 13),
        value: num(o.attended_lectures), unit: `/ ${num(o.total_lectures)}`,
        tone: 'var(--success-soft)',
        meta: `Recorded across ${(att.subjects ?? []).length} subjects`,
      })}
      ${statTile({
        label: 'Overall percentage', icon: icon('activity', 13),
        value: pct(o.percentage, 1),
        tone: `var(--${attendanceBand(o.percentage, threshold)}-soft)`,
        meta: `Minimum required ${esc(threshold)}%`,
      })}
      ${statTile({
        label: 'Lectures you may skip', icon: icon('layers', 13),
        value: num(proj.lectures_may_skip ?? 0),
        tone: 'var(--warning-soft)',
        meta: proj.safe_if_all_present ? 'Safe even if you attend nothing' : 'Attendance is fragile',
      })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <h3 class="card__title">Attendance by subject</h3>
          <span class="chip chip--ghost">LIVE FROM DATABASE</span>
        </header>
        <div class="card__body">
          ${(att.subjects ?? []).map((row) => {
            const b = attendanceBand(row.percentage, threshold);
            return `
              <div class="att-row">
                <div style="min-width:0">
                  <p class="att-row__name">${esc(row.course_code)}</p>
                  <p class="att-row__meta truncate">${esc(row.course_name)}</p>
                  <p class="att-row__meta">${esc(row.faculty ?? '')} ·
                    ${num(row.attended_lectures)}/${num(row.total_lectures)} lectures ·
                    last ${esc(fmtDateShort(row.last_session_date))}</p>
                </div>
                <div style="text-align:right;display:grid;gap:4px;justify-items:end">
                  <span class="att-row__figure text-${b}">${pct(row.percentage, 1)}</span>
                  ${chip(row.status, toneFor(row.status))}
                </div>
                <div class="att-row__bar">${bar(row.percentage, { tone: b, large: true })}</div>
              </div>`;
          }).join('') || emptyState({ title: 'No attendance rows', icon: 'calendar' })}
        </div>
      </article>

      <div class="stack">
        <article class="card" data-reveal>
          <header class="card__head">
            <div>
              <h3 class="card__title">Skip planner</h3>
              <p class="card__sub">How many lectures you can afford to miss</p>
            </div>
          </header>
          <div class="card__body">
            <div class="planner">
              <div class="cluster cluster-between">
                <div>
                  <p class="planner__figure text-${proj.lectures_may_skip > 0 ? 'success' : 'danger'}">
                    ${num(proj.lectures_may_skip ?? 0)}</p>
                  <p class="mono faint" style="font-size:0.64rem;letter-spacing:.12em">
                    LECTURES YOU MAY SKIP</p>
                </div>
                ${progressRing({
                  value: o.percentage ?? 0, size: 104, thickness: 9,
                  color: cssVar('--accent'), caption: 'NOW', id: 'ring-proj',
                })}
              </div>
              <div>
                ${kv('Current standing', proj.status_now ?? '—')}
                ${kv('Warning threshold', `${proj.warning_threshold ?? 65}%`)}
                ${kv('Eligibility threshold', `${proj.threshold ?? 75}%`)}
                ${kv('Minimum to appear in exam', num(o.minimum_to_appear ?? 0))}
                ${kv('Buffer over minimum',
                  `${num(proj.buffer_percentage ?? 0)} lectures`)}
              </div>
              <p class="soft" style="font-size:var(--step--2)">
                ${proj.safe_if_all_present
                  ? 'Even if you stop attending entirely, you stay above the eligibility threshold for this term.'
                  : 'Skipping further lectures will drop you below the eligibility threshold.'}
              </p>
            </div>
          </div>
        </article>

        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Percentage distribution</h3>
          </header>
          <div class="card__body" data-chart="attendance"></div>
        </article>
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Recent sessions</h3>
          <p class="card__sub">Every lecture the backend has recorded for you</p>
        </div>
      </header>
      <div class="card__body" data-sessions>
        ${loader('Loading session log')}
      </div>
    </section>`;
}

/* ============================================================ academics == */

function academicsPanel(courses) {
  const list = courses.courses ?? [];

  return `
    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      ${list.map((c, i) => `
        <article class="card card--hover" data-tilt data-reveal
                 style="--reveal-delay:${i * 55}ms">
          <header class="card__head">
            <div style="min-width:0">
              <p class="mono text-accent" style="font-size:0.66rem;letter-spacing:.14em">
                ${esc(c.course_code)} · SEM ${esc(c.semester)}</p>
              <h3 class="card__title card__title--sm" style="margin-top:4px">
                ${esc(c.course_name)}</h3>
            </div>
            ${chip(`${num(c.credits)} CR`, 'accent')}
          </header>
          <div class="card__body stack stack-s">
            <div class="cluster cluster-s">
              <span class="chip chip--ghost">${icon('user', 12)} ${esc(c.instructor ?? 'TBA')}</span>
              <span class="chip chip--ghost">${icon('users', 12)} ${num(c.enrolled_count)} ENROLLED</span>
              ${c.cabin_status ? chip(c.cabin_status, toneFor(c.cabin_status), { dot: true }) : ''}
            </div>
            ${c.topics?.length ? `
              <div class="cluster cluster-s">
                ${c.topics.slice(0, 4).map((t) => `<span class="chip chip--ghost">${esc(t)}</span>`).join('')}
                ${c.topics.length > 4
                  ? `<span class="chip chip--ghost">+${c.topics.length - 4} MORE</span>` : ''}
              </div>` : ''}
            ${c.syllabus_file ? `
              <button class="btn btn--soft btn--sm" type="button" data-syllabus="${esc(c.syllabus_file)}">
                ${icon('download')} Download syllabus
              </button>` : ''}
          </div>
        </article>`).join('')}
    </section>
    ${list.length ? '' : emptyState({ title: 'No courses enrolled', icon: 'book' })}`;
}

/* ============================================================== results == */

function resultsPanel(transcript, gpaData) {
  const t = transcript.transcript ?? {};
  const g = gpaData.gpa ?? {};
  const scale = t.scale ?? [];

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({
        label: 'CGPA', icon: icon('award', 13), value: gpa(t.cgpa),
        tone: 'var(--accent-soft)', meta: `Standing: ${esc(g.standing ?? '—')}`,
      })}
      ${statTile({
        label: 'SGPA (current sem)', icon: icon('trend', 13), value: gpa(t.sgpa),
        tone: 'var(--secondary-soft)', meta: `${num(t.credits_earned ?? 0)} credits earned`,
      })}
      ${statTile({
        label: 'Credits registered', icon: icon('book', 13),
        value: num(g.credits_registered ?? t.credits_earned ?? 0),
        tone: 'var(--tertiary-soft)', meta: 'Semester VI',
      })}
      ${statTile({
        label: 'Subjects graded', icon: icon('checkCircle', 13),
        value: num((t.courses ?? []).length),
        tone: 'var(--success-soft)',
        meta: Object.entries(g.distribution ?? {}).map(([k, v]) => `${k}×${v}`).join(' · ') || '',
      })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Semester performance</h3>
            <p class="card__sub">SGPA trend by semester</p>
          </div>
        </header>
        <div class="card__body" data-chart="semesters"></div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Grade distribution</h3>
            <p class="card__sub">How your subjects map onto the HPU scale</p>
          </div>
        </header>
        <div class="card__body" data-chart="grades"></div>
      </article>
    </section>

    <section class="card" style="margin-bottom:var(--space-l)" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Official transcript</h3>
          <p class="card__sub">Grades resolved server-side from <code>hpu_grade_scale</code></p>
        </div>
        <button class="btn btn--secondary btn--sm" type="button" data-print>${icon('file')} Print</button>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Code', header: true,
              render: (r) => `<span class="mono text-accent">${esc(r.course_code)}</span>` },
            { key: 'course_name', label: 'Subject', header: true,
              render: (r) => `<div><span style="display:block">${esc(r.course_name)}</span>
                <span class="faint" style="font-size:0.66rem">${esc(r.instructor ?? '')}</span></div>` },
            { key: 'internal_marks', label: 'Internal', align: 'right',
              render: (r) => `<span class="mono">${num(r.internal_marks)}</span>` },
            { key: 'midterm_marks', label: 'Midterm', align: 'right',
              render: (r) => `<span class="mono">${num(r.midterm_marks)}</span>` },
            { key: 'endterm_marks', label: 'Endterm', align: 'right',
              render: (r) => `<span class="mono">${num(r.endterm_marks)}</span>` },
            { key: 'total_marks', label: 'Total', align: 'right',
              render: (r) => `<span class="mono" style="font-weight:700">${num(r.total_marks)}</span>` },
            { key: 'credits', label: 'Cr', align: 'right',
              render: (r) => `<span class="mono dim">${num(r.credits)}</span>` },
            { key: 'grade_letter', label: 'Grade', align: 'right',
              render: (r) => `<span class="chip chip--grade" data-grade="${esc(r.grade_letter)}">
                ${esc(r.grade_letter)}</span>` },
            { key: 'grade_point', label: 'GP', align: 'right',
              render: (r) => `<span class="mono">${gpa(r.grade_point)}</span>` },
          ],
          rows: t.courses ?? [],
          rowKey: (r) => r.course_code,
          empty: 'No graded subjects yet',
        })}
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <h3 class="card__title">Grading scale</h3>
        <p class="card__sub">Shared by the PL/SQL package and the Python resolver</p>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'grade_letter', label: 'Grade', header: true,
              render: (r) => `<span class="chip chip--grade" data-grade="${esc(r.grade_letter)}">
                ${esc(r.grade_letter)}</span>` },
            { key: 'min_percent', label: 'From', align: 'right',
              render: (r) => `<span class="mono">${num(r.min_percent)}%</span>` },
            { key: 'max_percent', label: 'To', align: 'right',
              render: (r) => `<span class="mono">${num(r.max_percent)}%</span>` },
            { key: 'grade_point', label: 'Point', align: 'right',
              render: (r) => `<span class="mono">${gpa(r.grade_point)}</span>` },
            { key: 'classification', label: 'Classification',
              render: (r) => esc(r.classification) },
          ],
          rows: scale,
          rowKey: (r) => r.grade_letter,
          empty: 'Scale unavailable',
        })}
      </div>
    </section>`;
}

/* =========================================================== worksheets == */

function worksheetsPanel(worksheets) {
  const list = worksheets.worksheets ?? [];
  const templates = worksheets.templates ?? [];

  return `
    <section class="grid grid-3" style="margin-bottom:var(--space-l)">
      ${list.map((w) => {
        const u = urgency(w.deadline_date);
        const mine = w.my_status;
        return `
          <article class="ws-card" data-reveal>
            <div class="ws-card__head">
              <div style="min-width:0">
                <p class="ws-card__code">${esc(w.course_code)} · ${num(w.max_marks)} MARKS</p>
                <h3 class="ws-card__title clamp-2" style="margin-top:4px">${esc(w.title)}</h3>
              </div>
              ${chip(mine ?? 'NOT SUBMITTED', toneFor(mine ?? 'NOT SUBMITTED'))}
            </div>

            <div class="ws-card__meta">
              <span>${icon('clock', 12)} ${esc(u.label)}</span>
              <span>${icon('user', 12)} ${esc(w.faculty ?? '')}</span>
            </div>

            <div class="ws-card__foot">
              ${mine === 'CHECKED & GRADED'
                ? `<span class="chip chip--grade" data-grade="O">${num(w.my_marks)} / ${num(w.max_marks)}</span>`
                : `<span class="faint mono" style="font-size:0.64rem">${esc(fmtDate(w.deadline_date))}</span>`}
              <div class="cluster cluster-s">
                ${w.attachment_url ? `
                  <button class="btn btn--ghost btn--sm" type="button" data-asset="${esc(w.attachment_url)}">
                    ${icon('file')}</button>` : ''}
                ${mine ? `
                  <button class="btn btn--ghost btn--sm" type="button" data-download-ws="${w.worksheet_id}"
                          data-file="${esc(w.my_file ?? '')}">${icon('download')}</button>` : ''}
                <button class="btn btn--soft btn--sm" type="button" data-upload-ws="${w.worksheet_id}"
                        data-max="${num(w.max_marks)}" data-title="${esc(w.title)}">
                  ${icon('upload')} ${mine ? 'Re-upload' : 'Submit'}
                </button>
              </div>
            </div>

            ${w.my_remarks ? `
              <p class="soft" style="font-size:var(--step--2);border-left:2px solid var(--accent-line);
                 padding-left:8px">
                ${icon('award', 12)} ${esc(w.my_remarks)}</p>` : ''}
          </article>`;
      }).join('')}
    </section>

    ${list.length ? '' : emptyState({ title: 'No worksheets published', icon: 'file',
      text: 'Your faculty have not published any worksheets for this batch yet.' })}

    ${templates.length ? `
      <section class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Submission templates</h3>
            <p class="card__sub">Use these when formatting your answer sheets</p>
          </div>
        </header>
        <div class="card__body grid grid-2">
          ${templates.map((t) => `
            <div class="cluster cluster-between card card--pad-s" style="background:var(--bg-inset)">
              <div style="min-width:0">
                <p style="font-weight:700;font-size:var(--step--1)">${esc(t.title)}</p>
                <p class="mono faint" style="font-size:0.64rem">${esc(t.file_url)} ·
                  ${num(t.page_count)} PAGES</p>
              </div>
              <button class="btn btn--secondary btn--sm" type="button" data-asset="${esc(t.file_url)}">
                ${icon('download')}
              </button>
            </div>`).join('')}
        </div>
      </section>` : ''}`;
}

/* ============================================================ resources == */

function resourcesPanel(data) {
  const { pyq = [], library = [], datesheet = null, courses = [] } = data;
  const rows = datesheet?.rows ?? [];

  return `
    <section class="card" style="margin-bottom:var(--space-l)" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Previous year question papers</h3>
          <p class="card__sub">${pyq.length} papers · download counter increments server-side</p>
        </div>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Code', header: true,
              render: (r) => `<span class="mono text-accent">${esc(r.course_code)}</span>` },
            { key: 'subject_name', label: 'Subject', header: true,
              render: (r) => esc(r.subject_name) },
            { key: 'year', label: 'Year', align: 'right',
              render: (r) => `<span class="mono">${esc(r.year)}</span>` },
            { key: 'exam_type', label: 'Exam',
              render: (r) => chip(r.exam_type ?? 'END-TERM', 'ghost') },
            { key: 'downloads', label: 'Downloads', align: 'right',
              render: (r) => `<span class="mono dim" data-dl="${r.paper_id}">${num(r.downloads)}</span>` },
            { key: 'file_url', label: '', align: 'right',
              render: (r) => `<button class="btn btn--soft btn--sm" type="button"
                data-pyq="${r.paper_id}" data-file="${esc(r.file_url)}">
                ${icon('download')} PDF</button>` },
          ],
          rows: pyq,
          rowKey: (r) => r.paper_id,
          empty: 'No question papers uploaded',
        })}
      </div>
    </section>

    <section class="card" style="margin-bottom:var(--space-l)" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Examination date sheet</h3>
          <p class="card__sub">${esc(datesheet?.notification_no ?? 'Notification pending')}</p>
        </div>
        <span class="chip chip--info">${num(rows.length)} PAPERS</span>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'exam_date', label: 'Date', header: true,
              render: (r) => `<div><span class="mono">${esc(fmtDateShort(r.exam_date))}</span>
                <span class="faint" style="font-size:0.64rem;display:block">${esc(r.exam_day ?? '')}</span></div>` },
            { key: 'course_code', label: 'Code',
              render: (r) => `<span class="mono text-accent">${esc(r.course_code)}</span>` },
            { key: 'subject_name', label: 'Subject', header: true,
              render: (r) => `<div><span style="display:block">${esc(r.subject_name)}</span>
                <span class="faint" style="font-size:0.64rem">${esc(r.venue ?? '')}</span></div>` },
            { key: 'start_time', label: 'Time',
              render: (r) => `<span class="mono">${esc(r.start_time ?? '')}–${esc(r.end_time ?? '')}</span>` },
            { key: 'exam_type', label: 'Type',
              render: (r) => chip(r.exam_type ?? 'THEORY', r.exam_type === 'PRACTICAL' ? 'warning' : 'info') },
          ],
          rows,
          rowKey: (r) => r.schedule_id ?? r.course_code,
          empty: 'Date sheet not published',
        })}
      </div>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Digital library</h3>
          <p class="card__sub">${library.length} curated titles</p>
        </div>
        <div class="input-icon input-icon--fluid" style="min-width:220px">
          ${icon('search', 18)}
          <input class="input input--sm" type="search" placeholder="Filter titles…"
                 data-library-filter aria-label="Filter library titles">
        </div>
      </header>
      <div class="card__body grid grid-3" data-library>
        ${library.map((item) => `
          <article class="card card--pad-s card--hover" data-library-item
                   data-title="${esc(`${item.title} ${item.category} ${item.subject}`.toLowerCase())}">
            <div class="cluster cluster-between" style="margin-bottom:6px">
              ${chip(item.category ?? 'GENERAL', 'accent')}
              <span class="mono faint" style="font-size:0.62rem">${num(item.page_count)} PP</span>
            </div>
            <h4 style="font-family:var(--font-sans);font-size:var(--step--1);font-weight:700;
                       line-height:1.34">${esc(item.title)}</h4>
            <p class="dim" style="font-size:var(--step--2);margin-top:5px">${esc(item.authors ?? '')}</p>
            <div class="cluster cluster-between" style="margin-top:10px;padding-top:8px;
                        border-top:1px solid var(--line-faint)">
              <span class="mono faint" style="font-size:0.64rem">★ ${num(item.rating)}</span>
              <button class="btn btn--soft btn--sm" type="button" data-asset="${esc(item.file_url)}">
                ${icon('download')} PDF
              </button>
            </div>
          </article>`).join('')}
      </div>
    </section>`;
}

/* ============================================================== notices == */

function noticesPanel(data) {
  const notices = data.notices ?? [];
  const categories = data.categories ?? [];
  let active = 'ALL';

  return `
    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">University circulars</h3>
          <p class="card__sub">${notices.length} active notices</p>
        </div>
      </header>
      <div class="card__body stack">
        <div class="filter-bar" data-notice-filters>
          ${['ALL', ...categories].map((cat, i) => `
            <button class="filter-pill" type="button" data-category="${esc(cat)}"
                    aria-pressed="${i === 0}">${esc(cat)}</button>`).join('')}
        </div>

        <div class="stack stack-s" data-notice-list>
          ${notices.map((n) => `
            <article class="card card--pad-s" data-notice data-category="${esc(n.category)}"
                     style="background:var(--bg-raised)">
              <div class="cluster cluster-between" style="margin-bottom:8px">
                <div class="cluster cluster-s">
                  ${n.is_pinned ? chip('PINNED', 'brand') : ''}
                  ${chip(n.category ?? 'GENERAL',
                    ['EXAM DATE SHEET', 'RESULT'].includes(n.category) ? 'warning' : 'accent')}
                </div>
                <span class="mono faint nowrap" style="font-size:0.64rem">${esc(fmtRelative(n.issued_on))}</span>
              </div>
              <h4 style="font-family:var(--font-sans);font-size:var(--step-0);font-weight:700">
                ${esc(n.title)}</h4>
              <p class="soft" style="font-size:var(--step--1);margin-top:6px">${esc(n.summary)}</p>
              <div class="cluster cluster-between" style="margin-top:12px;padding-top:8px;
                          border-top:1px solid var(--line-faint)">
                <span class="mono faint" style="font-size:0.64rem">${esc(n.issued_by ?? '')}</span>
                <span class="mono faint" style="font-size:0.64rem">${esc(fmtDate(n.issued_on))}</span>
              </div>
            </article>`).join('')}
        </div>
      </div>
    </section>`;
}

/* ============================================================== wiring == */

function openUploadModal(worksheetId, maxMarks, title) {
  let file = null;

  openModal({
    title: 'Submit worksheet',
    subtitle: `${title} · out of ${maxMarks} marks`,
    body: `
      <form id="wsForm" class="stack stack-s" novalidate>
        <label class="dropzone" data-drop>
          ${icon('upload', 34)}
          <span style="font-weight:700;font-size:var(--step--1)">
            <span data-file-name>Drop your PDF here or click to browse</span></span>
          <span class="faint" style="font-size:var(--step--2)">
            PDF only · maximum 8 MB · A4 portrait recommended</span>
          <input type="file" name="file" accept="application/pdf,.pdf" hidden data-file-input>
        </label>
        <p class="field__error" data-file-error hidden></p>
        <p class="field__hint">
          Submissions are recorded in <code>hpu_worksheet_submission</code> with status
          <strong>SUBMITTED</strong>. Faculty grade them from the worksheet queue.</p>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>${icon('upload')} Upload answer sheet</button>`,
    onMount(backdrop, close) {
      const input = qs('[data-file-input]', backdrop);
      const zone = qs('[data-drop]', backdrop);
      const nameSlot = qs('[data-file-name]', backdrop);
      const errorSlot = qs('[data-file-error]', backdrop);

      const accept = (candidate) => {
        errorSlot.hidden = true;
        if (!candidate) { file = null; nameSlot.textContent = 'Drop your PDF here or click to browse'; return; }
        if (candidate.type !== 'application/pdf' && !candidate.name.toLowerCase().endsWith('.pdf')) {
          file = null;
          errorSlot.textContent = 'Only PDF files are accepted.';
          errorSlot.hidden = false;
          nameSlot.textContent = candidate.name;
          return;
        }
        if (candidate.size > 8 * 1024 * 1024) {
          file = null;
          errorSlot.textContent = 'File is larger than 8 MB.';
          errorSlot.hidden = false;
          nameSlot.textContent = candidate.name;
          return;
        }
        file = candidate;
        nameSlot.textContent = `${candidate.name} · ${(candidate.size / 1024).toFixed(0)} KB`;
      };

      input.addEventListener('change', () => accept(input.files?.[0]));
      ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => {
        e.preventDefault(); zone.classList.add('is-over');
      }));
      ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => {
        e.preventDefault(); zone.classList.remove('is-over');
      }));
      zone.addEventListener('drop', (e) => {
        const candidate = e.dataTransfer?.files?.[0];
        if (candidate) { accept(candidate); input.files = e.dataTransfer.files; }
      });

      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        if (!file) {
          errorSlot.textContent = 'Choose a PDF first.';
          errorSlot.hidden = false;
          return;
        }
        await withBusy(event.currentTarget, async () => {
          const body = new FormData();
          body.append('worksheet_id', String(worksheetId));
          body.append('file', file, file.name);
          try {
            const result = await Api.uploadWorksheet(body);
            toast(`Submitted. Status: ${result.submission?.evaluation_status ?? 'SUBMITTED'}.`,
              { type: 'success', title: 'Worksheet uploaded' });
            close();
            await load({ force: true });
          } catch (error) {
            errorSlot.textContent = error.message;
            errorSlot.hidden = false;
          }
        });
      });
    },
  });
}

function wirePanel(root) {
  // Library asset downloads anywhere in the portal.
  on(root, 'click', '[data-asset]', async (event, button) => {
    event.preventDefault();
    await withBusy(button, () => downloadFrom(Api.libraryUrl(button.dataset.asset))
      .then(() => toast('Download started', { type: 'success', duration: 2200 }))
      .catch((error) => toast(error.message, { type: 'error' })));
  });

  on(root, 'click', '[data-syllabus]', (event, button) => {
    event.preventDefault();
    downloadFrom(Api.libraryUrl(button.dataset.syllabus)).catch((e) => toast(e.message, { type: 'error' }));
  });

  on(root, 'click', '[data-pyq]', async (event, button) => {
    const id = button.dataset.pyq;
    await withBusy(button, async () => {
      try {
        await downloadPyq(id);
        const cell = qs(`[data-dl="${id}"]`);
        if (cell) cell.textContent = num(Number(cell.textContent.replace(/,/g, '')) + 1);
        toast('Question paper downloaded', { type: 'success', duration: 2400 });
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-upload-ws]', (event, button) => {
    openUploadModal(button.dataset.uploadWs, button.dataset.max, button.dataset.title);
  });

  on(root, 'click', '[data-download-ws]', async (event, button) => {
    const id = button.dataset.downloadWs;
    const file = button.dataset.file;
    await withBusy(button, () => downloadFrom(Api.downloadWorksheetUrl(id, file), file)
      .catch((error) => toast(error.message, { type: 'error' })));
  });

  on(root, 'click', '[data-goto-worksheets]', () => {
    history.replaceState(null, '', '#worksheets');
    document.dispatchEvent(new CustomEvent('hpu:nav', { detail: { id: 'worksheets' } }));
    location.reload();
  });

  on(root, 'click', '[data-print]', () => window.print());
}

/* ================================================================ load == */

/**
 * Fetch-once cache accessor.
 *
 * The cache stores the *resolved* payload, never the Promise: awaiting the
 * assignment (`cache.x ?? await (cache.x = Api.f())`) stores the pending Promise,
 * so every later read sees a truthy Promise, skips the request and then trips
 * over `undefined` fields. Deduplicate on the in-flight Promise instead.
 */
const inflight = new Map();

function once(key, fetcher, { force = false } = {}) {
  const cache = state.cache;
  if (!force && cache[key] !== undefined && cache[key] !== null) return cache[key];
  if (!force && inflight.has(key)) return inflight.get(key);

  const promise = Promise.resolve()
    .then(fetcher)
    .then((value) => {
      cache[key] = value;
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      // Never leave a rejected promise cached, or every retry reuses the failure.
      inflight.delete(key);
      throw error;
    });

  inflight.set(key, promise);
  return promise;
}

async function load({ force = false } = {}) {
  const cache = state.cache;
  const dash = await once('dashboard', () => Api.studentDashboard(), { force });
  const courses = await once('courses', () => Api.courses(), { force });
  const [attendance, transcript, gpa, worksheets, resources, notices] = await Promise.all([
    once('attendance', () => Api.studentAttendance(), { force }),
    once('transcript', () => Api.studentTranscript(), { force }),
    once('gpa', () => Api.studentGpa(), { force }),
    once('worksheets', () => Api.worksheets(), { force }),
    once('resources', async () => {
      const [pyq, library, datesheet] = await Promise.all([
        Api.pyq(), Api.elibrary(), Api.datesheet(),
      ]);
      return { pyq: pyq.papers ?? [], library: library.items ?? [], datesheet };
    }, { force }),
    once('notices', () => Api.notices(), { force }),
  ]);

  setPanel('overview', overviewPanel(dash));
  setPanel('attendance', attendancePanel(attendance));
  setPanel('academics', academicsPanel(courses));
  setPanel('results', resultsPanel(transcript, gpa));
  setPanel('worksheets', worksheetsPanel(worksheets));
  setPanel('library', resourcesPanel(resources));
  setPanel('notices', noticesPanel(notices));

  // Library filter.
  on(document, 'input', '[data-library-filter]', (event, input) => {
    const term = input.value.trim().toLowerCase();
    qsa('[data-library-item]').forEach((item) => {
      item.hidden = Boolean(term) && !item.dataset.title.includes(term);
    });
  });

  // Notice category filter.
  on(document, 'click', '[data-notice-filters] [data-category]', (event, button) => {
    qsa('[data-notice-filters] .filter-pill').forEach((p) => p.setAttribute('aria-pressed', 'false'));
    button.setAttribute('aria-pressed', 'true');
    const cat = button.dataset.category;
    qsa('[data-notice]').forEach((item) => {
      item.hidden = cat !== 'ALL' && item.dataset.category !== cat;
    });
  });

  wirePanel(document);

  // Charts (only the active panel is measured, so force a draw).
  drawCharts();

  // Keyed on the host node rather than a module-level flag: setPanel() replaces
  // this markup on every reload, so a flag left set from a previous load meant the
  // fresh "Loading session log" placeholder was never filled -- a permanent
  // spinner in the attendance card.
  const sessionsHost = qs('[data-sessions]');
  if (sessionsHost && sessionsHost.dataset.loaded !== 'true') {
    sessionsHost.dataset.loaded = 'true';
    Api.studentSessions()
      .then(({ sessions = [] }) => {
        const host = qs('[data-sessions]');
        if (!host) return;
        const list = (Array.isArray(sessions) ? sessions : sessions.rows ?? []).filter(Boolean);
        host.innerHTML = list.length
          ? table({
            columns: [
              { key: 'session_date', label: 'Date', header: true,
                render: (r) => `<span class="mono">${esc(fmtDate(r.session_date))}</span>` },
              { key: 'slot', label: 'Slot',
                render: (r) => `<span class="mono">${esc(r.slot ?? '')}</span>` },
              { key: 'course_code', label: 'Course',
                render: (r) => `<span class="mono text-accent">${esc(r.course_code ?? '')}</span>` },
              { key: 'class_attendance', label: 'Class attendance',
                render: (r) => `<span class="mono">${n2(r.percentage).toFixed(0)}%</span>` },
              { key: 'marked_by', label: 'Marked by',
                render: (r) => `<span class="faint" style="font-size:0.7rem">${esc(r.marked_by ?? '')}</span>` },
            ],
            rows: list.slice().reverse(),
            rowKey: (r) => r.session_id ?? `${r.session_date}-${r.slot}`,
            empty: 'No sessions recorded',
          })
          : emptyState({ title: 'No session log yet',
            text: 'Sessions appear here as soon as your faculty punch attendance.' });
        refreshMotion(host);
      })
      .catch(() => {
        // Never leave the loader up: a silent catch turned a failed fetch into an
        // indefinite spinner.
        const host = qs('[data-sessions]');
        if (host) host.innerHTML = emptyState({ title: 'Session log unavailable',
          icon: 'alert', text: 'Could not reach the attendance service. Try again shortly.' });
      });
  }

  refreshMotion(document);
}

function drawCharts() {
  killCharts();
  const cache = state.cache;
  const att = cache.attendance?.attendance ?? cache.dashboard?.attendance ?? {};
  const gpaData = cache.gpa?.gpa ?? {};

  // Attendance by subject — grouped bar with the threshold called out.
  const subjects = att.subjects ?? [];
  const attHost = qs('[data-chart="attendance"]');
  if (attHost) {
    if (subjects.length) {
      charts.push(barChart(attHost, {
        labels: subjects.map((s) => s.course_code),
        values: subjects.map((s) => n2(s.percentage)),
        height: 220,
        valueLabel: 'Attendance',
        formatValue: (v) => `${n2(v).toFixed(1)}%`,
        yMax: 100,
        ariaLabel: 'Attendance percentage by subject',
      }));
    } else {
      attHost.innerHTML = emptyState({ title: 'No attendance data', icon: 'chart' });
    }
  }

  // Semester SGPA.
  const semHost = qs('[data-chart="semesters"]');
  if (semHost) {
    const history = gpaData.history ?? [];
    if (history.length) {
      charts.push(lineChart(semHost, {
        labels: history.map((h) => `SEM ${h.semester}`),
        series: [{ name: 'SGPA', values: history.map((h) => n2(h.sgpa)) }],
        height: 220, yMax: 10, uid: 'sem',
        formatValue: (v) => n2(v).toFixed(1),
        ariaLabel: 'SGPA by semester',
      }));
    } else {
      semHost.innerHTML = emptyState({ title: 'Only one semester on record', icon: 'chart' });
    }
  }

  // Grade distribution donut.
  const gradeHost = qs('[data-chart="grades"]');
  if (gradeHost) {
    const dist = Object.entries(gpaData.distribution ?? {});
    charts.push(donutChart(gradeHost, {
      data: dist.map(([grade, count], i) => ({
        label: `Grade ${grade}`,
        value: count,
        color: cssVar(['--grade-o', '--grade-ap', '--grade-a', '--grade-bp', '--grade-b',
          '--grade-c', '--grade-p', '--grade-f'][i] ?? '--accent'),
      })),
      size: 186, thickness: 22,
      centreLabel: 'SUBJECTS',
      centreValue: String(Object.values(gpaData.distribution ?? {}).reduce((a, b) => a + b, 0)),
      ariaLabel: 'Grade distribution',
    }));
  }

  animateRings(document);
}

export async function init() {
  // Warm the cache in parallel so the first paint is complete.
  const [dashboard] = await Promise.all([Api.studentDashboard()]);
  state.cache.dashboard = dashboard;
  await load();
}