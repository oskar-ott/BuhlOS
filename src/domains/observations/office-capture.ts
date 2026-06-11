import type { HttpResult } from "@/lib/http";
import type {
  CreateOfficeObservationPayload,
  ObservationItem,
  ObservationMutationResponse,
  OfficePhotoUploadResponse,
} from "./types";

/**
 * "Send to office" submit loop — the no-job sibling of
 * src/domains/evidence/capture-batch.ts.
 *
 * An office capture is ONE observation carrying N photos (photoUrls), unlike
 * a job batch where each photo becomes its own evidence row. So the shape is:
 * upload every photo first (sequentially), and only when ALL binaries are up
 * create the single observation referencing them.
 *
 * Honesty rules:
 *   - A partial upload NEVER creates the observation — silently dropping a
 *     failed photo would send the office an incomplete record. The caller
 *     keeps the failed ids for retry.
 *   - Already-uploaded photos (uploadedUrl from a previous attempt) are
 *     reused, not re-uploaded — retry only re-runs what actually failed.
 *   - A created observation is only reported with the server's canonical row.
 */

export interface OfficeCapturePhoto {
  id: string;
  dataUrl: string;
  /** Blob URL from a previous attempt — skip re-uploading this photo. */
  uploadedUrl?: string | null;
}

export interface OfficeCaptureDeps {
  uploadPhoto(dataUrl: string): Promise<HttpResult<OfficePhotoUploadResponse>>;
  create(
    payload: CreateOfficeObservationPayload,
  ): Promise<HttpResult<ObservationMutationResponse>>;
}

export type OfficeCaptureResult =
  | { ok: true; observation: ObservationItem; uploadedById: Record<string, string> }
  | {
      ok: false;
      phase: "upload";
      failedIds: string[];
      /** Successfully uploaded URLs by photo id — carry into the retry. */
      uploadedById: Record<string, string>;
      message: string;
    }
  | {
      ok: false;
      phase: "create";
      uploadedById: Record<string, string>;
      message: string;
    };

export type OfficeCaptureProgress =
  | { step: "uploading"; current: number; total: number }
  | { step: "sending" };

/**
 * Upload all photos (sequentially, reusing prior uploads), then create the
 * single office observation with every photo URL in tray order. Never throws.
 */
export async function submitOfficeCapture(
  photos: ReadonlyArray<OfficeCapturePhoto>,
  payload: Omit<CreateOfficeObservationPayload, "photoUrls">,
  deps: OfficeCaptureDeps,
  onProgress?: (progress: OfficeCaptureProgress) => void,
): Promise<OfficeCaptureResult> {
  const uploadedById: Record<string, string> = {};
  const failedIds: string[] = [];
  let firstFailure: string | null = null;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]!;
    if (photo.uploadedUrl) {
      uploadedById[photo.id] = photo.uploadedUrl;
      continue;
    }
    onProgress?.({ step: "uploading", current: i + 1, total: photos.length });
    try {
      const r = await deps.uploadPhoto(photo.dataUrl);
      if (r.ok) {
        uploadedById[photo.id] = r.data.url;
      } else {
        failedIds.push(photo.id);
        firstFailure ??= `Couldn't upload a photo (${r.error.status || "network"}).`;
      }
    } catch (e) {
      failedIds.push(photo.id);
      firstFailure ??= e instanceof Error ? e.message : "Couldn't upload a photo.";
    }
  }

  if (failedIds.length > 0) {
    return {
      ok: false,
      phase: "upload",
      failedIds,
      uploadedById,
      message: firstFailure ?? "Couldn't upload the photos.",
    };
  }

  onProgress?.({ step: "sending" });
  const photoUrls = photos.map((p) => uploadedById[p.id]!).filter(Boolean);
  try {
    const created = await deps.create({ ...payload, photoUrls });
    if (!created.ok) {
      return {
        ok: false,
        phase: "create",
        uploadedById,
        message: `Photos uploaded but the item didn't send (${created.error.status || "network"}).`,
      };
    }
    return { ok: true, observation: created.data.observation, uploadedById };
  } catch (e) {
    return {
      ok: false,
      phase: "create",
      uploadedById,
      message: e instanceof Error ? e.message : "Photos uploaded but the item didn't send.",
    };
  }
}
