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
// The ONE freshness rule (size + storage stamp vs the store's own metadata),
// shared with the day-file write guard — never a second copy of it here.
const {
  contentVerdict,
  writeStampMs,
  FRESHNESS_SKEW_MS,
  CDN_SETTLE_MS,
} = require('./source-freshness');
const { isLeadingHandRole, isFieldRole } = require('./auth');
const { prorateAllocations } = require('./payroll-rows');

// ── Freshness-verified entry reads ───────────────────────────────────────────
// Every entry read here is held against the store's own listing metadata —
// byte size and last-PUT time — by contentVerdict (api/_lib/source-freshness.js,
// which carries the measured constants and the incident history).
// A single content fetch may not hang the whole payroll read: a stalled CDN
// connection used to hold `Promise.all` — and the office's Send button — until
// the function itself timed out. A timed-out attempt counts as unreadable and
// is retried like any other.
const FETCH_TIMEOUT_MS = 8_000;
// A refusal that outlasts the CDN window backs off by this much per re-send
// rather than hammering (the send surfaces re-send by themselves on 'settling').
const RETRY_AFTER_FLOOR_MS = 10_000;
// Bounded in-request retry before refusing (~12s worst case). It covers the
// common seconds-scale CDN race without making the office wait a minute on
// every send; anything longer is refused with `retryAfterMs` (when the newest
// refused day will have settled) and the send surfaces wait that out and
// re-send by themselves (2026-10-05: the week was approved and sent inside the
// ~60s window, refused twice, and never reached accounts). Tests shrink this
// so the suite never sleeps.
let RETRY_DELAYS_MS = [1000, 2000, 3000, 3000, 3000];
function __setFreshnessRetryDelaysForTests(delays) {
  RETRY_DELAYS_MS = Array.isArray(delays) ? delays : [];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kept for existing importers: the stamp held against the PUT (the storage
 *  stamp first; handler stamps only for documents that predate it) — see
 *  source-freshness.js. */
const entryWriteStampMs = writeStampMs;

/** One content fetch, bounded by FETCH_TIMEOUT_MS. Resolves { doc, bytes } —
 *  the parsed entry and the exact byte length of the body as served, so the
 *  verdict can hold it against the listing's `size` — or null (HTTP error, bad
 *  JSON, network failure, timeout). A response without text() (some test
 *  doubles) still parses; its byte length is then simply unknown. */
async function fetchEntryOnce(url) {
  let signal;
  try { signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); } catch { signal = undefined; }
  try {
    const r = await fetch(url, { cache: 'no-store', signal });
    if (!r.ok) return null;
    let doc;
    let bytes;
    if (typeof r.text === 'function') {
      const body = await r.text();
      bytes = Buffer.byteLength(body, 'utf8');
      doc = JSON.parse(body);
    } else {
      doc = await r.json();
    }
    return doc && typeof doc === 'object' ? { doc, bytes } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one entry blob and verify it is the version the listing describes
 * (contentVerdict: byte size + storage stamp vs `size`/`uploadedAt`). Retries
 * per RETRY_DELAYS_MS. Resolves { entry } on a verified (or unverifiable)
 * read, else { problem: 'stale' | 'unreadable', … the numbers behind it }.
 */
async function fetchEntryVerified(b) {
  const meta = { uploadedAt: b && b.uploadedAt, size: b && b.size };
  let last = { problem: 'unreadable' };
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const got = await fetchEntryOnce(b.url + '?t=' + Date.now() + '-' + attempt);
    if (!got) { last = { problem: 'unreadable' }; continue; }
    const v = contentVerdict(meta, got, Date.now());
    if (v.current) {
      // Settled long enough that no propagation window is left — this IS the
      // current document. Accept it rather than refuse payroll forever, but
      // say so: a run of these means a writer stamps before it stores, or the
      // size signal disagrees with the store (re-measure before trusting it).
      if (v.settled && (v.sizeMismatch || (v.gapMs != null && v.gapMs > FRESHNESS_SKEW_MS))) {
        console.warn(
          'payroll read: accepting settled entry — ' + b.pathname +
          (v.sizeMismatch ? ' (byte size ' + got.bytes + ' ≠ listed ' + b.size + ')' : '') +
          (v.gapMs != null ? ' (write stamp trails its PUT by ' + v.gapMs + 'ms)' : '') +
          ' — last written ' + Math.round((Date.now() - v.uploadedMs) / 1000) + 's ago, ' +
          'so no CDN propagation window remains',
        );
      }
      return { entry: got.doc };
    }
    // The CDN served a version other than the current one — retry.
    last = {
      problem: 'stale',
      reason: v.reason,
      contentMs: v.contentMs,
      gapMs: v.gapMs,
      bytes: got.bytes,
    };
  }
  // Carry the numbers out so the refusal can SAY why, not just that. A refusal
  // used to log nothing at all, so "the email didn't send" was unanswerable
  // after the fact — the 2026-09-21 payroll block took a code read to explain.
  return {
    ...last,
    uploadedMs: uploadedMsOf(b),
    size: b && Number.isFinite(b.size) ? b.size : null,
  };
}

/** ms epoch of a listing's uploadedAt (the SDK hands back a Date or a string). */
function uploadedMsOf(b) {
  const v = b && b.uploadedAt;
  if (v instanceof Date) return v.getTime();
  return Date.parse(v || '');
}

/**
 * How long until every refused day has settled, in ms — or null when the
 * refusal is not one that waiting will clear. Retryable only when EVERY
 * refused day has a listing PUT time and is either a 'stale' verdict (which
 * only exists inside the suspect window of its write, by construction) or an
 * 'unreadable' blob written inside CDN_SETTLE_MS (a just-created day-file can
 * 404 from the CDN for a moment). Floored at RETRY_AFTER_FLOOR_MS so a stale
 * verdict past the expected window still backs off instead of hammering.
 */
function settleRetryAfterMs(refused, nowMs) {
  if (!refused.length) return null;
  let newestPut = 0;
  for (const r of refused) {
    if (!Number.isFinite(r.uploadedMs)) return null;
    const justWritten = nowMs - r.uploadedMs < CDN_SETTLE_MS;
    if (r.problem !== 'stale' && !justWritten) return null;
    if (r.uploadedMs > newestPut) newestPut = r.uploadedMs;
  }
  return Math.max(RETRY_AFTER_FLOOR_MS, newestPut + CDN_SETTLE_MS - nowMs);
}

/** "Mick Doran 2026-10-02" for a day-file pathname — names the days a refusal
 *  is about, so the office knows exactly what to wait for or chase. */
function dayLabel(pathname, userById) {
  const m = String(pathname || '').match(/^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})/);
  const u = m ? userById[m[1]] : null;
  const who = (u && (u.name || u.username)) || (m ? m[1] : pathname);
  return (who + ' ' + (m ? m[2] : '')).trim();
}

/**
 * Collect the payroll rows for a range.
 *
 * `quiet: true` — the ARTIFACT mode (the emailed sheet, a CSV/PDF download, a
 * Xero batch): refuse, before reading a single day, while ANY day-file in the
 * range was written inside CDN_SETTLE_MS. Two failures it closes for every
 * client, not just the phone closeout:
 *   · a stale read the verdict cannot see (two same-size writes seconds apart);
 *   · approvals still being written — a bulk approve writes one day every few
 *     seconds, so while it runs there is always a fresh write in range, and a
 *     sheet produced mid-batch would carry the days already approved and
 *     silently leave off the ones still queued (2026-10-06 audit).
 * The refusal is fast (no content fetched), names the days that just changed,
 * and carries code 'settling' + retryAfterMs — the moment the newest change has
 * settled — so the send surfaces wait it out and re-send by themselves. The
 * on-screen previews (/hours/period rollup) don't pass it: they verify every
 * read instead, and a preview can be refreshed.
 */
async function collectRows({ status, userId, jobId, fromDate, toDate, quiet = false }) {
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

  if (quiet) {
    const nowMs = Date.now();
    const recent = entryBlobs
      .map((b) => ({ b, putMs: uploadedMsOf(b) }))
      .filter(({ putMs }) => Number.isFinite(putMs) && nowMs - putMs < CDN_SETTLE_MS)
      .sort((a, b) => b.putMs - a.putMs);
    if (recent.length) {
      const retryAfterMs = Math.max(1_000, recent[0].putMs + CDN_SETTLE_MS - nowMs);
      const shown = recent.slice(0, 6).map(({ b }) => dayLabel(b.pathname, userById)).join('; ');
      console.warn(
        'payroll read held: ' + recent.length + ' day-file(s) in ' + fromDate + '..' + toDate +
        ' written in the last ' + Math.round(CDN_SETTLE_MS / 1000) + 's (newest ' +
        new Date(recent[0].putMs).toISOString() + ') — retry in ' + retryAfterMs + 'ms',
      );
      return {
        ok: false,
        status: 503,
        code: 'settling',
        retryAfterMs,
        error:
          'payroll read refused — hours in this period changed in the last minute (' +
          shown + (recent.length > 6 ? '; …' : '') + '). Nothing was produced: every change ' +
          'finishes saving first, so nothing is left off — try again in about ' +
          Math.ceil(retryAfterMs / 1000) + ' seconds.',
      };
    }
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
      reason: out.reason,
      uploadedMs: out.uploadedMs,
      contentMs: out.contentMs,
      gapMs: out.gapMs,
      bytes: out.bytes,
      size: out.size,
    });
  }
  if (refused.length) {
    // Never produce a payroll artifact missing real hours. Name the days so
    // the office knows exactly what to wait for / chase.
    const label = (r) =>
      dayLabel(r.pathname, userById) + ' (' + (r.problem === 'stale' ? 'just changed' : 'unreadable') + ')';
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
          ? ' (' + (r.reason === 'size' ? 'byte size ' + r.bytes + ' ≠ listed ' + r.size + '; ' : '') +
            'blob PUT ' + (Number.isFinite(r.uploadedMs) ? new Date(r.uploadedMs).toISOString() : 'unknown') +
            ', newest stamp in content ' +
            (r.contentMs ? new Date(r.contentMs).toISOString() : 'none') +
            ', gap ' + r.gapMs + 'ms)'
          : ''),
      );
    }
    const shown = refused.slice(0, 6).map(label).join('; ');
    const retryAfterMs = settleRetryAfterMs(refused, Date.now());
    return {
      ok: false,
      status: 503,
      error:
        'payroll read refused — ' + refused.length + ' day record(s) could not be read consistently: ' +
        shown + (refused.length > 6 ? '; …' : '') + '. ' +
        (retryAfterMs != null
          ? 'Nothing was produced with missing hours — those days changed moments ago and are still settling; ' +
            'try again in about ' + Math.ceil(retryAfterMs / 1000) + ' seconds.'
          : 'Nothing was produced with missing hours — wait a minute and retry.'),
      // Present ONLY when every refused day is a just-written blob still inside
      // the CDN window, so a retry at that moment is expected to succeed. A
      // refusal of anything else (an old unreadable day-file) has no automatic
      // retry: a person needs to look.
      ...(retryAfterMs != null ? { code: 'settling', retryAfterMs } : {}),
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
