import type { JobContact } from "@/domains/contacts/schema";
import type { CreateObservationPayload } from "@/domains/observations/types";
import { OBSERVATION_DESCRIPTION_MAX } from "@/domains/observations/schema";
import type { JobStage } from "@/domains/jobs/types";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { CaptureBatchPhotoResult } from "@/domains/evidence/capture-batch";
import type { TrayPhoto } from "./CapturePhotoTray";

/**
 * Pure helpers for the SHARPENED Capture sheet (§2.5 of the Phil redesign,
 * dark behind `phil_sharpened`). Kept out of the component so the purpose→
 * real-concept mapping, the RFI subject derivation, the recipient list and
 * the blocked-scope rule are unit-testable without rendering.
 *
 * THE MAPPING (P7 — every chip is backed by a real, office-visible concept;
 * chips with no real backing are omitted, never faked):
 *
 *   Progress      → the default evidence photo path (kind=photo, note as
 *                   typed) — exactly what the office's photo gallery reads.
 *   Covered work  → the same evidence path with an office-visible
 *                   "Covered work" tag prepended to the note (the note IS
 *                   the caption every evidence surface shows).
 *   Snag          → the existing snag-raise write (POST /api/snags) with the
 *                   just-saved photos linked via evidenceIds — the
 *                   ReportSnagSheet model, inlined.
 *   RFI           → a REAL register RFI (POST /api/rfis raise, field-gated
 *                   behind phil_sharpened) + optional blocking observation.
 *
 *   OMITTED — "ITP / test": a test result is a structured TestRecord minted
 *   on the Checks surface (kind=test_result requires a testRecordId); a bare
 *   photo can't honestly become one. OMITTED — "Highlight": no backing
 *   concept the office can see (as-built is a different, handover-scoped
 *   designation with its own flag flow). No dead selections.
 */

export type CapturePurposeKey = "progress" | "covered" | "snag" | "rfi";

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
  { key: "snag", label: "Snag", hint: "Raise it on the job's snag list" },
  { key: "rfi", label: "RFI", hint: "A question the office has to answer" },
];

export function purposeByKey(key: CapturePurposeKey): CapturePurpose {
  return CAPTURE_PURPOSES.find((p) => p.key === key) ?? CAPTURE_PURPOSES[0]!;
}

/**
 * The purpose chips actually offered. The RFI chip requires the office RFI
 * register (`rfi_register`, resolved server-side with the phil flags): the
 * field raise 404s while it's off, so rendering the chip would be a dead
 * selection — every send fails inevitably (P7, "no dead selections"). The
 * other chips are unconditional.
 */
export function availableCapturePurposes(
  rfiRegisterOn: boolean,
): ReadonlyArray<CapturePurpose> {
  return rfiRegisterOn
    ? CAPTURE_PURPOSES
    : CAPTURE_PURPOSES.filter((p) => p.key !== "rfi");
}

/* ── Partial-batch honesty — the tray ↔ batch contract ─────────────────────
 *
 * A save attempt and its retry share ONE rule set (mirrors the proven
 * non-sharpened launcher: `partial` state + `retryFailed`):
 *   - what saved LEAVES the tray and keeps its evidence id — a retry never
 *     re-uploads it (no duplicate evidence);
 *   - what failed STAYS, marked with its honest per-photo message, and is
 *     part of the NEXT attempt's batch — never silently dropped (P8);
 *   - a snag/RFI raise happens only once every tray photo has saved or been
 *     explicitly removed by the worker (P7 — the raise must never carry
 *     fewer photos than the worker sees in the batch).
 */

/**
 * The photos a save attempt actually sends: ready photos AND failed photos
 * whose bytes are still good (an upload/create failure keeps the dataUrl —
 * the retry re-sends exactly those). A failed photo is NEVER silently
 * excluded from a batch: it goes up with the attempt or the attempt honestly
 * fails before anything downstream (the snag/RFI raise) happens. Photos
 * still resizing are the caller's gate (`resizing` blocks save); resize
 * failures have no dataUrl and can never send — see unreadableTrayPhotos.
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
 * upload. A snag/RFI raise is blocked while one sits in the tray (the worker
 * removes it — its tile says why — then raises); a plain photo save simply
 * has nothing to send for it, same as the non-sharpened launcher.
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
 * chain, across retries — and what isn't is still here. For snag/RFI it also
 * says the raise hasn't happened, so a worker never walks off believing a
 * snag/RFI went up on the strength of the photos alone.
 */
export function partialBatchFailureMessage(
  savedTotal: number,
  failedCount: number,
  purpose: CapturePurposeKey,
): string {
  const raiseSuffix =
    purpose === "snag"
      ? " The snag hasn't been raised yet."
      : purpose === "rfi"
        ? " The RFI hasn't been sent yet."
        : "";
  if (savedTotal === 0) {
    const base =
      failedCount === 1
        ? "That photo didn't send — it's still here. Nothing was sent."
        : `${failedCount} photos didn't send — they're still here. Nothing was sent.`;
    return `${base}${raiseSuffix}`;
  }
  const savedPart = savedTotal === 1 ? "1 saved" : `${savedTotal} saved`;
  const failedPart =
    failedCount === 1
      ? "1 didn't send — it's still here"
      : `${failedCount} didn't send — they're still here`;
  return `${savedPart} · ${failedPart}.${raiseSuffix} Retry sends only the ones that failed.`;
}

/**
 * The lifted composition belongs to a job. The launcher deliberately keeps
 * purpose / RFI question / snag title / selected job across close (P8 — an
 * accidental backdrop tap loses nothing). But OPENING with a DIFFERENT
 * explicit job context (the FAB on another job's home) must not reopen a
 * composed Job-A RFI while the worker stands on Job B — a wrong-job
 * submission waiting to happen. Reset only when the incoming context is a
 * REAL job different from the one the composition was written against;
 * a no-context open (the My Day FAB) and a same-job reopen keep everything.
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

/**
 * The truth of "blocked" on the RFI receipt. Once the blocking observation
 * EXISTS on the server (`observationId` set), the raise links it and the
 * receipt says blocked — regardless of the checkbox, which locks in the UI
 * (unticking can't delete an observation; the office clears blockers).
 * Before it exists, blocked is a plan: the ticked checkbox on a full task
 * coordinate.
 */
export function rfiBlockedOutcome(
  observationId: string | null,
  markBlocked: boolean,
  blockable: boolean,
): boolean {
  if (observationId) return true;
  return markBlocked && blockable;
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

/** Caption linking an RFI batch's photos to the question they illustrate. */
export function rfiPhotoNote(subject: string): string {
  return `RFI: ${subject}`.slice(0, EVIDENCE_NOTE_MAX);
}

/** api/rfis.js caps: subject ≤200; we keep it list-view short. */
export const RFI_SUBJECT_MAX = 120;
export const RFI_QUESTION_MAX = 4000;

/**
 * Derive the register's required `subject` from the worker's question — the
 * sheet asks ONE thing (the question, P10); the subject is its first line,
 * capped for list views. Empty question → empty subject (submit stays
 * disabled; never an invented subject).
 */
export function deriveRfiSubject(question: string): string {
  const firstLine = question.trim().split(/\r?\n/, 1)[0] ?? "";
  const clean = firstLine.trim();
  if (clean.length <= RFI_SUBJECT_MAX) return clean;
  return `${clean.slice(0, RFI_SUBJECT_MAX - 1).trimEnd()}…`;
}

/** One "Send it to" option. `askedOf` is what lands on the RFI's askedOf
 *  field (the office's send step emails it when it's an address). */
export interface RfiRecipient {
  key: string;
  label: string;
  detail: string | null;
  askedOf: string;
}

/** The office/PM route is always real — the RFI lands on the job's register
 *  either way; blank askedOf means the office picks the recipient. */
export const RFI_OFFICE_RECIPIENT: RfiRecipient = {
  key: "office",
  label: "Office / PM",
  detail: "The office routes it",
  askedOf: "",
};

/**
 * REAL recipients only: Office/PM always, then the job's categorised
 * `project` contacts (the same rows Phil's "Who to call" card shows —
 * suppliers and legacy uncategorised email-list rows are not people you ask
 * an RFI of). askedOf prefers the contact's email (the register's send step
 * emails askedOf); a phone-only contact still records who was asked by name.
 * No hardcoded names, ever.
 */
export function rfiRecipients(contacts: ReadonlyArray<JobContact>): RfiRecipient[] {
  const out: RfiRecipient[] = [RFI_OFFICE_RECIPIENT];
  for (const c of contacts) {
    if (c.category !== "project") continue;
    const name = c.name?.trim();
    if (!name) continue;
    const email = c.email?.trim() || null;
    out.push({
      key: `contact_${c.id}`,
      label: name,
      detail: c.role?.trim() || null,
      askedOf: email ?? name,
    });
  }
  return out;
}

/**
 * "Mark the affected work blocked" is only real for a FULL task coordinate:
 * the blocked state Phil renders derives from task-scoped observations only
 * (taskBlockersFromObservations needs areaId + stage + taskId). An area-only
 * capture context can't honestly promise "work here marked blocked", so the
 * checkbox is withheld — never fake blocking (P7).
 */
export function canMarkBlocked(
  stage: JobStage | null,
  areaId: string | null,
  taskId: string | null,
): boolean {
  return Boolean(stage && areaId && taskId);
}

/**
 * The blocking observation raised alongside an RFI when the worker ticks
 * "mark the affected work blocked". EXACTLY the shape
 * taskBlockersFromObservations derives a task blocker from: type `rfi`
 * (a blocking type), OPEN (server sets needs_action via requiresAction),
 * full task coordinate. linkedEvidenceId ties it to the first saved photo
 * when there is one — a real link the observation model supports.
 *
 * The description (the note the office reads on the blocker) ALWAYS carries
 * the question, "RFI: "-prefixed and capped at the observation model's limit
 * — a blocker must state its reason, and if the raise then fails this
 * observation is an ORPHAN whose only context is this note (P7: the office
 * must never see a blocker with no reason).
 */
export function buildBlockingObservationPayload(args: {
  subject: string;
  question: string;
  stage: JobStage;
  areaId: string;
  taskId: string;
  linkedEvidenceId?: string | null;
}): CreateObservationPayload {
  const question = args.question.trim();
  const note = `RFI: ${question || args.subject}`.slice(0, OBSERVATION_DESCRIPTION_MAX);
  return {
    type: "rfi",
    title: args.subject.slice(0, 140),
    requiresAction: true,
    stage: args.stage,
    areaId: args.areaId,
    taskId: args.taskId,
    description: note,
    ...(args.linkedEvidenceId ? { linkedEvidenceId: args.linkedEvidenceId } : {}),
  };
}
