/**
 * Phil Job Command Model — the real-data bridge.
 *
 * `buildPhilJobCommandModel` (job-command-model.ts) is a pure decision layer
 * over a `PhilJobCommandInput`. THIS file is the only place that knows about
 * the concrete job/snag/ITP/document shapes: it turns what the Phil job page
 * actually fetches into that input, marking everything it cannot truthfully
 * derive as `unknown` / `not_configured` rather than guessing.
 *
 * The split is deliberate. When the job, snag, ITP, or document schemas change
 * — or when a new real signal arrives (per-job rejected hours, richer task
 * progress) — only this bridge moves. The decision layer, its ranking, and the
 * UI generated from it stay put. That is the whole point: Phil can evolve
 * without rewriting the field-worker surface every week.
 *
 * Honesty rules encoded here:
 *   - Module OFF for the job        → `not_configured` (no action, no noise).
 *   - List fetch failed             → `unknown` (a limitation, never a false 0).
 *   - List genuinely empty          → `count: 0` (no attention, no fake action).
 *   - Capability lives elsewhere    → `elsewhere` with the real href.
 *   - Not derivable on this screen  → `unknown` (e.g. per-job rejected hours).
 *
 * What is real on `main` today vs. what is honestly deferred is documented in
 * docs/phil-job-command-model.md (the input matrix).
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/page.tsx — fetches job + evidence + snags + ITPs + plans
 *   src/domains/jobs/builder.ts — isVisibleToField / moduleEnabled / buildPhilPreview
 *   src/domains/timesheets/resubmit.ts — the rejected-hours resubmit flow (#93)
 */

import { buildPhilPreview, isVisibleToField, moduleEnabled } from "@/domains/jobs/builder";
import { countTagRegister } from "@/domains/tags/expiry";
import type { TagItem } from "@/domains/tags/schema";
import { effectiveTasks, visibleAreaGroups } from "@/domains/jobs/format";
import { readTaskState, type JobTaskState } from "@/domains/jobs/taskState";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";
import type { PhilJobCommandInput } from "./job-command-model";

/**
 * Everything the Phil job page already has in hand when it renders. Lists
 * mirror the page's server-side loads; each is optional so a partial render
 * still produces a valid input.
 */
export interface PhilJobDataForCommand {
  job: Job;
  /** Global feature-flag state (#915, lean reset). The per-job module toggle
   *  below can't see a globally hidden feature, so with `snags`/`itps` false
   *  the input derives `not_configured` — no action, no dead anchor. Omitted
   *  key = feature on (callers predating the lean reset are unchanged). */
  features?: {
    snags?: boolean;
    itps?: boolean;
  };
  /** GET /api/snags?jobId — every snag on the job the worker can see. */
  snags?: SnagItem[];
  /** GET /api/job-itps?jobId — attached ITP instances. */
  itps?: ITPInstance[];
  /** Per-job test & tag entries (jobs/<id>/tags.json), when the page loaded them. */
  tags?: TagItem[];
  /** GET /api/plans?jobId — plan/spec documents. */
  documents?: Document[];
  /**
   * Optional real task state from GET /api/data → parseJobTaskState (#94). When
   * present, the bridge can safely produce tracked task progress. When omitted,
   * tasks remain `list_only` so no completion count is invented.
   */
  taskState?: JobTaskState;
  /**
   * Set a flag when a list fetch FAILED (as opposed to returning empty), so
   * the signal becomes `unknown` instead of a misleading 0. The page already
   * distinguishes this for documents (its loader returns `{ documents, error }`);
   * snags/ITPs fall back to `[]` silently today, so pass these only if the
   * caller learns of a failure.
   */
  loadErrors?: {
    snags?: boolean;
    itps?: boolean;
    documents?: boolean;
    tags?: boolean;
  };
  /**
   * This worker's latest induction record on this job (#332), when the page
   * loaded it. Omitted/null = no record (or unknown) → the induction
   * attention stays, which is the safe direction for a compliance nudge.
   */
  myInduction?: { completedAt: string } | null;
  /**
   * Count of the worker's own REJECTED hour entries allocated to this job.
   * Omitted on `main` — the job page doesn't fetch time entries, so per-job
   * rejected hours is genuinely not knowable here and resolves to `unknown`.
   * When a caller can compute it (filter the worker's rejected entries by
   * `allocations[].jobId`, see src/domains/timesheets/resubmit.ts), pass it and
   * the model lights up `fix_rejected_hours` with NO change to the decision layer.
   */
  rejectedHoursForJob?: number;
}

/** Open snags = the active states (matches `statsSnagsV2Active`). */
const OPEN_SNAG_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "resolved",
]);

/** Checks the WORKER still has to record: pending / in-progress. `witnessed`
 *  (awaiting sign-off) and `signed-off` are not the worker's action. */
const WORKER_ITP_STATUSES: ReadonlySet<string> = new Set(["pending", "in-progress"]);
const JOB_STAGES: readonly JobStage[] = ["roughIn", "fitOff"];

function countOpenSnags(snags: ReadonlyArray<SnagItem>): number {
  return snags.filter((s) => OPEN_SNAG_STATUSES.has(s.status)).length;
}

function countOutstandingItps(itps: ReadonlyArray<ITPInstance>): number {
  return itps.filter((i) => !i.archived && WORKER_ITP_STATUSES.has(i.status)).length;
}

function countCurrentDocuments(documents: ReadonlyArray<Document>): number {
  // Missing status defaults to "current" server-side; only "current" is shown.
  return documents.filter((d) => (d.status ?? "current") === "current").length;
}

/** How many tasks the field worker would see — derived from the same preview
 *  the live surface uses, so it never diverges. Used only when no real task
 *  state is supplied, so the model can offer "View your tasks" without claiming
 *  completion progress. */
function countVisibleTasks(job: Job): number {
  const preview = buildPhilPreview(job);
  const areaTasks = preview.areas.reduce(
    (n, a) => n + a.roughInTasks.length + a.fitOffTasks.length,
    0,
  );
  if (areaTasks > 0) return areaTasks;
  return preview.stages.reduce((n, s) => n + s.jobLevelTaskCount, 0);
}

function countTrackedAreaTasks(
  job: Job,
  taskState: JobTaskState,
): PhilJobCommandInput["tasks"] | null {
  let visible = 0;
  let incomplete = 0;
  for (const group of visibleAreaGroups(job.areaGroups)) {
    for (const area of group.areas ?? []) {
      for (const stage of JOB_STAGES) {
        const tasks = effectiveTasks(job, area, stage);
        visible += tasks.length;
        for (const task of tasks) {
          if (readTaskState(taskState, area.id, stage, task.id) !== "complete") {
            incomplete += 1;
          }
        }
      }
    }
  }
  return visible > 0 ? { kind: "tracked", visible, incomplete } : null;
}

/**
 * Build the command-model input from a successfully loaded job + its lists.
 * Pure (no fetch, no React) so it can be unit-tested with fixtures.
 */
/** Entries needing a retest: expired + due within the 14-day window (#305 semantics). */
function countTagsNeedingRetest(tags: TagItem[]): number {
  const counts = countTagRegister(tags);
  return counts.expired + counts.expiring;
}

export function philJobCommandInputFromJobData(
  data: PhilJobDataForCommand,
): PhilJobCommandInput {
  const { job } = data;
  const errors = data.loadErrors ?? {};

  const capture: PhilJobCommandInput["capture"] = moduleEnabled(job, "photos")
    ? { kind: "available" }
    : { kind: "unavailable", reason: "Photo capture is turned off for this job." };

  const plans: PhilJobCommandInput["plans"] = !moduleEnabled(job, "plans")
    ? { kind: "not_configured" }
    : errors.documents
      ? { kind: "unknown" }
      : { kind: "count", value: countCurrentDocuments(data.documents ?? []) };

  const snags: PhilJobCommandInput["snags"] = data.features?.snags === false || !moduleEnabled(job, "snags")
    ? { kind: "not_configured" }
    : errors.snags
      ? { kind: "unknown" }
      : { kind: "count", value: countOpenSnags(data.snags ?? []) };

  const itps: PhilJobCommandInput["itps"] = data.features?.itps === false || !moduleEnabled(job, "itps")
    ? { kind: "not_configured" }
    : errors.itps
      ? { kind: "unknown" }
      : { kind: "count", value: countOutstandingItps(data.itps ?? []) };

  const tags: PhilJobCommandInput["tags"] = !moduleEnabled(job, "tags")
    ? { kind: "not_configured" }
    : errors.tags
      ? { kind: "unknown" }
      : { kind: "count", value: countTagsNeedingRetest(data.tags ?? []) };

  const rejectedHours: PhilJobCommandInput["rejectedHours"] =
    typeof data.rejectedHoursForJob === "number"
      ? { kind: "count", value: Math.max(0, Math.trunc(data.rejectedHoursForJob)) }
      : { kind: "unknown" };

  return {
    job: {
      kind: "ok",
      id: job.id,
      name: job.name,
      visibleToField: isVisibleToField(job),
      onHold: (job.status ?? "active") === "on_hold",
      inductionRequired: Boolean(job.inductionRequired),
      inductionDone: Boolean(data.myInduction),
    },
    capture,
    plans,
    snags,
    itps,
    tags,
    tasks: data.taskState
      ? countTrackedAreaTasks(job, data.taskState) ?? { kind: "list_only", visible: countVisibleTasks(job) }
      : { kind: "list_only", visible: countVisibleTasks(job) },
    rejectedHours,
    // Hours are logged on the Day tab, not per job — a real capability that
    // lives on another surface.
    hours: { kind: "elsewhere", href: "/phil/my-day" },
    // No in-app material request flow yet — honestly a limitation, not an action.
    materials: { kind: "unavailable", reason: "Call your PM to request materials." },
  };
}

/**
 * Input for the failure paths the page already handles before rendering
 * (job not found / not assigned / load error). Keeps job context (the id) and
 * marks every signal `unknown` — the model returns the `error` state and the
 * signals are not consulted, but a complete input keeps callers uniform.
 */
export function philJobCommandLoadFailureInput(opts: {
  kind: "not_found" | "error";
  jobId?: string;
  message?: string;
}): PhilJobCommandInput {
  return {
    job:
      opts.kind === "not_found"
        ? { kind: "not_found", id: opts.jobId }
        : { kind: "error", id: opts.jobId, message: opts.message },
    capture: { kind: "unknown" },
    plans: { kind: "unknown" },
    snags: { kind: "unknown" },
    itps: { kind: "unknown" },
    tags: { kind: "unknown" },
    tasks: { kind: "unknown" },
    rejectedHours: { kind: "unknown" },
    hours: { kind: "unknown" },
    materials: { kind: "unknown" },
  };
}
