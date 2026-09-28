// Per-job materials SPEND ledger (owner pull 2026-08-23). ADMIN-TIER ONLY on
// every method — money is office data; a leading hand never reads it. Dark
// behind the `job_materials_spend` launch-gate (404 while off, like itp_simple).
//
//   GET    /api/job-materials?jobId=X          → { jobId, lines, totalCents, count, asOf }
//   POST   /api/job-materials?jobId=X          body { date, supplier, description?, reference?, amountCents, override?: { reason } }
//                                              → 201 { jobId, line, duplicateCheck, lines, totalCents, count }
//                                              → 409 { error: 'possible_duplicate', candidates } when a CONFIRMED
//                                                supplier invoice on this job looks like the same cost (same
//                                                supplier + same invoice number, or same supplier + same amount
//                                                within 14 days — never amount alone). Re-POST with
//                                                { override: { reason } } to add it anyway; the override is
//                                                stored on the line and journalled as
//                                                job.material_spend_duplicate_override (2026-09-27).
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
const { getDb } = require('./_lib/supabase-db');
const invoiceStore = require('./_lib/invoices/store');
const {
  readLedger,
  writeLedger,
  validateLineInput,
  appendLine,
  removeLine,
  summariseLedger,
  findPossibleDuplicates,
  parseOverride,
} = require('./_lib/job-materials');

function actorName(me) {
  return (me && (me.name || me.username)) || '';
}

/**
 * Confirmed supplier invoices on this job that the typed line may duplicate.
 * Reads the invoice store (Postgres) in read mode; when that store is not
 * reachable in this deployment the check is reported as 'unavailable' and the
 * save goes ahead — a warning must never lock the office out of its own
 * ledger, but it must say when it could not look. Never throws.
 */
async function duplicateCheck(jobId, value) {
  let sql;
  try {
    sql = getDb({ mode: 'read' });
  } catch {
    return { status: 'unavailable', candidates: [] };
  }
  try {
    const tenant = await invoiceStore.resolveTenant(sql);
    if (!tenant) return { status: 'unavailable', candidates: [] };
    const allocations = await invoiceStore.jobActiveAllocations(sql, tenant.id, jobId);
    const candidates = findPossibleDuplicates(value, allocations);
    return { status: candidates.length ? 'possible' : 'clear', candidates };
  } catch (e) {
    console.error('[job-materials] duplicate check unavailable', { code: (e && e.code) || 'error' });
    return { status: 'unavailable', candidates: [] };
  }
}

async function journal(me, job, action, line, summary, extra) {
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
      metadata: { lineId: line.id, date: line.date, supplier: line.supplier, ...(extra || {}) },
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
    const override = parseOverride(req.body || {});
    if (override && override.error) return res.status(400).json({ error: override.error });
    // Possible duplicate cost (2026-09-27): a docket typed here that a
    // confirmed supplier invoice already books on this job would count twice
    // in the Money card. Warn — never silently block — and let an explicit,
    // reasoned, audited override add it anyway. Checked on EVERY POST, server
    // side, so a concurrent or replayed save cannot skip it.
    const check = await duplicateCheck(jobId, parsed.value);
    if (check.status === 'possible' && !override) {
      return res.status(409).json({ error: 'possible_duplicate', jobId, candidates: check.candidates });
    }
    const value = { ...parsed.value };
    const overridden =
      override && check.candidates.length
        ? {
            reason: override.reason,
            invoiceIds: check.candidates.map((c) => c.invoiceId),
            strength: check.candidates[0].strength,
            checkedAt: new Date().toISOString(),
            by: me.id,
            byName: actorName(me),
          }
        : null;
    if (overridden) value.duplicateOverride = overridden;
    const data = await readLedger(jobId);
    const appended = appendLine(data, value, me);
    if (appended.error) return res.status(409).json({ error: appended.error });
    await writeLedger(jobId, appended.data);
    await journal(
      me,
      job,
      'job.material_spend_added',
      appended.line,
      `${actorName(me) || 'someone'} recorded materials spend from ${appended.line.supplier} (${appended.line.date}) on ${job.name || job.id}`,
    );
    if (overridden) {
      await journal(
        me,
        job,
        'job.material_spend_duplicate_override',
        appended.line,
        `${actorName(me) || 'someone'} added materials spend from ${appended.line.supplier} (${appended.line.date}) on ${job.name || job.id} despite a possible duplicate — ${overridden.reason}`,
        { invoiceIds: overridden.invoiceIds, strength: overridden.strength, reason: overridden.reason },
      );
    }
    return res.status(201).json({
      jobId,
      line: appended.line,
      duplicateCheck: overridden ? 'overridden' : check.status,
      ...summariseLedger(appended.data),
    });
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
