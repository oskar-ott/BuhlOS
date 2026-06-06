import type { EvidenceStage } from "./types";

/**
 * Phil capture — the job-first client model.
 *
 * This is the shape a Phil on-site capture hands forward so it can later
 * surface inside the BuhlOS **Job** page (Overview evidence summary, the
 * per-job Evidence tab/panel at `/v2/jobs/[jobId]/evidence`, task/stage
 * indicators, and the Evidence detail drawer). Evidence is **job context**,
 * not a standalone admin module — so this model is keyed on `jobId` and never
 * fabricates an attachment when the job is unknown.
 *
 * It is deliberately shell-neutral (lives in the evidence domain, not under
 * `src/components/phil/`) so the future admin Job-Evidence surface can import
 * it without a cross-shell violation (`check:shell-contract`).
 *
 * Relationship to the persisted model (`./types` `EvidenceItem`):
 *   - The server is the source of truth. `api/evidence.js` persists an
 *     `EvidenceItem` to `jobs/<jobId>/data.json` and the admin surface reads
 *     it back. This `PhilCaptureEvidence` is the **client capture descriptor**
 *     — it represents the capture's lifecycle on-device (selected → uploading →
 *     uploaded/failed, or not_configured) which the persisted enum does not.
 *   - `source` here is the literal `"phil_capture"` (a Phil-origin capture);
 *     it maps to the persisted `EvidenceSource` value `"phil"`.
 *
 * HONESTY RULES (encoded as invariants, not just docs):
 *   - No job → no record. A missing/blank `jobId` returns `{ ok: false }` with
 *     a "No job selected" message; we never invent a job attachment.
 *   - `status: "uploaded"` is only reachable with a real `blobUrl` (enforced by
 *     the `PhilCaptureOutcome` union), so success can't be faked.
 *   - `status: "failed"` always carries an `errorMessage`.
 *   - `status: "not_configured"` is the honest state when upload plumbing isn't
 *     connected — it never carries a `blobUrl` or `evidenceId`.
 *   - `evidenceId` / `blobUrl` / `thumbnailUrl` are set only when truly present;
 *     blank optional fields are omitted rather than written as "".
 *
 * NOTE: the live `CaptureSheet` already does a real two-step Blob upload with
 * its own internal phase state; this helper is the canonical, tested contract
 * that the future Job-Evidence surface builds against (and that the sheet can
 * adopt when that surface lands). See docs/phil-capture.md.
 */

/** Worker-facing capture status. `selected` / `uploading` / `not_configured`
 *  are client-only; `uploaded` means a real upload returned a URL. */
export type PhilCaptureStatus =
  | "selected" // picked on-device, NOT yet uploaded (not saved)
  | "uploading" // upload in flight
  | "uploaded" // a real upload succeeded (blobUrl present)
  | "failed" // a real attempt failed (errorMessage present)
  | "not_configured"; // upload plumbing not connected in this build

/** Client discriminator for a Phil-origin capture. Maps to persisted
 *  `EvidenceSource` `"phil"`. */
export const PHIL_CAPTURE_SOURCE = "phil_capture" as const;

/** Shown when a capture is attempted with no job in context. */
export const NO_JOB_MESSAGE = "No job selected — pick a job before capturing.";

export type PhilCaptureEvidence = {
  /** Set only once the server has persisted the row (uploaded path). */
  evidenceId?: string;
  /** Required — evidence is job context; never blank. */
  jobId: string;
  jobName?: string;
  taskId?: string;
  taskName?: string;
  /** roughIn | fitOff — the canonical job stage (subtype of string). */
  stage?: EvidenceStage;
  workerId?: string;
  workerName?: string;
  createdAt: string;
  source: typeof PHIL_CAPTURE_SOURCE;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  status: PhilCaptureStatus;
  note?: string;
  blobUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
};

/** The job/task/stage/worker context Phil knows at capture time. */
export interface PhilCaptureContext {
  job: { id?: string | null; name?: string | null } | null | undefined;
  task?: { id?: string | null; name?: string | null } | null;
  stage?: EvidenceStage | null;
  /** Worker identity Phil can read client-side (id from the session viewer;
   *  name is usually filled server-side, so it's optional here). */
  worker?: { id?: string | null; name?: string | null } | null;
  note?: string | null;
  /** Caller-supplied ISO timestamp — passed in (not read from a global clock)
   *  so the builder stays pure and deterministically testable. */
  createdAt: string;
}

/** The safe subset of a browser `File` (or a test stub). */
export interface CaptureFileMeta {
  name?: string | null;
  type?: string | null;
  size?: number | null;
}

/**
 * Honest capture outcome. The union enforces the honesty rules at the type
 * level: `uploaded` REQUIRES a `blobUrl`, and `failed` REQUIRES an
 * `errorMessage` — the builder physically cannot claim a save without a URL.
 */
export type PhilCaptureOutcome =
  | { status: "selected"; file: CaptureFileMeta }
  | { status: "uploading"; file: CaptureFileMeta }
  | {
      status: "uploaded";
      file: CaptureFileMeta;
      blobUrl: string;
      evidenceId?: string;
      thumbnailUrl?: string;
    }
  | { status: "failed"; file?: CaptureFileMeta; errorMessage: string }
  | { status: "not_configured"; file?: CaptureFileMeta };

export type PhilCaptureBuild =
  | { ok: true; evidence: PhilCaptureEvidence }
  | { ok: false; reason: "no_job"; message: string };

/** Trim a maybe-string; return undefined when blank so we never write "". */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function fileOf(outcome: PhilCaptureOutcome): CaptureFileMeta | undefined {
  return "file" in outcome ? outcome.file ?? undefined : undefined;
}

/**
 * Build a job-first `PhilCaptureEvidence` from the capture context + an honest
 * outcome. Returns `{ ok: false, reason: "no_job" }` (never a fabricated
 * record) when there is no job in context.
 *
 * Only truthfully-known fields are populated. `blobUrl` / `evidenceId` /
 * `thumbnailUrl` appear only on the `uploaded` path; `errorMessage` only on
 * `failed`.
 */
export function buildPhilCaptureEvidence(
  context: PhilCaptureContext,
  outcome: PhilCaptureOutcome,
): PhilCaptureBuild {
  const jobId = clean(context.job?.id);
  if (!jobId) {
    // Evidence is job-keyed for the future Job-Evidence surface — an
    // unattached capture must not pretend to be a saved record.
    return { ok: false, reason: "no_job", message: NO_JOB_MESSAGE };
  }

  const file = fileOf(outcome);

  const evidence: PhilCaptureEvidence = {
    jobId,
    source: PHIL_CAPTURE_SOURCE,
    createdAt: context.createdAt,
    status: outcome.status,
  };

  const jobName = clean(context.job?.name);
  if (jobName) evidence.jobName = jobName;

  const taskId = clean(context.task?.id);
  if (taskId) evidence.taskId = taskId;
  const taskName = clean(context.task?.name);
  if (taskName) evidence.taskName = taskName;

  if (context.stage) evidence.stage = context.stage;

  const workerId = clean(context.worker?.id);
  if (workerId) evidence.workerId = workerId;
  const workerName = clean(context.worker?.name);
  if (workerName) evidence.workerName = workerName;

  const fileName = clean(file?.name);
  if (fileName) evidence.fileName = fileName;
  const contentType = clean(file?.type);
  if (contentType) evidence.contentType = contentType;
  if (typeof file?.size === "number" && Number.isFinite(file.size) && file.size >= 0) {
    evidence.sizeBytes = file.size;
  }

  const note = clean(context.note);
  if (note) evidence.note = note;

  if (outcome.status === "uploaded") {
    evidence.blobUrl = outcome.blobUrl;
    if (outcome.evidenceId) evidence.evidenceId = outcome.evidenceId;
    if (outcome.thumbnailUrl) evidence.thumbnailUrl = outcome.thumbnailUrl;
  } else if (outcome.status === "failed") {
    evidence.errorMessage = outcome.errorMessage;
  }

  return { ok: true, evidence };
}
