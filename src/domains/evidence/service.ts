import type { ServerEvidenceStatus } from "./types";

/**
 * Pure helpers + state-machine logic for the evidence domain.
 *
 * Lives separately from `format.ts` (display) and `client.ts` (network)
 * so server-side code can import the state machine without dragging
 * fetch dependencies, and D3's capture sheet can import the image
 * resize helper without bundling Zod / format strings it doesn't need.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5.5 — state machine
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §A.2
 */

/* ---------------------------------------------------------------------
 * State machine
 * -------------------------------------------------------------------*/

/**
 * Server-side state transitions for an EvidenceItem.
 *
 *   null           → submitted   (create — fresh row written to storage)
 *   submitted      → reviewed    (admin marks reviewed in D4)
 *   submitted      → rejected    (admin rejects with reason in D4)
 *   reviewed       → submitted   (admin un-reviews — D4/D5 secondary)
 *
 * Everything else is rejected by the server. Client-only states
 * (uploading, pending_sync) live in the capture sheet and never reach
 * canTransition — those rows haven't been persisted yet.
 *
 * Mirrors doc 24 §5.5 and doc 28 §A.2 verbatim.
 */
export type EvidenceTransitionFrom = ServerEvidenceStatus | null;
export type EvidenceTransitionTo = ServerEvidenceStatus;

const ALLOWED_TRANSITIONS = new Set<string>([
  // create
  "null→submitted",
  // admin review (D4)
  "submitted→reviewed",
  "submitted→rejected",
  // admin un-review (D4/D5 secondary)
  "reviewed→submitted",
]);

export function canTransition(
  from: EvidenceTransitionFrom,
  to: EvidenceTransitionTo
): boolean {
  const key = `${from ?? "null"}→${to}`;
  return ALLOWED_TRANSITIONS.has(key);
}

/* ---------------------------------------------------------------------
 * Display helpers used by D3 capture sheet (extracted for D3 to import
 * verbatim — keeps the resize / size logic in one place).
 * -------------------------------------------------------------------*/

/**
 * Human-readable file size string. Mirrors the legacy snag-photo code
 * path's display so the capture sheet's "2.3 MB" matches the snag
 * picker's "2.3 MB" pixel-for-pixel.
 */
export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // 1 dp under 100, integer above — matches phone gallery convention.
  const formatted = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * Resize an image File to a JPEG dataURL with max-dimension + quality
 * controls. Used by the D3 capture sheet to keep photo upload payloads
 * comfortably under the 6 MB cap on slow site networks.
 *
 *   resizeImageToDataUrl(file, 1920, 0.7) -> "data:image/jpeg;base64,..."
 *
 * Browser-only — relies on createImageBitmap and OffscreenCanvas (with
 * a HTMLCanvasElement fallback). Throws if neither is available so the
 * caller can surface a clear error in the capture sheet UI.
 *
 * Defaults pinned to doc 28 §A.2 contract (maxDim=1920, quality=0.7)
 * so D3 doesn't drift accidentally.
 */
export async function resizeImageToDataUrl(
  file: Blob,
  maxDim = 1920,
  quality = 0.7
): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("resizeImageToDataUrl is browser-only");
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap not available in this browser");
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  // Prefer OffscreenCanvas (no DOM attach needed). Fall back to a real
  // canvas for browsers that haven't shipped it yet.
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality)
    );
  }
  if (!blob) throw new Error("image encode failed");

  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}
