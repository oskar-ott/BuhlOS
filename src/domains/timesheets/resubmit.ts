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
 * PATCH path (api/time-entries.js handlePatch) does NOT re-run the create-path
 * field-attribution check, so — exactly as on the create path — the Phil UI is
 * the guardrail. `resolveResubmitJob` is that guard; `buildResubmitPayload`
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
 * Can this entry be fixed-and-resubmitted from inside Phil?
 *
 * Only a `rejected` entry with a single allocation — the shape Phil itself
 * creates (one job per day). A multi-allocation entry (legacy / admin split)
 * is intentionally excluded so the single-job resubmit form can never silently
 * collapse a split day; those stay on the legacy surface.
 */
export function canResubmitInPhil(entry: Pick<TimeEntry, "status" | "allocations">): boolean {
  return entry.status === "rejected" && Array.isArray(entry.allocations) && entry.allocations.length === 1;
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
  assignedJobs: ReadonlyArray<AssignableJob>,
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
  input: { totalHours: number; jobId: string; notes: string | null },
): PatchTimeEntryPayload {
  const { ordinary, overtime } = autoSplitOT(input.totalHours);
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

export type ResubmitFeedback =
  | { kind: "success"; entry: TimeEntry }
  | { kind: "error"; message: string; status: number };

/**
 * Map the typed HttpResult of `editOwnEntry` to a worker-facing banner. Pure so
 * the success/failure copy is unit-testable without a DOM or a live request.
 */
export function resubmitFeedback(
  result: HttpResult<TimeEntryMutationResponse>,
): ResubmitFeedback {
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
