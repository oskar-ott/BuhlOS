'use strict';

// Job closeout snapshot builder (#349, Epic 3). Freezes a job's "final numbers"
// — its permanent report card — at the moment it finishes, so completed jobs
// become the durable population Epic 14 trends and Epic 7 quote benchmarks read,
// instead of a LIVE view over mutable inputs (estimates editable, rates change,
// entries reopen).
//
// CJS so the serverless handler can require it. Money is INTEGER CENTS. Pure: the
// handler gathers the inputs (profitability via api/_lib/job-profitability.js,
// duration from the job's dates + recorded activity, snag lifecycle from the
// snag list) and this composes them + states honesty badges. Missing inputs are
// NAMED, never zero-filled (P7).

const { computeJobProfitability } = require('./job-profitability');

/** Whole days between two YYYY-MM-DD (or ISO) dates, or null if either missing. */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * @param {{
 *   contractValueCents: number|null, claimedToDateCents: number|null,
 *   labourCostCents: number, unratedWorkers: string[], hoursTotal: number,
 *   labourEstimateCents: number|null,
 *   materialCostCents: number|null, materialSource: 'consumption'|'received_proxy'|'none',
 *   duration: { startDate?: string|null, dueDate?: string|null,
 *               programmedDurationDays?: number|null,
 *               firstActivity?: string|null, lastActivity?: string|null },
 *   snags: { opened: number, closed: number, openNow: number, meanDaysToClose: number|null },
 *   meta: { closedBy: string, closedByName: string, closedAt: string,
 *           backfilled: boolean, version: number, fromStatus: string }
 * }} input
 */
function buildCloseoutSnapshot(input) {
  const profit = computeJobProfitability({
    contractValueCents: input.contractValueCents,
    labourCostCents: input.labourCostCents,
    unratedWorkers: input.unratedWorkers || [],
    materialCostCents: input.materialCostCents,
    materialSource: input.materialSource,
  });

  const d = input.duration || {};
  const plannedDays =
    d.programmedDurationDays != null && Number.isFinite(Number(d.programmedDurationDays))
      ? Number(d.programmedDurationDays)
      : daysBetween(d.startDate, d.dueDate);
  const actualDays = daysBetween(d.firstActivity, d.lastActivity);

  const labourEstimateCents =
    input.labourEstimateCents != null && Number.isFinite(input.labourEstimateCents)
      ? Math.round(input.labourEstimateCents)
      : null;
  const labourVarianceCents =
    labourEstimateCents == null ? null : profit.labourCostCents - labourEstimateCents;

  const snags = input.snags || { opened: 0, closed: 0, openNow: 0, meanDaysToClose: null };

  // Report-card honesty badges — name what's missing rather than fake it.
  const badges = [...profit.badges];
  if (labourEstimateCents == null) badges.push('no labour estimate set');
  if (plannedDays == null) badges.push('no planned duration');
  if (actualDays == null) badges.push('no recorded activity dates');
  if (snags.openNow > 0) badges.push(`${snags.openNow} snag${snags.openNow === 1 ? '' : 's'} still open`);
  if (input.meta && input.meta.backfilled) badges.push('backfilled closeout');

  return {
    version: (input.meta && input.meta.version) || 1,
    closedAt: input.meta && input.meta.closedAt,
    closedBy: input.meta && input.meta.closedBy,
    closedByName: input.meta && input.meta.closedByName,
    backfilled: Boolean(input.meta && input.meta.backfilled),
    fromStatus: input.meta && input.meta.fromStatus,
    revenue: {
      contractValueCents: profit.contractValueCents,
      claimedToDateCents:
        input.claimedToDateCents != null && Number.isFinite(input.claimedToDateCents)
          ? Math.round(input.claimedToDateCents)
          : null,
    },
    labour: {
      hoursTotal: Math.round((input.hoursTotal || 0) * 100) / 100,
      costCents: profit.labourCostCents,
      estimateCents: labourEstimateCents,
      varianceCents: labourVarianceCents,
      unratedWorkers: input.unratedWorkers || [],
    },
    material: { costCents: profit.materialCostCents, source: profit.completeness.material },
    margin: { cents: profit.marginCents, pct: profit.marginPct },
    duration: {
      startDate: d.startDate || null,
      dueDate: d.dueDate || null,
      firstActivity: d.firstActivity || null,
      lastActivity: d.lastActivity || null,
      plannedDays,
      actualDays,
    },
    snags: {
      opened: snags.opened || 0,
      closed: snags.closed || 0,
      openNow: snags.openNow || 0,
      meanDaysToClose: snags.meanDaysToClose == null ? null : snags.meanDaysToClose,
    },
    badges,
  };
}

/**
 * Snag lifecycle totals for the report card, from the per-job data.json snags
 * array. Defensive over legacy ('Open'/'Closed') + v2 lowercase vocab. Pure.
 *   - opened: snags raised (excludes 'rejected' — dismissed as not-a-snag)
 *   - closed: fixed/done (resolved | verified | closed)
 *   - openNow: still active (open | in_progress)
 *   - meanDaysToClose: mean createdAt → last-updated for closed snags that carry
 *     both timestamps; null when none do (never a fabricated figure).
 */
function snagLifecycleStats(rawSnags) {
  const snags = Array.isArray(rawSnags) ? rawSnags : [];
  const norm = (s) => String(s || 'open').toLowerCase();
  const DONE = new Set(['resolved', 'verified', 'closed']);
  const ACTIVE = new Set(['open', 'in_progress']);

  let opened = 0;
  let closed = 0;
  let openNow = 0;
  const closeDurations = [];
  for (const s of snags) {
    const status = norm(s && s.status);
    if (status === 'rejected') continue; // dismissed — not a real snag
    opened += 1;
    if (DONE.has(status)) {
      closed += 1;
      const created = s && (s.createdAt || s.date);
      const ended = s && (s.closedAt || s.resolvedAt || s.updatedAt);
      const d = daysBetween(created, ended);
      if (d != null && d >= 0) closeDurations.push(d);
    } else if (ACTIVE.has(status)) {
      openNow += 1;
    } else {
      // unknown status → treat as active (conservative — don't claim it's done)
      openNow += 1;
    }
  }
  const meanDaysToClose = closeDurations.length
    ? Math.round((closeDurations.reduce((a, b) => a + b, 0) / closeDurations.length) * 10) / 10
    : null;
  return { opened, closed, openNow, meanDaysToClose };
}

module.exports = { buildCloseoutSnapshot, daysBetween, snagLifecycleStats };
