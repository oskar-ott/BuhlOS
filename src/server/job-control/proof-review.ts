import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ID_PREFIXES } from "@/domains/job-control/schema";
import { isRequiredEvidenceMet } from "@/domains/job-control/task-context";
import type { ProofReview } from "@/domains/job-control/types";
import {
  PersistedJobControlSchema,
  computeJobControlRevision,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * Proof-review writer — the office review lifecycle for a work package's required
 * proof, written into `jobs/<jobId>/job-control.json`'s `proofReviews`:
 *
 *   ready (all required proof met)  →[submit]→  submitted
 *   submitted                       →[approve]→ approved
 *   submitted                       →[reject]→  rejected (+ reason)
 *   rejected                        →[submit]→  submitted (resubmit)
 *
 * Mirrors the L4 evidence-link writer (#468): pure core (`applyProofReview`) +
 * injectable I/O deps (`ProofReviewDeps`), the SAME shared revision precondition
 * guard on the artifact, and the SAME "validate against the compiled artifact,
 * never invent a record" discipline.
 *
 * Hard rules:
 *   - Touches ONLY `proofReviews` (+ `updatedAt`/`revision`). Work packages,
 *     evidence links, claim/closeout arrays and compile meta are preserved.
 *   - SUBMIT is server-verified: the work package must exist, carry ≥1 required
 *     evidence item, and have EVERY item met (the SAME `isRequiredEvidenceMet`
 *     rule Phil + the admin status board use). The client gate is never trusted.
 *   - Submit never approves; approve/reject is a separate action on a `submitted`
 *     record. Nothing here mutates captured proof, ITP sign-off, or task state.
 *   - Keyed by `workPackageId` (proof is package/area-granular today, #494). One
 *     current review per package (upsert).
 *   - Revision-guarded: `writeProofReview` REQUIRES `expectedRevision` and rejects
 *     `409 stale_revision` when the artifact moved since the caller read it
 *     (application-level read→compare→write, NOT atomic CAS — same caveat as the
 *     evidence-link writer; see docs/architecture/job-control-revision-guard.md).
 */

export const PROOF_REVIEW_ACTIONS = ["submit", "approve", "reject"] as const;
export const ProofReviewActionSchema = z.enum(PROOF_REVIEW_ACTIONS);
export type ProofReviewAction = z.infer<typeof ProofReviewActionSchema>;

export const ProofReviewRequestSchema = z.object({
  action: ProofReviewActionSchema,
  workPackageId: z.string().min(1),
  /** Only meaningful on `reject` — a short worker-readable reason. */
  reason: z.string().trim().max(500).nullable().optional(),
});
export type ProofReviewRequest = z.infer<typeof ProofReviewRequestSchema>;

// ── Pure apply ───────────────────────────────────────────────────────────────

export type ProofReviewApplyReason =
  | "invalid_work_package"
  | "no_required_proof"
  | "incomplete"
  | "already_submitted"
  | "already_approved"
  | "no_review"
  | "not_submitted";

export type ProofReviewApplyResult =
  | { ok: true; artifact: PersistedJobControl; review: ProofReview }
  | { ok: false; reason: ProofReviewApplyReason };

function indexOfReview(artifact: PersistedJobControl, workPackageId: string): number {
  return (artifact.proofReviews ?? []).findIndex((r) => r.workPackageId === workPackageId);
}

/** All required-evidence items on the package are met (and there is ≥1). The SAME
 *  predicate Phil + the admin board use, so submit-eligibility never drifts. */
function allRequiredProofMet(artifact: PersistedJobControl, workPackageId: string): boolean {
  const wp = artifact.workPackages.find((w) => w.id === workPackageId);
  const reqs = wp?.requiredEvidence ?? [];
  if (reqs.length === 0) return false;
  return reqs.every((e) => isRequiredEvidenceMet(artifact.evidenceLinks, workPackageId, e.id));
}

function withReviews(artifact: PersistedJobControl, reviews: ProofReview[], at: string): PersistedJobControl {
  const base: PersistedJobControl = { ...artifact, proofReviews: reviews, updatedAt: at };
  return { ...base, revision: computeJobControlRevision(base) };
}

/**
 * Validate the action against the compiled artifact and return the artifact with
 * the review upserted. PURE — no I/O, no mutation of the input.
 */
export function applyProofReview(
  artifact: PersistedJobControl,
  request: ProofReviewRequest,
  ctx: { id: string; at: string; actor?: string | null },
): ProofReviewApplyResult {
  const wp = artifact.workPackages.find((w) => w.id === request.workPackageId);
  if (!wp) return { ok: false, reason: "invalid_work_package" };

  const reviews = [...(artifact.proofReviews ?? [])];
  const idx = indexOfReview(artifact, request.workPackageId);
  const current = idx >= 0 ? reviews[idx]! : null;

  if (request.action === "submit") {
    const reqs = wp.requiredEvidence ?? [];
    if (reqs.length === 0) return { ok: false, reason: "no_required_proof" };
    if (!allRequiredProofMet(artifact, request.workPackageId)) return { ok: false, reason: "incomplete" };
    if (current?.status === "submitted") return { ok: false, reason: "already_submitted" };
    if (current?.status === "approved") return { ok: false, reason: "already_approved" };
    // New submission cycle: fresh id, clears any prior rejection reason/review stamps.
    const review: ProofReview = {
      id: ctx.id,
      jobId: artifact.jobId,
      workPackageId: request.workPackageId,
      status: "submitted",
      reason: null,
      submittedAt: ctx.at,
      submittedBy: ctx.actor ?? null,
      reviewedAt: null,
      reviewedBy: null,
    };
    if (idx >= 0) reviews[idx] = review;
    else reviews.push(review);
    return { ok: true, artifact: withReviews(artifact, reviews, ctx.at), review };
  }

  // approve / reject — operate on an existing submitted record only.
  if (!current) return { ok: false, reason: "no_review" };
  if (current.status !== "submitted") return { ok: false, reason: "not_submitted" };
  const review: ProofReview = {
    ...current,
    status: request.action === "approve" ? "approved" : "rejected",
    reason: request.action === "reject" ? request.reason?.trim() || null : null,
    reviewedAt: ctx.at,
    reviewedBy: ctx.actor ?? null,
  };
  reviews[idx] = review;
  return { ok: true, artifact: withReviews(artifact, reviews, ctx.at), review };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

export interface ProofReviewDeps {
  loadRaw(jobId: string): Promise<unknown | null>;
  save(jobId: string, artifact: PersistedJobControl): Promise<void>;
  mintId(): string;
}

export type WriteProofReviewResult =
  | { ok: true; status: 200; review: ProofReview; revision: string }
  | {
      ok: false;
      status: 404 | 409;
      reason: "missing" | "unreadable" | "stale_revision" | ProofReviewApplyReason;
      warning: string;
      currentRevision?: string;
    };

const WARNINGS: Record<"missing" | "unreadable" | "stale_revision" | ProofReviewApplyReason, string> = {
  missing: "No compiled job-control artifact for this job — nothing to review.",
  unreadable: "The compiled job-control artifact is unreadable — no review written (artifact left untouched).",
  stale_revision: "The job-control artifact changed since it was read — re-read and retry.",
  invalid_work_package: "That work package is not in the compiled job-control artifact — no review written.",
  no_required_proof: "This work package has no required proof to review.",
  incomplete: "Required proof is still outstanding — capture it before submitting for review.",
  already_submitted: "This work package is already submitted for review.",
  already_approved: "This work package's proof is already approved.",
  no_review: "There is no submitted review for this work package.",
  not_submitted: "Only a submitted review can be approved or rejected.",
};

/** Write flow: load → revision guard → validate+apply → persist. A missing or
 *  unreadable artifact is failed-soft with a structured warning and NO write. */
export async function writeProofReview(
  deps: ProofReviewDeps,
  input: {
    jobId: string;
    request: ProofReviewRequest;
    expectedRevision: string;
    at: string;
    actor?: string | null;
  },
): Promise<WriteProofReviewResult> {
  const raw = await deps.loadRaw(input.jobId);
  if (raw == null) return { ok: false, status: 404, reason: "missing", warning: WARNINGS.missing };

  const parsed = PersistedJobControlSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 409, reason: "unreadable", warning: WARNINGS.unreadable };
  }

  const currentRevision = jobControlRevisionOf(parsed.data);
  if (input.expectedRevision !== currentRevision) {
    return { ok: false, status: 409, reason: "stale_revision", warning: WARNINGS.stale_revision, currentRevision };
  }

  const applied = applyProofReview(parsed.data, input.request, {
    id: deps.mintId(),
    at: input.at,
    actor: input.actor,
  });
  if (!applied.ok) {
    return { ok: false, status: 409, reason: applied.reason, warning: WARNINGS[applied.reason] };
  }

  await deps.save(input.jobId, applied.artifact);
  return { ok: true, status: 200, review: applied.review, revision: jobControlRevisionOf(applied.artifact) };
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

export function blobProofReviewDeps(): ProofReviewDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(jobControlKey(jobId), null),
    save: (jobId, artifact) => writeJsonBlob(jobControlKey(jobId), artifact),
    mintId: () => `${ID_PREFIXES.proofReview}${randomUUID()}`,
  };
}
