/* =============================================================================
   login.js — the sign-in screen.
   -----------------------------------------------------------------------------
   Deliberately small. It renders the demo identities advertised by the backend,
   posts the credentials to /api/auth/login, and hands the browser to the portal
   the *server* chose. It never decides a role on its own.
   ========================================================================== */

import { Api, ApiError } from './core/api.js';
import { login as signIn, portalFor, refresh } from './core/auth.js';
import { mountThemePicker, cycleTheme, watchTheme } from './core/theme.js';
import { initMotion, countUpAll } from './core/motion.js';
import { esc } from './core/format.js';
import { qs, qsa, el, toast, withBusy, icon } from './core/ui.js';

const form = qs('#loginForm');
const identifierField = qs('#identifier');
const passwordField = qs('#password');
const submitBtn = qs('[data-submit]', form);
const alertBox = qs('#loginAlert');
const demoGrid = qs('[data-demo-grid]');

let accounts = [];
let selected = null;

/* -------------------------------------------------------------- feedback -- */

const ALERT_ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
  warn: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/>',
};

function alert(message, tone = 'error') {
  if (!alertBox) return;
  if (!message) {
    alertBox.hidden = true;
    alertBox.innerHTML = '';
    return;
  }
  alertBox.hidden = false;
  alertBox.className = `auth-alert auth-alert--${tone}`;
  alertBox.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  alertBox.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${ALERT_ICONS[tone] ?? ALERT_ICONS.error}
    </svg>
    <span>${esc(message)}</span>`;
}

function fieldError(input, errorNode, message) {
  if (errorNode) {
    errorNode.textContent = message || '';
    errorNode.hidden = !message;
  }
  if (input) {
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) input.closest('.field')?.classList.add('is-invalid');
    else input.closest('.field')?.classList.remove('is-invalid');
  }
}

/* ---------------------------------------------------------- demo accounts -- */

const ROLE_ICON = { STUDENT: 'cap', TEACHER: 'user', ADMIN: 'shield' };

function demoCard(account) {
  const card = el('button', {
    class: 'demo-card',
    type: 'button',
    'aria-pressed': 'false',
    'data-identifier': account.identifier,
    'data-password': account.password,
    title: `Sign in as ${account.name}`,
  });
  card.innerHTML = `
    <span class="demo-card__badge">${icon(ROLE_ICON[account.role] ?? 'user', 19)}</span>
    <span class="demo-card__body">
      <span class="demo-card__name">${esc(account.name)}</span>
      <span class="demo-card__hint">${esc(account.hint ?? account.identifier)}</span>
    </span>
    <svg class="demo-card__tick" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"/>
    </svg>`;
  card.addEventListener('click', () => pick(account, card));
  return card;
}

function pick(account, card) {
  selected = account;
  identifierField.value = account.identifier;
  passwordField.value = account.password;
  qsa('.demo-card', demoGrid).forEach((c) =>
    c.setAttribute('aria-pressed', String(c === card)));
  fieldError(identifierField, qs('#identifierError'));
  fieldError(passwordField, qs('#passwordError'));
  alert('');
  toast(`Loaded ${account.label.toLowerCase()} credentials — press Sign in.`, {
    type: 'info', duration: 3200,
  });
}

async function loadDemoAccounts() {
  try {
    const data = await Api.demoAccounts();
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    accounts = [];
  }

  demoGrid.innerHTML = '';
  if (!accounts.length) {
    demoGrid.innerHTML = `
      <p class="field__hint">
        The demo identity list is unavailable. Type your university credentials below.
      </p>`;
    return;
  }
  accounts.forEach((account) => demoGrid.append(demoCard(account)));
}

/* -------------------------------------------------------------- submitting -- */

async function handleSubmit(event) {
  event.preventDefault();
  alert('');

  const identifier = identifierField.value.trim();
  const password = passwordField.value;

  let invalid = false;
  if (!identifier) {
    fieldError(identifierField, qs('#identifierError'), 'Enter your email or roll number.');
    invalid = true;
  } else if (!password) {
    fieldError(passwordField, qs('#passwordError'), 'Enter your password.');
    invalid = true;
  }
  if (invalid) {
    (identifier ? passwordField : identifierField).focus();
    return;
  }

  try {
    // The portal comes from the server response, never from the selected card.
    const session = await withBusy(submitBtn, () => signIn(identifier, password));
    const target = session?.portal || portalFor(session?.role);
    toast(`Signed in as ${session?.user?.full_name ?? identifier}. Opening your portal…`,
      { type: 'success', duration: 2000 });
    // Let the toast land before the navigation swaps the document.
    setTimeout(() => window.location.replace(target), 300);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 401) {
      fieldError(passwordField, qs('#passwordError'), 'That password is not correct.');
      fieldError(identifierField, qs('#identifierError'), 'No account matches that identifier.');
      alert('Sign-in failed. Check the identifier and password, or try the roll number.', 'error');
      passwordField.select();
    } else if (status === 429) {
      alert('Too many attempts from this device. Wait a minute and try again.', 'warn');
    } else if (status === 423) {
      alert('This account is locked. Contact the examination cell.', 'warn');
    } else {
      alert(error.message || 'Sign-in failed. Please try again.', 'error');
    }
    passwordField.focus();
  }
}

/* ------------------------------------------------------------------- wire -- */

function wireReveal() {
  const toggle = qs('[data-reveal-password]');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const showing = passwordField.type === 'text';
    passwordField.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-pressed', String(!showing));
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    passwordField.focus();
  });
}

function wireShortcut() {
  qs('[data-theme-cycle]')?.addEventListener('click', () => {
    const next = cycleTheme();
    toast(`Theme · ${next.name}`, { duration: 1500 });
  });
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      const next = cycleTheme();
      toast(`Theme · ${next.name}`, { duration: 1500 });
    }
  });
}

/** Replaces <span data-icon="name"> placeholders with real SVG. */
function hydrateIcons(root = document) {
  qsa('[data-icon]', root).forEach((node) => {
    if (node.firstElementChild) return;
    node.innerHTML = icon(node.dataset.icon, Number(node.dataset.iconSize) || 20);
  });
}

function wireSlug() {
  // "/?student_id=2" style deep links from the admin directory.
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get('identifier') || params.get('email');
  if (prefill) {
    identifierField.value = prefill;
    passwordField.focus();
  }
}

function explainReason() {
  const reason = new URLSearchParams(window.location.search).get('reason');
  if (reason === 'session') {
    alert('Your session ended. Please sign in again to continue.', 'info');
  } else if (reason === 'role') {
    alert('You are already signed in with a different role.', 'warn');
  } else if (reason === 'expired') {
    alert('Your session expired for security. Please sign in again.', 'info');
  }
}

/* ------------------------------------------------------------------- boot -- */

async function boot() {
  // Two pickers: the aside one on desktop, the compact strip on mobile.
  qsa('[data-theme-picker]').forEach((slot) => mountThemePicker(slot));
  watchTheme();
  hydrateIcons();
  wireReveal();
  wireShortcut();
  wireSlug();
  explainReason();

  form.addEventListener('submit', handleSubmit);
  identifierField.addEventListener('input', () => {
    fieldError(identifierField, qs('#identifierError'));
    alert('');
  });
  passwordField.addEventListener('input', () => {
    fieldError(passwordField, qs('#passwordError'));
    alert('');
  });

  // Already signed in? Skip straight to the right portal.
  const existing = await refresh({ force: true });
  if (existing?.role) {
    window.location.replace(portalFor(existing.role));
    return;
  }

  initMotion();
  countUpAll(qs('.auth-aside'));
  await loadDemoAccounts();
  initMotion(qs('.auth-card'));
  identifierField.focus({ preventScroll: true });
}

boot().catch((error) => {
  // A hard failure here must still leave a usable form.
  alert(error.message || 'The sign-in screen could not initialise.', 'error');
  loadDemoAccounts();
  identifierField.focus({ preventScroll: true });
});