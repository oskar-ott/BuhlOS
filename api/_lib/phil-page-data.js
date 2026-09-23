// In-process data loaders for the Phil server pages (/phil/my-day, /phil/hours).
//
// These pages used to fetch their OWN deployment's /api/time-entries and
// /api/jobs over HTTP, so a single page view invoked up to THREE serverless
// functions (the Next SSR function + two api/*.js functions) — and on a quiet
// deployment each hop brought its own cold start, stacking into the
// occasional 10s+ page load (owner-reported 2026-08-03; prod logs showed the
// aborted /phil/hours requests). These loaders run the SAME reads inside the
// SSR function instead: same fresh-users.json auth (getCurrentUser — role,
// disabled check), same per-role scoping as the HTTP handlers, no network hop.
//
// Parity contract (deliberate mirrors of the handler branches):
//   entries — api/time-entries.js handleGet self path: auth → listUserEntries
//     (PG rung or Blob list; recent-day read-your-writes overlay on BOTH,
//     2026-08-06) → entryView projection.
//   jobs — api/jobs.js list branch: field/LH read the jobs-summary projection
//     (minus draft/archived/complete), any other role falls back to the full
//     jobs.json read; a summary failure ALSO falls back to the full read.
//     Redaction is unnecessary here: these results never leave the server —
//     the pages project to {id, name, ref, siteAddress} before rendering.
//
// Deps are injectable for tests (same pattern as jobs-summary.js).

const {
  SESSION_COOKIE,
  getCurrentUser,
  isFieldRole,
  isLeadingHandRole,
} = require('./auth');
const { listUserEntries, entryView } = require('./time-entries');
const { isFieldListedByDefault, isFieldOpenable } = require('./job-lifecycle');
const { readJobsSummary } = require('./jobs-summary');
const { readBlob } = require('./blob');

function realDeps() {
  return {
    getCurrentUser,
    isFieldRole,
    isLeadingHandRole,
    listUserEntries,
    entryView,
    readJobsSummary,
    readBlob,
  };
}

// getCurrentUser is request-shaped (it parses req.headers.cookie); the pages
// hold the raw session-cookie VALUE from next/headers cookies(), so rebuild
// the header it expects.
function reqFromCookieValue(cookieValue) {
  return {
    headers: { cookie: cookieValue ? `${SESSION_COOKIE}=${cookieValue}` : '' },
  };
}

/**
 * The signed-in user, freshly resolved from users.json — the in-process twin
 * of GET /api/auth?action=me (same getCurrentUser: HMAC-verified cookie,
 * disabled check, password hash stripped). Null when not authenticated.
 * Callers shape-gate the result with parseSessionUser (session.ts), the same
 * schema the HTTP response went through.
 */
async function loadCurrentUserInProcess(cookieValue, deps = realDeps()) {
  return deps.getCurrentUser(reqFromCookieValue(cookieValue));
}

/**
 * One worker's own entries — the in-process twin of GET /api/time-entries
 * (self scope). `ok:false, status:401` mirrors the handler's unauthenticated
 * response so page copy ("API returned 401") stays identical. Storage errors
 * propagate — the calling page's try/catch renders them as fetchError, same
 * as a failed HTTP fetch did.
 */
async function loadWorkerEntriesInProcess(cookieValue, { fromDate, toDate } = {}, deps = realDeps()) {
  const user = await deps.getCurrentUser(reqFromCookieValue(cookieValue));
  if (!user) return { ok: false, status: 401, entries: [] };
  const entries = await deps.listUserEntries(user.id, { fromDate, toDate });
  return { ok: true, status: 200, entries: entries.map(deps.entryView) };
}

/**
 * The jobs a Phil page may offer as log targets — the in-process twin of the
 * GET /api/jobs list branches. Field/LH: the jobs-summary projection minus
 * draft/archived/complete (#349); summary failure or any other role: the full
 * jobs.json read (the pages' own isVisibleToField filter still applies on
 * top, as it did to the HTTP response). Storage errors propagate to the
 * page's catch → { jobs: [], error: true } → submission blocks honestly.
 */
async function loadFieldJobsInProcess(cookieValue, deps = realDeps()) {
  const user = await deps.getCurrentUser(reqFromCookieValue(cookieValue));
  if (!user) return { ok: false, jobs: [] };
  if (deps.isFieldRole(user.role) || deps.isLeadingHandRole(user.role)) {
    try {
      const { records } = await deps.readJobsSummary();
      // The crew's default set (docs/job-lifecycle.md): active / on-hold /
      // finishing. Closed jobs are reached through the history search only.
      return {
        ok: true,
        jobs: (records || []).filter((j) => isFieldListedByDefault(j)),
      };
    } catch (e) {
      console.error('phil-page-data: jobs-summary read failed; falling back to jobs.json', e && e.message);
      // fall through to the full read below — same recovery as api/jobs.js
    }
  }
  const blob = await deps.readBlob('jobs.json', { jobs: [] });
  // Same lifecycle rule on the fallback read — the summary failing must not
  // widen what the log sheet offers (it used to hand back every job).
  return { ok: true, jobs: (blob.jobs || []).filter((j) => isFieldListedByDefault(j)) };
}

/**
 * Is the signed-in worker an APPRENTICE (employee-record role, the fine
 * vocabulary — users.json role is only the auth tier)? Drives the TAFE-day
 * option on the log sheet (owner-directed 2026-08-10): apprentices attend
 * trade school one paid day a week and log it as a TAFE day; nobody else
 * sees the option. FAIL-CLOSED: any miss (no session, no linked employee
 * record, storage error) returns false — the worst outcome is an apprentice
 * temporarily not seeing the option, never a non-apprentice seeing it.
 */
async function loadIsApprenticeInProcess(cookieValue, deps = realDeps()) {
  try {
    const user = await deps.getCurrentUser(reqFromCookieValue(cookieValue));
    if (!user) return false;
    const blob = await deps.readBlob('employees.json', { employees: [] });
    const employee = (blob.employees || []).find((e) => e && e.userId === user.id);
    // This is the EMPLOYEE record's field-role vocabulary (employees
    // schema.ts FIELD_ROLES), not a users.json auth role — the auth.js
    // predicates don't speak it.
    // role-literal-ok: employee-record field role, not an auth role
    return !!employee && employee.role === 'apprentice';
  } catch (e) {
    console.error('phil-page-data: apprentice lookup failed (fail-closed)', e && e.message);
    return false;
  }
}

/**
 * ONE job by id for a Phil page that arrived with a job in hand (the job
 * screen's "Log hours" → /phil/hours?job=<id>). A closed job is not in the
 * default list, so the log sheet must be handed it explicitly — that is the
 * whole callback path (docs/job-lifecycle.md). Null when the job doesn't
 * exist or the crew may not open it (draft/archived); never throws.
 */
async function loadFieldJobInProcess(cookieValue, jobId, deps = realDeps()) {
  const found = await loadFieldJobsByIdInProcess(cookieValue, [jobId], deps);
  return found[0] || null;
}

/**
 * Several jobs by id — the jobs a worker's OWN hours reference that are no
 * longer in the default set (closed jobs they did a callback on). Lets the
 * week history name "Old Depot · Closed" instead of "A job you're no longer
 * on". Only openable jobs come back; unknown ids are simply absent. Never
 * throws; a storage error yields [] (the pages already say "couldn't load").
 */
async function loadFieldJobsByIdInProcess(cookieValue, jobIds, deps = realDeps()) {
  try {
    const wanted = new Set((jobIds || []).filter(Boolean));
    if (wanted.size === 0) return [];
    const user = await deps.getCurrentUser(reqFromCookieValue(cookieValue));
    if (!user) return [];
    let records = null;
    try {
      records = (await deps.readJobsSummary()).records;
    } catch {
      records = (await deps.readBlob('jobs.json', { jobs: [] })).jobs;
    }
    return (records || []).filter((j) => j && wanted.has(j.id) && isFieldOpenable(j));
  } catch {
    return [];
  }
}

module.exports = {
  loadFieldJobInProcess,
  loadFieldJobsByIdInProcess,
  loadCurrentUserInProcess,
  loadWorkerEntriesInProcess,
  loadFieldJobsInProcess,
  loadIsApprenticeInProcess,
};
