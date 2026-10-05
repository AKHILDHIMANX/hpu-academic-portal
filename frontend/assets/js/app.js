/* =============================================================================
   app.js — the shell shared by all three portals.
   -----------------------------------------------------------------------------
   Responsibilities:
     * verify the session and role before anything renders
     * paint the header, sidebar rail, mobile tab bar and theme picker
     * wire the rail to the in-page tab system (URL hash routing)
     * own logout, the notification drawer and the password modal
     * refresh animations after every render
   ========================================================================== */

import { Api, onApiError, downloadFrom } from './core/api.js';
import {
  refresh, guardPage, logout, goLogin, goPortal, currentUser, currentRole,
  onAuthChange, ROLES, cachedSession,
} from './core/auth.js';
import {
  qs, qsa, el, on, render, toast, openModal, openDrawer, tabs,
  icon, withBusy, formData, fieldError, passwordStrength,
} from './core/ui.js';
import { esc, upper, initials, fmtRelative, fmtDate } from './core/format.js';
import { initMotion, refresh as refreshMotion, scrollTo } from './core/motion.js';
import { mountThemePicker, watchTheme, currentTheme, themeName, cycleTheme } from './core/theme.js';
import { destroyAllCharts } from './core/charts.js';

const page = document.documentElement.dataset.page
  || document.body.dataset.page
  || 'student';

const nav = {
  student: [
    { id: 'overview', label: 'Overview', icon: 'home',
      hint: 'Your attendance, marks and deadlines at a glance.' },
    { id: 'attendance', label: 'Attendance', icon: 'checkCircle',
      hint: 'Subject-wise record, projected standing and shortfalls.' },
    { id: 'academics', label: 'Academics', icon: 'book',
      hint: 'Enrolled courses, faculty and syllabus references.' },
    { id: 'results', label: 'Results & CGPA', icon: 'award',
      hint: 'Transcript, credit totals, standing and grade scale.' },
    { id: 'worksheets', label: 'Worksheets', icon: 'file',
      hint: 'Submit assignments and track faculty grading.' },
    { id: 'library', label: 'Resources', icon: 'layers',
      hint: 'Question papers, notes and reference material.' },
    { id: 'notices', label: 'Notices', icon: 'bell',
      hint: 'University circulars and examination schedules.' },
  ],
  teacher: [
    { id: 'overview', label: 'Overview', icon: 'home',
      hint: 'Your allocated courses and today’s teaching load.' },
    { id: 'attendance', label: 'Attendance', icon: 'checkCircle',
      hint: 'Punch a lecture and mark the register in one pass.' },
    { id: 'marks', label: 'Marks Entry', icon: 'edit',
      hint: 'Enter internal assessment marks for the whole section.' },
    { id: 'worksheets', label: 'Worksheets', icon: 'file',
      hint: 'Publish assignments and grade submissions.' },
    { id: 'analytics', label: 'Analytics', icon: 'chart',
      hint: 'Section performance trends and risk distribution.' },
    { id: 'notices', label: 'Circulars', icon: 'bell',
      hint: 'Publish department notices to your students.' },
  ],
  admin: [
    { id: 'overview', label: 'Command Centre', icon: 'home',
      hint: 'Institution-wide KPIs, risk list and audit activity.' },
    { id: 'students', label: 'Students', icon: 'users',
      hint: 'Directory, enrolment, promotion and bulk operations.' },
    { id: 'faculty', label: 'Faculty', icon: 'user',
      hint: 'Appointments, allocations and grading deadlines.' },
    { id: 'courses', label: 'Curriculum', icon: 'book',
      hint: 'Course catalogue, credits and prerequisites.' },
    { id: 'worksheets', label: 'Worksheets', icon: 'file',
      hint: 'Extend deadlines and moderate every assignment.' },
    { id: 'audit', label: 'Audit Trail', icon: 'shield',
      hint: 'Every privileged action, who did it and when.' },
    { id: 'permissions', label: 'Permissions', icon: 'key',
      hint: 'What each role is allowed to do, enforced server-side.' },
    { id: 'system', label: 'System', icon: 'settings',
      hint: 'Maintenance, checkpoints and data export.' },
  ],
};

const ROLE_FOR_PAGE = { student: 'STUDENT', teacher: 'TEACHER', admin: 'ADMIN' };

/* ============================================================ app state === */
export const state = {
  page,
  session: null,
  user: null,
  role: null,
  cache: {},
  nav: nav[page] ?? [],
  active: nav[page]?.[0]?.id ?? 'overview',
};

export const setCache = (key, value) => { state.cache[key] = value; };
export const getCache = (key, fallback = null) => state.cache[key] ?? fallback;

/* ============================================================== helpers === */

/**
 * The API returns the role-specific record nested under `detail`
 * (hpu_student / hpu_teacher / hpu_user_auth). Flatten it once so the shell,
 * the drawers and the panels can read `user.roll_no` etc. directly.
 */
function flattenProfile(profile) {
  if (!profile) return null;
  const { detail, ...rest } = profile;
  const merged = { ...rest, ...(detail && typeof detail === 'object' ? detail : {}) };
  merged.detail = detail ?? {};
  if (!merged.first_name || !merged.last_name) {
    const [first, ...restName] = String(merged.full_name ?? '').trim().split(/\s+/);
    merged.first_name ??= first ?? '';
    merged.last_name = restName.join(' ');
  }
  return merged;
}

/** Short context line under the rail brand, per role. */
function railContext() {
  const u = state.user ?? {};
  if (state.role === 'STUDENT') {
    return [u.batch_code, u.course].filter(Boolean).join(' · ') || 'STUDENT';
  }
  if (state.role === 'TEACHER') {
    return [u.faculty_code, u.department].filter(Boolean).join(' · ') || 'FACULTY';
  }
  return u.designation || u.full_name || 'ADMINISTRATOR';
}

function brand(compact = false) {
  return `
    <a class="brand" href="/" aria-label="HPU Academic Portal home">
      <img class="brand__mark" src="/media/hpu-logo.png" alt="" width="38" height="38">
      <span class="brand__text">
        <span class="brand__name">HPU Academic Portal</span>
        <span class="brand__sub">${esc(ROLES[state.role]?.label ?? 'Portal')}</span>
      </span>
    </a>`;
}

function avatarNode(user, size = '') {
  if (!user) return `<span class="avatar ${size}">??</span>`;
  if (user.avatar_url) {
    return `<span class="avatar ${size}"><img src="/media/${esc(user.avatar_url)}"
      alt="${esc(user.full_name ?? '')}" loading="lazy"></span>`;
  }
  return `<span class="avatar ${size}">${esc(initials(user.first_name, user.last_name))}</span>`;
}

function railMarkup() {
  return `
    <div class="rail-brand">
      <a class="brand" href="/" aria-label="HPU Academic Portal home">
        <img class="brand__mark" src="/media/hpu-logo.png" alt="" width="38" height="38">
        <span class="brand__text">
          <span class="brand__name">HPU Portal</span>
          <span class="brand__sub">${esc(railContext())}</span>
        </span>
      </a>
    </div>

    <div class="app-rail__scroll">
      <div class="rail-group">
        <span class="rail-label" id="railLabel">Workspace</span>
        <nav aria-labelledby="railLabel">
          ${state.nav.map((item) => `
            <a class="rail-link" href="#${item.id}" data-nav="${item.id}"
               ${item.id === state.active ? 'aria-current="page"' : ''}>
              <span class="rail-link__icon">${icon(item.icon, 20)}</span>
              <span class="rail-link__label">${esc(item.label)}</span>
              ${item.count ? `<span class="rail-link__count" data-count-for="${item.id}"></span>` : ''}
            </a>`).join('')}
        </nav>
      </div>

      <div class="rail-group">
        <span class="rail-label" id="railHelp">Account</span>
        <nav aria-labelledby="railHelp">
          <a class="rail-link" href="#vault" data-vault>
            <span class="rail-link__icon">${icon('download', 20)}</span>
            <span class="rail-link__label">Document Vault</span>
          </a>
          <button class="rail-link" type="button" data-password>
            <span class="rail-link__icon">${icon('lock', 20)}</span>
            <span class="rail-link__label">Change Password</span>
          </button>
          <a class="rail-link" href="#shortcuts" data-shortcuts>
            <span class="rail-link__icon">${icon('key', 20)}</span>
            <span class="rail-link__label">Keyboard Shortcuts</span>
          </a>
        </nav>
      </div>
    </div>

    <div class="rail-foot">
      <button class="rail-link" type="button" data-collapse>
        <span class="rail-link__icon">${icon('menu', 20)}</span>
        <span class="rail-foot__text rail-link__label">Collapse</span>
      </button>
    </div>`;
}

function headerMarkup() {
  const user = state.user ?? {};
  const roleLabel = ROLES[state.role]?.label ?? '';
  return `
    <button class="btn btn--ghost btn--icon" type="button" data-drawer-toggle
            aria-label="Open navigation menu" aria-expanded="false">
      ${icon('menu')}
    </button>

    <div style="min-width:0;flex:1 1 auto">${brand()}</div>

    <div class="header-actions">
      <button class="btn btn--ghost btn--icon" type="button" data-bell
              aria-label="Notifications">
        ${icon('bell')}
        <span class="chip__dot" data-bell-dot
              style="position:absolute;top:6px;right:6px;background:var(--danger);display:none"></span>
      </button>

      <span data-theme-picker></span>

      <button class="user-chip" type="button" data-account aria-label="Account menu">
        ${avatarNode(user)}
        <span style="min-width:0">
          <span class="user-chip__name">${esc(user.full_name ?? 'Account')}</span>
          <span class="user-chip__role">${esc(roleLabel)}</span>
        </span>
      </button>

      <button class="btn btn--ghost btn--icon" type="button" data-logout
              aria-label="Sign out" data-tip="Sign out">${icon('logout')}</button>
    </div>

    <span class="header-scroll" aria-hidden="true"></span>`;
}

function mobileBarMarkup() {
  const primary = state.nav.slice(0, 4);
  return `
    <div class="mobile-bar__row">
      ${primary.map((item) => `
        <a class="mobile-bar__item" href="#${item.id}" data-nav="${item.id}">
          ${icon(item.icon, 21)}<span>${esc(item.label.split(' ')[0])}</span>
        </a>`).join('')}
      <button class="mobile-bar__item" type="button" data-drawer-toggle>
        ${icon('menu', 21)}<span>More</span>
      </button>
    </div>`;
}

/* ============================================================== shell ===== */

function buildShell() {
  const shell = qs('#app');
  if (!shell) return;

  shell.className = 'app-shell';
  shell.dataset.page = state.page;
  shell.innerHTML = `
    <aside class="app-rail" id="rail" aria-label="Portal navigation">${railMarkup()}</aside>
    <div class="app-column">
      <header class="site-header" id="siteHeader">${headerMarkup()}</header>
      <main class="app-main" id="main" tabindex="-1">
        <div class="container" id="panels"></div>
      </main>
    </div>`;

  const bar = qs('#mobileBar');
  if (bar) bar.innerHTML = mobileBarMarkup();
}

/** Renders the tab strip + panel wrappers once, then lets pages fill them. */
function buildPanels() {
  const host = qs('#panels');
  if (!host) return null;

  const sticky = document.querySelector('meta[name="portal-sticky"]');
  const showTabs = sticky?.content !== 'false' && state.nav.length > 1;

  host.innerHTML = `
    <div class="portal-head" id="sectionHead">
      <div class="portal-head__id">
        <p class="eyebrow">${esc(ROLES[state.role]?.label ?? 'Portal')}</p>
        <h1 class="portal-head__title" data-section-title>${esc(state.nav[0]?.label ?? '')}</h1>
        <p class="portal-head__meta" data-section-hint>${esc(state.nav[0]?.hint ?? '')}</p>
      </div>
    </div>

    ${showTabs ? `
      <div class="tab-list" role="tablist" aria-label="Portal sections">
        ${state.nav.map((item, i) => `
          <button class="tab" type="button" role="tab" id="tab-${item.id}"
                  data-tab="${item.id}" data-tab-panel="panel-${item.id}"
                  aria-controls="panel-${item.id}"
                  aria-selected="${i === 0 ? 'true' : 'false'}"
                  tabindex="${i === 0 ? 0 : -1}">${esc(item.label)}</button>`).join('')}
      </div>` : ''}

    ${state.nav.map((item, i) => `
      <section class="tab-panel" role="tabpanel" id="panel-${item.id}"
               data-tab-panel="panel-${item.id}" data-nav-panel="${item.id}"
               aria-labelledby="tab-${item.id}" ${i === 0 ? '' : 'hidden'}></section>`).join('')}
  `;

  return { host, showTabs };
}

/** Called by a page module to fill one panel. */
export function panel(id) {
  return qs(`[data-nav-panel="${id}"]`);
}

export function setPanel(id, markup) {
  const node = panel(id);
  if (!node) return null;
  node.innerHTML = markup;
  node.dataset.animateIn = '';
  return node;
}

/* ======================================================== interactivity === */

function wireRail() {
  const rail = qs('#rail');
  const scrim = qs('#scrim');
  if (!rail) return;

  const closeDrawer = () => {
    rail.classList.remove('is-open');
    scrim?.classList.remove('is-open');
    document.body.style.overflow = '';
    qsa('[data-drawer-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };

  qsa('[data-drawer-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const open = rail.classList.toggle('is-open');
      scrim?.classList.toggle('is-open', open);
      document.body.style.overflow = open ? 'hidden' : '';
      button.setAttribute('aria-expanded', String(open));
    });
  });

  scrim?.addEventListener('click', closeDrawer);
  rail.addEventListener('click', (event) => {
    if (event.target.closest('[data-nav]')) closeDrawer();
  });

  on(rail, 'click', '[data-collapse]', () => setRailCollapsed());

  // Restore the collapsed state the user chose last time.
  const saved = document.cookie.split('; ')
    .find((c) => c.startsWith('hpu.rail='))?.endsWith('collapsed');
  if (saved) setRailCollapsed(true, false);

  qsa('.rail-link[data-nav]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      gotoSection(link.dataset.nav);
    });
  });

  on(qs('#mobileBar') || document, 'click', '[data-nav]', (event, link) => {
    event.preventDefault();
    gotoSection(link.dataset.nav);
    closeDrawer();
  });

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && state.nav.some((n) => n.id === id)) activate(id);
  });

  wireTabs();
}

/** The horizontal tab strip: click plus the ARIA keyboard pattern. */
function wireTabs() {
  const list = qs('.tab-list');
  if (!list) return;

  list.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    gotoSection(tab.dataset.tab);
    tab.focus({ preventScroll: true });
  });

  list.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) {
      if (event.key === 'Home') { event.preventDefault(); qsa('.tab', list)[0]?.focus(); }
      if (event.key === 'End') {
        event.preventDefault();
        const all = qsa('.tab', list);
        all[all.length - 1]?.focus();
      }
      return;
    }
    event.preventDefault();
    const all = qsa('.tab', list);
    const current = all.indexOf(document.activeElement);
    const next = all[(current + step + all.length) % all.length];
    if (!next) return;
    gotoSection(next.dataset.tab);
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/** Persist + apply the collapsed rail in one place. */
function setRailCollapsed(force, persist = true) {
  const rail = qs('#rail');
  if (!rail) return;
  const collapsed = force === undefined ? !rail.hasAttribute('data-collapsed') : Boolean(force);
  // The CSS keys off [data-collapsed='true'], so never use an empty value.
  if (collapsed) rail.setAttribute('data-collapsed', 'true');
  else rail.removeAttribute('data-collapsed');
  qs('#app')?.setAttribute('data-rail', collapsed ? 'collapsed' : 'expanded');
  if (persist) {
    document.cookie = `hpu.rail=${collapsed ? 'collapsed' : 'open'};path=/;max-age=31536000;samesite=lax`;
  }
}

function gotoSection(id) {
  history.replaceState(null, '', `#${id}`);
  activate(id);
}

/** Marks a nav item active and shows its panel. */
function activate(id) {
  state.active = id;
  const item = state.nav.find((n) => n.id === id);

  qsa('[data-nav]').forEach((node) => {
    if (node.classList.contains('rail-link')) {
      if (node.dataset.nav === id) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    } else if (node.classList.contains('mobile-bar__item')) {
      if (node.dataset.nav === id) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
  });
  qsa('.tab').forEach((tab) => {
    const active = tab.dataset.tab === id;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  });
  qsa('[data-nav-panel]').forEach((node) => {
    const active = node.dataset.navPanel === id;
    node.hidden = !active;
    if (active) { node.dataset.animateIn = ''; }
  });

  const title = qs('[data-section-title]');
  const hint = qs('[data-section-hint]');
  if (title && item) title.textContent = item.label;
  if (hint && item) hint.textContent = item.hint ?? '';

  document.title = `${item?.label ?? 'Portal'} · HPU ${ROLES[state.role]?.label ?? 'Portal'}`;
  document.dispatchEvent(new CustomEvent('hpu:nav', { detail: { id } }));
}

function wireGlobalActions() {
  on(document, 'click', '[data-logout]', async (event, button) => {
    await withBusy(button, async () => {
      await logout();
      toast('Signed out. Your session has been revoked on the server.', { type: 'success' });
      setTimeout(() => goLogin({ reason: 'logout' }), 480);
    });
  });

  on(document, 'click', '[data-password]', () => openPasswordModal());
  on(document, 'click', '[data-bell]', () => openNotifications());
  on(document, 'click', '[data-account]', () => openAccountDrawer());
  on(document, 'click', '[data-vault]', (event) => {
    event.preventDefault();
    openVault();
  });
  on(document, 'click', '[data-shortcuts]', (event) => {
    event.preventDefault();
    openShortcuts();
  });

  // Keyboard: "?" opens the shortcut sheet, "g" then a key jumps sections.
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (event.key === '?') { event.preventDefault(); openShortcuts(); return; }
    if (event.key === 't' && !event.shiftKey) { cycleTheme(); }
    if (event.key === 'g') {
      const on_ = (e) => {
        const index = '123456789'.indexOf(e.key);
        if (index >= 0 && state.nav[index]) {
          const id = state.nav[index].id;
          history.replaceState(null, '', `#${id}`);
          activate(id);
        }
        document.removeEventListener('keydown', on_, true);
      };
      document.addEventListener('keydown', on_, true);
      setTimeout(() => document.removeEventListener('keydown', on_, true), 1400);
    }
  });
}

function openPasswordModal() {
  openModal({
    title: 'Change password',
    subtitle: 'This revokes every other active session on the server.',
    body: `
      <form id="pwForm" class="stack stack-s" novalidate>
        <label class="field">
          <span class="field__label">Current password</span>
          <input class="input" type="password" name="current_password" required
                 autocomplete="current-password" placeholder="••••••••">
        </label>
        <label class="field">
          <span class="field__label">New password</span>
          <input class="input" type="password" name="new_password" required minlength="8"
                 autocomplete="new-password" placeholder="At least 8 characters">
          <span class="pw-meter" data-meter>
            <span class="pw-meter__track"><span class="pw-meter__fill" data-fill></span></span>
            <span class="pw-meter__label" data-strength>ENTER A NEW PASSWORD</span>
          </span>
        </label>
        <label class="field">
          <span class="field__label">Confirm new password</span>
          <input class="input" type="password" name="confirm_password" required
                 autocomplete="new-password" placeholder="Repeat the new password">
        </label>
      </form>`,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-submit>
        ${icon('key')} Update password
      </button>`,
    onMount(backdrop, close) {
      const form = qs('#pwForm', backdrop);
      const newPw = form.elements.new_password;

      newPw.addEventListener('input', () => {
        const { score, label, tone } = passwordStrength(newPw.value);
        const fill = qs('[data-fill]', backdrop);
        fill.style.width = `${(score / 4) * 100}%`;
        fill.style.background = `var(--${tone})`;
        qs('[data-strength]', backdrop).textContent = newPw.value ? label : 'ENTER A NEW PASSWORD';
      });

      qs('[data-submit]', backdrop).addEventListener('click', async (event) => {
        const data = formData(form);
        qsa('input', form).forEach((i) => fieldError(i, ''));
        let bad = false;
        if (!data.current_password) { fieldError(form.elements.current_password, 'Required'); bad = true; }
        if (!data.new_password || data.new_password.length < 8) {
          fieldError(form.elements.new_password, 'Minimum 8 characters'); bad = true;
        }
        if (data.new_password !== data.confirm_password) {
          fieldError(form.elements.confirm_password, 'Passwords do not match'); bad = true;
        }
        if (bad) return;

        await withBusy(event.currentTarget, async () => {
          try {
            await Api.changePassword(data);
            toast('Password updated. Other sessions were signed out.', { type: 'success' });
            close();
          } catch (error) {
            if (error.isValidation) fieldError(form.elements.current_password, error.message);
            else toast(error.message, { type: 'error', title: 'Could not change password' });
          }
        });
      });
    },
  });
}

async function openNotifications() {
  openDrawer({
    title: 'Notifications',
    subtitle: 'Circulars, deadlines and academic alerts',
    body: '<div class="loader"><span class="loader__spinner"></span></div>',
  });

  try {
    const { notifications = [] } = await Api.notifications();
    const backdrop = qs('.drawer-backdrop.is-open');
    const body = backdrop?.querySelector('.modal__body');
    if (!body) return;

    if (!notifications.length) {
      body.innerHTML = '<div class="empty"><p class="empty__title">No notifications</p>'
        + '<p class="empty__text">Circulars from the examination cell will appear here.</p></div>';
      return;
    }

    body.innerHTML = `<div class="timeline">
      ${notifications.map((n) => `
        <article class="timeline__item">
          <div class="cluster cluster-s" style="margin-bottom:4px">
            <span class="chip chip--${n.severity === 'WARNING' ? 'warning' : 'info'}">${esc(n.kind)}</span>
            ${n.read ? '' : '<span class="chip chip--accent">NEW</span>'}
          </div>
          <h4 style="font-family:var(--font-sans);font-size:var(--step--1);font-weight:700">
            ${esc(n.title)}</h4>
          <p class="soft clamp-3" style="font-size:var(--step--2);margin-top:4px">${esc(n.body)}</p>
          <p class="mono faint" style="font-size:0.62rem;margin-top:6px">
            ${esc(n.meta)} · ${esc(fmtRelative(n.timestamp))}</p>
        </article>`).join('')}
    </div>`;

    qs('[data-bell-dot]')?.style.setProperty('display', 'none');
  } catch (error) {
    const backdrop = qs('.drawer-backdrop.is-open');
    const body = backdrop?.querySelector('.modal__body');
    if (body) body.innerHTML = `<div class="auth-alert">${icon('alert')}<span>${esc(error.message)}</span></div>`;
  }
}

function openAccountDrawer() {
  const u = state.user ?? {};
  const rows = [
    ['Full name', u.full_name],
    ['University email', u.email],
    [state.role === 'TEACHER' ? 'Faculty code' : state.role === 'STUDENT' ? 'Roll number' : 'User code',
      state.role === 'TEACHER' ? u.faculty_code : state.role === 'STUDENT' ? u.roll_no : u.user_code],
    state.role === 'STUDENT' ? ['Registration', u.reg_no] : null,
    state.role === 'TEACHER' ? ['Designation', u.designation] : null,
    state.role === 'STUDENT' ? ['Department', [u.department, u.course].filter(Boolean).join(' · ')] : null,
    state.role === 'STUDENT' ? ['Semester / batch', [u.semester, u.batch_code].filter(Boolean).join(' · ')] : null,
    ['Role', ROLES[state.role]?.label],
    ['Last sign-in', u.last_login_at ? fmtDate(u.last_login_at, { withDay: true }) : '—'],
  ].filter((row) => row && row[1]);

  openDrawer({
    title: 'Account',
    subtitle: ROLES[state.role]?.label,
    body: `
      <div class="cluster" style="gap:var(--space-s)">
        ${avatarNode(u, 'avatar-lg')}
        <div style="min-width:0">
          <h3 style="font-family:var(--font-sans);font-size:var(--step-1)">${esc(u.full_name ?? '')}</h3>
          <p class="dim" style="font-size:var(--step--2)">${esc(u.email ?? '')}</p>
        </div>
      </div>
      <div>${rows.map(([k, v]) => `
        <div class="kv"><span class="kv__key">${esc(k)}</span>
        <span class="kv__val">${esc(v)}</span></div>`).join('')}</div>
      <div class="card card--pad-s" style="background:var(--bg-inset)">
        <p class="mono faint" style="font-size:0.62rem;letter-spacing:.12em">THEME</p>
        <p class="soft" style="font-size:var(--step--2);margin-top:4px">
          ${esc(themeName(currentTheme()))} — press <kbd>T</kbd> to cycle.</p>
      </div>`,
    footer: `
      <button class="btn btn--secondary" type="button" data-close>Close</button>
      <button class="btn btn--secondary" type="button" data-password>
        ${icon('key')} Change password
      </button>
      <button class="btn btn--danger" type="button" data-logout>
        ${icon('logout')} Sign out
      </button>`,
  });
}

async function openVault() {
  openModal({
    title: 'Document vault',
    subtitle: 'Every seeded document served by the backend',
    wide: true,
    body: '<div class="loader"><span class="loader__spinner"></span></div>',
  });

  try {
    const { assets = [] } = await Api.fileManifest();
    // openModal() hands back its close fn; the backdrop is the node it appended,
    // so read it from the DOM instead of depending on the .is-open animation
    // class having landed yet.
    const body = [...qsa('.modal-backdrop')].pop()?.querySelector('.modal__body');
    if (!body) return;

    const byKind = assets.reduce((acc, a) => {
      (acc[a.kind ?? a.category ?? 'OTHER'] ??= []).push(a);
      return acc;
    }, {});

    body.innerHTML = Object.entries(byKind).map(([kind, list]) => `
      <section class="stack stack-s">
        <h4 style="font-family:var(--font-sans);font-size:var(--step-0);font-weight:700">
          ${esc(upper(kind))} <span class="faint mono" style="font-size:0.7rem">(${list.length})</span>
        </h4>
        <div class="grid grid-3">
          ${list.map((a) => `
            <button class="card card--pad-s card--hover" type="button" data-asset="${esc(a.file_url)}"
                    style="text-align:left;display:grid;gap:4px">
              <span class="mono faint" style="font-size:0.58rem">${esc(a.file_url)}</span>
              <span style="font-size:var(--step--1);font-weight:700">${esc(a.title ?? a.file_url)}</span>
              <span class="faint" style="font-size:0.66rem">${esc(a.size_label ?? '')}</span>
            </button>`).join('')}
        </div>
      </section>`).join('');

    on(body, 'click', '[data-asset]', async (event, button) => {
      await withBusy(button, () => downloadFrom(Api.libraryUrl(button.dataset.asset))
        .then(() => toast('Download started', { type: 'success', duration: 2200 }))
        .catch((error) => toast(error.message, { type: 'error' })));
    });
  } catch (error) {
    const body = [...qsa('.modal-backdrop')].pop()?.querySelector('.modal__body');
    if (body) body.innerHTML = `<div class="auth-alert">${icon('alert')}<span>${esc(error.message)}</span></div>`;
  }
}

function openShortcuts() {
  openModal({
    title: 'Keyboard shortcuts',
    body: `
      <div class="kv"><span class="kv__key">Move between sections</span>
        <span class="kv__val"><kbd>1</kbd> … <kbd>9</kbd></span></div>
      <div class="kv"><span class="kv__key">Jump then pick</span>
        <span class="kv__val"><kbd>G</kbd> then <kbd>3</kbd></span></div>
      <div class="kv"><span class="kv__key">Cycle colour theme</span>
        <span class="kv__val"><kbd>T</kbd></span></div>
      <div class="kv"><span class="kv__key">This dialog</span>
        <span class="kv__val"><kbd>?</kbd></span></div>
      <div class="kv"><span class="kv__key">Close any overlay</span>
        <span class="kv__val"><kbd>Esc</kbd></span></div>`,
    footer: '<button class="btn btn--secondary" type="button" data-close>Got it</button>',
  });
}

/* ================================================================= boot === */

function finishBoot() {
  qs('#boot')?.classList.add('is-done');
  setTimeout(() => qs('#boot')?.remove(), 900);
}

function paintIdentity(session) {
  state.session = session;
  const source = session?.user ?? cachedSession()?.user ?? null;
  state.user = flattenProfile(source);
  state.role = session?.role ?? session?.user?.role ?? currentRole() ?? ROLE_FOR_PAGE[state.page];
}

function bootError(message) {
  finishBoot();
  render(qs('#panels') ?? document.body, `
    <div class="stack" style="max-width:520px;margin-inline:auto;text-align:center;padding-block:var(--space-2xl)">
      <div class="empty">
        ${icon('alert', 44)}
        <p class="empty__title">Could not reach the portal</p>
        <p class="empty__text">${esc(message)}</p>
      </div>
      <div class="cluster" style="justify-content:center">
        <button class="btn btn--primary" type="button" data-retry>Retry</button>
        <button class="btn btn--secondary" type="button" data-goto-login>Go to sign in</button>
      </div>
    </div>`);
  on(document, 'click', '[data-retry]', () => location.reload());
  on(document, 'click', '[data-goto-login]', () => goLogin({ reason: 'error' }));
}

async function boot() {
  watchTheme();

  onApiError((error) => {
    if (error.isAuth && !location.pathname.startsWith('/login')) {
      goLogin({ reason: 'expired', next: location.pathname });
      return;
    }
    if (error.isForbidden) {
      toast('You do not have permission to do that.', { type: 'warning', title: 'Access denied' });
    } else if (!error.isOffline && error.status >= 500) {
      toast(error.message, { type: 'error', title: 'Server error' });
    }
  });

  onAuthChange((session) => {
    if (session) paintIdentity(session);
  });

  let session;
  try {
    session = await guardPage(ROLE_FOR_PAGE[state.page]);
  } catch (error) {
    paintIdentity(null);
    bootError(error.message);
    return;
  }

  if (!session) return;

  paintIdentity(session);
  buildShell();
  buildPanels();
  // The picker lives inside the header the shell just built, so mount it now.
  qsa('[data-theme-picker]').forEach((slot) => mountThemePicker(slot));
  wireRail();
  wireGlobalActions();
  initMotion(document);

  // Let the page module paint its panels.
  const module = await import(`./pages/${state.page}.js`);
  await module.init?.(state);

  activate(location.hash.slice(1) || state.nav[0]?.id || 'overview');
  refreshMotion(document);
  finishBoot();

  // Kick off lazily-loaded shared data.
  Api.notifications()
    .then(({ notifications = [] }) => {
      const dot = qs('[data-bell-dot]');
      if (dot) dot.style.display = notifications.some((n) => !n.read) ? 'block' : 'none';
    })
    .catch(() => {});
}

export { activate, scrollTo, toast, icon, esc, openModal, openDrawer, qs, qsa,
  el, on, tabs, destroyAllCharts };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}