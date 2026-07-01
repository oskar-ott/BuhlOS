// Site diary (#210) — the job's daily record.
//
//   GET   /api/diary?jobId=<id>&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
//                                    → date-keyed entries in range (one blob
//                                      read; a date with no entry is simply
//                                      absent — the UI renders "no diary entry",
//                                      never a fabricated one). READ = canManageJob
//                                      (admin OR LH-on-job); tradie/client → 403.
//   POST  /api/diary?jobId=<id>      → create the day's entry. WRITE = isAdminRole
//                                      (the office's contemporaneous record). One
//                                      entry per (job,date): a duplicate is a 409
//                                      pointing at the amend path. Future dates
//                                      rejected. delay.reason required when
//                                      delay.flagged. happenings capped ~5k (400).
//   POST  /api/diary?jobId=<id>&action=amend
//                                    → append a stamped amendment to the entry's
//                                      amendments[] (createdBy/At + changed
//                                      fields); the original fields stay
//                                      unchanged and visible (append-only).
//
// WHY THIS SHAPE
//   The diary doubles as DELAY-CLAIM EVIDENCE, so the integrity rules are
//   mandatory (and test-locked in src/domains/diary/*.test.ts +
//   diary-api.test.ts):
//     - one entry per (job,date) — never silently overwritten (409 → amend)
//     - future dates rejected (a diary records what happened, not what will)
//     - a flagged delay requires a reason
//     - the attendance snapshot is FROZEN at save — a later hours change must
//       NOT mutate a saved entry (we DENORMALISE userId/userName/hours/status
//       and stamp attendanceSource {fetchedAt, adjusted})
//     - amendments are APPEND-ONLY (mirror api/dayworks.js amendDocket, #370)
//   No fabricated data, ever (P7). The attendance snapshot is supplied by the
//   editor, which pre-fetched GET /api/site-visits?jobId&fromDate=D&toDate=D
//   (the documented attendance lookup) — this endpoint persists what it's given.
//
// STORAGE — PER-JOB sibling blob at `jobs/<jobId>/diary.json`: { entries: [...] }.
//   Same convention as contacts/dayworks (NOT in jobs.json), so this needs NO
//   change to api/_lib/backup-manifest.js EXACT_STORES.
//
// PERMISSIONS — READ is canManageJob (admin/LH-on-job); WRITE (create + amend)
//   is isAdminRole. tradie / client → 403, so the diary's commercial/legal
//   content never leaks past the site-visits attendance line. Phil write is
//   DEFERRED (no field create path here).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { nanoid } = require('./_lib/validation');
const { append: appendAuditLog } = require('./_lib/audit-log');

// ── Limits (mirror src/domains/diary/schema.ts DIARY_LIMITS) ─────────────────
const LIMITS = {
  maxHappenings: 5000,
  maxWeatherNote: 500,
  maxDelayReason: 2000,
  maxAttendanceRows: 200,
  maxAmendmentNote: 2000,
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYDNEY_TZ = 'Australia/Sydney';

// ── Sydney date-key (mirror src/domains/diary/date-key.ts + site-visits.js) ──
function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ── Storage ──────────────────────────────────────────────────────────────────
function storeKey(jobId) {
  return `jobs/${jobId}/diary.json`;
}
function emptyStore() {
  return { entries: [] };
}
async function readStore(jobId) {
  const store = await readBlob(storeKey(jobId), emptyStore());
  if (!store || !Array.isArray(store.entries)) return emptyStore();
  return store;
}

function actorNameOf(user) {
  return user.name || user.username || 'Unknown';
}

// ── Pure shaping (mirror src/domains/diary/entry.ts) ─────────────────────────
function normaliseDelay(input) {
  const flagged = Boolean(input && input.flagged);
  if (!flagged) return { flagged: false, reason: null };
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return { error: 'a flagged delay requires a reason' };
  return { flagged: true, reason: reason.slice(0, LIMITS.maxDelayReason) };
}

function freezeAttendance(rows) {
  return (rows || []).map((r) => ({
    userId: String(r.userId),
    userName: String(r.userName),
    hours: Number(r.hours) || 0,
    status: String(r.status),
  }));
}

// ── Create validation (mirror CreateDiaryPayloadSchema) ──────────────────────
function validateCreateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be an object'] };
  }

  const date = typeof body.date === 'string' ? body.date : '';
  if (!DATE_KEY_RE.test(date)) errors.push('date must be YYYY-MM-DD');

  const happenings = typeof body.happenings === 'string' ? body.happenings.trim() : '';
  if (!happenings) errors.push('happenings is required');
  if (happenings.length > LIMITS.maxHappenings) {
    errors.push(`happenings must be ${LIMITS.maxHappenings} characters or fewer`);
  }

  let weatherNote = null;
  if (body.weatherNote != null) {
    const w = String(body.weatherNote);
    if (w.length > LIMITS.maxWeatherNote) {
      errors.push(`weatherNote must be ${LIMITS.maxWeatherNote} characters or fewer`);
    }
    weatherNote = w.trim() || null;
  }

  const delay = normaliseDelay(body.delay || {});
  if (delay.error) errors.push(delay.error);

  let attendance = [];
  if (body.attendance != null) {
    if (!Array.isArray(body.attendance)) {
      errors.push('attendance must be an array');
    } else if (body.attendance.length > LIMITS.maxAttendanceRows) {
      errors.push(`attendance must be ${LIMITS.maxAttendanceRows} rows or fewer`);
    } else {
      body.attendance.forEach((r, i) => {
        if (!r || typeof r !== 'object') {
          errors.push(`attendance[${i}] must be an object`);
          return;
        }
        if (!r.userId) errors.push(`attendance[${i}].userId is required`);
        if (typeof r.userName !== 'string' || !r.userName.trim()) {
          errors.push(`attendance[${i}].userName is required`);
        }
        const h = r.hours;
        if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) {
          errors.push(`attendance[${i}].hours must be a number >= 0`);
        }
        if (typeof r.status !== 'string' || !r.status.trim()) {
          errors.push(`attendance[${i}].status is required`);
        }
      });
      attendance = freezeAttendance(body.attendance);
    }
  }

  const attendanceSource = {
    fetchedAt:
      body.attendanceSource && body.attendanceSource.fetchedAt != null
        ? String(body.attendanceSource.fetchedAt)
        : null,
    adjusted: Boolean(body.attendanceSource && body.attendanceSource.adjusted),
  };

  return {
    errors,
    date,
    happenings,
    weatherNote,
    delay: delay.error ? null : delay,
    attendance,
    attendanceSource,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function listEntries(req, res, jobId) {
  const store = await readStore(jobId);
  const q = req.query || {};
  const fromDate = q.fromDate && DATE_KEY_RE.test(q.fromDate) ? q.fromDate : null;
  const toDate = q.toDate && DATE_KEY_RE.test(q.toDate) ? q.toDate : null;
  if ((q.fromDate && !fromDate) || (q.toDate && !toDate)) {
    return res.status(400).json({ error: 'fromDate / toDate must be YYYY-MM-DD' });
  }
  let entries = store.entries.filter((e) => {
    if (fromDate && e.date < fromDate) return false;
    if (toDate && e.date > toDate) return false;
    return true;
  });
  // Newest date first.
  entries = entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return res.status(200).json({
    entries,
    filters: { jobId, fromDate, toDate },
  });
}

async function createEntry(req, res, user, jobId) {
  const v = validateCreateBody(req.body || {});
  if (v.errors && v.errors.length) {
    return res.status(400).json({ error: v.errors[0], errors: v.errors });
  }

  // Future-date guard (a diary records what HAPPENED).
  if (v.date > sydneyToday()) {
    return res.status(400).json({ error: 'a diary entry cannot be dated in the future' });
  }

  const store = await readStore(jobId);
  // One-per-date guard — never silently overwrite an existing day.
  if (store.entries.some((e) => e && e.date === v.date)) {
    return res.status(409).json({
      error: `a diary entry already exists for ${v.date} — amend it instead`,
      code: 'duplicate_date',
    });
  }

  const nowIso = new Date().toISOString();
  const actorName = actorNameOf(user);
  const entry = {
    id: nanoid('di_'),
    jobId,
    date: v.date,
    happenings: v.happenings,
    weatherNote: v.weatherNote,
    delay: v.delay,
    attendance: v.attendance,
    attendanceSource: v.attendanceSource,
    amendments: [],
    createdById: user.id,
    createdByName: actorName,
    createdByRole: user.role || null,
    createdAt: nowIso,
    updatedAt: nowIso,
    auditLogIds: [],
  };

  // Audit BEFORE the write so the intent survives a flaky writeBlob; catch+null
  // so an audit failure never blocks the entry.
  const audit = await appendAuditLog({
    action: 'diary.created',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'diary',
    targetId: entry.id,
    summary: `site diary entry for ${entry.date}${entry.delay.flagged ? ' (delay flagged)' : ''}`,
    metadata: {
      date: entry.date,
      delayFlagged: entry.delay.flagged,
      attendanceCount: entry.attendance.length,
    },
  }).catch(() => null);
  if (audit && audit.id) entry.auditLogIds.push(audit.id);

  store.entries.push(entry);
  try {
    // CAS guard: expectedRev narrows the stale-write race for this money-/
    // legally-relevant record. actor lets a fail-closed abort be attributed.
    await writeBlob(storeKey(jobId), store, {
      expectedRev: store.rev,
      actor: { id: user.id, name: actorName, role: user.role || null },
    });
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  return res.status(201).json({ entry });
}

async function amendEntry(req, res, user, jobId, body) {
  const id = body && body.id ? String(body.id) : '';
  if (!id) return res.status(400).json({ error: 'id required to amend' });

  const store = await readStore(jobId);
  const idx = store.entries.findIndex((e) => e && e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'diary entry not found' });
  const original = store.entries[idx];

  // Shape the append-only amendment delta (the original is NEVER mutated).
  const changes = {};
  const rawChanges = (body && body.changes) || {};
  if (typeof rawChanges.happenings === 'string') {
    const h = rawChanges.happenings.trim();
    if (!h) return res.status(400).json({ error: 'happenings cannot be cleared by an amendment' });
    if (h.length > LIMITS.maxHappenings) {
      return res.status(400).json({ error: `happenings must be ${LIMITS.maxHappenings} characters or fewer` });
    }
    changes.happenings = h;
  }
  if (rawChanges.weatherNote !== undefined) {
    const w = rawChanges.weatherNote == null ? null : String(rawChanges.weatherNote);
    if (w && w.length > LIMITS.maxWeatherNote) {
      return res.status(400).json({ error: `weatherNote must be ${LIMITS.maxWeatherNote} characters or fewer` });
    }
    changes.weatherNote = w ? w.trim() : null;
  }
  if (rawChanges.delay !== undefined) {
    const d = normaliseDelay(rawChanges.delay || {});
    if (d.error) return res.status(400).json({ error: d.error });
    changes.delay = d;
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'an amendment must change at least one field' });
  }

  const note = body && body.note != null ? String(body.note).slice(0, LIMITS.maxAmendmentNote).trim() || null : null;
  const nowIso = new Date().toISOString();
  const actorName = actorNameOf(user);
  const amendment = {
    id: nanoid('dia_'),
    createdAt: nowIso,
    createdById: user.id,
    createdByName: actorName,
    createdByRole: user.role || null,
    note,
    changes,
  };

  // APPEND-ONLY: push the amendment, bump updatedAt; original fields untouched.
  const updated = {
    ...original,
    amendments: [...(original.amendments || []), amendment],
    updatedAt: nowIso,
  };

  const audit = await appendAuditLog({
    action: 'diary.amended',
    actorId: user.id,
    actorName,
    actorRole: user.role || null,
    jobId,
    targetType: 'diary',
    targetId: original.id,
    summary: `site diary entry for ${original.date} amended`,
    metadata: { date: original.date, changedFields: Object.keys(changes) },
  }).catch(() => null);
  if (audit && audit.id) updated.auditLogIds = [...(updated.auditLogIds || []), audit.id];

  store.entries[idx] = updated;
  try {
    await writeBlob(storeKey(jobId), store, {
      expectedRev: store.rev,
      actor: { id: user.id, name: actorName, role: user.role || null },
    });
  } catch (e) {
    return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
  }
  return res.status(200).json({ entry: updated });
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // requireAuth with jobId admits admin-tier any job + assigned LH/field; we
  // then narrow per-method: READ = canManageJob (admin/LH-on-job), WRITE =
  // isAdminRole. A tradie/client never gets past the canManageJob/isAdminRole
  // check, so the diary's content never leaks past the site-visits line.
  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  if (!(await isFlagEnabled('diary', user))) return res.status(404).json({ error: 'not found' });

  if (req.method === 'GET') {
    if (!canManageJob(user, jobId)) return res.status(403).json({ error: 'forbidden' });
    try {
      return await listEntries(req, res, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'list failed' });
    }
  }

  if (req.method === 'POST') {
    // Office-only write (the contemporaneous record). Phil write is deferred.
    if (!isAdminRole(user.role)) {
      return res.status(403).json({ error: 'admin only — the office keeps the site diary' });
    }
    const action = String((req.query && req.query.action) || (req.body && req.body.action) || '');
    try {
      if (action === 'amend') return await amendEntry(req, res, user, jobId, req.body || {});
      return await createEntry(req, res, user, jobId);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'write failed' });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
};

// Exposed for reuse / parity tests (not on the HTTP surface).
module.exports.storeKey = storeKey;
module.exports.readStore = readStore;
module.exports.sydneyToday = sydneyToday;
