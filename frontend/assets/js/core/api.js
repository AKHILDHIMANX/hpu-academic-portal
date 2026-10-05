/* =============================================================================
   api.js — the single network layer for the whole portal.
   -----------------------------------------------------------------------------
   * Same-origin by default (Flask serves the frontend), so the session cookie
     is httpOnly and there is no CORS handshake.
   * Every state-changing request carries the X-HPU-REQUEST header the backend
     requires as CSRF proof.
   * Failures are normalised into ApiError so callers never touch Fetch.
   ========================================================================== */

const BASE = (window.HPU_API_BASE ?? '/api').replace(/\/$/, '');
const CSRF_HEADER = 'X-HPU-REQUEST';
const CSRF_VALUE = 'hpu-portal';
const TIMEOUT_MS = 25_000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }

  /** 401 means the session is gone; the shell uses this to bounce to login. */
  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isValidation() { return this.status === 422; }
  get isOffline() { return this.code === 'TIMEOUT' || this.code === 'NETWORK_ERROR'; }
}

const listeners = new Set();

/** Subscribe to auth-level failures so app.js can react (redirect, toasts). */
export function onApiError(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(error, context) {
  for (const fn of listeners) {
    try { fn(error, context); } catch { /* a bad listener must not mask errors */ }
  }
}

function buildUrl(path, params) {
  const url = path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!params) return url;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

async function request(method, path, { params, body, formData, signal } = {}) {
  const url = buildUrl(path, params);
  const headers = {};
  const options = { method, credentials: 'same-origin', signal };

  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = CSRF_VALUE;

  if (formData) {
    options.body = formData; // let the browser set the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // Every request carries the built headers (CSRF proof + content type).
  options.headers = headers;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  options.signal = controller.signal;

  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    clearTimeout(timer);
    const timedOut = controller.signal.aborted && !signal?.aborted;
    const error = new ApiError(
      timedOut
        ? 'The server took too long to respond.'
        : 'Cannot reach the HPU server. Check your connection.',
      { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR' },
    );
    announce(error, { method, path });
    throw error;
  }
  clearTimeout(timer);

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = { raw }; }
  }

  if (!response.ok) {
    const error = new ApiError(
      payload?.message || payload?.error || `Request failed (${response.status})`,
      { status: response.status, code: payload?.error ?? `HTTP_${response.status}`, payload },
    );
    announce(error, { method, path });
    throw error;
  }

  return payload ?? {};
}

/* ------------------------------------------------------------------ verbs -- */
export const api = {
  get: (path, params, options) => request('GET', path, { ...options, params }),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  del: (path, options) => request('DELETE', path, options),
  upload: (path, formData, options) => request('POST', path, { ...options, formData }),
};

/* ------------------------------------------------------- typed shortcuts -- */
export const Api = {
  health: () => api.get('/health'),

  /* auth */
  demoAccounts: () => api.get('/auth/demo-accounts'),
  login: (identifier, password) => api.post('/auth/login', { identifier, password }),
  logout: () => api.post('/auth/logout', {}),
  session: () => api.get('/auth/session'),
  changePassword: (payload) => api.post('/auth/change-password', payload),

  /* shared academic content */
  courses: () => api.get('/courses'),
  course: (code) => api.get(`/courses/${encodeURIComponent(code)}`),
  gradeScale: () => api.get('/grade-scale'),
  pyq: () => api.get('/pyq'),
  elibrary: (params) => api.get('/elibrary', params),
  notices: () => api.get('/notices'),
  datesheet: () => api.get('/datesheet'),
  faculty: () => api.get('/faculty'),
  notifications: () => api.get('/notifications'),

  /* worksheets */
  worksheets: () => api.get('/worksheets'),
  myWorksheet: (id) => api.get(`/worksheets/${id}/mine`),
  uploadWorksheet: (formData) => api.upload('/worksheets/upload', formData),
  downloadWorksheetUrl: (id, storedName) =>
    `${BASE}/worksheets/${id}/download/${encodeURIComponent(storedName)}`,

  /* student */
  studentDashboard: () => api.get('/student/dashboard'),
  studentProfile: () => api.get('/student/profile'),
  studentAttendance: () => api.get('/student/attendance'),
  studentSessions: () => api.get('/student/attendance/sessions'),
  studentTranscript: () => api.get('/student/transcript'),
  studentGpa: () => api.get('/student/gpa'),

  /* faculty */
  teacherOverview: () => api.get('/teacher/overview'),
  teacherClasses: () => api.get('/teacher/classes'),
  teacherRoster: (course) => api.get('/teacher/roster', { course }),
  teacherMarks: (course) => api.get('/teacher/marks', { course }),
  teacherSaveMark: (payload) => api.post('/teacher/marks', payload),
  teacherPunch: (payload) => api.post('/teacher/attendance/punch', payload),
  teacherTrend: (course) => api.get('/teacher/attendance/trend', { course }),
  teacherSessions: (course) => api.get('/teacher/attendance/sessions', { course }),
  teacherWorksheets: (course) => api.get('/teacher/worksheets', { course }),
  teacherGradeWorksheet: (id, payload) => api.post(`/teacher/worksheets/${id}/grade`, payload),
  teacherCreateWorksheet: (payload) => api.post('/teacher/worksheets', payload),
  teacherNotice: (payload) => api.post('/teacher/notices', payload),
  teacherAnalytics: () => api.get('/teacher/analytics'),

  /* admin */
  adminOverview: () => api.get('/admin/overview'),
  adminStudents: (params) => api.get('/admin/students', params),
  adminCreateStudent: (payload) => api.post('/admin/students', payload),
  adminUpdateStudent: (id, payload) => api.patch(`/admin/students/${id}`, payload),
  adminDeleteStudent: (id) => api.del(`/admin/students/${id}`),
  adminBulkStudents: (payload) => api.post('/admin/students/bulk', payload),
  adminTeachers: () => api.get('/admin/teachers'),
  adminCreateTeacher: (payload) => api.post('/admin/teachers', payload),
  adminUpdateTeacher: (id, payload) => api.patch(`/admin/teachers/${id}`, payload),
  adminCourses: () => api.get('/admin/courses'),
  adminCreateCourse: (payload) => api.post('/admin/courses', payload),
  adminNotices: () => api.get('/admin/worksheets'),
  adminWorksheetDeadline: (id, deadlineDate) =>
    api.patch(`/admin/worksheets/${id}/deadline`, { deadline_date: deadlineDate }),
  adminNoticeCreate: (payload) => api.post('/admin/notices', payload),
  adminNoticePin: (id) => api.patch(`/admin/notices/${id}/pin`, {}),
  adminNoticeDelete: (id) => api.del(`/admin/notices/${id}`),
  adminAudit: (params) => api.get('/admin/audit', params),
  adminPermissions: () => api.get('/admin/permissions'),
  adminMaintenance: () => api.post('/admin/maintenance', {}),
  adminCommit: (message) => api.post('/admin/commit', { message }),
  adminExportUrl: (name = 'students.csv') => `${BASE}/admin/export/${name}`,

  /* files */
  libraryUrl: (file) => `${BASE}/files/library/${file}`,
  downloadUrl: (file) => `${BASE}/files/download/${file}`,
  fileManifest: () => api.get('/files/manifest'),
};

/**
 * Triggers a browser download for an authenticated endpoint without losing the
 * session cookie. Uses fetch + object URL so httpOnly cookies are sent.
 */
export async function downloadFrom(url, filename) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    const error = new ApiError(`Download failed (${response.status})`,
      { status: response.status, code: 'DOWNLOAD_FAILED' });
    announce(error, { method: 'GET', path: url });
    throw error;
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename || url.split('/').pop() || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  return blob.size;
}

/** POST a download counter bump, then fetch the bytes. */
export async function downloadPyq(paperId) {
  return downloadFrom(`${BASE}/files/pyq/${paperId}/download`, null);
}