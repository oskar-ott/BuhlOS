import type { HttpResult } from "@/lib/http";
import type {
  CreateEvidencePayload,
  EvidenceCreateResponse,
  EvidenceItem,
  EvidencePhotoUploadResponse,
  EvidenceStage,
} from "./types";

/**
 * Multi-photo capture batch — the submit loop behind the camera-first global
 * Capture flow (PhilCaptureLauncher v2).
 *
 * A batch is N photos captured in one session, all going to the SAME job with
 * the same optional note / stage / area / task context. Each photo becomes its
 * own evidence row via the existing, proven two-step path (upload binary →
 * create metadata row) — no new persistence shape, just a loop over it.
 *
 * Honesty rules (same spirit as phil-capture.ts):
 *   - Photos are submitted SEQUENTIALLY, never in parallel. createEvidence
 *     appends to jobs/<id>/data.json with a read-modify-write, so parallel
 *     creates could race and silently lose rows.
 *   - A photo only counts as saved when createEvidence returned ok. An
 *     uploaded binary whose metadata row failed reports `failedAt: "create"`
 *     — never claimed as saved.
 *   - Partial failure is a first-class outcome: the caller gets per-photo
 *     results so failed photos can stay in the tray for retry while saved
 *     ones leave it.
 *
 * Dependencies are injected so the loop is unit-testable without fetch.
 */

export interface CaptureBatchPhoto {
  /** Caller-local id (tray id) — results are keyed back to it. */
  id: string;
  /** Resized data-url (resizeImageToDataUrl output), ready to upload. */
  dataUrl: string;
}

export interface CaptureBatchContext {
  jobId: string;
  note?: string | null;
  stage?: EvidenceStage | null;
  areaId?: string | null;
  taskId?: string | null;
  /** ISO timestamp captured by the caller at submit time. */
  clientCapturedAt: string;
}

export interface CaptureBatchDeps {
  uploadPhoto(
    jobId: string,
    dataUrl: string,
  ): Promise<HttpResult<EvidencePhotoUploadResponse>>;
  createEvidence(
    jobId: string,
    payload: CreateEvidencePayload,
  ): Promise<HttpResult<EvidenceCreateResponse>>;
}

export type CaptureBatchPhotoResult =
  | { id: string; ok: true; evidence: EvidenceItem }
  | { id: string; ok: false; failedAt: "upload" | "create"; message: string };

export interface CaptureBatchResult {
  results: CaptureBatchPhotoResult[];
  savedCount: number;
  /** Tray ids that did NOT save — the caller keeps these for retry. */
  failedIds: string[];
  allSaved: boolean;
}

/** Worker-facing progress: "Saving photo 2 of 5…". */
export type CaptureBatchProgress = { current: number; total: number };

function failureMessage(
  step: "upload" | "create",
  status: number | undefined,
): string {
  const suffix = status ? `(${status})` : "(network)";
  return step === "upload"
    ? `Couldn't upload the photo ${suffix}.`
    : `Photo uploaded but didn't save ${suffix}.`;
}

/**
 * Submit every photo in the batch to the job, sequentially. Never throws —
 * per-photo errors land in that photo's result and the loop continues, so one
 * bad photo doesn't take down the rest of the batch.
 */
export async function submitCaptureBatch(
  photos: ReadonlyArray<CaptureBatchPhoto>,
  context: CaptureBatchContext,
  deps: CaptureBatchDeps,
  onProgress?: (progress: CaptureBatchProgress) => void,
): Promise<CaptureBatchResult> {
  const results: CaptureBatchPhotoResult[] = [];
  const total = photos.length;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]!;
    onProgress?.({ current: i + 1, total });

    try {
      const uploaded = await deps.uploadPhoto(context.jobId, photo.dataUrl);
      if (!uploaded.ok) {
        results.push({
          id: photo.id,
          ok: false,
          failedAt: "upload",
          message: failureMessage("upload", uploaded.error.status),
        });
        continue;
      }

      const payload: CreateEvidencePayload = {
        kind: "photo",
        photoId: uploaded.data.id,
        photoUrl: uploaded.data.url,
        note: context.note?.trim() ? context.note.trim() : null,
        stage: context.stage ?? null,
        areaId: context.areaId ?? null,
        taskId: context.taskId ?? null,
        clientCapturedAt: context.clientCapturedAt,
      };
      const created = await deps.createEvidence(context.jobId, payload);
      if (!created.ok) {
        results.push({
          id: photo.id,
          ok: false,
          failedAt: "create",
          message: failureMessage("create", created.error.status),
        });
        continue;
      }

      results.push({ id: photo.id, ok: true, evidence: created.data.evidenceItem });
    } catch (e) {
      results.push({
        id: photo.id,
        ok: false,
        failedAt: "upload",
        message: e instanceof Error ? e.message : "Couldn't save this photo.",
      });
    }
  }

  const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
  return {
    results,
    savedCount: results.length - failedIds.length,
    failedIds,
    allSaved: failedIds.length === 0 && results.length === photos.length,
  };
}
