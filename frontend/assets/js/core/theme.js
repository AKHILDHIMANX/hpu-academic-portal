/* =============================================================================
   theme.js — theme switcher.
   The chosen theme is written to localStorage and applied by an inline <head>
   script before first paint (no flash). This module owns the picker UI and the
   cross-tab / system-preference behaviour.
   ========================================================================== */

import { esc } from './format.js';

export const THEMES = [
  { id: 'noir', name: 'Noir', note: 'Pure black', swatches: ['#000000', '#ffffff', '#8d8d93'] },
  { id: 'graphite', name: 'Graphite', note: 'Dark grey', swatches: ['#131316', '#f2f2f4', '#919197'] },
  { id: 'hdr', name: 'HDR', note: 'Max contrast', swatches: ['#ffffff', '#000000', '#5c5c63'] },
  { id: 'cream', name: 'Cream', note: 'Warm paper', swatches: ['#fbf6ec', '#1c1710', '#8c2b22'] },
  { id: 'alabaster', name: 'Alabaster', note: 'Cool white', swatches: ['#f4f5f7', '#0e1116', '#22654a'] },
];

const KEY = 'hpu.theme';
const DEFAULT = 'noir';

const isValid = (id) => THEMES.some((t) => t.id === id);

export function currentTheme() {
  return document.documentElement.dataset.theme || DEFAULT;
}

export function applyTheme(id, { persist = true } = {}) {
  const theme = isValid(id) ? id : DEFAULT;
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg-base').trim() || '#000000';
  }

  if (persist) {
    try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
  }

  document.dispatchEvent(new CustomEvent('hpu:theme', { detail: { theme } }));

  const trigger = document.querySelector('[data-theme-toggle]');
  if (trigger) {
    trigger.setAttribute('aria-label', `Theme: ${themeName(theme)}. Change theme`);
    trigger.setAttribute('title', `Theme: ${themeName(theme)}`);
  }
  return theme;
}

export const themeName = (id) => THEMES.find((t) => t.id === id)?.name ?? id;

/** Cycles through the five themes — used by the header button. */
export function cycleTheme() {
  const index = THEMES.findIndex((t) => t.id === currentTheme());
  const next = THEMES[(index + 1) % THEMES.length];
  applyTheme(next.id);
  return next;
}

/* --------------------------------------------------------------- picker -- */

export function mountThemePicker(container) {
  if (!container) return;
  container.classList.add('theme-menu');
  container.innerHTML = `
    <button class="btn btn--ghost btn--icon" type="button" data-theme-toggle
            aria-haspopup="true" aria-expanded="false" aria-label="Change theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="13.5" cy="6.5" r="1.4"/><circle cx="17.5" cy="10.5" r="1.4"/>
        <circle cx="8.5" cy="7.5" r="1.4"/><circle cx="6.5" cy="12.5" r="1.4"/>
        <path d="M12 2a10 10 0 1 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.5-1.1-.3-.3-.4-.6-.4-1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-5-4.5-8.7-10-8.7Z"/>
      </svg>
    </button>
    <div class="theme-pop" role="menu" aria-label="Colour theme">
      ${THEMES.map((t) => `
        <button class="theme-option" type="button" role="menuitemradio" data-theme="${t.id}"
                aria-checked="${t.id === currentTheme()}">
          <span class="theme-option__swatches" aria-hidden="true">
            ${t.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}
          </span>
          <span class="theme-option__name">${esc(t.name)}</span>
          <span class="theme-option__note">${esc(t.note)}</span>
          <svg class="theme-option__check" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </button>`).join('')}
    </div>`;

  const trigger = container.querySelector('[data-theme-toggle]');
  const pop = container.querySelector('.theme-pop');

  const close = () => {
    pop.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const open = () => {
    pop.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  };

  const onOutside = (event) => {
    if (!container.contains(event.target)) close();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') { close(); trigger.focus(); }
  };

  trigger.addEventListener('click', () => {
    if (pop.classList.contains('is-open')) close(); else open();
  });

  container.addEventListener('click', (event) => {
    const option = event.target.closest('[data-theme]');
    if (!option) return;
    applyTheme(option.dataset.theme);
    container.querySelectorAll('[data-theme]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.theme === option.dataset.theme));
    });
    close();
  });

  // Keep multiple open pickers in sync (e.g. header + mobile bar).
  document.addEventListener('hpu:theme', (event) => {
    container.querySelectorAll('[data-theme]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.theme === event.detail.theme));
    });
  });
}

/** Sync the picker state across browser tabs. */
export function watchTheme() {
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY || !isValid(event.newValue)) return;
    applyTheme(event.newValue, { persist: false });
  });
}