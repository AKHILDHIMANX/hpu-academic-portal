/* =============================================================================
   format.js — pure display helpers. No DOM, no network.
   Every number the portal shows passes through here so units, rounding and
   locale stay consistent across all three portals.
   ========================================================================== */

const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * Raw number, NaN-safe. `Number(x) ?? 0` is a trap — `??` only catches
 * null/undefined, so `Number(undefined)` slips through as NaN and poisons any
 * arithmetic or SVG attribute downstream. Anything that feeds a chart, a
 * comparison or a coordinate must go through this instead.
 */
export const n2 = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const num = (value, fallback = 0) => NUM.format(n2(value, fallback));

export const int = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  return INT.format(Number.isFinite(n) ? n : fallback);
};

export const pct = (value, digits = 1) => {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';};

export const gpa = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
};

export const money = (value) => (Number.isFinite(Number(value)) ? `₹${NUM.format(value)}` : '—');

/** Fraction (0..1) -> percentage string. */
export const fractionToPct = (value, digits = 1) => pct(Number(value) * 100, digits);

/* ------------------------------------------------------------------ dates -- */

/** Accepts 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM:SS' or an ISO string. */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const iso = raw.length === 10 ? `${raw}T00:00:00` : raw.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/** '04 OCT 2026' */
export function fmtDate(value, { withDay = false, upper = true } = {}) {
  const d = parseDate(value);
  if (!d) return '—';
  const base = `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const day = withDay ? `${DAYS[d.getDay()]} · ` : '';
  return upper ? `${day}${base}` : `${day}${base.toLowerCase()}`;
}

/** '04 OCT' — compact axis label */
export function fmtDateShort(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

/** '2 DAYS AGO' / 'IN 3 HOURS' */
export function fmtRelative(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const delta = d.getTime() - Date.now();
  const abs = Math.abs(delta);
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

  const phrase = (n, unit) => {
    const plural = Math.round(n) === 1 ? unit : `${unit}s`;
    return `${Math.round(n)} ${plural}`;
  };

  let out;
  if (abs < MIN) out = 'JUST NOW';
  else if (abs < HOUR) out = phrase(abs / MIN, 'MINUTE');
  else if (abs < DAY) out = phrase(abs / HOUR, 'HOUR');
  else if (abs < DAY * 30) out = phrase(abs / DAY, 'DAY');
  else if (abs < DAY * 365) out = phrase(abs / (DAY * 30), 'MONTH');
  else out = phrase(abs / (DAY * 365), 'YEAR');

  if (out === 'JUST NOW') return out;
  return delta < 0 ? `${out} AGO` : `IN ${out}`;
}

/** Whole days between today and the date (negative = past). */
export function daysUntil(value) {
  const d = parseDate(value);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86_400_000);
}

/** 'DEADLINE IN 2 DAYS' style urgency chip. */
export function urgency(value) {
  const d = daysUntil(value);
  if (d === null) return { label: 'NO DATE', tone: 'ghost' };
  if (d < 0) return { label: `CLOSED ${Math.abs(d)}D AGO`, tone: 'danger' };
  if (d === 0) return { label: 'DUE TODAY', tone: 'danger' };
  if (d === 1) return { label: 'DUE TOMORROW', tone: 'warning' };
  if (d <= 3) return { label: `DUE IN ${d} DAYS`, tone: 'warning' };
  if (d <= 7) return { label: `DUE IN ${d} DAYS`, tone: 'info' };
  return { label: `DUE IN ${d} DAYS`, tone: 'ghost' };
}

export const monthName = (m) => MONTHS[Number(m) - 1] ?? '—';
export const dayName = (value) => {
  const d = parseDate(value);
  return d ? DAYS[d.getDay()] : '—';
};

/* ------------------------------------------------------------------ text -- */

/** Title Case from an UPPER/lower source, preserving known short forms. */
export function titleCase(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Pl\/Sql|Or|Sql|Pls|Api|Ui|Ux|Cgpa|Gpa|Cpu|Ram|Cse|Hpu|Pdf)\b/g,
      (m) => m.toUpperCase());
}

export const upper = (value) => String(value ?? '').toUpperCase();

export function initials(first, last) {
  const a = String(first ?? '').trim()[0] ?? '';
  const b = String(last ?? '').trim()[0] ?? '';
  return (a + b).toUpperCase() || '??';
}

export const truncate = (value, len = 60) => {
  const s = String(value ?? '');
  return s.length > len ? `${s.slice(0, len - 1)}…` : s;
};

export const slugify = (value) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Escape for safe interpolation into an HTML template string. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ----------------------------------------------------------------- status -- */

const STATUS_TONE = {
  ACTIVE: 'success', SAFE: 'success', UNLOCKED: 'success', GRADED: 'success',
  'CHECKED & GRADED': 'success', PUBLISHED: 'success', COMPLETED: 'success',
  PRESENT: 'success', GOOD: 'success', EXCELLENT: 'success',

  WARNING: 'warning', WATCH: 'warning', PENDING: 'warning', UNDER_EVALUATION: 'warning',
  SUBMITTED: 'info', 'ON CAMPUS': 'info', IN_CABIN: 'info', DRAFT: 'info',
  OFF_CAMPUS: 'ghost', AWAY: 'ghost',

  DETAINED: 'danger', SUSPENDED: 'danger', LOCKED: 'danger', FAIL: 'danger',
  ABSENT: 'danger', ABSENTEES: 'danger', LOW: 'danger', OVERDUE: 'danger',

  DEFAULTER: 'danger', AT_RISK: 'danger', SECURITY: 'danger', ERROR: 'danger',
  'IN CABIN': 'info', NOT_APPLICABLE: 'ghost', 'NA': 'ghost',
};

export function toneFor(status) {
  return STATUS_TONE[String(status ?? '').toUpperCase()] ?? 'ghost';
}

/** Attendance/health band used for bars and chips. */
export function attendanceBand(percentage, threshold = 75) {
  const p = Number(percentage);
  if (!Number.isFinite(p)) return 'danger';
  if (p >= threshold) return 'success';
  if (p >= threshold - 10) return 'warning';
  return 'danger';
}

/** Attendance colour token name so themes keep control of the palette. */
export function attendanceColor(percentage, threshold = 75) {
  const band = attendanceBand(percentage, threshold);
  return band === 'success' ? 'var(--success)'
    : band === 'warning' ? 'var(--warning)' : 'var(--danger)';
}

export const clamp = (value, lo, hi) => Math.min(Math.max(n2(value, lo), lo), hi);

/**
 * Saturation the active theme allows for generated series colours.
 * The monochrome themes declare a low `--chart-sat`, which keeps donut and bar
 * slices distinguishable without turning the page into a rainbow.
 */
export function themeSaturation() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--chart-sat').trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 58;
}

/** Stable CSS colour from a string — used when a series has no fixed palette. */
export function hashColor(text, saturation = null, lightness = 58) {
  let hash = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  const sat = saturation ?? themeSaturation();
  return `hsl(${Math.abs(hash) % 360} ${sat}% ${lightness}%)`;
}