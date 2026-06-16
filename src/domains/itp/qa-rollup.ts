import { isActive, formatProgress } from "./format";
import type { ITPInstance, ITPStatus } from "./types";

/**
 * Cross-job QA rollup (#290, narrow first increment — the office "QA exposure"
 * readback, the ITP analog of the job-control proof-status view #473).
 *
 * PURE aggregation: given a job's ITP instances → a per-job rollup (status
 * counts, open points, oldest-unactioned age, awaiting-sign-off), and given many
 * jobs → a dashboard with totals. No I/O, no `Date.now()` (the caller passes
 * `now` so it stays deterministic + testable).
 *
 * Honesty rules:
 *   - Reuses the domain's own status semantics (`isActive`) and progress
 *     (`formatProgress`) — never re-derives them, so the dashboard and the
 *     per-job ITP surface agree (P7).
 *   - "Oldest active age" is computed ONLY from real timestamps (updatedAt /
 *     createdAt) — no invented due dates (#290 AC).
 *   - A job with zero ITPs is a real state the caller renders as a GAP ("no ITPs
 *     attached"), never as all-clear — this layer just reports total: 0.
 *   - Pass rates are intentionally OUT of this first increment (they belong to
 *     the completion-analytics child #297 and need per-point verdict logic);
 *     this readback answers "what's open / stuck / unwitnessed", not "pass %".
 */

const DAY_MS = 86_400_000;

export type QaStatusCounts = Record<ITPStatus, number>;

export interface JobQaRollup {
  /** Non-archived instances on the job. */
  total: number;
  statusCounts: QaStatusCounts;
  /** pending | in-progress | witnessed. */
  activeCount: number;
  /** witnessed — recorded, waiting on admin sign-off. */
  awaitingSignOff: number;
  /** Required, not-yet-recorded points across ACTIVE instances. */
  openPoints: number;
  /** Oldest active instance's updatedAt (or createdAt), or null. */
  oldestActiveAt: string | null;
  /** Whole days since `oldestActiveAt`, or null. */
  oldestActiveAgeDays: number | null;
}

function emptyCounts(): QaStatusCounts {
  return { pending: 0, "in-progress": 0, witnessed: 0, "signed-off": 0 };
}

/** Whole days between two ISO timestamps (0 on unparseable / future). */
export function ageDays(fromIso: string, nowIso: string): number {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(from) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.floor((now - from) / DAY_MS));
}

export function buildJobQaRollup(
  instances: ReadonlyArray<ITPInstance>,
  now: string,
): JobQaRollup {
  const live = instances.filter((i) => !i.archived);
  const statusCounts = emptyCounts();
  let activeCount = 0;
  let awaitingSignOff = 0;
  let openPoints = 0;
  let oldestActiveAt: string | null = null;
  let oldestActiveEpoch = Infinity;

  for (const inst of live) {
    statusCounts[inst.status] += 1;
    if (inst.status === "witnessed") awaitingSignOff += 1;
    if (isActive(inst.status)) {
      activeCount += 1;
      const p = formatProgress(inst);
      openPoints += Math.max(0, p.total - p.done);
      // Pick the chronologically-oldest active timestamp by PARSED instant, not
      // lexical string order — so a mixed ISO format (offset vs Zulu) can't
      // mis-rank. An unparseable / missing stamp is ignored (no fabricated age).
      const at = inst.updatedAt || inst.createdAt;
      const epoch = at ? Date.parse(at) : Number.NaN;
      if (!Number.isNaN(epoch) && epoch < oldestActiveEpoch) {
        oldestActiveEpoch = epoch;
        oldestActiveAt = at;
      }
    }
  }

  return {
    total: live.length,
    statusCounts,
    activeCount,
    awaitingSignOff,
    openPoints,
    oldestActiveAt,
    oldestActiveAgeDays: oldestActiveAt ? ageDays(oldestActiveAt, now) : null,
  };
}

export interface QaJobRow {
  jobId: string;
  jobName: string;
  rollup: JobQaRollup;
}

export interface QaDashboardTotals {
  jobs: number;
  jobsWithItps: number;
  instances: number;
  activeInstances: number;
  awaitingSignOff: number;
  openPoints: number;
}

export interface QaDashboard {
  rows: QaJobRow[];
  totals: QaDashboardTotals;
  /** Oldest active age across all jobs (the headline "worst" number), or null. */
  oldestActiveAgeDays: number | null;
}

export function buildQaDashboard(
  perJob: ReadonlyArray<{ jobId: string; jobName: string; instances: ReadonlyArray<ITPInstance> }>,
  now: string,
): QaDashboard {
  const rows: QaJobRow[] = perJob.map((j) => ({
    jobId: j.jobId,
    jobName: j.jobName,
    rollup: buildJobQaRollup(j.instances, now),
  }));

  // Worst-first: most awaiting sign-off, then oldest active age, then name.
  rows.sort(
    (a, b) =>
      b.rollup.awaitingSignOff - a.rollup.awaitingSignOff ||
      (b.rollup.oldestActiveAgeDays ?? -1) - (a.rollup.oldestActiveAgeDays ?? -1) ||
      a.jobName.localeCompare(b.jobName),
  );

  const totals = rows.reduce<QaDashboardTotals>(
    (t, r) => ({
      jobs: t.jobs + 1,
      jobsWithItps: t.jobsWithItps + (r.rollup.total > 0 ? 1 : 0),
      instances: t.instances + r.rollup.total,
      activeInstances: t.activeInstances + r.rollup.activeCount,
      awaitingSignOff: t.awaitingSignOff + r.rollup.awaitingSignOff,
      openPoints: t.openPoints + r.rollup.openPoints,
    }),
    { jobs: 0, jobsWithItps: 0, instances: 0, activeInstances: 0, awaitingSignOff: 0, openPoints: 0 },
  );

  const oldestActiveAgeDays = rows.reduce<number | null>((m, r) => {
    const d = r.rollup.oldestActiveAgeDays;
    if (d === null) return m;
    return m === null ? d : Math.max(m, d);
  }, null);

  return { rows, totals, oldestActiveAgeDays };
}
