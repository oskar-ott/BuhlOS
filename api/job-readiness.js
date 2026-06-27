// Pre-start readiness gate (#371) — resolves the REAL signals that
// computeReadiness() (src/domains/jobs/readiness.ts) needs, and persists the
// per-job manual checklist + override. The pure engine lives in TypeScript and
// cannot be required from api/*.js, so this handler SERVES SIGNALS and the
// job hub (a TS server component) runs the engine over them — the same
// API-serves-data / TS-computes split the hub already uses for its cards.
//
//   GET  /api/job-readiness?jobId=X            → ReadinessSignals + inductionRequired (admin tier)
//   POST /api/job-readiness?jobId=X { action } → mutate jobs/<id>/prestart.json (admin tier)
//        action:"tick"           { itemId, ticked }  → tick/un-tick a manual obligation
//        action:"override"       { reason }          → record an override-with-reason
//        action:"clear-override"                     → remove the override
//
// Signals resolved here:
//   crew       = live, non-client users assigned to the job ({ id, name })
//   inductions = byWorkerId hasRecord (jobs/<id>/inductions.json); ALL-TRUE when
//                the job doesn't require induction (not a concern — never
//                "not tracked", which would read as a false warning)
//   licences   = byWorkerId worstStatusByUser === 'ok' (workforce/credentials.json);
//                a worker with none on file is absent → false → soft warning
//   safetyDocs = null (#219 not built → engine renders "not tracked", never green)
//   manualItems / override from jobs/<id>/prestart.json (defaults seeded in-memory)
//
// Admin-tier only (v1): LH/field/client get no panel (the hub hides the card on
// a 403), mirroring the induction crew view. Auth uses requireAuth (the
// HMAC-verifying session path), never the App Router decode.
//
// DEFAULT_PRESTART_ITEMS MIRRORS src/domains/jobs/readiness.ts — readiness-api
// test pins them so they can't drift (repo TS/JS mirror discipline).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole } = require('./_lib/auth');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { worstStatusByUser } = require('./_lib/licence-compliance');

const DEFAULT_PRESTART_ITEMS = [
  { id: 'insurances', label: 'Insurances lodged' },
  { id: 'swms', label: "SWMS uploaded to the builder's system" },
  { id: 'ampc_induction', label: 'AMPC induction completed' },
  { id: 'site_rules', label: 'Site rules issued' },
];

function prestartKey(jobId) {
  return 'jobs/' + jobId + '/prestart.json';
}
function inductionsKey(jobId) {
  return 'jobs/' + jobId + '/inductions.json';
}

/** Stored items if present, else the honest defaults (all un-ticked). */
function seededItems(stored) {
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return DEFAULT_PRESTART_ITEMS.map((d) => ({
    id: d.id,
    label: d.label,
    ticked: false,
    tickedBy: null,
    tickedAt: null,
  }));
}

async function readPrestart(jobId) {
  const data = await readBlob(prestartKey(jobId), { items: [], override: null });
  return {
    items: Array.isArray(data.items) ? data.items : [],
    override: data.override || null,
  };
}

/** Live, non-client users assigned to the job → { id, name } (induction precedent). */
function crewFor(usersBlob, jobId) {
  return (usersBlob.users || [])
    .filter((u) => Array.isArray(u.assignedJobIds) && u.assignedJobIds.includes(jobId))
    .filter((u) => !(u.archived || u.disabled || u.status === 'disabled'))
    .filter((u) => !isClientRole(u.role))
    .map((u) => ({ id: u.id, name: u.username || u.id }));
}

async function buildSignals(jobId, job) {
  const usersBlob = await readBlob('users.json', { users: [] });
  const crew = crewFor(usersBlob, jobId);

  // Inductions: a record means inducted. When induction isn't required it's not
  // a concern → every crew member reads satisfied (NOT null/"not tracked").
  const indLedger = await readBlob(inductionsKey(jobId), { records: [] });
  const inductedIds = new Set((indLedger.records || []).map((r) => r.workerId));
  const inductions = { byWorkerId: {} };
  for (const c of crew) {
    inductions.byWorkerId[c.id] = job.inductionRequired ? inductedIds.has(c.id) : true;
  }

  // Licences: worst status per worker; 'ok' = current/no-expiry. Absent from the
  // map = none on file = NOT ok (a licence gap is a soft warning in the engine).
  const creds = await readBlob('workforce/credentials.json', { credentials: [] });
  const worst = worstStatusByUser(creds.credentials || [], { now: new Date(), withinDays: 60 });
  const licences = { byWorkerId: {} };
  for (const c of crew) licences.byWorkerId[c.id] = worst[c.id] === 'ok';

  const prestart = await readPrestart(jobId);

  return {
    crew,
    inductions,
    licences,
    safetyDocs: null, // #219 not built — honest "not tracked", never faked
    manualItems: seededItems(prestart.items),
    override: prestart.override,
    inductionRequired: Boolean(job.inductionRequired),
  };
}

async function audit(me, action, jobId, summary, metadata) {
  await appendAuditLog({
    action,
    actorId: me.id,
    actorName: me.username || 'Unknown',
    actorRole: me.role || null,
    jobId,
    targetType: 'prestart',
    targetId: jobId,
    summary,
    metadata: metadata || {},
  }).catch(() => {});
}

async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  // Admin-tier only (v1). The hub hides the readiness card on a 403.
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  if (req.method === 'GET') {
    return res.status(200).json(await buildSignals(jobId, job));
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const action = body.action;
    const prestart = await readPrestart(jobId);
    const nowIso = new Date().toISOString();
    const by = me.username || me.id;

    if (action === 'tick') {
      const itemId = body.itemId;
      if (!itemId) return res.status(400).json({ error: 'itemId required' });
      const ticked = Boolean(body.ticked);
      const items = seededItems(prestart.items);
      const item = items.find((i) => i.id === itemId);
      if (!item) return res.status(404).json({ error: 'unknown checklist item' });
      item.ticked = ticked;
      item.tickedBy = ticked ? by : null;
      item.tickedAt = ticked ? nowIso : null;
      await writeBlob(prestartKey(jobId), { items, override: prestart.override });
      await audit(
        me,
        'readiness.item_ticked',
        jobId,
        `${ticked ? 'ticked' : 'un-ticked'} pre-start "${item.label}"`,
        { itemId, ticked }
      );
      return res.status(200).json(await buildSignals(jobId, job));
    }

    if (action === 'override') {
      const reason = String(body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'a reason is required to override' });
      const override = { reason: reason.slice(0, 500), by, at: nowIso };
      await writeBlob(prestartKey(jobId), { items: seededItems(prestart.items), override });
      await audit(me, 'readiness.overridden', jobId, `overrode pre-start readiness: ${override.reason}`, {});
      return res.status(200).json(await buildSignals(jobId, job));
    }

    if (action === 'clear-override') {
      await writeBlob(prestartKey(jobId), { items: seededItems(prestart.items), override: null });
      await audit(me, 'readiness.override_cleared', jobId, 'cleared the pre-start readiness override', {});
      return res.status(200).json(await buildSignals(jobId, job));
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  return res.status(405).json({ error: 'method not allowed' });
}

module.exports = handler;
// Exposed for the TS/JS defaults parity test (readiness-api.test.ts).
module.exports.DEFAULT_PRESTART_ITEMS = DEFAULT_PRESTART_ITEMS;
