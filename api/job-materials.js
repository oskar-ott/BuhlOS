// Per-job materials SPEND ledger (owner pull 2026-08-23). ADMIN-TIER ONLY on
// every method — money is office data; a leading hand never reads it. Dark
// behind the `job_materials_spend` launch-gate (404 while off, like itp_simple).
//
//   GET    /api/job-materials?jobId=X          → { jobId, lines, totalCents, count, asOf }
//   POST   /api/job-materials?jobId=X          body { date, supplier, description?, amountCents }
//                                              → 201 { jobId, line, lines, totalCents, count }
//   DELETE /api/job-materials?jobId=X&id=<line> → 200 { jobId, lines, totalCents, count }
//
// MONEY IS INTEGER CENTS. Store + pure helpers: api/_lib/job-materials.js.
// The job hub's Money card reads the same ledger through api/job-profitability.js
// (materialSource 'ledger'), so the Materials figure and this list never differ.
//
// Audit: every add/remove is journalled (job.material_spend_added/_removed,
// targetType 'job') WITHOUT the dollar amount — the cross-job journal is
// readable below the admin tier; the amount lives only in the ledger itself.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const auditLog = require('./_lib/audit-log');
const {
  readLedger,
  writeLedger,
  validateLineInput,
  appendLine,
  removeLine,
  summariseLedger,
} = require('./_lib/job-materials');

function actorName(me) {
  return (me && (me.name || me.username)) || '';
}

async function journal(me, job, action, line, summary) {
  try {
    await auditLog.append({
      action,
      actorId: me.id,
      actorName: actorName(me),
      actorRole: me.role || null,
      jobId: job.id,
      targetType: 'job',
      targetId: job.id,
      summary: summary.slice(0, 240),
      // Privacy line: supplier + date, never the amount.
      metadata: { lineId: line.id, date: line.date, supplier: line.supplier },
    });
  } catch {
    // Best-effort — the ledger write has already landed.
  }
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!(await isFlagEnabled('job_materials_spend', me))) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const q = req.query || {};
  const jobId = String(q.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find((j) => j && j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  if (req.method === 'GET') {
    const data = await readLedger(jobId);
    return res.status(200).json({ jobId, ...summariseLedger(data), asOf: new Date().toISOString() });
  }

  if (req.method === 'POST') {
    const parsed = validateLineInput(req.body || {});
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const data = await readLedger(jobId);
    const appended = appendLine(data, parsed.value, me);
    if (appended.error) return res.status(409).json({ error: appended.error });
    await writeLedger(jobId, appended.data);
    await journal(
      me,
      job,
      'job.material_spend_added',
      appended.line,
      `${actorName(me) || 'someone'} recorded materials spend from ${appended.line.supplier} (${appended.line.date}) on ${job.name || job.id}`,
    );
    return res.status(201).json({ jobId, line: appended.line, ...summariseLedger(appended.data) });
  }

  if (req.method === 'DELETE') {
    const id = String(q.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readLedger(jobId);
    const removed = removeLine(data, id, me);
    if (!removed) return res.status(404).json({ error: 'line not found' });
    await writeLedger(jobId, removed.data);
    await journal(
      me,
      job,
      'job.material_spend_removed',
      removed.line,
      `${actorName(me) || 'someone'} removed a materials spend line from ${removed.line.supplier} (${removed.line.date}) on ${job.name || job.id}`,
    );
    return res.status(200).json({ jobId, ...summariseLedger(removed.data) });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
