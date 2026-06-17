import type { Job } from "@/domains/jobs/types";
import {
  officeOptionByKey,
  requiresActionForOption,
  workerOptionByKey,
  type OfficeCaptureOption,
  type WorkerCaptureOption,
} from "@/domains/observations/service";
import type {
  CreateObservationPayload,
  CreateOfficeObservationPayload,
} from "@/domains/observations/types";

/**
 * Pure helpers for the global Capture launcher (the centre FAB in
 * PhilTabBar). Kept out of the component so the "which jobs, and what to
 * do with them" decision is unit-testable without rendering.
 *
 * Cross-ref:
 *   src/components/phil/PhilCaptureLauncher.tsx — the consumer
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §3 (capture flow)
 */

export interface LaunchableJob {
  id: string;
  name: string;
  siteAddress: string | null;
}

/**
 * Jobs the worker can capture against, in list order. Archived jobs are
 * dropped — the Phil jobs list hides them too, and a worker shouldn't be
 * pushed into capturing evidence against a job that's been closed out.
 */
export function launchableJobs(jobs: ReadonlyArray<Job>): LaunchableJob[] {
  return jobs
    .filter((j) => j.status !== "archived")
    .map((j) => ({
      id: j.id,
      name: j.name,
      siteAddress: j.siteAddress ?? null,
    }));
}

export type LauncherDecision =
  | { kind: "empty" }
  | { kind: "single"; job: LaunchableJob }
  | { kind: "choose"; jobs: LaunchableJob[] };

/**
 * What the launcher should do once the worker's jobs load:
 *   - none           → empty state ("ask your PM")
 *   - exactly one    → skip the picker, deep-link straight to capture
 *   - more than one  → show the picker
 *
 * Skipping the picker for the single-job case is the common tradie
 * reality (one site at a time) and saves a tap on a noisy site.
 */
export function launcherDecision(jobs: ReadonlyArray<Job>): LauncherDecision {
  const launchable = launchableJobs(jobs);
  if (launchable.length === 0) return { kind: "empty" };
  if (launchable.length === 1) return { kind: "single", job: launchable[0]! };
  return { kind: "choose", jobs: launchable };
}

/**
 * The job-page capture deep link (`?capture=<token>`). A fresh token each
 * call (defaults to now) so the detail page re-opens its capture sheet even
 * for a repeat launch. The v2 camera-first launcher no longer generates this
 * link (it submits the batch itself), but PhilJobDetail still honours it —
 * kept as the canonical builder for any other entry point.
 */
export function captureHref(jobId: string, token: number = Date.now()): string {
  return `/phil/jobs/${encodeURIComponent(jobId)}?capture=${token}`;
}

/**
 * Which job the camera-first capture should preselect as the destination:
 * the job home the FAB was tapped on (when it's actually launchable), else
 * the worker's only job, else none — a worker with multiple jobs makes an
 * explicit choice, never a guessed one.
 */
export function preselectCaptureJob(
  jobs: ReadonlyArray<LaunchableJob>,
  initialJobId: string | null | undefined,
): string | null {
  if (initialJobId && jobs.some((j) => j.id === initialJobId)) return initialJobId;
  if (jobs.length === 1) return jobs[0]!.id;
  return null;
}

/**
 * The job id when the worker is on a single job's detail page
 * (/phil/jobs/<id>), else null. The global Capture button uses this to
 * decide between a direct deep-link (we already know the job, so capture
 * is one tap) and the job picker (we don't, so ask which job). Sub-routes
 * like /phil/jobs/<id>/itps/<x> intentionally return null — those aren't
 * the job home, so we fall back to the picker.
 */
export function philJobDetailId(pathname: string): string | null {
  const m = /^\/phil\/jobs\/([^/]+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Extra fields for a structured variation flag (#369) — captured only when the
 * chosen option is the "Variation / change" one. All optional; blanks are
 * omitted, not sent empty.
 */
export interface VariationExtras {
  askedBy?: string;
  /** Rough labour hours — a guess, not a timesheet. */
  labourHours?: number | null;
  materialsNote?: string;
}

/**
 * Build the create-observation payload from a chosen worker capture option +
 * the worker's note. Kept pure (no fetch) so the classify-then-submit shape is
 * unit-testable. `requiresAction` is sent explicitly (computed from the option)
 * so the "Not sure — office review" override on a plain note still flags the
 * office; source is inferred server-side (phil for a field worker). Description
 * is omitted when blank rather than sent empty.
 *
 * For a `variation` option, the structured estimate fields ride along (#369);
 * they are ignored for any other type, so a stray `extras` never leaks onto an
 * unrelated capture.
 */
export function buildObservationPayload(
  option: WorkerCaptureOption,
  title: string,
  description: string,
  extras?: VariationExtras,
): CreateObservationPayload {
  const trimmedDescription = description.trim();
  const payload: CreateObservationPayload = {
    type: option.type,
    title: title.trim(),
    requiresAction: requiresActionForOption(option),
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
  };

  if (option.type === "variation" && extras) {
    const askedBy = extras.askedBy?.trim();
    if (askedBy) payload.variationAskedBy = askedBy;
    if (typeof extras.labourHours === "number" && Number.isFinite(extras.labourHours)) {
      payload.variationLabourHours = extras.labourHours;
    }
    const materialsNote = extras.materialsNote?.trim();
    if (materialsNote) payload.variationMaterialsNote = materialsNote;
  }

  return payload;
}

/**
 * Build the create payload for a "send to office" capture (no job). Office
 * items ALWAYS require office action — that's the point of sending one (it
 * replaces the text-to-the-boss channel). photoUrls are appended by the
 * submit loop (office-capture.ts) once the binaries are up.
 */
export function buildOfficeObservationPayload(
  option: OfficeCaptureOption,
  title: string,
  description: string,
): Omit<CreateOfficeObservationPayload, "photoUrls"> {
  const trimmedDescription = description.trim();
  return {
    type: option.type,
    title: title.trim(),
    requiresAction: true,
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
  };
}

/**
 * A My Day quick-action tile target: a single Capture option the worker can
 * launch straight into, instead of stepping through the camera-first flow.
 * `kind` says which Capture destination it belongs to (a job-scoped worker
 * option, or the no-job "send to office" set); `optionKey` is the option's key
 * in WORKER_CAPTURE_OPTIONS / OFFICE_CAPTURE_OPTIONS.
 */
export type CaptureQuickAction =
  | { kind: "worker"; optionKey: string }
  | { kind: "office"; optionKey: string };

/**
 * How the Capture launcher should open for a quick action:
 *   - office       → "send to office" mode with the option chosen
 *   - worker-note  → a single resolvable job, jump straight to its note step
 *   - worker-pick  → several jobs, open the picker carrying the option
 *   - none         → unknown key; open the launcher as a normal capture
 */
export type QuickCapturePreset =
  | { mode: "office"; option: OfficeCaptureOption }
  | { mode: "worker-note"; job: LaunchableJob; option: WorkerCaptureOption }
  | { mode: "worker-pick"; option: WorkerCaptureOption }
  | { mode: "none" };

/**
 * Map a quick-action tile to how the launcher should open. Pure (no fetch / no
 * render) so the office-vs-worker and single-vs-many-job branching is unit
 * tested without driving the launcher's state machine. An unrecognised key
 * falls back to a normal launcher open rather than a dead end.
 */
export function resolveQuickCapture(
  action: CaptureQuickAction,
  jobs: ReadonlyArray<LaunchableJob>,
  initialJobId: string | null,
): QuickCapturePreset {
  if (action.kind === "office") {
    const option = officeOptionByKey(action.optionKey);
    return option ? { mode: "office", option } : { mode: "none" };
  }
  const option = workerOptionByKey(action.optionKey);
  if (!option) return { mode: "none" };
  const jobId = preselectCaptureJob(jobs, initialJobId);
  const job = jobId ? (jobs.find((j) => j.id === jobId) ?? null) : null;
  return job ? { mode: "worker-note", job, option } : { mode: "worker-pick", option };
}
