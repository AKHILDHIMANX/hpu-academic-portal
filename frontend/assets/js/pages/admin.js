/* =============================================================================
   pages/admin.js — the administration console.
   -----------------------------------------------------------------------------
   Command centre, student directory (search / filter / sort / paginate / CRUD /
   bulk actions / CSV export), faculty register, curriculum, worksheet
   oversight, the audit trail, the permission matrix and system maintenance.
   ========================================================================== */

import { Api, downloadFrom, ApiError } from '../core/api.js';
import { state, panel, setPanel } from '../app.js';
import {
  qs, qsa, on, toast, icon, esc, table, chip, bar, kv, statTile,
  emptyState, loader, openModal, withBusy, formData, confirmDialog,
  pager, bindPager,
} from '../core/ui.js';
import {
  num, pct, gpa, fmtDate, fmtDateShort, fmtRelative, toneFor, initials,
  attendanceBand, daysUntil, hashColor, n2,
} from '../core/format.js';
import {
  barChart, donutChart, lineChart, progressRing, animateRings, cssVar, palette,
} from '../core/charts.js';
import { refresh as refreshMotion } from '../core/motion.js';

const charts = [];
const killCharts = () => { while (charts.length) charts.pop()?.destroy?.(); };

const directory = {
  q: '',
  status: 'ALL',
  sort: 'roll_no',
  dir: 'asc',
  page: 1,
  perPage: 10,
  selection: new Set(),
  data: null,
};

/* ============================================================= overview == */

function overviewPanel(data) {
  const o = data.overview ?? data;
  const k = o.kpis ?? {};
  const stats = o.audit_stats ?? {};
  const threshold = o.thresholds?.attendance_required ?? 75;

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Students', icon: icon('users', 13), value: num(k.students ?? 0),
        tone: 'var(--accent-soft)', meta: `${num(k.active)} active · ${num(k.detained)} detained` })}
      ${statTile({ label: 'Faculty', icon: icon('user', 13), value: num(k.faculty ?? 0),
        tone: 'var(--secondary-soft)', meta: `${num(o.faculty_warnings?.length ?? 0)} carrying warnings` })}
      ${statTile({ label: 'Courses', icon: icon('book', 13), value: num(k.courses ?? 0),
        tone: 'var(--tertiary-soft)', meta: `${num(k.worksheets)} worksheets published` })}
      ${statTile({ label: 'At risk', icon: icon('alert', 13), value: num(o.at_risk_total ?? 0),
        tone: 'var(--danger-soft)', meta: `${num(k.locked_portals)} portals locked` })}
    </section>

    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Students requiring intervention</h3>
            <p class="card__sub">Below ${esc(threshold)}% attendance or flagged academically</p>
          </div>
          <button class="btn btn--soft btn--sm" type="button" data-goto-students>
            Open directory</button>
        </header>
        <div class="card__body stack stack-s">
          ${(o.at_risk ?? []).length ? (o.at_risk ?? []).map((s) => `
            <div class="risk-card" data-reveal>
              <span class="risk-card__gauge">${pct(s.attendance, 0)}</span>
              <div style="flex:1 1 auto;min-width:0">
                <p style="font-weight:700;font-size:var(--step--1)">${esc(s.full_name)}</p>
                <p class="mono faint" style="font-size:.62rem">${esc(s.roll_no)} ·
                  ${num(s.attended)}/${num(s.total)} lectures</p>
                <div class="cluster cluster-s" style="margin-top:5px">
                  ${chip(s.academic_status, toneFor(s.academic_status), { dot: true })}
                  ${chip(s.portal_access, toneFor(s.portal_access))}
                  <span class="text-danger mono" style="font-size:.62rem">
                    −${num(s.below_threshold_by)}% SHORT</span>
                </div>
              </div>
              <button class="btn btn--ghost btn--icon btn--sm" type="button"
                      data-quick-status="${s.student_id}" data-status="ACTIVE"
                      aria-label="Reinstate ${esc(s.full_name)}" data-tip="Reinstate">
                ${icon('refresh')}
              </button>
            </div>`).join('')
            : emptyState({ title: 'No student is at risk', icon: 'check' })}
        </div>
      </article>

      <div class="stack">
        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Cohort outcome</h3>
            <p class="card__sub">Grade distribution across all subjects</p>
          </header>
          <div class="card__body" data-chart="grades"></div>
        </article>

        <article class="card" data-reveal>
          <header class="card__head">
            <h3 class="card__title">Subject performance</h3>
            <p class="card__sub">Class average by course</p>
          </header>
          <div class="card__body" data-chart="subjects"></div>
        </article>
      </div>
    </section>

    <section class="grid grid-3" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head"><h3 class="card__title">Toppers</h3></header>
        <div class="card__body stack stack-s">
          ${(o.toppers ?? []).length ? (o.toppers ?? []).map((t, i) => `
            <div class="kv">
              <span class="kv__key cluster cluster-s">
                <span class="mono faint" style="width:16px">${i + 1}</span>
                <span>${esc(t.full_name)}</span></span>
              <span class="kv__val text-success">${gpa(t.cgpa)}</span>
            </div>`).join('') : emptyState({ title: 'No graded cohorts yet' })}
        </div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head"><h3 class="card__title">Audit posture</h3></header>
        <div class="card__body">
          ${kv('Total entries', num(stats.total ?? 0))}
          ${kv('Security events', num(stats.SECURITY ?? 0))}
          ${kv('Warnings', num(stats.WARNING ?? 0))}
          ${kv('Critical', num(stats.CRITICAL ?? 0))}
          ${kv('Distinct actors', num(stats.distinct_actors ?? 0))}
          ${kv('Last entry', stats.last_entry ? fmtDate(stats.last_entry, { withDay: true }) : '—')}
        </div>
        <footer class="card__foot">
          <button class="btn btn--ghost btn--sm" type="button" data-goto-audit>
            ${icon('shield')} Open audit trail</button>
        </footer>
      </article>

      <article class="card" data-reveal>
        <header class="card__head"><h3 class="card__title">Sign-in activity</h3></header>
        <div class="card__body">
          ${(o.login_activity ?? []).length ? (o.login_activity ?? []).map((a) => `
            <div class="att-row">
              <div>
                <p class="att-row__name">${esc(a.role)}</p>
                <p class="att-row__meta">${num(a.ever_logged)} accounts ·
                  last ${esc(fmtRelative(a.last_seen))}</p>
              </div>
              <div style="text-align:right">
                <span class="att-row__figure">${num(a.total)}</span>
                <p class="faint mono" style="font-size:.6rem">SIGN-INS</p>
              </div>
            </div>`).join('') : emptyState({ title: 'No sign-in history' })}
        </div>
      </article>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Latest audit entries</h3>
          <p class="card__sub">Every privileged action is recorded server-side</p>
        </div>
      </header>
      <div class="card__body">
        ${auditTable(o.audit ?? [], 8)}
      </div>
    </section>`;
}

function auditTable(rows, limit = null) {
  const list = limit ? rows.slice(0, limit) : rows;
  return table({
    columns: [
      { key: 'created_at', label: 'When', header: true,
        render: (r) => `<div><span class="mono" style="font-size:.7rem">${esc(fmtDateShort(r.created_at))}</span>
          <span class="faint" style="font-size:.62rem;display:block">${esc(fmtRelative(r.created_at))}</span></div>` },
      { key: 'action', label: 'Action',
        render: (r) => `<span class="audit-row__action" data-sev="${esc(r.severity)}">${esc(r.action)}</span>` },
      { key: 'actor_name', label: 'Actor', header: true,
        render: (r) => `<div><span style="display:block;font-size:var(--step--1)">${esc(r.actor_name)}</span>
          <span class="mono faint" style="font-size:.62rem">${esc(r.actor_code ?? '')} · ${esc(r.actor_role ?? '')}</span></div>` },
      { key: 'details', label: 'Detail',
        render: (r) => `<span class="clamp-2 faint" style="font-size:.68rem">${esc(r.details ?? '—')}</span>` },
      { key: 'ip_address', label: 'Source',
        render: (r) => `<span class="mono faint" style="font-size:.66rem">${esc(r.ip_address ?? '')}</span>` },
    ],
    rows: list,
    rowKey: (r) => r.log_id,
    empty: 'No audit entries',
    stack: false,
  });
}

/* ============================================================= students == */

/**
 * Status filter options with live counts. Split out of studentsPanel() so
 * loadDirectory() can refresh the counts in place after the first fetch --
 * re-rendering the whole panel would steal focus from the search box.
 */
function statusOptions() {
  const counts = directory.data?.counts ?? {};
  return ['ALL', 'ACTIVE', 'DETAINED', 'SUSPENDED'].map((s) => `
    <option value="${s}" ${directory.status === s ? 'selected' : ''}>
      ${s === 'ALL' ? `All (${num(counts.ALL ?? 0)})` : `${s} (${num(counts[s] ?? 0)})`}
    </option>`).join('');
}

function studentsPanel() {
  return `
    <section class="card" data-reveal>
      <div class="dir-toolbar">
        <div class="input-icon">
          ${icon('search', 18)}
          <input class="input" type="search" placeholder="Search name, roll number, email or registration…"
                 data-dir-search value="${esc(directory.q)}" aria-label="Search students">
        </div>

        <label class="field">
          <span class="sr-only">Academic status</span>
          <select class="select" data-dir-status>
            ${statusOptions()}
          </select>
        </label>

        <label class="field">
          <span class="sr-only">Sort by</span>
          <select class="select" data-dir-sort>
            ${[['roll_no', 'Roll number'], ['name', 'Name'], ['attendance', 'Attendance'],
              ['status', 'Status'], ['last_login', 'Last sign-in']].map(([k, l]) => `
              <option value="${k}" ${directory.sort === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}
          </select>
        </label>

        <div class="cluster cluster-s">
          <button class="btn btn--secondary btn--sm" type="button" data-dir-toggle
                  aria-pressed="${directory.dir === 'desc'}">
            ${icon('refresh')} ${directory.dir === 'desc' ? 'Descending' : 'Ascending'}
          </button>
          <button class="btn btn--secondary btn--sm" type="button" data-export>
            ${icon('download')} CSV
          </button>
          <button class="btn btn--primary btn--sm" type="button" data-new-student>
            ${icon('plus')} Register
          </button>
        </div>
      </div>

      <div class="cluster cluster-between" style="margin-bottom:var(--space-s)">
        <div class="cluster cluster-s" data-bulk-bar style="display:none">
          <span class="chip chip--accent" data-selected-count>0 selected</span>
          <button class="btn btn--ghost btn--sm" type="button" data-bulk="LOCK">
            ${icon('lock')} Lock</button>
          <button class="btn btn--ghost btn--sm" type="button" data-bulk="UNLOCK">
            ${icon('key')} Unlock</button>
          <button class="btn btn--ghost btn--sm" type="button" data-bulk="ACTIVE">
            ${icon('check')} Activate</button>
          <button class="btn btn--ghost btn--sm" type="button" data-bulk="DETAINED">
            ${icon('alert')} Detain</button>
        </div>
        <div class="spacer"></div>
        <button class="btn btn--ghost btn--sm" type="button" data-select-all>
          Select page</button>
      </div>

      <div data-dir-table>${loader('Loading directory')}</div>
      <div data-dir-pager></div>
    </section>`;
}

function renderDirectoryTable() {
  const d = directory.data;
  const host = qs('[data-dir-table]');
  if (!host || !d) return;

  host.innerHTML = table({
    columns: [
      { key: 'select', label: '', header: true,
        render: (r) => `<input type="checkbox" data-select="${r.student_id}"
          ${directory.selection.has(r.student_id) ? 'checked' : ''}
          aria-label="Select ${esc(r.full_name)}">` },
      { key: 'student_id', label: 'Student', header: true,
        render: (r) => `<div class="cluster cluster-s">
          <span class="avatar" style="width:34px;height:34px;font-size:.68rem">${esc(r.initials ?? '??')}</span>
          <span style="min-width:0"><span style="display:block">${esc(r.full_name)}</span>
          <span class="mono faint" style="font-size:.62rem">${esc(r.roll_no)}</span></span></div>` },
      { key: 'reg_no', label: 'Reg no',
        render: (r) => `<span class="mono faint" style="font-size:.7rem">${esc(r.reg_no)}</span>` },
      { key: 'overall_attendance', label: 'Attendance', align: 'right',
        render: (r) => {
          const b = attendanceBand(r.overall_attendance);
          return `<div style="min-width:120px"><div class="cluster cluster-s" style="justify-content:flex-end">
            <span class="mono text-${b}">${pct(r.overall_attendance, 1)}</span></div>
            <div style="margin-top:4px">${bar(r.overall_attendance, { tone: b })}</div></div>`;
        } },
      { key: 'course_count', label: 'Courses', align: 'right',
        render: (r) => `<span class="mono dim">${num(r.course_count)}</span>` },
      { key: 'academic_status', label: 'Status',
        render: (r) => chip(r.academic_status, toneFor(r.academic_status), { dot: true }) },
      { key: 'portal_access', label: 'Portal',
        render: (r) => chip(r.portal_access, toneFor(r.portal_access)) },
      { key: 'last_login_at', label: 'Last sign-in',
        render: (r) => (r.last_login_at
          ? `<span class="mono faint" style="font-size:.68rem">${esc(fmtRelative(r.last_login_at))}</span>`
          : '<span class="faint">Never</span>') },
      { key: 'act', label: '', align: 'right',
        render: (r) => `
          <div class="cell-actions">
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-toggle-lock="${r.student_id}"
              data-locked="${r.portal_access === 'LOCKED'}"
              aria-label="${r.portal_access === 'LOCKED' ? 'Unlock' : 'Lock'} portal for ${esc(r.full_name)}">
              ${icon(r.portal_access === 'LOCKED' ? 'lock' : 'key')}
            </button>
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-edit-student="${r.student_id}"
              aria-label="Edit ${esc(r.full_name)}">${icon('edit')}</button>
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-delete-student="${r.student_id}"
              data-name="${esc(r.full_name)}" aria-label="Remove ${esc(r.full_name)}">${icon('trash')}</button>
          </div>` },
    ],
    rows: d.rows ?? [],
    rowKey: (r) => r.student_id,
    selectedIds: [...directory.selection],
    empty: 'No student matches these filters',
  });

  refreshMotion(host);
}

async function loadDirectory({ keepSelection = false } = {}) {
  if (!keepSelection) directory.selection.clear();
  const data = await Api.adminStudents({
    q: directory.q,
    status: directory.status,
    sort: directory.sort,
    dir: directory.dir,
    page: directory.page,
    per_page: directory.perPage,
  });
  directory.data = data.directory;
  renderDirectoryTable();

  // The toolbar is rendered before the first fetch, so its counts start at 0.
  // Patch just the options to keep them honest without re-rendering the panel.
  const statusSelect = qs('[data-dir-status]');
  if (statusSelect) statusSelect.innerHTML = statusOptions();

  const pagerHost = qs('[data-dir-pager]');
  if (pagerHost) {
    pagerHost.innerHTML = pager({
      page: directory.data.page,
      pages: directory.data.pages,
      total: directory.data.total,
      perPage: directory.data.per_page,
    });
    refreshMotion(pagerHost);
  }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = qs('[data-bulk-bar]');
  const count = qs('[data-selected-count]');
  if (!bar || !count) return;
  bar.style.display = directory.selection.size ? 'flex' : 'none';
  count.textContent = `${directory.selection.size} selected`;
}

/* --- student modals ---------------------------------------------------- */

function openStudentModal(existing = null) {
  const isEdit = Boolean(existing);
  openModal({
    title: isEdit ? 'Edit student record' : 'Register a student',
    subtitle: isEdit
      ? `${existing.full_name} · ${existing.roll_no}`
      : 'Creates the login account and the student record in one transaction',
    body: `
      <form id="stuForm" class="stack stack-s">
        <div class="grid grid-2">
          <label class="field"><span class="field__label">First name</span>
            <input class="input" name="first_name" required maxlength="60"
              value="${esc(existing?.first_name ?? '')}"></label>
          <label class="field"><span class="field__label">Last name</span>
            <input class="input" name="last_name" required maxlength="60"
              value="${esc(existing?.last_name ?? '')}"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Roll number</span>
            <input class="input mono" name="roll_no" required
              ${isEdit ? 'disabled' : ''} placeholder="HPU-CS-2023-901"
              value="${esc(existing?.roll_no ?? '')}"></label>
          <label class="field"><span class="field__label">Registration number</span>
            <input class="input mono" name="reg_no" required
              ${isEdit ? 'disabled' : ''} placeholder="18-HPU-10300"
              value="${esc(existing?.reg_no ?? '')}"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">University email</span>
            <input class="input" type="email" name="email" required
              ${isEdit ? 'disabled' : ''} placeholder="name@hpu.ac.in"
              value="${esc(existing?.email ?? '')}"></label>
          <label class="field"><span class="field__label">Phone</span>
            <input class="input" name="phone" maxlength="24" placeholder="+91 98160 00000"
              value="${esc(existing?.phone ?? '')}"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Semester</span>
            <input class="input" type="number" name="semester" min="1" max="10"
              value="${esc(existing?.semester ?? 6)}"></label>
          <label class="field"><span class="field__label">Batch</span>
            <select class="select" name="batch_code">
              ${['CSE-2023-BATCH-A', 'CSE-2023-BATCH-B', 'ECE-2023-BATCH-A']
                .map((b) => `<option ${(existing?.batch_code ?? 'CSE-2023-BATCH-A') === b ? 'selected' : ''}>
                  ${b}</option>`).join('')}
            </select></label>
        </div>
        ${isEdit ? `
          <div class="grid grid-2">
            <label class="field"><span class="field__label">Academic status</span>
              <select class="select" name="academic_status">
                ${['ACTIVE', 'DETAINED', 'SUSPENDED'].map((s) => `
                  <option ${existing.academic_status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select></label>
            <label class="field"><span class="field__label">Portal access</span>
              <span class="cluster" style="min-height:44px">
                <label class="switch">
                  <input type="checkbox" name="attendance_lock"
                    ${existing.portal_access === 'LOCKED' ? 'checked' : ''}>
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                  <span style="font-size:var(--step--2);font-weight:700">LOCK PORTAL</span>
                </label>
              </span></label>
          </div>` : `
          <label class="field"><span class="field__label">Initial password</span>
            <input class="input" type="text" name="password" minlength="8" required
              placeholder="At least 8 characters" autocomplete="new-password"></label>`}
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>
        ${icon('save')} ${isEdit ? 'Save changes' : 'Register student'}</button>`,
    onMount(backdrop, close) {
      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const form = qs('#stuForm', backdrop);
        const data = formData(form, { numbers: ['semester'] });

        if (isEdit) {
          const payload = {
            academic_status: data.academic_status,
            attendance_lock: form.elements.attendance_lock.checked,
          };
          if (!payload.academic_status && !data.phone && data.semester === undefined) {
            toast('Nothing to update.', { type: 'warning' });
            return;
          }
          await withBusy(event.currentTarget, async () => {
            try {
              await Api.adminUpdateStudent(existing.student_id, payload);
              toast('Student record updated.', { type: 'success' });
              close();
              await loadDirectory();
              loadOverview();
            } catch (error) { toast(error.message, { type: 'error' }); }
          });
          return;
        }

        if (!data.password || data.password.length < 8) {
          toast('Set an initial password of at least 8 characters.', { type: 'warning' });
          return;
        }

        await withBusy(event.currentTarget, async () => {
          try {
            const result = await Api.adminCreateStudent(data);
            toast(`Registered ${result.student?.full_name ?? data.first_name}.`,
              { type: 'success', title: 'Student created' });
            close();
            await loadDirectory();
            loadOverview();
          } catch (error) {
            const field = error.code === 'DUPLICATE' ? 'roll_no' : null;
            if (field) {
              const input = qs(`[name="${field}"]`, backdrop);
              input.setAttribute('aria-invalid', 'true');
              input.closest('.field')?.append(
                Object.assign(document.createElement('p'),
                  { className: 'field__error', textContent: error.message }),
              );
            }
            toast(error.message, { type: 'error', title: 'Registration failed' });
          }
        });
      });
    },
  });
}

/* =============================================================== faculty == */

function facultyPanel(data) {
  const faculty = data.faculty ?? [];

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Faculty on record', icon: icon('user', 13), value: num(faculty.length),
        tone: 'var(--accent-soft)', meta: 'Computer Science & Engineering' })}
      ${statTile({ label: 'On campus', icon: icon('checkCircle', 13),
        value: num(faculty.filter((f) => String(f.cabin_status).includes('CAMPUS')).length),
        tone: 'var(--success-soft)', meta: 'Cabin status reported' })}
      ${statTile({ label: 'With warnings', icon: icon('alert', 13),
        value: num(faculty.filter((f) => Number(f.warning_count) > 0).length),
        tone: 'var(--warning-soft)', meta: 'Formal warnings issued' })}
      ${statTile({ label: 'Course allocations', icon: icon('book', 13),
        value: num(faculty.reduce((s, f) => s + Number(f.course_count ?? 0), 0)),
        tone: 'var(--secondary-soft)', meta: 'Across the department' })}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Faculty register</h3>
          <p class="card__sub">Teaching load, office hours and warning status</p>
        </div>
        <button class="btn btn--primary btn--sm" type="button" data-new-teacher>
          ${icon('plus')} Add faculty
        </button>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'faculty_code', label: 'Faculty', header: true,
              render: (r) => `<div class="cluster cluster-s">
                <span class="avatar" style="width:34px;height:34px;font-size:.68rem">${esc(r.initials ?? '??')}</span>
                <span style="min-width:0"><span style="display:block">${esc(r.full_name)}</span>
                <span class="mono faint" style="font-size:.62rem">${esc(r.faculty_code)}</span></span></div>` },
            { key: 'designation', label: 'Designation',
              render: (r) => `<div><span style="display:block;font-size:var(--step--1)">${esc(r.designation)}</span>
                <span class="faint" style="font-size:.64rem">${esc(r.specialization ?? '')}</span></div>` },
            { key: 'course_count', label: 'Courses', align: 'right',
              render: (r) => `<span class="mono">${num(r.course_count)}</span>` },
            { key: 'office_hours', label: 'Office hours',
              render: (r) => `<span class="mono faint" style="font-size:.7rem">${esc(r.office_hours ?? '—')}</span>` },
            { key: 'cabin_status', label: 'Cabin',
              render: (r) => chip(r.cabin_status ?? '—', toneFor(r.cabin_status), { dot: true }) },
            { key: 'warning_count', label: 'Warnings', align: 'right',
              render: (r) => (Number(r.warning_count) > 0
                ? chip(String(r.warning_count), 'danger')
                : '<span class="faint">—</span>') },
            { key: 'grading_deadline', label: 'Grading due',
              render: (r) => {
                const d = daysUntil(r.grading_deadline);
                return `<span class="mono ${d !== null && d <= 3 ? 'text-warning' : ''}"
                  style="font-size:.7rem">${esc(fmtDateShort(r.grading_deadline))}</span>`;
              } },
            { key: 'act', label: '', align: 'right',
              render: (r) => `<button class="btn btn--ghost btn--icon btn--sm" type="button"
                data-warn-teacher="${r.teacher_id}" data-name="${esc(r.full_name)}"
                data-count="${num(r.warning_count)}"
                aria-label="Adjust warning for ${esc(r.full_name)}">${icon('alert')}</button>` },
          ],
          rows: faculty,
          rowKey: (r) => r.faculty_id ?? r.faculty_code,
          empty: 'No faculty on record',
        })}
      </div>
    </section>`;
}

function openTeacherModal() {
  openModal({
    title: 'Add faculty member',
    subtitle: 'Creates the faculty record and login in one transaction',
    body: `
      <form id="teaForm" class="stack stack-s">
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Faculty code</span>
            <input class="input mono" name="faculty_code" required placeholder="F-CS-07"></label>
          <label class="field"><span class="field__label">Full name</span>
            <input class="input" name="full_name" required placeholder="Dr. A.B. Verma"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Designation</span>
            <input class="input" name="designation" required placeholder="Assistant Professor"></label>
          <label class="field"><span class="field__label">Specialization</span>
            <input class="input" name="specialization" placeholder="Database Systems"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Email</span>
            <input class="input" type="email" name="email" required placeholder="name@hpu.ac.in"></label>
          <label class="field"><span class="field__label">Phone</span>
            <input class="input" name="phone" maxlength="24"></label>
        </div>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Weekly hours</span>
            <input class="input" type="number" name="weekly_hours" value="12" min="1" max="40"></label>
          <label class="field"><span class="field__label">Office location</span>
            <input class="input" name="office_location" placeholder="BLOCK A, ROOM 312"></label>
        </div>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>${icon('plus')} Register faculty</button>`,
    onMount(backdrop, close) {
      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const data = formData(qs('#teaForm', backdrop), { numbers: ['weekly_hours'] });
        if (!data.faculty_code || !data.full_name) {
          toast('Faculty code and name are required.', { type: 'warning' });
          return;
        }
        await withBusy(event.currentTarget, async () => {
          try {
            await Api.adminCreateTeacher(data);
            toast('Faculty member registered.', { type: 'success' });
            close();
            setPanel('faculty', facultyPanel(await Api.adminTeachers()));
            loadOverview();
            refreshMotion(document);
          } catch (error) { toast(error.message, { type: 'error' }); }
        });
      });
    },
  });
}

/* ============================================================== courses == */

function coursesPanel(data) {
  const courses = data.courses ?? [];

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Courses', icon: icon('book', 13), value: num(courses.length),
        tone: 'var(--accent-soft)', meta: 'Current curriculum' })}
      ${statTile({ label: 'Credit hours', icon: icon('award', 13),
        value: num(courses.reduce((s, c) => s + Number(c.credits ?? 0), 0)),
        tone: 'var(--secondary-soft)', meta: 'Across semester VI' })}
      ${statTile({ label: 'Enrolments', icon: icon('users', 13),
        value: num(courses.reduce((s, c) => s + Number(c.enrolled_count ?? 0), 0)),
        tone: 'var(--tertiary-soft)', meta: 'Subject registrations' })}
      ${statTile({ label: 'Syllabi on file', icon: icon('file', 13),
        value: num(courses.filter((c) => c.syllabus_file).length),
        tone: 'var(--success-soft)', meta: 'Documents available' })}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Curriculum</h3>
          <p class="card__sub">Every course with its instructor and unit list</p>
        </div>
        <button class="btn btn--primary btn--sm" type="button" data-new-course>
          ${icon('plus')} Add course</button>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Code', header: true,
              render: (r) => `<span class="mono text-accent" style="font-weight:700">${esc(r.course_code)}</span>` },
            { key: 'course_name', label: 'Course', header: true,
              render: (r) => `<div><span style="display:block">${esc(r.course_name)}</span>
                <span class="faint mono" style="font-size:.62rem">SEM ${esc(r.semester)} ·
                ${esc(r.batch_code ?? 'ALL BATCHES')}</span></div>` },
            { key: 'credits', label: 'Credits', align: 'right',
              render: (r) => `<span class="mono">${num(r.credits)}</span>` },
            { key: 'instructor', label: 'Instructor',
              render: (r) => `<div><span style="display:block;font-size:var(--step--1)">${esc(r.instructor ?? 'UNALLOCATED')}</span>
                <span class="mono faint" style="font-size:.62rem">${esc(r.faculty_code ?? '')}</span></div>` },
            { key: 'enrolled_count', label: 'Enrolled', align: 'right',
              render: (r) => `<span class="mono">${num(r.enrolled_count)}</span>` },
            { key: 'syllabus_file', label: 'Syllabus',
              render: (r) => (r.syllabus_file
                ? `<button class="btn btn--ghost btn--sm" type="button" data-syllabus="${esc(r.syllabus_file)}">
                   ${icon('download')}</button>`
                : '<span class="faint">—</span>') },
          ],
          rows: courses,
          rowKey: (r) => r.course_code,
          empty: 'No courses defined',
          stack: false,
        })}
      </div>
    </section>`;
}

function openCourseModal() {
  openModal({
    title: 'Add a course',
    subtitle: 'Course code must be unique across the department',
    body: `
      <form id="crsForm" class="stack stack-s">
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Course code</span>
            <input class="input mono" name="course_code" required placeholder="CS-605"></label>
          <label class="field"><span class="field__label">Credits</span>
            <input class="input" type="number" name="credits" value="4" min="1" max="10" required></label>
        </div>
        <label class="field"><span class="field__label">Course name</span>
          <input class="input" name="course_name" required
            placeholder="DATA MINING & MACHINE LEARNING"></label>
        <div class="grid grid-2">
          <label class="field"><span class="field__label">Semester</span>
            <input class="input" type="number" name="semester" value="6" min="1" max="10" required></label>
          <label class="field"><span class="field__label">Faculty code</span>
            <input class="input mono" name="faculty_code" placeholder="F-CS-02"></label>
        </div>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>${icon('plus')} Create course</button>`,
    onMount(backdrop, close) {
      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const data = formData(qs('#crsForm', backdrop), { numbers: ['credits', 'semester'] });
        if (!data.course_code || !data.course_name) {
          toast('Code and name are required.', { type: 'warning' });
          return;
        }
        await withBusy(event.currentTarget, async () => {
          try {
            await Api.adminCreateCourse(data);
            toast('Course created.', { type: 'success' });
            close();
            setPanel('courses', coursesPanel(await Api.adminCourses()));
            loadOverview();
            refreshMotion(document);
          } catch (error) { toast(error.message, { type: 'error' }); }
        });
      });
    },
  });
}

/* =========================================================== worksheets == */

function worksheetsPanel(data) {
  const worksheets = data.worksheets ?? [];

  return `
    <section class="grid grid-4" style="margin-bottom:var(--space-l)">
      ${statTile({ label: 'Worksheets', icon: icon('file', 13), value: num(worksheets.length),
        tone: 'var(--accent-soft)', meta: 'Published across all batches' })}
      ${statTile({ label: 'Submissions', icon: icon('upload', 13),
        value: num(worksheets.reduce((s, w) => s + Number(w.submitted_count ?? 0), 0)),
        tone: 'var(--secondary-soft)', meta: 'Answer sheets received' })}
      ${statTile({ label: 'Graded', icon: icon('checkCircle', 13),
        value: num(worksheets.reduce((s, w) => s + Number(w.graded_count ?? 0), 0)),
        tone: 'var(--success-soft)', meta: 'Evaluated by faculty' })}
      ${statTile({ label: 'Awaiting evaluation', icon: icon('clock', 13),
        value: num(worksheets.reduce((s, w) => s + Number(w.submitted_count ?? 0)
          - Number(w.graded_count ?? 0), 0)),
        tone: 'var(--warning-soft)', meta: 'Blocking the evaluation queue' })}
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Worksheet oversight</h3>
          <p class="card__sub">Publication and evaluation progress per worksheet</p>
        </div>
      </header>
      <div class="card__body">
        ${table({
          columns: [
            { key: 'course_code', label: 'Course', header: true,
              render: (r) => `<div><span class="mono text-accent">${esc(r.course_code)}</span>
                <span class="faint" style="font-size:.64rem;display:block">${esc(r.batch_code ?? '')}</span></div>` },
            { key: 'title', label: 'Title', header: true,
              render: (r) => `<div><span style="display:block">${esc(r.title)}</span>
                <span class="faint mono" style="font-size:.62rem">${esc(r.created_by ?? '')}</span></div>` },
            { key: 'deadline_date', label: 'Deadline',
              render: (r) => `<span class="mono" style="font-size:.7rem">${esc(fmtDateShort(r.deadline_date))}</span>` },
            { key: 'progress', label: 'Progress', align: 'right',
              render: (r) => {
                const submitted = Number(r.submitted_count ?? 0);
                const graded = Number(r.graded_count ?? 0);
                const rate = submitted ? (graded / submitted) * 100 : 0;
                return `<div style="min-width:110px">
                  <span class="mono">${num(graded)}/${num(submitted)}</span>
                  <div style="margin-top:4px">${bar(rate, { tone: rate >= 100 ? 'success' : 'warning' })}</div>
                </div>`;
              } },
            { key: 'act', label: '', align: 'right',
              render: (r) => `<button class="btn btn--ghost btn--icon btn--sm" type="button"
                data-extend-ws="${r.worksheet_id}" data-title="${esc(r.title)}"
                data-deadline="${esc(fmtDateShort(r.deadline_date))}"
                aria-label="Extend deadline for ${esc(r.title)}" data-tip="Extend deadline">
                ${icon('clock')}</button>` },
          ],
          rows: worksheets,
          rowKey: (r) => r.worksheet_id,
          empty: 'No worksheets published',
          stack: false,
        })}
      </div>
    </section>`;
}

/* ================================================================= audit == */

function auditPanel(data) {
  const a = data.audit ?? {};
  const filters = state.cache.auditFilters ?? { severity: '', action: '', page: 1, perPage: 20 };

  return `
    <section class="card" data-reveal>
      <header class="card__head">
        <div>
          <h3 class="card__title">Audit trail</h3>
          <p class="card__sub">Append-only record of every privileged action</p>
        </div>
        <button class="btn btn--secondary btn--sm" type="button" data-export-audit>
          ${icon('download')} Export view</button>
      </header>

      <div class="card__body stack">
        <div class="filter-bar">
          <label class="field">
            <span class="sr-only">Severity</span>
            <select class="select" data-audit-severity>
              ${['', 'INFO', 'WARNING', 'SECURITY', 'CRITICAL'].map((s) => `
                <option value="${s}" ${filters.severity === s ? 'selected' : ''}>
                  ${s === '' ? 'All severities' : s}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="sr-only">Action</span>
            <select class="select" data-audit-action>
              <option value="">All actions</option>
              ${(a.actions ?? []).map((x) => `
                <option value="${esc(x)}" ${filters.action === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
            </select>
          </label>
          <div class="cluster cluster-s" style="margin-left:auto">
            ${chip(`${num(a.total ?? 0)} ENTRIES`, 'ghost')}
          </div>
        </div>

        <div data-audit-table>${auditTable(a.rows ?? [])}</div>
        <div data-audit-pager>${pager({
          page: a.page ?? 1, pages: a.pages ?? 1, total: a.total ?? 0, perPage: a.per_page ?? 20,
        })}</div>
      </div>
    </section>`;
}

/* =========================================================== permissions == */

function permissionsPanel(data) {
  const matrix = data.matrix ?? [];
  const legend = data.legend ?? {};

  return `
    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Capability matrix</h3>
            <p class="card__sub">Enforced by the <code>require_roles</code> decorator, not the UI</p>
          </div>
        </header>
        <div class="card__body">
          <div class="perm-grid">
            <div class="perm-grid__head" style="text-align:left">Capability</div>
            <div class="perm-grid__head">Student</div>
            <div class="perm-grid__head">Faculty</div>
            <div class="perm-grid__head">Admin</div>
            ${matrix.map((row) => `
              <div>${esc(row.capability)}</div>
              <div class="perm-cell" data-level="${esc(row.student)}">${esc(row.student)}</div>
              <div class="perm-cell" data-level="${esc(row.teacher)}">${esc(row.teacher)}</div>
              <div class="perm-cell" data-level="${esc(row.admin)}">${esc(row.admin)}</div>`).join('')}
          </div>
        </div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head">
          <h3 class="card__title">Legend</h3>
        </header>
        <div class="card__body">
          ${Object.entries(legend).map(([level, text]) => `
            <div class="kv">
              <span class="kv__key">
                <span class="perm-cell" data-level="${esc(level)}"
                      style="padding:2px 8px;border-radius:4px;display:inline-block">${esc(level)}</span>
              </span>
              <span class="kv__val soft" style="font-family:var(--font-sans)">${esc(text)}</span>
            </div>`).join('')}
        </div>
        <footer class="card__foot">
          <p class="faint" style="font-size:var(--step--2)">
            ${icon('shield')} Role is read from the database at login. A client that sends
            <code>role</code> in the login body has it ignored.</p>
        </footer>
      </article>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <h3 class="card__title">How access is enforced</h3>
      </header>
      <div class="card__body grid grid-3">
        <div class="card card--pad-s" style="background:var(--bg-inset)">
          <p class="mono text-accent" style="font-size:.64rem">01 · AUTHENTICATE</p>
          <p class="soft" style="font-size:var(--step--2);margin-top:6px">
            The httpOnly cookie carries an HS256 JWT. Its <code>jti</code> is registered in
            <code>hpu_auth_session</code>, so logout genuinely revokes.</p>
        </div>
        <div class="card card--pad-s" style="background:var(--bg-inset)">
          <p class="mono text-accent" style="font-size:.64rem">02 · GATE</p>
          <p class="soft" style="font-size:var(--step--2);margin-top:6px">
            <code>require_roles</code> rejects any request whose role claim is not on the
            blueprint's allow-list, with a 403 and an audit row.</p>
        </div>
        <div class="card card--pad-s" style="background:var(--bg-inset)">
          <p class="mono text-accent" style="font-size:.64rem">03 · SCOPE</p>
          <p class="soft" style="font-size:var(--step--2);margin-top:6px">
            Faculty can only touch courses in their own allocation — checked per query,
            not just per route.</p>
        </div>
      </div>
    </section>`;
}

/* =============================================================== system == */

function systemPanel() {
  const k = state.cache.overview?.kpis ?? {};

  return `
    <section class="grid grid-2" style="margin-bottom:var(--space-l)">
      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Database commit</h3>
            <p class="card__sub">Write a named checkpoint to the audit trail</p>
          </div>
          ${icon('db', 20)}
        </header>
        <div class="card__body stack stack-s">
          <label class="field">
            <span class="field__label">Commit message</span>
            <input class="input" id="commitMsg" placeholder="SEM VI MARKS FINALISED"
                   maxlength="120" value="SEM VI ADMIN CHECKPOINT">
          </label>
          <div class="cluster">
            <button class="btn btn--primary" type="button" data-commit>
              ${icon('save')} Run commit cycle</button>
          </div>
          <p class="field__hint">
            Records a <code>COMMIT_CYCLE</code> audit entry with your message and the live
            row counts, then commits the transaction.</p>
        </div>
      </article>

      <article class="card" data-reveal>
        <header class="card__head">
          <div>
            <h3 class="card__title">Maintenance</h3>
            <p class="card__sub">Integrity checks and housekeeping</p>
          </div>
          ${icon('settings', 20)}
        </header>
        <div class="card__body stack stack-s">
          <div>
            ${kv('Students', num(k.students ?? 0))}
            ${kv('Faculty', num(k.faculty ?? 0))}
            ${kv('Courses', num(k.courses ?? 0))}
            ${kv('Worksheets', num(k.worksheets ?? 0))}
            ${kv('Submissions', num(k.submissions ?? 0))}
            ${kv('Audit entries', num(k.audit_entries ?? 0))}
          </div>
          <div class="cluster">
            <button class="btn btn--secondary" type="button" data-maintenance>
              ${icon('refresh')} Run maintenance</button>
            <button class="btn btn--ghost" type="button" data-health>
              ${icon('activity')} Health check</button>
          </div>
        </div>
      </article>
    </section>

    <section class="card" data-reveal>
      <header class="card__head">
        <h3 class="card__title">Bulk exports</h3>
        <p class="card__sub">Generated by the backend from live query results</p>
      </header>
      <div class="card__body grid grid-3">
        ${[
          ['students.csv', 'Student directory', 'Roll, name, registration, attendance, status'],
          ['attendance.csv', 'Attendance register', 'Every lecture record per student'],
          ['marks.csv', 'Marks register', 'Component marks, totals and grades'],
        ].map(([file, title, desc]) => `
          <div class="card card--pad-s card--hover" style="cursor:pointer" data-export-file="${file}">
            <div class="cluster cluster-between" style="margin-bottom:6px">
              <span class="mono text-accent" style="font-size:.64rem">${file}</span>
              ${icon('download', 18)}
            </div>
            <p style="font-weight:700;font-size:var(--step--1)">${title}</p>
            <p class="faint" style="font-size:var(--step--2);margin-top:3px">${desc}</p>
          </div>`).join('')}
      </div>
    </section>`;
}

/* ============================================================== wiring === */

async function loadOverview() {
  try {
    const data = await Api.adminOverview();
    state.cache.overview = data;
    setPanel('overview', overviewPanel(data));
    drawOverviewCharts(data.overview);
    if (panel('system')) setPanel('system', systemPanel());
    refreshMotion(document);
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

function drawOverviewCharts(o = {}) {
  killCharts();

  const gradeHost = qs('[data-chart="grades"]');
  if (gradeHost) {
    const dist = o.grade_distribution ?? [];
    charts.push(donutChart(gradeHost, {
      data: dist.map((g, i) => ({
        label: `Grade ${g.grade}`,
        value: g.total,
        color: cssVar(['--grade-o', '--grade-ap', '--grade-a', '--grade-bp', '--grade-b',
          '--grade-c', '--grade-p', '--grade-f'][i] ?? '--accent'),
      })),
      size: 186, thickness: 22, centreLabel: 'ENTRIES',
      centreValue: String(dist.reduce((s, g) => s + Number(g.total ?? 0), 0)),
      ariaLabel: 'Cohort grade distribution',
    }));
  }

  const subjectHost = qs('[data-chart="subjects"]');
  if (subjectHost) {
    const perf = o.subject_performance ?? [];
    charts.push(barChart(subjectHost, {
      labels: perf.map((s) => s.course_code),
      values: perf.map((s) => n2(s.average)),
      height: 220, valueLabel: 'Average', formatValue: (v) => `${Number(v).toFixed(0)}%`,
      yMax: 100, horizontal: perf.length > 4, ariaLabel: 'Subject performance',
    }));
  }

  animateRings(document);
  refreshMotion(document);
}

async function loadAudit() {
  const filters = state.cache.auditFilters ?? { severity: '', action: '', page: 1, perPage: 20 };
  const data = await Api.adminAudit({
    severity: filters.severity,
    action: filters.action,
    page: filters.page,
    per_page: filters.perPage,
  });
  setPanel('audit', auditPanel(data));
  refreshMotion(document);
}

function wireGlobal() {
  const root = document;

  /* --- navigation helpers ------------------------------------------- */
  on(root, 'click', '[data-goto-students]', () => {
    history.replaceState(null, '', '#students');
    document.dispatchEvent(new CustomEvent('hpu:nav', { detail: { id: 'students' } }));
  });
  on(root, 'click', '[data-goto-audit]', () => {
    history.replaceState(null, '', '#audit');
    document.dispatchEvent(new CustomEvent('hpu:nav', { detail: { id: 'audit' } }));
  });

  /* --- directory ----------------------------------------------------- */
  let searchTimer;
  on(root, 'input', '[data-dir-search]', (event, input) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      directory.q = input.value.trim();
      directory.page = 1;
      loadDirectory();
    }, 260);
  });

  on(root, 'change', '[data-dir-status]', (event, select) => {
    directory.status = select.value;
    directory.page = 1;
    loadDirectory();
  });

  on(root, 'change', '[data-dir-sort]', (event, select) => {
    directory.sort = select.value;
    loadDirectory();
  });

  on(root, 'click', '[data-dir-toggle]', (event, button) => {
    directory.dir = directory.dir === 'desc' ? 'asc' : 'desc';
    button.setAttribute('aria-pressed', String(directory.dir === 'desc'));
    button.innerHTML = `${icon('refresh')} ${directory.dir === 'desc' ? 'Descending' : 'Ascending'}`;
    loadDirectory();
  });

  on(root, 'change', '[data-select]', (event, box) => {
    const id = Number(box.dataset.select);
    if (box.checked) directory.selection.add(id); else directory.selection.delete(id);
    box.closest('tr')?.classList.toggle('is-selected', box.checked);
    updateBulkBar();
  });

  on(root, 'click', '[data-select-all]', () => {
    const rows = directory.data?.rows ?? [];
    const allSelected = rows.every((r) => directory.selection.has(r.student_id));
    rows.forEach((r) => {
      if (allSelected) directory.selection.delete(r.student_id);
      else directory.selection.add(r.student_id);
    });
    renderDirectoryTable();
  });

  on(root, 'click', '[data-bulk]', async (event, button) => {
    const action = button.dataset.bulk;
    const ids = [...directory.selection];
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Apply ${action} to ${ids.length} student${ids.length === 1 ? '' : 's'}?`,
      message: 'This is recorded in the audit trail with your administrator identity.',
      confirmLabel: `Apply ${action}`,
      danger: action === 'LOCK' || action === 'DETAINED',
    });
    if (!ok) return;
    await withBusy(button, async () => {
      try {
        await Api.adminBulkStudents({ action, student_ids: ids });
        toast(`${action} applied to ${ids.length} student${ids.length === 1 ? '' : 's'}.`,
          { type: 'success' });
        await loadDirectory();
        loadOverview();
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  bindPager(qs('[data-dir-pager]') ?? document.createElement('div'), (page) => {
    directory.page = page;
    loadDirectory();
  });

  on(root, 'click', '[data-export]', async (event, button) => {
    await withBusy(button, () => downloadFrom(Api.adminExportUrl('students.csv'), 'hpu-students.csv')
      .then((size) => toast(`Downloaded ${(size / 1024).toFixed(0)} KB of CSV.`,
        { type: 'success', duration: 2600 }))
      .catch((error) => toast(error.message, { type: 'error' })));
  });

  on(root, 'click', '[data-export-file]', (event, card) => {
    downloadFrom(Api.adminExportUrl(card.dataset.exportFile), card.dataset.exportFile)
      .catch((error) => toast(error.message, { type: 'error' }));
  });

  on(root, 'click', '[data-new-student]', () => openStudentModal());
  on(root, 'click', '[data-new-teacher]', openTeacherModal);
  on(root, 'click', '[data-new-course]', openCourseModal);

  on(root, 'click', '[data-edit-student]', async (event, button) => {
    const id = button.dataset.editStudent;
    const row = directory.data?.rows.find((r) => String(r.student_id) === String(id));
    if (!row) return;
    // Fetch the full record so every field is available in the editor.
    const detail = await Api.adminStudents({ q: row.roll_no, per_page: 1 });
    const record = detail.directory.rows.find((r) => String(r.student_id) === String(id)) ?? row;
    openStudentModal({
      ...record,
      first_name: record.full_name.split(' ')[0],
      last_name: record.full_name.split(' ').slice(1).join(' '),
    });
  });

  on(root, 'click', '[data-delete-student]', async (event, button) => {
    const id = button.dataset.deleteStudent;
    const name = button.dataset.name;
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      message: 'The student record and its login are deleted. This cannot be undone.',
      confirmLabel: 'Delete student', danger: true,
    });
    if (!ok) return;
    await withBusy(button, async () => {
      try {
        await Api.adminDeleteStudent(id);
        toast(`${name} removed.`, { type: 'success' });
        directory.selection.delete(Number(id));
        await loadDirectory();
        loadOverview();
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-toggle-lock]', async (event, button) => {
    const id = button.dataset.toggleLock;
    const lock = button.dataset.locked !== 'true';
    await withBusy(button, async () => {
      try {
        await Api.adminUpdateStudent(id, { attendance_lock: lock });
        toast(lock ? 'Portal locked.' : 'Portal unlocked.', { type: 'success', duration: 2400 });
        await loadDirectory();
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-quick-status]', async (event, button) => {
    await withBusy(button, async () => {
      try {
        await Api.adminUpdateStudent(button.dataset.quickStatus,
          { academic_status: button.dataset.status });
        toast(`Status set to ${button.dataset.status}.`, { type: 'success', duration: 2400 });
        loadOverview();
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-warn-teacher]', async (event, button) => {
    const current = Number(button.dataset.count) || 0;
    openModal({
      title: `Formal warnings — ${button.dataset.name}`,
      body: `
        <label class="field">
          <span class="field__label">Warning count (currently ${current})</span>
          <input class="input" type="number" id="warnCount" min="0" max="10" value="${current}">
        </label>`,
      footer: `
        <button class="btn btn--ghost" type="button" data-close>Cancel</button>
        <button class="btn btn--danger" type="button" data-ok>${icon('save')} Update</button>`,
      onMount(backdrop, close) {
        qs('[data-ok]', backdrop).addEventListener('click', async (event) => {
          const value = Number(qs('#warnCount', backdrop).value) || 0;
          await withBusy(event.currentTarget, async () => {
            try {
              await Api.adminUpdateTeacher(button.dataset.warnTeacher, { warning_count: value });
              toast('Warning status updated.', { type: 'success' });
              close();
              setPanel('faculty', facultyPanel(await Api.adminTeachers()));
              refreshMotion(document);
            } catch (error) { toast(error.message, { type: 'error' }); }
          });
        });
      },
    });
  });

  on(root, 'click', '[data-syllabus]', (event, button) => {
    downloadFrom(Api.libraryUrl(button.dataset.syllabus)).catch((e) => toast(e.message, { type: 'error' }));
  });

  on(root, 'click', '[data-extend-ws]', (event, button) => {
    openModal({
      title: 'Extend deadline',
      subtitle: `${button.dataset.title} · currently ${button.dataset.deadline}`,
      body: `
        <label class="field">
          <span class="field__label">New deadline</span>
          <input class="input" type="date" id="newDeadline"
                 value="${esc(new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))}">
        </label>`,
      footer: `
        <button class="btn btn--ghost" type="button" data-close>Cancel</button>
        <button class="btn btn--primary" type="button" data-ok>${icon('save')} Update</button>`,
      onMount(backdrop, close) {
        qs('[data-ok]', backdrop).addEventListener('click', async (event) => {
          await withBusy(event.currentTarget, async () => {
            try {
              const value = qs('#newDeadline', backdrop).value;
              if (!value) throw new Error('Pick a new deadline first.');
              await Api.adminWorksheetDeadline(button.dataset.extendWs, value);
              toast('Deadline updated for every student in this worksheet.',
                { type: 'success' });
              close();
              setPanel('worksheets', worksheetsPanel(await Api.adminNotices()));
              refreshMotion(document);
            } catch (error) { toast(error.message, { type: 'error' }); }
          });
        });
      },
    });
  });

  /* --- audit --------------------------------------------------------- */
  on(root, 'change', '[data-audit-severity]', (event, select) => {
    state.cache.auditFilters = { ...(state.cache.auditFilters ?? {}), severity: select.value, page: 1 };
    loadAudit();
  });

  on(root, 'change', '[data-audit-action]', (event, select) => {
    state.cache.auditFilters = { ...(state.cache.auditFilters ?? {}), action: select.value, page: 1 };
    loadAudit();
  });

  on(root, 'click', '[data-audit-pager] [data-page]', (event, button) => {
    state.cache.auditFilters = {
      ...(state.cache.auditFilters ?? {}), page: Number(button.dataset.page),
    };
    loadAudit();
  });

  on(root, 'click', '[data-export-audit]', (event, button) => {
    const rows = qs('[data-audit-table] table tbody')?.querySelectorAll('tr') ?? [];
    const lines = [['Timestamp', 'Severity', 'Action', 'Actor', 'Role', 'Target', 'Detail', 'Source']];
    rows.forEach((tr) => {
      lines.push([...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()));
    });
    const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), { href: url, download: 'hpu-audit.csv' });
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('Audit view exported.', { type: 'success', duration: 2400 });
  });

  /* --- system -------------------------------------------------------- */
  on(root, 'click', '[data-commit]', async (event, button) => {
    const message = qs('#commitMsg')?.value || 'ADMIN CHECKPOINT';
    await withBusy(button, async () => {
      try {
        const result = await Api.adminCommit(message);
        toast(`Committed as ${result.reference}.`, { type: 'success', title: 'Commit cycle complete' });
        loadOverview();
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-maintenance]', async (event, button) => {
    await withBusy(button, async () => {
      try {
        const result = await Api.adminMaintenance();
        const lines = Object.entries(result.checks ?? result.results ?? {})
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
        toast(result.message ?? 'Maintenance complete',
          { type: 'success', title: 'Maintenance', duration: 7000 });
        if (lines.length) {
          openModal({
            title: 'Maintenance report',
            wide: true,
            body: `<div class="stack stack-s">${lines.map((l) => `
              <div class="kv"><span class="kv__key mono" style="font-size:.7rem">${esc(l.split(':')[0])}</span>
              <span class="kv__val" style="white-space:normal;text-align:right">${esc(l.split(':').slice(1).join(':'))}</span>
              </div>`).join('')}</div>`,
            footer: '<button class="btn btn--secondary" type="button" data-close>Close</button>',
          });
        }
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });

  on(root, 'click', '[data-health]', async (event, button) => {
    await withBusy(button, async () => {
      try {
        const h = await Api.health();
        openModal({
          title: 'System health',
          wide: true,
          body: `
            <div class="grid grid-3" style="gap:var(--space-2xs)">
              ${Object.entries(h.counts ?? {}).map(([k, v]) => `
                <div class="card card--pad-s" style="background:var(--bg-inset)">
                  <p class="mono faint" style="font-size:.6rem">${esc(k)}</p>
                  <p class="ring__figure" style="margin-top:4px">${num(v)}</p>
                </div>`).join('')}
            </div>
            <div>
              ${kv('Engine', h.database?.engine ?? '—')}
              ${kv('Schema migrated', h.database?.migrated ? 'yes' : 'no')}
              ${kv('Seed loaded', h.database?.seeded ? 'yes' : 'no')}
              ${kv('Server time', fmtDate(h.server_time ?? new Date().toISOString(), { withDay: true }))}
              ${kv('Version', h.version ?? '—')}
            </div>`,
          footer: '<button class="btn btn--secondary" type="button" data-close>Close</button>',
        });
      } catch (error) { toast(error.message, { type: 'error' }); }
    });
  });
}

/* ================================================================ init == */

export async function init() {
  const [overview, teachers, courses, worksheets] = await Promise.all([
    Api.adminOverview(),
    Api.adminTeachers(),
    Api.adminCourses(),
    Api.adminNotices(),
  ]);

  state.cache.overview = overview;

  setPanel('overview', overviewPanel(overview));
  // Render the real directory shell (toolbar + [data-dir-table] + pager) before
  // fetching, so loadDirectory() has a host to fill. A bare loader here left the
  // panel spinning forever.
  setPanel('students', studentsPanel());
  setPanel('faculty', facultyPanel(teachers));
  setPanel('courses', coursesPanel(courses));
  setPanel('worksheets', worksheetsPanel(worksheets));
  setPanel('audit', `<div class="card">${loader('Loading audit trail')}</div>`);
  setPanel('permissions', permissionsPanel(await Api.adminPermissions()));
  setPanel('system', systemPanel());

  drawOverviewCharts(overview.overview);
  await loadDirectory();
  await loadAudit();

  wireGlobal();
  refreshMotion(document);
  animateRings(document);
}