/**
 * xero-closeout — the pure decisions behind the mobile weekly closeout's
 * Xero finale (#249 consumer).
 *
 * The finale is the last screen of the phone closeout: once the boss has
 * reviewed every worker, the approved week can be pushed to Xero as DRAFT
 * timesheets. Everything that decides *what the boss is told* lives here, not
 * in the component — the repo's vitest env is node-only (no jsdom), so a
 * decision inside JSX is a decision nobody can test.
 *
 * Honesty rules this module exists to enforce (P7):
 * - "Created" counts ONLY `verified` — a timesheet Xero accepted AND that read
 *   back matching. `accepted`-but-`drifted`, `rejected` and `error` are never
 *   folded into the success number.
 * - Workers the engine can't send (no employee link, no earnings-rate mapping,
 *   pay-period mismatch) are named and EXCLUDED — never silently dropped, never
 *   counted as pushed.
 * - The screen is driven by the engine's OWN validation findings, never a local
 *   re-derivation. Whether an unmapped worker BLOCKS the period (an error) or
 *   is WITHHELD from the push (a warning) is the backend's call — this module
 *   renders whichever the API reports, so it stays honest on either side of
 *   that backend change.
 */

/** The one Xero WRITE scope. Mirrors api/_lib/xero/config.js TIMESHEET_WRITE_SCOPE. */
export const TIMESHEET_WRITE_SCOPE = "payroll.timesheets";

/**
 * Was the timesheet write scope granted? A connection made before the write
 * flag existed is read-only and needs a reconnect — the export pre-flights the
 * same check server-side, so the finale must not offer a push it will refuse.
 */
export function hasTimesheetWriteScope(grantedScopes: string | null | undefined): boolean {
  if (!grantedScopes) return false;
  return grantedScopes.split(/\s+/).filter(Boolean).includes(TIMESHEET_WRITE_SCOPE);
}

/** What the finale may show. `unavailable` = render the plain "Week reviewed" panel. */
export type XeroFinaleAccess =
  | { kind: "unavailable" }
  | { kind: "connect" }
  | { kind: "reconnect" }
  | { kind: "ready" };

export interface XeroFinaleAccessInput {
  /** Xero endpoints are admin-only; this surface also renders for leading hands. */
  isAdmin: boolean;
  /** `xero_connection` — the Xero feature at all. */
  connectionFlag: boolean;
  /** `xero_payroll_export` — the independent WRITE gate. */
  exportFlag: boolean;
  /** connection-health state, or null when unknown/unreadable. */
  connectionState: string | null;
  grantedScopes: string | null;
}

/**
 * Gate the finale. Order matters: a leading hand or a dark flag must not even
 * learn that a push exists, whereas an admin with the feature on is owed an
 * honest reason when the push can't run (ADR #609 P8 — "while Xero is
 * disconnected, every dependent surface states it").
 */
export function xeroFinaleAccess(input: XeroFinaleAccessInput): XeroFinaleAccess {
  const { isAdmin, connectionFlag, exportFlag, connectionState, grantedScopes } = input;
  if (!isAdmin || !connectionFlag || !exportFlag) return { kind: "unavailable" };
  if (connectionState !== "connected") return { kind: "connect" };
  if (!hasTimesheetWriteScope(grantedScopes)) return { kind: "reconnect" };
  return { kind: "ready" };
}

/** Two-letter initials for the avatar. Mirrors the crew cards above the finale. */
export function workerInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "—"
  );
}

export interface PushRow {
  workerId: string;
  workerName: string;
  initials: string;
  hours: number;
  overtimeHours: number;
  hasOvertime: boolean;
}

export interface ExcludedWorker {
  workerName: string;
  code: string;
  message: string;
}

/** A finding from the batch validation engine (api/_lib/xero/payroll-validation.js). */
export interface ValidationFinding {
  code: string;
  message: string;
  /** Worker NAMES this finding is about, when it is worker-scoped. */
  workers?: string[];
}

export interface ValidationLike {
  ready: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
}

/** A worker with approved hours in the period, straight off the closeout. */
export interface ReviewCandidate {
  workerId: string;
  workerName: string;
  approvedHours: number;
  overtimeHours: number;
  hasOvertime: boolean;
}

/**
 * Finding codes that mean "this worker's hours are left out of the push"
 * (no confirmed Xero employee link). As an ERROR the engine blocks the whole
 * period; as a WARNING (the skip-with-warning engine) the push proceeds
 * without those workers. The finale renders whichever the API reports.
 */
const WITHHELD_CODES = /unmapped|withheld|missing_employee|no_employee/;

/**
 * Finding codes that mean "these hours are never part of a push BY DESIGN"
 * (subcontractors invoice the business directly — owner decision 2026-08-02).
 * Unlike withheld workers there is nothing to fix: the finding stays a calm
 * "Worth knowing" warning, but the named workers must not appear in the
 * will-send list either.
 */
const OUTSIDE_PAYROLL_CODES = /subcontractor/;

export interface ReviewPlan {
  /** Workers whose approved hours the push would carry (withheld ones excluded). */
  rows: PushRow[];
  sendCount: number;
  totalHours: number;
  /**
   * Workers WITHHELD from this push (worker-scoped WARNINGS with a withheld
   * code): the engine sends the rest of the period and leaves these out. Named
   * so the boss knows exactly whose hours are not going across.
   */
  withheld: ExcludedWorker[];
  /** Blocking errors that name specific workers — e.g. no Xero employee link. */
  workerIssues: ExcludedWorker[];
  /** Blocking errors not scoped to a worker — no_rows, org_mismatch, stale_reference. */
  generalIssues: ValidationFinding[];
  /** Other non-blocking findings — e.g. a terminated employee. Shown, never a barrier. */
  warnings: ValidationFinding[];
  /**
   * True only when the engine's validation is READY and something remains to
   * send. While the engine blocks all-or-nothing (`lockBatch` refuses on any
   * validation error), one unmapped worker holds up the whole period — the
   * finale says that rather than imply a partial push the engine will refuse.
   */
  canPush: boolean;
}

/**
 * Build the review screen from the closeout's own approved hours plus the
 * engine's no-write validation preview.
 *
 * Deliberately driven by `POST payroll-batches {action:'preview'}`, which
 * persists nothing — opening the finale must never leave a stray batch behind.
 */
export function buildReviewPlan(
  candidates: ReviewCandidate[],
  validation: ValidationLike | null,
): ReviewPlan {
  const workerIssues: ExcludedWorker[] = [];
  const generalIssues: ValidationFinding[] = [];
  for (const e of validation?.errors ?? []) {
    if (e.workers?.length) {
      for (const name of e.workers) {
        workerIssues.push({ workerName: name, code: e.code, message: e.message });
      }
    } else {
      generalIssues.push(e);
    }
  }

  // Worker-scoped warnings with a withheld code = the engine will send the
  // period WITHOUT these workers. Everything else stays a plain warning.
  const withheld: ExcludedWorker[] = [];
  const warnings: ValidationFinding[] = [];
  for (const w of validation?.warnings ?? []) {
    if (w.workers?.length && WITHHELD_CODES.test(w.code)) {
      for (const name of w.workers) {
        withheld.push({ workerName: name, code: w.code, message: w.message });
      }
    } else {
      warnings.push(w);
    }
  }

  // The push list honestly excludes withheld workers — their hours are the
  // ones the engine says will NOT go across. Matching is by name because the
  // engine's findings carry names; an unmatched name still shows in the card.
  // Outside-payroll workers (subbies) are excluded the same way: their
  // finding renders as a calm warning, never a row in the will-send list.
  const withheldNames = new Set(withheld.map((w) => w.workerName));
  for (const w of validation?.warnings ?? []) {
    if (w.workers?.length && OUTSIDE_PAYROLL_CODES.test(w.code)) {
      for (const name of w.workers) withheldNames.add(name);
    }
  }
  const rows: PushRow[] = candidates
    .filter((c) => !withheldNames.has(c.workerName))
    .map((c) => ({
      workerId: c.workerId,
      workerName: c.workerName,
      initials: workerInitials(c.workerName),
      hours: c.approvedHours,
      overtimeHours: c.overtimeHours,
      hasOvertime: c.hasOvertime,
    }));

  return {
    rows,
    sendCount: rows.length,
    totalHours: round2(rows.reduce((t, r) => t + r.hours, 0)),
    withheld,
    workerIssues,
    generalIssues,
    warnings,
    canPush: Boolean(validation?.ready) && rows.length > 0,
  };
}

/** Per-worker outcome from POST /api/xero/payroll-export {action:'export'}. */
export interface ResultWorkerLike {
  worker: string;
  outcome: string;
  xeroTimesheetId?: string | null;
  mismatches?: string[];
  blocker?: { message?: string } | null;
  reason?: string;
  category?: string;
}

export interface PushResultSummary {
  /** Accepted by Xero AND verified by readback. The ONLY number we call "created". */
  created: number;
  /** Hours across the created timesheets. */
  createdHours: number;
  /** Accepted but the readback disagreed — surfaced separately, never as success. */
  drifted: ExcludedWorker[];
  /** Xero refused, or the call errored. */
  failed: ExcludedWorker[];
  /** Nothing to do (already verified). */
  skipped: ExcludedWorker[];
  /** Engine-blocked at push time. */
  blocked: ExcludedWorker[];
  /** True when at least one timesheet was created and nothing went wrong. */
  clean: boolean;
}

/**
 * Summarise what Xero actually did. `hoursByWorkerName` comes from the plan —
 * the result rows carry names, not ids, so the created-hours total is matched
 * by name and falls back to 0 rather than inventing a figure.
 */
export function summarisePushResult(
  workers: ResultWorkerLike[],
  hoursByWorkerName: Map<string, number> = new Map(),
): PushResultSummary {
  const out: PushResultSummary = {
    created: 0,
    createdHours: 0,
    drifted: [],
    failed: [],
    skipped: [],
    blocked: [],
    clean: false,
  };

  for (const w of workers) {
    const entry: ExcludedWorker = {
      workerName: w.worker,
      code: w.outcome,
      message: w.blocker?.message || w.reason || w.category || "",
    };
    switch (w.outcome) {
      case "verified":
        out.created += 1;
        out.createdHours = round2(out.createdHours + (hoursByWorkerName.get(w.worker) ?? 0));
        break;
      case "drifted":
        out.drifted.push({
          ...entry,
          message: w.mismatches?.length
            ? `Xero read back different values: ${w.mismatches.join(", ")}`
            : "Xero accepted it, but the read-back didn't match.",
        });
        break;
      case "skipped":
        out.skipped.push({ ...entry, message: "Already in Xero for this period." });
        break;
      case "blocked":
        out.blocked.push(entry);
        break;
      default:
        // rejected, error, retry_required, unable_to_verify, and anything new
        // the engine grows: never a success.
        out.failed.push(entry);
        break;
    }
  }

  out.clean =
    out.created > 0 && out.drifted.length === 0 && out.failed.length === 0 && out.blocked.length === 0;
  return out;
}

/** Did anything at all go wrong? Drives whether the finale offers a Retry. */
export function pushNeedsAttention(summary: PushResultSummary): boolean {
  return summary.drifted.length > 0 || summary.failed.length > 0 || summary.blocked.length > 0;
}

/**
 * Pick the batch to push for a period. The closeout must never create a second
 * batch for a week it already has one for — that's how duplicate drafts happen.
 * An exported/exporting batch is reused so a retry resumes instead of forking.
 */
export function chooseBatchForPeriod<T extends { id: string; status: string; revision?: number }>(
  batches: T[],
): T | null {
  if (batches.length === 0) return null;
  const rank: Record<string, number> = {
    exporting: 0,
    partially_exported: 1,
    locked: 2,
    exported: 3,
    ready: 4,
    draft: 5,
    blocked: 6,
  };
  const sorted = [...batches].sort((a, b) => {
    const ra = rank[a.status] ?? 99;
    const rb = rank[b.status] ?? 99;
    if (ra !== rb) return ra - rb;
    return (b.revision ?? 0) - (a.revision ?? 0);
  });
  return sorted[0] ?? null;
}

/** Batch statuses the export endpoint accepts without a fresh lock. */
const EXPORTABLE = new Set(["locked", "exporting", "partially_exported"]);

/**
 * What the finale must do next to get `batch` pushed. Keeps the multi-step
 * create → lock → export dance out of the component.
 */
export type BatchStep = "create" | "lock" | "export" | "done" | "correction";

export function nextBatchStep(batch: { status: string } | null): BatchStep {
  if (!batch) return "create";
  if (batch.status === "exported") return "done";
  if (EXPORTABLE.has(batch.status)) return "export";
  if (batch.status === "ready") return "lock";
  // draft / blocked — validation must clear before a lock will hold.
  return "correction";
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
