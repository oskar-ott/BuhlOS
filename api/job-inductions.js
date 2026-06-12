// Per-job site induction register (#332) — turns the inductionRequired FLAG
// into a tracked record. Who was inducted on which job, when, recorded by
// whom: the question a principal contractor or SafeWork inspector actually
// asks. Records are APPEND-ONLY — re-induction adds a record, history is
// never edited.
//
//   GET  /api/job-inductions?jobId=X&mine=1 → my latest record on this job
//          (any assigned worker; the session is the identity)
//   GET  /api/job-inductions?mine=1          → my records across my assigned
//          jobs (worker history; fans out over assignedJobIds — small N)
//   GET  /api/job-inductions?jobId=X         → all records + crew status
//          (admin tier: assigned crew ∩ records, no false "complete")
//   POST /api/job-inductions { jobId, note? }            → self-confirm
//          (assignment-gated; double-tap idempotent — returns the existing
//          record rather than duplicating)
//   POST /api/job-inductions { jobId, workerId, note? }  → office backfill
//          (admin tier; paper/verbal reality — recordedBy retained, audited
//          under its own verb so backfills stay distinguishable)
//
// Ledger: jobs/<jobId>/inductions.json (per-job blob, temps.js precedent).
// Store shape: { records: [{ id, workerId, workerName, jobId, completedAt,
//   recordedBy, recordedByName, note, backfill }] }
//
// Field workers never see each other's induction state (admin-only crew
// view, v1 — leading-hand visibility is a deliberate later decision).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const {
  requireAuth,
  isAdminRole,
  isClientRole,
  canViewDraftJobs,
  canViewArchivedJobs,
} = require('./_lib/auth');
const { append: appendAuditLog } = require('./_lib/audit-log');

function newId() {
  return 'ind_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function keyFor(jobId) {
  return 'jobs/' + jobId + '/inductions.json';
}

async function readLedger(jobId) {
  const data = await readBlob(keyFor(jobId), { records: [] });
  return Array.isArray(data.records) ? data : { records: [] };
}

/** Latest record for one worker on one job (re-induction appends → latest wins). */
function latestFor(records, workerId) {
  let latest = null;
  for (const r of records) {
    if (r.workerId !== workerId) continue;
    if (!latest || String(r.completedAt) > String(latest.completedAt)) latest = r;
  }
  return latest;
}

async function audit(user, action, record) {
  await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId: record.jobId,
    targetType: 'induction',
    targetId: record.id,
    summary: `${action === 'induction.backfilled' ? 'backfilled' : 'confirmed'} site induction for ${record.workerName}`,
    metadata: { workerId: record.workerId, backfill: record.backfill },
  }).catch(() => {});
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  const mine = req.query && req.query.mine === '1';

  if (req.method === 'GET') {
    if (mine && jobId) {
      // My state on one job — what the Phil job screen needs.
      const ledger = await readLedger(jobId);
      return res.status(200).json({ record: latestFor(ledger.records, me.id) });
    }
    if (mine) {
      // Worker history: fan out across MY assigned jobs (deliberate v1 —
      // small N per worker; a per-user index is premature, documented in
      // the issue). Job names come along so the profile list is readable.
      const jobsBlob = await readBlob('jobs.json', { jobs: [] });
      const assigned = Array.isArray(me.assignedJobIds) ? me.assignedJobIds : [];
      const jobsById = {};
      for (const j of jobsBlob.jobs || []) jobsById[j.id] = j;
      const records = [];
      await Promise.all(assigned.map(async id => {
        try {
          const ledger = await readLedger(id);
          const latest = latestFor(ledger.records, me.id);
          if (latest) {
            records.push({ ...latest, jobName: (jobsById[id] && jobsById[id].name) || id });
          }
        } catch {}
      }));
      records.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
      return res.status(200).json({ records });
    }
    // Full per-job view: admin tier only — field workers never read each
    // other's induction state (v1 ruling per the issue audit).
    if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const ledger = await readLedger(jobId);
    // Crew status = CURRENT assignment ∩ records. A worker assigned after
    // the others were inducted shows "not yet" — never a false complete.
    const usersBlob = await readBlob('users.json', { users: [] });
    const crew = (usersBlob.users || [])
      .filter(u => Array.isArray(u.assignedJobIds) && u.assignedJobIds.includes(jobId))
      .filter(u => !(u.archived || u.disabled || u.status === 'disabled'))
      // Client accounts get assignedJobIds for portal visibility — they are
      // never crew and never need inducting.
      .filter(u => !isClientRole(u.role))
      .map(u => {
        const latest = latestFor(ledger.records, u.id);
        return {
          workerId: u.id,
          workerName: u.username || u.id,
          inducted: Boolean(latest),
          completedAt: latest ? latest.completedAt : null,
          backfill: latest ? Boolean(latest.backfill) : false,
          recordedByName: latest ? latest.recordedByName : null,
        };
      })
      .sort((a, b) => Number(a.inducted) - Number(b.inducted) || a.workerName.localeCompare(b.workerName));
    return res.status(200).json({
      records: ledger.records,
      crew,
      inductionRequired: Boolean(job.inductionRequired),
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const targetJobId = body.jobId;
    if (!targetJobId) return res.status(400).json({ error: 'jobId required' });

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsBlob.jobs || []).find(j => j.id === targetJobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (!job.inductionRequired) {
      return res.status(400).json({ error: 'this job does not require induction' });
    }

    // Backfill = admin recording for someone else. Attribution rule (#112
    // pattern): workerId is only honoured from the OFFICE; a worker's own
    // confirm always records the session identity.
    const onBehalf = body.workerId && body.workerId !== me.id;
    if (onBehalf && !isAdminRole(me.role)) {
      return res.status(403).json({ error: 'only the office can record for someone else' });
    }

    let worker = me;
    if (onBehalf) {
      const usersBlob = await readBlob('users.json', { users: [] });
      worker = (usersBlob.users || []).find(u => u.id === body.workerId);
      if (!worker) return res.status(404).json({ error: 'worker not found' });
      // Paper reality: the office may backfill a worker who isn't (or is no
      // longer) assigned — the record is history, assignment is now.
    } else {
      // Self-confirm: must actually be on the job, with a live account, and
      // the job must be field-visible (draft/archived are office-only —
      // same guard pattern as api/task-toggle.js).
      const assigned = Array.isArray(me.assignedJobIds) && me.assignedJobIds.includes(targetJobId);
      if (!assigned && !isAdminRole(me.role)) {
        return res.status(403).json({ error: 'not assigned to this job' });
      }
      if (
        (job.status === 'draft' && !canViewDraftJobs(me.role)) ||
        (job.status === 'archived' && !canViewArchivedJobs(me.role))
      ) {
        return res.status(403).json({ error: 'job not available' });
      }
    }

    // Re-read + append (two workers confirming at once must both persist as
    // far as this handler can control); double-tap idempotent — an existing
    // record for this worker comes straight back, never a duplicate.
    const ledger = await readLedger(targetJobId);
    const existing = latestFor(ledger.records, worker.id);
    if (existing && !onBehalf) {
      return res.status(200).json({ record: existing, already: true });
    }
    if (existing && onBehalf) {
      // Office re-recording over an existing record is a deliberate
      // re-induction append (e.g. new site rules) — allowed, history kept.
    }

    const record = {
      id: newId(),
      jobId: targetJobId,
      workerId: worker.id,
      workerName: worker.username || worker.id,
      completedAt: new Date().toISOString(),
      recordedBy: me.id,
      recordedByName: me.username || me.id,
      note: body.note ? String(body.note).trim().slice(0, 500) : null,
      backfill: Boolean(onBehalf),
    };
    ledger.records.push(record);
    await writeBlob(keyFor(targetJobId), ledger);
    await audit(me, onBehalf ? 'induction.backfilled' : 'induction.confirmed', record);
    return res.status(201).json({ record });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
