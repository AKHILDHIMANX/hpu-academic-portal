/* =============================================================================
   ui.js — DOM helpers, toasts, modals, drawers, tabs, skeletons and the
   small render primitives (cards, tables, chips) shared by all three portals.
   ========================================================================== */

import { esc, toneFor, num, pct, clamp } from './format.js';

/* Re-exported so page modules can pull every primitive from one place. */
export { esc, toneFor, num, pct, clamp } from './format.js';

/* ------------------------------------------------------------- DOM utils -- */
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Tagged template that auto-escapes interpolations. Use `raw()` to opt out. */
const RAW = Symbol('raw');
export const raw = (html) => ({ [RAW]: String(html) });

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    out += value && typeof value === 'object' && RAW in value
      ? value[RAW]
      : Array.isArray(value)
        ? value.map((v) => (v && typeof v === 'object' && RAW in v ? v[RAW] : esc(v))).join('')
        : esc(value);
    out += strings[i + 1];
  }
  return out;
}

/** Replace a container's contents with an HTML string, then announce it. */
export function render(target, markup) {
  const node = typeof target === 'string' ? qs(target) : target;
  if (!node) return null;
  node.innerHTML = markup;
  node.dispatchEvent(new CustomEvent('hpu:render', { bubbles: true }));
  return node;
}

/** Event delegation: on(root, 'click', '[data-act="x"]', handler). */
export function on(root, type, selector, handler, options) {
  const node = typeof root === 'string' ? qs(root) : root;
  if (!node) return () => {};
  const listener = (event) => {
    const match = event.target.closest(selector);
    if (match && node.contains(match)) handler(event, match);
  };
  node.addEventListener(type, listener, options);
  return () => node.removeEventListener(type, listener, options);
}

/* -------------------------------------------------------------- feedback -- */

const ICONS = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/>',
  warning: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
};

function toastStack() {
  let stack = qs('.toast-stack');
  if (!stack) {
    stack = el('div', {
      class: 'toast-stack',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    });
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message, { type = 'info', title = '', duration = 4600 } = {}) {
  const stack = toastStack();
  const node = el('div', {
    class: `toast toast--${type}`,
    role: type === 'error' ? 'alert' : 'status',
  });
  node.innerHTML = `
    <svg class="toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${ICONS[type] ?? ICONS.info}
    </svg>
    <div class="toast__body">
      ${title ? `<div class="toast__title">${esc(title)}</div>` : ''}
      <div class="toast__msg">${esc(message)}</div>
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss notification">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;

  const dismiss = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  };

  node.querySelector('.toast__close').addEventListener('click', dismiss);
  stack.append(node);
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

toast.success = (m, o) => toast(m, { ...o, type: 'success' });
toast.error = (m, o) => toast(m, { ...o, type: 'error', duration: 6500 });
toast.warn = (m, o) => toast(m, { ...o, type: 'warning' });
toast.info = (m, o) => toast(m, { ...o, type: 'info' });

/* ----------------------------------------------------------------- modal -- */

let openOverlays = [];

function lockScroll(lock) {
  document.body.style.overflow = lock ? 'hidden' : '';
}

/**
 * `.is-open` gates `visibility`, not just opacity, so a missed frame would leave
 * an invisible but focus-trapping overlay on screen. requestAnimationFrame is
 * throttled to a standstill in background tabs, so we add the class on the next
 * frame for the entrance transition but force it shortly after regardless.
 */
function revealOverlay(node) {
  requestAnimationFrame(() => node.classList.add('is-open'));
  setTimeout(() => node.classList.add('is-open'), 80);
}

export function openModal({ title, subtitle = '', body, footer = '', wide = false, tall = false,
  onMount } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'modal--wide' : ''} ${tall ? 'modal--tall' : ''}"
         role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal__head">
        <div style="min-width:0">
          <h2 class="modal__title">${esc(title)}</h2>
          ${subtitle ? `<p class="modal__sub">${esc(subtitle)}</p>` : ''}
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close
                aria-label="Close dialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </header>
      <div class="modal__body">${body ?? ''}</div>
      ${footer ? `<footer class="modal__foot">${footer}</footer>` : ''}
    </div>`;

  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.classList.remove('is-open');
    openOverlays = openOverlays.filter((o) => o !== close);
    if (!openOverlays.length) lockScroll(false);
    setTimeout(() => backdrop.remove(), 260);
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    // Trap focus inside the dialog.
    const focusables = qsa(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      backdrop,
    ).filter((n) => n.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.append(backdrop);
  lockScroll(true);
  openOverlays.push(close);
  revealOverlay(backdrop);
  setTimeout(() => qs('input, select, textarea, button:not([data-close])', backdrop)
    ?.focus?.({ preventScroll: true }), 120);

  if (onMount) onMount(backdrop, close);
  return close;
}

export function closeModal(closeFn) {
  if (typeof closeFn === 'function') { closeFn(); return; }
  // Overlays stack, so always act on the topmost one -- and match on the node
  // rather than the .is-open animation class, which may not have landed yet.
  const top = [...document.querySelectorAll('.modal-backdrop')].pop();
  top?.querySelector('[data-close]')?.click();
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm',
  cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Wire inside onMount. Reaching for '.modal-backdrop.is-open' here would run
    // in the same tick openModal() created the node, before the class lands, and
    // left every confirm button in the portal dead.
    openModal({
      title,
      body: `<p class="soft">${esc(message)}</p>`,
      footer: `
        <button class="btn btn--ghost" type="button" data-close>${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" type="button" data-ok>
          ${esc(confirmLabel)}
        </button>`,
      onMount(backdrop, close) {
        qs('[data-ok]', backdrop).addEventListener('click', () => {
          close();
          settle(true);
        });
        backdrop.addEventListener('click', (event) => {
          if (event.target === backdrop || event.target.closest('[data-close]')) settle(false);
        });
      },
    });
  });
}

/* ---------------------------------------------------------------- drawer -- */

export function openDrawer({ title, subtitle = '', body, footer = '', onMount } = {}) {
  const backdrop = el('div', { class: 'drawer-backdrop' });
  backdrop.innerHTML = `
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal__head">
        <div style="min-width:0">
          <h2 class="modal__title">${esc(title)}</h2>
          ${subtitle ? `<p class="modal__sub">${esc(subtitle)}</p>` : ''}
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close aria-label="Close panel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </header>
      <div class="modal__body">${body ?? ''}</div>
      ${footer ? `<footer class="modal__foot">${footer}</footer>` : ''}
    </aside>`;

  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.classList.remove('is-open');
    setTimeout(() => backdrop.remove(), 320);
    lockScroll(openOverlays.some((o) => o !== close));
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };

  const onKey = (event) => { if (event.key === 'Escape') close(); };

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.append(backdrop);
  lockScroll(true);
  openOverlays.push(close);
  revealOverlay(backdrop);
  if (onMount) onMount(backdrop, close);
  return close;
}

/* ------------------------------------------------------------------ tabs -- */

/**
 * Wires a tab list to panels. Uses View Transitions when the browser has them
 * so a tab swap animates rather than snapping.
 */
export function tabs({ list, panels, onChange, initial = null }) {
  const listNode = typeof list === 'string' ? qs(list) : list;
  if (!listNode) return { select: () => {} };

  const buttons = qsa('[data-tab]', listNode);
  const panelNodes = buttons
    .map((b) => qs(`#${CSS.escape(b.dataset.tabPanel || b.dataset.tab)}`))
    .filter(Boolean);

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function activate(name, { focus = false } = {}) {
    buttons.forEach((button) => {
      const active = button.dataset.tab === name;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });

    panelNodes.forEach((panel) => {
      const active = panel.id === `panel-${name}` || panel.dataset.tabPanel === name;
      panel.hidden = !active;
      if (active) {
        panel.dataset.animateIn = '';
        if (prefersReduced) delete panel.dataset.animateIn;
      }
    });

    onChange?.(name);
    if (location.hash.slice(1) !== name) {
      history.replaceState(null, '', `#${name}`);
    }
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.tab === (qs('[data-tab][aria-selected="true"]', listNode)?.dataset.tab)) return;
      const name = button.dataset.tab;
      if (document.startViewTransition && !prefersReduced) {
        document.startViewTransition(() => activate(name));
      } else {
        activate(name);
      }
    });
    button.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(button);
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        buttons[(index + 1) % buttons.length].focus();
        buttons[(index + 1) % buttons.length].click();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = buttons[(index - 1 + buttons.length) % buttons.length];
        prev.focus();
        prev.click();
      } else if (event.key === 'Home') {
        event.preventDefault(); buttons[0].focus(); buttons[0].click();
      } else if (event.key === 'End') {
        event.preventDefault();
        buttons[buttons.length - 1].focus();
        buttons[buttons.length - 1].click();
      }
    });
  });

  const fromHash = location.hash.slice(1);
  const start = initial
    || (buttons.some((b) => b.dataset.tab === fromHash) ? fromHash : buttons[0]?.dataset.tab);
  if (start) activate(start);
  else panelNodes.forEach((p) => { p.hidden = true; });

  window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (buttons.some((b) => b.dataset.tab === name)) activate(name);
  });

  return { select: activate, buttons };
}

/* ------------------------------------------------------------- skeletons -- */

export const skeletonRows = (rows = 5, cols = 4) => `
  <div class="stack stack-s" aria-hidden="true">
    ${Array.from({ length: rows }, () => `
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px">
        ${Array.from({ length: cols }, (_, i) => `
          <div class="skeleton" style="height:14px;${i === 0 ? 'width:70%' : ''}"></div>
        `).join('')}
      </div>`).join('')}
  </div>`;

export const skeletonCards = (count = 4, height = 108) => `
  <div class="grid grid-4" aria-hidden="true">
    ${Array.from({ length: count }, () => `
      <div class="skeleton" style="height:${height}px;border-radius:var(--radius-m)"></div>
    `).join('')}
  </div>`;

export const skeletonLines = (count = 4) => `
  <div class="stack stack-s" aria-hidden="true">
    ${Array.from({ length: count }, () => `
      <div class="skeleton" style="height:13px;${Math.random() > 0.5 ? 'width:85%' : ''}"></div>
    `).join('')}
  </div>`;

export const skeletonTable = (rows = 6, cols = 5) => `
  <div class="stack stack-s" aria-hidden="true">
    <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px">
      ${Array.from({ length: cols }, (_, i) => `<div class="skeleton" style="height:11px;width:${i === 0 ? 60 : 45}%"></div>`).join('')}
    </div>
    ${Array.from({ length: rows }, () => `
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px">
        ${Array.from({ length: cols }, () => '<div class="skeleton" style="height:16px"></div>').join('')}
      </div>`).join('')}
  </div>`;

export const loader = (label = 'Loading') => `
  <div class="loader"><span class="loader__spinner"></span><span>${esc(label)}</span></div>`;

export function emptyState({ title = 'Nothing here yet', text = '', icon = 'inbox',
  action = '' } = {}) {
  const icons = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1Z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
  };
  return `
    <div class="empty">
      <svg class="empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        ${icons[icon] ?? icons.inbox}
      </svg>
      <p class="empty__title">${esc(title)}</p>
      ${text ? `<p class="empty__text">${esc(text)}</p>` : ''}
      ${action ? (action && typeof action === 'object' && RAW in action ? action[RAW] : action) : ''}
    </div>`;
}

/* ------------------------------------------------------------- fragments -- */

export const chip = (text, tone = null, { dot = false, grade = null } = {}) => {
  const resolved = tone ?? (grade ? toneFor(grade) : 'ghost');
  return `<span class="chip chip--${resolved}"${grade ? ` data-grade="${esc(grade)}"` : ''}>
    ${dot ? '<i class="chip__dot"></i>' : ''}${esc(text)}</span>`;
};

export const bar = (value, { tone = null, large = false } = {}) => `
  <div class="bar ${tone ? `bar--${tone}` : ''} ${large ? 'bar--lg' : ''}" role="progressbar"
       aria-valuenow="${clamp(value, 0, 100).toFixed(1)}" aria-valuemin="0" aria-valuemax="100">
    <span class="bar__fill" data-bar="${clamp(value, 0, 100) / 100}"></span>
  </div>`;

export function statTile({ label, value, unit = '', meta = '', icon = '', tone = '',
  trend = null } = {}) {
  const trendMarkup = trend
    ? `<span class="stat__trend trend-${trend.dir}">
         ${trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '■'} ${esc(trend.text)}
       </span>`
    : '';
  return `
    <article class="stat" ${tone ? `style="--stat-tint:${tone}"` : ''} data-reveal>
      <span class="stat__label">${icon ? icon : ''}${esc(label)}</span>
      <span class="stat__value" data-count="${esc(value)}">${esc(value)}${
        unit ? `<small> ${esc(unit)}</small>` : ''}</span>
      ${meta || trendMarkup
        ? `<span class="stat__meta">${esc(meta)}${trendMarkup ? ` ${trendMarkup}` : ''}</span>`
        : ''}
    </article>`;
}

export const kv = (key, value) => `
  <div class="kv"><span class="kv__key">${esc(key)}</span>
  <span class="kv__val">${esc(value)}</span></div>`;

/**
 * Renders a table from a declarative column spec.
 * cols: [{ key, label, align, render(row), sortable, className }]
 */
export function table({ columns, rows, rowKey = (r, i) => i, empty = 'No records',
  stack = true, sort = null, selectedIds = [] } = {}) {
  if (!rows || !rows.length) return emptyState({ title: empty, icon: 'search' });

  const head = columns.map((col) => {
    const sortable = col.sortable && sort;
    const direction = sortable && sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null;
    return `<th scope="col" class="${col.align === 'right' ? 'num' : ''} ${
      sortable ? 'is-sortable' : ''}"${sortable ? ` data-sort="${esc(col.key)}" tabindex="0" role="button"` : ''}${
      direction ? ` aria-sort="${direction}"` : ''}>
      ${esc(col.label)}${sortable ? '<span class="sort-mark" aria-hidden="true">▾</span>' : ''}</th>`;
  }).join('');

  const body = rows.map((row, index) => {
    const id = rowKey(row, index);
    return `<tr data-row-id="${esc(id)}"${selectedIds.includes(id) ? ' class="is-selected"' : ''}>
      ${columns.map((col) => {
        const content = col.render ? col.render(row, index) : esc(row[col.key] ?? '—');
        const cls = [col.align === 'right' ? 'num' : '', col.className ?? ''].filter(Boolean).join(' ');
        return `<${col.header ? 'th scope="row"' : 'td'} class="${cls}" data-label="${esc(col.label)}">${content}</${col.header ? 'th' : 'td'}>`;
      }).join('')}
    </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table class="table ${stack ? 'table--stack' : ''}">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

export function pager({ page, pages, total, perPage, onGo }) {
  if (!pages || pages < 1) return '';
  const window_ = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(pages, from + 4);
  for (let i = from; i <= to; i += 1) window_.push(i);

  const first = total === 0 ? 0 : (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);

  return `
    <nav class="pager" aria-label="Pagination">
      <p class="pager__info">Showing <strong>${num(first)}–${num(last)}</strong> of
        <strong>${num(total)}</strong> records</p>
      <div class="pager__pages">
        <button class="pager__btn" type="button" data-page="${page - 1}"
          ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
        ${window_.map((n) => `
          <button class="pager__btn" type="button" data-page="${n}"
            ${n === page ? 'aria-current="true"' : ''}>${n}</button>`).join('')}
        <button class="pager__btn" type="button" data-page="${page + 1}"
          ${page >= pages ? 'disabled' : ''} aria-label="Next page">›</button>
      </div>
    </nav>`;
}

export function bindPager(container, onGo) {
  on(container, 'click', '[data-page]', (event, button) => {
    const next = Number(button.dataset.page);
    if (Number.isFinite(next) && next > 0) onGo(next);
  });
}

/* ------------------------------------------------------------ form utils -- */

/** Toggle a button into a busy state, restoring it when the promise settles. */
export async function withBusy(button, task) {
  if (!button) return task();
  const wasDisabled = button.disabled;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = wasDisabled;
  }
}

/** Read a form into a plain object, trimming strings and coercing numbers. */
export function formData(form, { numbers = [] } = {}) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (value instanceof File) { if (value.size) data[key] = value; continue; }
    const text = typeof value === 'string' ? value.trim() : value;
    data[key] = numbers.includes(key) && text !== '' ? Number(text) : text;
  }
  return data;
}

export function fieldError(input, message = '') {
  const wrap = input.closest('.field');
  if (!wrap) return;
  const slot = wrap.querySelector('.field__error');
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    if (slot) { slot.textContent = message; slot.hidden = false; }
    else wrap.append(el('p', { class: 'field__error', text: message }));
  } else {
    input.removeAttribute('aria-invalid');
    if (slot) { slot.textContent = ''; slot.hidden = true; }
  }
}

/** Simple password strength score 0..4 with a human label. */
export function passwordStrength(value) {
  const s = String(value ?? '');
  if (!s) return { score: 0, label: 'EMPTY', tone: 'danger' };
  let score = 0;
  if (s.length >= 8) score += 1;
  if (s.length >= 12) score += 1;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score += 1;
  if (/\d/.test(s)) score += 1;
  if (/[^A-Za-z0-9]/.test(s)) score += 1;
  score = clamp(score, 0, 4);
  const labels = ['TOO WEAK', 'WEAK', 'FAIR', 'STRONG', 'EXCELLENT'];
  const tones = ['danger', 'danger', 'warning', 'success', 'success'];
  return { score, label: labels[score], tone: tones[score] };
}

/* --------------------------------------------------------------- icons --- */
export const icon = (name, size = 18) => {
  const paths = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m7 15 4-5 3 3 5-7"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    cap: '<path d="m22 10-10-5L2 10l10 5 10-5Z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M3 4h18l-7 8v7l-4 2v-9Z"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 1 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.5-1.1-.3-.3-.4-.6-.4-1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-5-4.5-8.7-10-8.7Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="m8.2 13.4-1.4 7.8L12 18.4l5.2 2.8-1.4-7.8"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l2.4 3.2H6.6Z"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.2-8.2"/><path d="m17 6 2.5 2.5"/><path d="M14.5 8.5 17 11"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${paths[name] ?? paths.grid}</svg>`;
}