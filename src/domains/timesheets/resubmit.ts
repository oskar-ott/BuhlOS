import type { HttpResult } from "@/lib/http";
import { autoSplitOT, primaryJobId } from "./service";
import type { PatchTimeEntryPayload, TimeEntry, TimeEntryMutationResponse } from "./types";

/**
 * Pure helpers for the Phil "fix a rejected entry and resubmit it" flow.
 *
 * No I/O, no React — the component (RejectedHoursResubmitSheet) and its tests
 * both build on these so the attribution invariant lives in one tested place.
 *
 * The hard rule this slice protects (the #77/#80/#81 guarantee, see
 * src/domains/qa/time-entry-attribution.ts): a field worker with active
 * assigned jobs must never (re)submit hours with `jobId: null`. The server's
 * PATCH path (api/time-entries.js handlePatch) re-runs the field-attribution
 * gate and — 2026-07-26 owner-directed — also rejects `jobId: null` from a
 * field self-edit, but the Phil UI stays the first guardrail:
 * `resolveResubmitJob` is that guard; `buildResubmitPayload`
 * only accepts a non-null `jobId: string`, so a null job can't reach the wire.
 *
 * The transition itself is already supported on `main`: PATCH
 * /api/time-entries?date= moves a `rejected` (or `draft`) entry to `submitted`,
 * clears `rejectedReason`, and stamps `submittedAt`. No API change is needed.
 *
 * Cross-ref:
 *   src/components/phil/LogHoursSheet.tsx — the sibling create-path guard
 *     (`jobAttributionError` / `jobReady`); this mirrors its rules for the
 *     resubmit path without modifying it.
 *   docs/buhlos-hours-safe-foundation.md — #92 deferred this slice to here.
 */

/** Worker-facing target shape: id + display name of an active assigned job. */
export interface AssignableJob {
  id: string;
  name: string;
}

/**
 * Can this entry be fixed-and-resubmitted (or changed-and-resent) from inside
 * Phil?
 *
 * Any `rejected` entry with at least one allocation — and, 2026-07-26
 * owner-directed, any `submitted` (undecided) entry too: the worker can fix a
 * sent day until the office decides. The rejected semantics are unchanged;
 * a submitted entry rides the exact same editors, just with "change & resend"
 * words instead of "fix & resubmit". Phil now creates split days itself
 * (#128 `buildSplitDayPayload`), so a split is no longer "legacy" — it must
 * be fixable in Phil too. The single-job form is never allowed to collapse a
 * split: `isSplitResubmit` routes a multi-allocation entry to the split
 * editor (which preserves every allocation), while a single-allocation entry
 * uses the single-job form. The attribution invariant is enforced at submit
 * by both editors (every row needs a real assigned job), not by excluding
 * splits here.
 */
export function canResubmitInPhil(
  entry: Pick<TimeEntry, "status" | "allocations" | "tafe">,
): boolean {
  // A TAFE day (2026-08-10) can't go through the fix sheet — that flow
  // REQUIRES attributing the hours to an active job, which would silently
  // turn the training day into a job day. The row falls back to the honest
  // "ask the office" copy; the office edits/amends TAFE days.
  if (entry.tafe) return false;
  return (
    (entry.status === "rejected" || entry.status === "submitted") &&
    Array.isArray(entry.allocations) &&
    entry.allocations.length >= 1
  );
}

/**
 * Is this a SPLIT day (2+ allocations) — i.e. resubmit it through the split
 * editor rather than the single-job form, so the multiple allocations survive?
 */
export function isSplitResubmit(entry: Pick<TimeEntry, "allocations">): boolean {
  return Array.isArray(entry.allocations) && entry.allocations.length > 1;
}

/**
 * Seed the split editor from a rejected split entry: the day total plus one row
 * per existing allocation. An allocation whose job is no longer one of the
 * worker's active assigned jobs is seeded `null`, so the worker must re-pick it
 * (never a silent attribution to a stale/unassigned job).
 */
export function splitResubmitInitialRows(
  entry: Pick<TimeEntry, "totalHours" | "allocations">,
  assignedJobs: ReadonlyArray<AssignableJob>
): { total: number; rows: Array<{ jobId: string | null; hours: number }> } {
  const rows = (entry.allocations ?? []).map((a) => ({
    jobId: a.jobId && assignedJobs.some((j) => j.id === a.jobId) ? a.jobId : null,
    hours: a.hours,
  }));
  return { total: entry.totalHours, rows };
}

/**
 * Seed the split editor when a SINGLE-allocation day is being split across
 * jobs from inside the change/fix flow (2026-07-26 owner-directed). Row 1 is
 * the day's current job carrying the day's full hours; row 2 is the empty
 * remainder row the worker moves hours into. Two rows are seeded on purpose —
 * SplitDaySheet only honours `initialRows` with 2+ rows (a split is 2+ jobs
 * by definition), and its last row is always the computed remainder.
 *
 * Same attribution rule as `splitResubmitInitialRows`: a current job that is
 * no longer one of the worker's active assigned jobs seeds `null`, so the
 * worker must re-pick (never a silent attribution to a stale/unassigned job).
 */
export function splitChangeInitialRows(
  entry: Pick<TimeEntry, "totalHours" | "allocations">,
  assignedJobs: ReadonlyArray<AssignableJob>
): { total: number; rows: Array<{ jobId: string | null; hours: number }> } {
  const current = primaryJobId(entry);
  const jobId = current && assignedJobs.some((j) => j.id === current) ? current : null;
  return {
    total: entry.totalHours,
    rows: [
      { jobId, hours: entry.totalHours },
      { jobId: null, hours: 0 },
    ],
  };
}

/**
 * The job to preselect when the resubmit form opens. Preserves the original
 * attribution where it is still valid, never guesses across multiple jobs:
 *   - original job id, if it's still one of the worker's active assigned jobs;
 *   - else the sole assigned job (the safe auto-select);
 *   - else null — the worker must explicitly pick (multiple jobs, or the
 *     original job is no longer assigned / was never set).
 */
export function resubmitInitialJobId(
  entry: Pick<TimeEntry, "allocations">,
  assignedJobs: ReadonlyArray<AssignableJob>
): string | null {
  const original = primaryJobId(entry);
  if (original && assignedJobs.some((j) => j.id === original)) return original;
  if (assignedJobs.length === 1) return assignedJobs[0]!.id;
  return null;
}

export type ResubmitJobResolution =
  | { ok: true; jobId: string }
  | { ok: false; reason: "jobs_error" | "no_jobs" | "no_selection" };

/**
 * Resolve the job a resubmission will attribute to, or an honest blocked
 * reason. Mirrors LogHoursSheet's `jobAttributionError` rules:
 *   - jobs failed to load        → block (never fall back to null)
 *   - no active assigned job      → block
 *   - selection missing / unknown → block (covers "multiple, none picked")
 * Only returns ok with a real, currently-assigned job id.
 */
export function resolveResubmitJob(input: {
  assignedJobs: ReadonlyArray<AssignableJob>;
  selectedJobId: string | null;
  jobsError: boolean;
}): ResubmitJobResolution {
  if (input.jobsError) return { ok: false, reason: "jobs_error" };
  if (input.assignedJobs.length === 0) return { ok: false, reason: "no_jobs" };
  const sel = input.selectedJobId;
  if (!sel || !input.assignedJobs.some((j) => j.id === sel)) {
    return { ok: false, reason: "no_selection" };
  }
  return { ok: true, jobId: sel };
}

/**
 * Build the PATCH payload that resubmits a corrected entry. `jobId` is typed
 * `string` (non-null) on purpose — callers must resolve it via
 * `resolveResubmitJob` first, so a null job can never be encoded here. Single
 * allocation by design (see canResubmitInPhil); ordinary/overtime split mirrors
 * the server (`autoSplitOT`). Status → `submitted` drives the rejected→submitted
 * transition the server already supports.
 */
export function buildResubmitPayload(
  entry: Pick<TimeEntry, "date">,
  input: { totalHours: number; jobId: string; notes: string | null }
): PatchTimeEntryPayload {
  const { ordinary, overtime } = autoSplitOT(input.totalHours, entry.date);
  return {
    date: entry.date,
    totalHours: input.totalHours,
    ordinaryHours: ordinary,
    overtimeHours: overtime,
    allocations: [{ jobId: input.jobId, hours: input.totalHours, notes: null }],
    status: "submitted",
    notes: input.notes,
  };
}

/**
 * Build the PATCH payload that resubmits a corrected SPLIT day, PRESERVING every
 * allocation (never collapsing to one job). Mirrors the create-path
 * `buildSplitDayPayload`: ordinary/overtime split on the day TOTAL, each
 * allocation's `jobId` typed `string` (non-null) — the split editor resolves a
 * real assigned job per row before calling this, so a null job can't be encoded.
 * Status → `submitted` drives the rejected→submitted transition. The schema
 * (allocations sum = total ±0.01) and the server field-allocation gate
 * (api/time-entries.js, which re-runs when a PATCH sends `allocations`) are the
 * downstream backstops.
 */
export function buildSplitResubmitPayload(
  entry: Pick<TimeEntry, "date">,
  input: {
    totalHours: number;
    allocations: ReadonlyArray<{ jobId: string; hours: number }>;
    notes: string | null;
  }
): PatchTimeEntryPayload {
  const { ordinary, overtime } = autoSplitOT(input.totalHours, entry.date);
  return {
    date: entry.date,
    totalHours: input.totalHours,
    ordinaryHours: ordinary,
    overtimeHours: overtime,
    allocations: input.allocations.map((a) => ({ jobId: a.jobId, hours: a.hours, notes: null })),
    status: "submitted",
    notes: input.notes,
  };
}

export type ResubmitFeedback =
  | { kind: "success"; entry: TimeEntry }
  | { kind: "error"; message: string; status: number };

/**
 * Map the typed HttpResult of `editOwnEntry` to a worker-facing banner. Pure so
 * the success/failure copy is unit-testable without a DOM or a live request.
 */
export function resubmitFeedback(result: HttpResult<TimeEntryMutationResponse>): ResubmitFeedback {
  if (result.ok) return { kind: "success", entry: result.data.entry };
  const status = result.error.status || 0;
  if (status === 401) {
    return { kind: "error", status, message: "Session expired. Sign in again to resubmit." };
  }
  if (status === 403) {
    return {
      kind: "error",
      status,
      message: "You can't edit this entry — ask the office to reopen it.",
    };
  }
  if (status === 404) {
    return { kind: "error", status, message: "This entry isn't here anymore. Pull to refresh." };
  }
  return {
    kind: "error",
    status,
    message: result.error.message || "Couldn't resubmit your hours. Try again in a moment.",
  };
}
