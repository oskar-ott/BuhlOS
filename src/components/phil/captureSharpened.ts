import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { CaptureBatchPhotoResult } from "@/domains/evidence/capture-batch";
import type { TrayPhoto } from "./CapturePhotoTray";

/**
 * Pure helpers for the SHARPENED Capture sheet (§2.5 of the Phil redesign,
 * dark behind `phil_sharpened`). Kept out of the component so the purpose→
 * real-concept mapping and the tray↔batch contract are unit-testable without
 * rendering.
 *
 * THE MAPPING (P7 — every chip is backed by a real, office-visible concept;
 * chips with no real backing are omitted, never faked):
 *
 *   Progress      → the default evidence photo path (kind=photo, note as
 *                   typed) — exactly what the office's photo gallery reads.
 *   Covered work  → the same evidence path with an office-visible
 *                   "Covered work" tag prepended to the note (the note IS
 *                   the caption every evidence surface shows).
 *
 *   OMITTED — "ITP / test": a test result is a structured TestRecord minted
 *   on the Checks surface (kind=test_result requires a testRecordId); a bare
 *   photo can't honestly become one. OMITTED — "Highlight": no backing
 *   concept the office can see (as-built is a different, handover-scoped
 *   designation with its own flag flow). No dead selections.
 */

export type CapturePurposeKey = "progress" | "covered";

export interface CapturePurpose {
  key: CapturePurposeKey;
  label: string;
  /** One short line under the selected chip — site voice. */
  hint: string;
}

export const CAPTURE_PURPOSES: ReadonlyArray<CapturePurpose> = [
  { key: "progress", label: "Progress", hint: "A photo on the job record" },
  {
    key: "covered",
    label: "Covered work",
    hint: "Proof before it's sheeted or closed in",
  },
];

export function purposeByKey(key: CapturePurposeKey): CapturePurpose {
  return CAPTURE_PURPOSES.find((p) => p.key === key) ?? CAPTURE_PURPOSES[0]!;
}

/* ── Partial-batch honesty — the tray ↔ batch contract ─────────────────────
 *
 * A save attempt and its retry share ONE rule set (mirrors the proven
 * non-sharpened launcher: `partial` state + `retryFailed`):
 *   - what saved LEAVES the tray and keeps its evidence id — a retry never
 *     re-uploads it (no duplicate evidence);
 *   - what failed STAYS, marked with its honest per-photo message, and is
 *     part of the NEXT attempt's batch — never silently dropped (P8).
 */

/**
 * The photos a save attempt actually sends: ready photos AND failed photos
 * whose bytes are still good (an upload/create failure keeps the dataUrl —
 * the retry re-sends exactly those). A failed photo is NEVER silently
 * excluded from a batch: it goes up with the attempt or the attempt honestly
 * fails. Photos still resizing are the caller's gate (`resizing` blocks
 * save); resize failures have no dataUrl and can never send — see
 * unreadableTrayPhotos.
 */
export function sendableTrayBatch(
  photos: ReadonlyArray<TrayPhoto>,
): { id: string; dataUrl: string }[] {
  return photos
    .filter((p) => (p.status === "ready" || p.status === "failed") && p.dataUrl)
    .map((p) => ({ id: p.id, dataUrl: p.dataUrl! }));
}

/**
 * Photos that can NEVER send — the resize failed, so there are no bytes to
 * upload. A photo save simply has nothing to send for it, same as the
 * non-sharpened launcher; its tile says why.
 */
export function unreadableTrayPhotos(
  photos: ReadonlyArray<TrayPhoto>,
): TrayPhoto[] {
  return photos.filter((p) => p.status === "failed" && !p.dataUrl);
}

/**
 * Reconcile the tray after a batch attempt: saved photos LEAVE (the caller
 * keeps their evidence ids — a retry never re-uploads them), failed photos
 * STAY with their honest per-photo message, and photos outside the attempt
 * (still resizing, unreadable) are untouched.
 */
export function applyBatchResultToTray(
  photos: ReadonlyArray<TrayPhoto>,
  results: ReadonlyArray<CaptureBatchPhotoResult>,
): TrayPhoto[] {
  const savedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
  const failedById = new Map<string, string>();
  for (const r of results) {
    if (!r.ok) failedById.set(r.id, r.message);
  }
  return photos
    .filter((p) => !savedIds.has(p.id))
    .map((p) =>
      failedById.has(p.id)
        ? { ...p, status: "failed" as const, error: failedById.get(p.id) }
        : p,
    );
}

/**
 * The honest split after a partial batch failure (P7): what's up is claimed
 * — `savedTotal` counts EVERY evidence row created so far in this save
 * chain, across retries — and what isn't is still here.
 */
export function partialBatchFailureMessage(
  savedTotal: number,
  failedCount: number,
): string {
  if (savedTotal === 0) {
    return failedCount === 1
      ? "That photo didn't send — it's still here. Nothing was sent."
      : `${failedCount} photos didn't send — they're still here. Nothing was sent.`;
  }
  const savedPart = savedTotal === 1 ? "1 saved" : `${savedTotal} saved`;
  const failedPart =
    failedCount === 1
      ? "1 didn't send — it's still here"
      : `${failedCount} didn't send — they're still here`;
  return `${savedPart} · ${failedPart}. Retry sends only the ones that failed.`;
}

/**
 * The lifted composition belongs to a job. The launcher deliberately keeps
 * purpose / note / selected job across close (P8 — an accidental backdrop
 * tap loses nothing). But OPENING with a DIFFERENT explicit job context (the
 * FAB on another job's home) must not reopen a composed Job-A note while the
 * worker stands on Job B — a wrong-job submission waiting to happen. Reset
 * only when the incoming context is a REAL job different from the one the
 * composition was written against; a no-context open (the My Day FAB) and a
 * same-job reopen keep everything.
 */
export function shouldResetCompositionOnOpen(
  initialJobId: string | null | undefined,
  compositionJobId: string | null,
  jobs: ReadonlyArray<{ id: string }>,
): boolean {
  if (!initialJobId || !compositionJobId) return false;
  if (initialJobId === compositionJobId) return false;
  return jobs.some((j) => j.id === initialJobId);
}

/** Office-visible tag on the evidence note for the Covered-work purpose. */
export const COVERED_WORK_TAG = "Covered work";

/**
 * The evidence note actually saved for a purpose. Progress passes the note
 * through; Covered work prepends the office-visible tag (the note is the
 * caption every evidence surface renders). Always ≤ EVIDENCE_NOTE_MAX so the
 * server never rejects a batch over a tag we added.
 */
export function noteForPurpose(purpose: CapturePurposeKey, note: string): string {
  const trimmed = note.trim();
  if (purpose === "covered") {
    const tagged = trimmed ? `${COVERED_WORK_TAG} — ${trimmed}` : COVERED_WORK_TAG;
    return tagged.slice(0, EVIDENCE_NOTE_MAX);
  }
  return trimmed.slice(0, EVIDENCE_NOTE_MAX);
}
