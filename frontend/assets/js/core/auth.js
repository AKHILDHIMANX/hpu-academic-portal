/* =============================================================================
   auth.js — client-side session mirror.
   -----------------------------------------------------------------------------
   The real lock is server-side: the httpOnly `hpu_session` cookie plus the
   server-side page gate in app.py. This module only caches the *known* profile
   so the shell can paint the right portal without a round trip, and it exposes
   the redirect helpers the pages use.
   ========================================================================== */

import { Api, ApiError } from './api.js';

const CACHE_KEY = 'hpu.session';

export const ROLES = {
  STUDENT: { role: 'STUDENT', portal: '/', label: 'Student Portal', icon: 'cap' },
  TEACHER: { role: 'TEACHER', portal: '/teacher', label: 'Faculty Portal', icon: 'user' },
  ADMIN: { role: 'ADMIN', portal: '/admin', label: 'Admin Console', icon: 'shield' },
};

let session = null;
const subscribers = new Set();

function readCache() {
  try {
    const raw = session.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(value) {
  try {
    if (value) session.setItem(CACHE_KEY, JSON.stringify(value));
    else session.removeItem(CACHE_KEY);
  } catch { /* private mode: the server cookie still works */ }
}

export function onAuthChange(fn) {
  subscribers.add(fn);
  if (session) fn(session);
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) {
    try { fn(session); } catch { /* listener isolation */ }
  }
}

/** Synchronous cached read — safe to call before the network responds. */
export const cachedSession = () => session ?? readCache();

export const currentUser = () => session?.user ?? null;
export const currentRole = () => session?.role ?? session?.user?.role ?? null;

export function portalFor(role) {
  return ROLES[role]?.portal ?? '/';
}

/** Ask the server who we are. Always the source of truth. */
export async function refresh({ force = false } = {}) {
  if (session && !force) return session;
  try {
    const data = await Api.session();
    session = data.authenticated
      ? { ...data, role: data.user?.role ?? data.role ?? null }
      : null;
  } catch (error) {
    if (error instanceof ApiError && (error.isAuth || error.status === 0)) session = null;
    else throw error;
  }
  writeCache(session);
  notify();
  return session;
}

export async function login(identifier, password) {
  const data = await Api.login(identifier, password);
  // The login response already carries the profile — no extra round trip.
  session = { authenticated: true, ...data, role: data.role ?? data.user?.role ?? null };
  writeCache(session);
  notify();
  return session;
}

export async function logout() {
  try { await Api.logout(); } catch { /* the cookie is cleared regardless */ }
  session = null;
  writeCache(null);
  notify();
}

export function clearLocalSession() {
  session = null;
  writeCache(null);
  notify();
}

/* ---------------------------------------------------------- route guards -- */

export function goLogin({ reason = '', next = '' } = {}) {
  const params = new URLSearchParams();
  if (reason) params.set('reason', reason);
  if (next) params.set('next', next);
  const query = params.toString();
  window.location.replace(`/login${query ? `?${query}` : ''}`);
}

export function goPortal(role) {
  window.location.replace(portalFor(role));
}

/**
 * Used by every portal page. `required` is the role that page belongs to.
 * Returns the verified session, or redirects away.
 */
export async function guardPage(required) {
  const cached = cachedSession();
  if (cached?.role && cached.role !== required) {
    goPortal(cached.role);
    return null;
  }

  const session = await refresh({ force: true });
  if (!session) {
    goLogin({ reason: 'session', next: window.location.pathname });
    return null;
  }

  const role = session.role ?? session.user?.role;
  if (role !== required) {
    goPortal(role);
    return null;
  }
  return session;
}