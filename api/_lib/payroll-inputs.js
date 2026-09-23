// Shared payroll-input collection (#894 seam) — the ONE row engine.
//
// EXTRACTED VERBATIM from api/time-entries-export.js so the CSV export
// (which keeps its exact behaviour — payroll-boundary ADR: the CSV is the
// permanent fallback) and the payroll-batch foundation (#893) read the SAME
// rows from the SAME collection logic. No second engine, ever: a batch can
// never pay differently than the CSV would have.
//
// Resolve the range, load reference data + every in-range entry, and build
// the one-row-per-allocation payroll rows (#380 OT proration applied BEFORE
// any jobId filter, so a filtered export never re-attributes overtime).
// Returns { ok:false, status, error } on a bad range / blob failure, else
// { ok:true, fromDate, toDate, status, userId, jobId, rows, entries,
// userById, jobById }.
//
// FRESHNESS GUARANTEE (2026-08-24 incident — wk34 print-out silently missing
// freshly-approved days): a just-overwritten day blob can serve its PREVIOUS
// content from the CDN for a short window even with cache-busting, so a stale
// read still said status='submitted' and the approved filter dropped real
// hours WITH NO ERROR. Every entry read here is verified against the store's
// own listing metadata: list() reports each blob's last-PUT time (uploadedAt —
// API-fresh, never CDN-cached). Content whose own write stamp predates that
// PUT by more than the skew is a SUSPECTED stale read — retried briefly, then
// the WHOLE collection is REFUSED with a 503 naming the affected days. An
// unreadable blob is refused the same way (it used to be silently dropped).
//
// WHICH STAMP (2026-09-22 audit, after the second payroll block): the stamp
// compared against the PUT is the STORAGE LAYER's own `__updatedAt`, which
// api/_lib/blob-guards applyGuards writes into every document inside
// writeBlob, immediately before the put. It is set by the same code path that
// stores the bytes, so no handler can trail it — the 2026-09-21 class of bug
// (a handler stamping `updatedAt` once before a slow sequential loop, so the
// tail of the batch stored a stamp a minute behind its own PUT) cannot recur
// through any writer, present or future. A read-only scan of every production
// day-file (331 entries, 2026-09-22) measured `__updatedAt` trailing its PUT by
// at most 3.1s, while the handler stamps trailed by up to 78s and sat within
// 2s of the 15s skew at the 90th percentile — the old signal was a hair
// trigger on ORDINARY writes, not just on batches. Handler stamps
// (updatedAt/approvedAt/…) remain only as the fallback for a legacy document
// that predates the storage stamp.
//
// Suspected, not proven: that gap only means a stale read while the blob is
// still inside its propagation window. A blob settled for longer than
// STALE_SUSPECT_WINDOW_MS is serving its current content by definition, and a
// stamp that trails it is a fact about how the document was WRITTEN, not about
// how we read it. Refusing those is permanent (the lag is stored), which cost
// a whole pay week on 2026-09-21. See the note on the constant below.
// A payroll artifact is complete, or it does not exist — never silently
// short. Every consumer (CSV, PDF, timesheet email, Xero batch create/lock)
// flows through this one engine, so they all inherit the guarantee.

const { list } = require('@vercel/blob');
const { readBlob } = require('./blob');
const { isLeadingHandRole, isFieldRole } = require('./auth');
const { prorateAllocations } = require('./payroll-rows');

// ── Freshness-verified entry reads ───────────────────────────────────────────
// Tolerance between the document's storage stamp (`__updatedAt`, written just
// before the put) and the blob's last-PUT time: both are Vercel wall clocks;
// the gap on a genuine write is the put's own latency. MEASURED, not reasoned:
// max 3.1s, p99 2.6s across every production day-file (2026-09-22) — 15s is
// five times the worst case seen. Beyond it, the fetched content predates the
// PUT, i.e. the CDN served the pre-overwrite document.
const FRESHNESS_SKEW_MS = 15_000;
// A single content fetch may not hang the whole payroll read: a stalled CDN
// connection used to hold `Promise.all` — and the office's Send button — until
// the function itself timed out. A timed-out attempt counts as unreadable and
// is retried like any other.
const FETCH_TIMEOUT_MS = 8_000;
// How long after a write the CDN can still plausibly serve the PREVIOUS
// document. Propagation is a seconds-scale race, so this is deliberately
// generous. Past it, a blob is SETTLED: whatever we read is the current
// document, full stop.
//
// This matters because the skew check below asks the wrong question on its
// own. It compares the blob's last-PUT time against the newest stamp INSIDE
// the content, and a gap can mean two very different things:
//   · the blob was just written and we were served the pre-overwrite copy
//     (the 2026-08-24 wk34 incident — refuse, and retry first); or
//   · the document's own stamp simply trails the write that stored it,
//     because of how it was WRITTEN (the 2026-09-21 batch-stamp bug, fixed in
//     time-entries-bulk-approve.js: one timestamp taken before a slow
//     sequential loop).
// Only the first is a stale read. The second is baked into stored data, so
// refusing it is permanent — it blocked the owner's payroll for a whole pay
// week, unfixable by retrying, until the two records were rewritten by hand.
// Recency is what separates them, and the gap alone cannot.
const STALE_SUSPECT_WINDOW_MS = 5 * 60_000;
// Bounded retry before refusing (~12s worst case). Vercel documents that an
// overwritten blob can keep serving its previous content from the CDN for up
// to ~60s, so this cannot cover every case — it covers the common seconds-scale
// race without making the office wait a minute on every send, and the refusal
// that follows says exactly what to do (wait, retry). Tests shrink this so the
// suite never sleeps.
let RETRY_DELAYS_MS = [1000, 2000, 3000, 3000, 3000];
function __setFreshnessRetryDelaysForTests(delays) {
  RETRY_DELAYS_MS = Array.isArray(delays) ? delays : [];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Newest HANDLER-written stamp on an entry, ms epoch — null when the entry
 *  carries none. Fallback only (see entryWriteStampMs): a handler stamp is
 *  taken before the write and can trail the PUT by however long the write
 *  path took to reach the put. */
function entryLastWriteMs(entry) {
  let max = 0;
  for (const k of ['updatedAt', 'approvedAt', 'rejectedAt', 'submittedAt', 'amendedAt', 'exportedAt', 'createdAt']) {
    const t = Date.parse((entry && entry[k]) || '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || null;
}

/** The stamp to hold against the blob's last-PUT time, ms epoch, or null when
 *  the document carries none (a raw-put legacy row), in which case freshness
 *  cannot be judged and the read is accepted (never invent staleness — P7).
 *
 *  Primary: the storage layer's `__updatedAt` — set inside writeBlob by
 *  applyGuards immediately before the put, on every document written through
 *  the app since #157. It is the only stamp no handler can trail.
 *  Fallback: the handler stamps, for a document that predates it. */
function entryWriteStampMs(entry) {
  const storage = Date.parse((entry && entry.__updatedAt) || '');
  if (Number.isFinite(storage)) return storage;
  return entryLastWriteMs(entry);
}

/** One content fetch, bounded by FETCH_TIMEOUT_MS. Resolves the parsed entry
 *  or null (HTTP error, bad JSON, network failure, timeout). */
async function fetchEntryOnce(url) {
  let signal;
  try { signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch { signal = undefined; }
  try {
    const r = await fetch(url, { cache: 'no-store', signal });
    if (!r.ok) return null;
    const entry = await r.json();
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one entry blob and verify the content is at least as new as the
 * blob's last PUT. Retries per RETRY_DELAYS_MS. Resolves { entry } on a
 * verified (or unverifiable) read, else { problem: 'stale' | 'unreadable' }.
 */
async function fetchEntryVerified(b) {
  const uploadedMs = Date.parse((b && b.uploadedAt) || '');
  let lastProblem = 'unreadable';
  let lastGapMs = null;
  let lastContentMs = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const entry = await fetchEntryOnce(b.url + '?t=' + Date.now() + '-' + attempt);
    if (!entry) { lastProblem = 'unreadable'; continue; }
    if (!Number.isFinite(uploadedMs)) return { entry }; // no listing stamp → cannot verify
    const contentMs = entryWriteStampMs(entry);
    if (contentMs == null) return { entry }; // legacy row → cannot verify
    if (uploadedMs - contentMs <= FRESHNESS_SKEW_MS) return { entry };
    // Settled long enough that no propagation window is left — this IS the
    // current document, and its stamp merely trails its own write. Accept it
    // rather than refuse payroll forever, but say so: a run of these means a
    // writer is stamping before it stores.
    if (Date.now() - uploadedMs > STALE_SUSPECT_WINDOW_MS) {
      console.warn(
        'payroll read: accepting settled entry whose write stamp trails its PUT by ' +
        (uploadedMs - contentMs) + 'ms — ' + b.pathname +
        ' (last written ' + Math.round((Date.now() - uploadedMs) / 1000) + 's ago, ' +
        'so no CDN propagation window remains)',
      );
      return { entry };
    }
    lastProblem = 'stale'; // CDN served the pre-overwrite document — retry
    lastGapMs = uploadedMs - contentMs;
    lastContentMs = contentMs;
  }
  // Carry the numbers out so the refusal can SAY why, not just that. A refusal
  // used to log nothing at all, so "the email didn't send" was unanswerable
  // after the fact — the 2026-09-21 payroll block took a code read to explain.
  return { problem: lastProblem, uploadedMs, contentMs: lastContentMs, gapMs: lastGapMs };
}

async function collectRows({ status, userId, jobId, fromDate, toDate }) {
  // Default range = current ISO week (Mon..Sun). NOTE: this is server-local
  // (UTC on Vercel); every UI caller passes explicit fromDate/toDate.
  if (!fromDate || !toDate) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const dow = t.getDay() || 7;
    const monday = new Date(t); monday.setDate(t.getDate() - (dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    fromDate = fromDate || monday.toISOString().slice(0, 10);
    toDate   = toDate   || sunday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { ok: false, status: 400, error: 'fromDate / toDate must be YYYY-MM-DD' };
  }
  if (fromDate > toDate) {
    return { ok: false, status: 400, error: 'fromDate must be <= toDate' };
  }

  // Reference data — users (rates, Xero IDs), jobs (names)
  const [usersBlob, jobsBlob] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('jobs.json',  { jobs: [] }),
  ]);
  const userById = {};
  for (const u of (usersBlob.users || [])) userById[u.id] = u;
  const jobById = {};
  for (const j of (jobsBlob.jobs || [])) jobById[j.id] = j;

  // Walk every user's time-entries (date-prefix filter applied at the
  // pathname level so we don't fetch entries outside the range).
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entryBlobs = [];
  try {
    // Fully paginated (#935): a silent 5000-blob cap on the payroll read
    // would drop hours with no error — the exact failure class this engine
    // now refuses.
    let cursor;
    do {
      const r = await list({ prefix: 'users/', token, limit: 1000, cursor });
      for (const b of (r && r.blobs) || []) {
        if (!b.pathname.includes('/time-entries/')) continue;
        if (b.pathname.includes('/time-entries-audit/')) continue;
        if (!b.pathname.endsWith('.json')) continue;
        const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!m) continue;
        const d = m[1];
        if (d < fromDate || d > toDate) continue;
        if (userId && !b.pathname.startsWith('users/' + userId + '/')) continue;
        entryBlobs.push(b);
      }
      cursor = r && r.hasMore ? r.cursor : undefined;
    } while (cursor);
  } catch (e) {
    return { ok: false, status: 502, error: 'blob list failed: ' + e.message };
  }

  const results = await Promise.all(
    entryBlobs.map(async (b) => ({ b, out: await fetchEntryVerified(b) })),
  );
  const entries = [];
  const refused = [];
  for (const { b, out } of results) {
    if (out.entry) entries.push(out.entry);
    else refused.push({
      pathname: b.pathname,
      problem: out.problem,
      uploadedMs: out.uploadedMs,
      contentMs: out.contentMs,
      gapMs: out.gapMs,
    });
  }
  if (refused.length) {
    // Never produce a payroll artifact missing real hours. Name the days so
    // the office knows exactly what to wait for / chase.
    const label = (r) => {
      const m = r.pathname.match(/^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})/);
      const u = m ? userById[m[1]] : null;
      const who = (u && (u.name || u.username)) || (m ? m[1] : r.pathname);
      return (who + ' ' + (m ? m[2] : '') + ' (' + (r.problem === 'stale' ? 'just changed' : 'unreadable') + ')').trim();
    };
    // One line per refused day, with the NUMBERS behind the verdict: which blob,
    // when it was last PUT, the newest stamp inside it, and the gap that failed
    // the skew. A 'stale' verdict with a large, stable gap is not a CDN lag at
    // all — it is a document whose own stamp trails its write (the batch-stamp
    // bug fixed in time-entries-bulk-approve.js on 2026-09-21), and no retry
    // will ever clear that. Only the office sees this; it carries ids, not hours.
    for (const r of refused) {
      console.error(
        'payroll read refused: ' + r.pathname + ' — ' + r.problem +
        (r.problem === 'stale'
          ? ' (blob PUT ' + new Date(r.uploadedMs).toISOString() +
            ', newest stamp in content ' +
            (r.contentMs ? new Date(r.contentMs).toISOString() : 'none') +
            ', gap ' + r.gapMs + 'ms, skew allows ' + FRESHNESS_SKEW_MS + 'ms)'
          : ''),
      );
    }
    const shown = refused.slice(0, 6).map(label).join('; ');
    return {
      ok: false,
      status: 503,
      error:
        'payroll read refused — ' + refused.length + ' day record(s) could not be read consistently: ' +
        shown + (refused.length > 6 ? '; …' : '') + '. ' +
        'Nothing was produced with missing hours — wait a minute and retry.',
    };
  }

  // Status filter — 'all' means everything, otherwise exact match.
  const filtered = entries.filter(e => status === 'all' ? true : e.status === status);

  // Build payroll rows. One row per allocation (a multi-job day produces
  // multiple rows with the same date + worker but different job + hours).
  const rows = [];
  for (const e of filtered) {
    const u = userById[e.userId] || {};
    const rate = (isFieldRole(u.role) || isLeadingHandRole(u.role)) ? Number(u.hourlyRate) || 0 : 0;
    const allAllocations = e.allocations || [];
    const prorated = prorateAllocations(e, allAllocations);
    const allocations = allAllocations
      .map((a, i) => ({ allocation: a, split: prorated[i] }))
      .filter(({ allocation: a }) => !jobId || a.jobId === jobId);
    if (!allocations.length) continue;
    for (const { allocation: a, split } of allocations) {
      const j = a.jobId ? jobById[a.jobId] : null;
      const hours = split.hours;
      rows.push({
        weekStart: weekMondayOf(e.date),
        weekEnd:   weekSundayOf(e.date),
        date:      e.date,
        // LIVE name first (owner-directed 2026-08-09): the stamp is frozen at
        // write time and goes stale on rename; the user record is the truth.
        workerName: u.name || e.userName || u.username || e.userId,
        workerId:   e.userId,
        // Role rides on the row so the payroll partition can exclude
        // outside-payroll workers (subcontractors invoice directly) without
        // another users.json read.
        workerRole: u.role || null,
        xeroEmployeeId: u.xeroEmployeeId || '',
        // Job-less day types ride the row (2026-08-10) so the payroll
        // partition can keep sick/holiday hours out of the wages push (they
        // are entered as leave in Xero) without another entry read; TAFE
        // pushes as ordinary wages and names itself instead of "no job".
        dayType:    e.dayType || null,
        jobName:    j
          ? j.name
          : e.dayType === 'tafe'
            ? 'TAFE'
            : e.dayType === 'sick'
              ? 'Sick day'
              : e.dayType === 'holiday'
                ? 'Holiday'
                : a.jobId
                  ? '(unknown job)'
                  : 'Internal — no job',
        jobId:      a.jobId || '',
        hours:      hours,
        ordinaryHours: split.ordinaryHours,
        overtimeHours: split.overtimeHours,
        rateExGst:  rate,
        lineCostExGst: Math.round(hours * rate * 100) / 100,
        notes:      String(a.notes || e.notes || '').replace(/\r?\n/g, ' ').trim(),
        status:     e.status,
        approvedBy: e.approvedBy ? (userById[e.approvedBy] || {}).username || e.approvedBy : '',
        approvedAt: e.approvedAt || '',
        exportedAt: e.exportedAt || '',
        exportId:   e.exportId || '',
      });
    }
  }
  // Stable sort: date, worker, job
  rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.workerName.localeCompare(b.workerName) ||
    a.jobName.localeCompare(b.jobName));

  // #248/#249: the CONFIRMED worker↔employee links live in Postgres
  // (xero_mappings) — users.json's free-text xeroEmployeeId predates them and
  // goes stale on every reconnect, which left the pay-period page showing
  // "No Xero id / Needs action" for workers whose links were confirmed and
  // whose batch passed validation (live find, 2026-07-25). A confirmed link
  // wins; the legacy field stands when Xero is disconnected or PG is
  // unreachable, so the CSV keeps working as the permanent fallback.
  const workerIds = [...new Set(rows.map(r => r.workerId))];
  if (workerIds.length) {
    try {
      const { mappingReadiness } = require('./xero/worker-mappings');
      const readiness = await mappingReadiness(workerIds);
      const confirmed = new Map(
        readiness.filter(m => m.mapped && m.employeeId).map(m => [m.workerId, m.employeeId]));
      for (const r of rows) {
        const employeeId = confirmed.get(r.workerId);
        if (employeeId) r.xeroEmployeeId = employeeId;
      }
    } catch { /* not connected / PG unreachable → legacy field stands */ }
  }

  return { ok: true, fromDate, toDate, status, userId, jobId, rows, entries, userById, jobById };
}

// Calendar-date arithmetic in UTC end to end: the previous local-midnight +
// toISOString() shape shifted the emitted date by a day on any non-UTC host
// (invisible on UTC production, wrong everywhere else — the same bug
// api/time-entries-overview.js fixed for its missing-day cursor).
function weekMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}
function weekSundayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (7 - dow));
  return d.toISOString().slice(0, 10);
}

module.exports = {
  collectRows,
  weekMondayOf,
  weekSundayOf,
  entryWriteStampMs,
  __setFreshnessRetryDelaysForTests,
};
