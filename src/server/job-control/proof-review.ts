import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ID_PREFIXES, ProofReviewSchema, TaskRefSchema } from "@/domains/job-control/schema";
import type { ProofReview } from "@/domains/job-control/types";
import { taskRefKey } from "@/domains/job-control/spine";
import { buildPhilTaskContext, summarisePhilTaskProof } from "@/domains/job-control/task-context";
import {
  PersistedJobControlSchema,
  computeJobControlRevision,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * Task-instance proof review/approval writer (#503) — the submit → approve/reject
 * lifecycle for ONE task instance's required proof, on
 * `jobs/<jobId>/job-control.json`.
 *
 * Re-keyed to the TASK INSTANCE (the parked #495 keyed by work package, at
 * area/package granularity; this keys by `taskRef`, matching the per-task proof
 * model #502/#506). Invariants (carried over from #495, verified per task):
 *   - SUBMIT is server-verified against captured proof — every required item for
 *     THIS task must be met (`summarisePhilTaskProof(...).eligibleForReview`),
 *     never a client gate. Submitting incomplete proof is rejected.
 *   - SUBMIT ≠ APPROVE: a submit only ever yields `submitted`.
 *   - APPROVE / REJECT are a separate admin action, allowed ONLY on a `submitted`
 *     review, and are subject to an INDEPENDENCE rule (the submitter cannot
 *     approve/reject their own submission).
 *   - REJECT carries a reason; RESUBMIT after a reject clears the prior stamps.
 *   - Review is keyed by task (`taskRefKey`) → cross-task isolation.
 *
 * Pure core (`applyProofReview`) + injectable I/O (`ProofReviewDeps`), mirroring
 * the evidence-link writer. `writeProofReview` REQUIRES `expectedRevision` and
 * rejects a stale write with 409 (the shared revision guard, #469) — an
 * application-level read→compare→write check, not blob atomic CAS.
 */

// ── Request ───────────────────────────────────────────────────────────────────

export const ProofReviewRequestSchema = z.object({
  action: z.enum(["submit", "approve", "reject"]),
  taskRef: TaskRefSchema,
  /** Required for `reject` — why the proof was sent back. */
  reason: z.string().min(1).nullable().optional(),
});
export type ProofReviewRequest = z.infer<typeof ProofReviewRequestSchema>;

// ── Pure apply ─────────────────────────────────────────────────────────────────

export type ProofReviewReason =
  | "invalid_task"
  | "no_required_proof"
  | "incomplete"
  | "already_submitted"
  | "no_review"
  | "not_submitted"
  | "self_review"
  | "reviewer_identity_required"
  | "reason_required";

export type ProofReviewApplyResult =
  | { ok: true; artifact: PersistedJobControl; review: ProofReview }
  | { ok: false; reason: ProofReviewReason };

function findReview(artifact: PersistedJobControl, taskRef: ProofReviewRequest["taskRef"]): ProofReview | undefined {
  const key = taskRefKey(taskRef);
  return artifact.proofReviews.find((r) => taskRefKey(r.taskRef) === key);
}

/** Replace the review for this task (by key), or append it. */
function upsertReview(reviews: ReadonlyArray<ProofReview>, review: ProofReview): ProofReview[] {
  const key = taskRefKey(review.taskRef);
  const others = reviews.filter((r) => taskRefKey(r.taskRef) !== key);
  return [...others, review];
}

function committed(
  artifact: PersistedJobControl,
  proofReviews: ProofReview[],
  review: ProofReview,
  at: string,
): ProofReviewApplyResult {
  const base: PersistedJobControl = { ...artifact, proofReviews, updatedAt: at };
  const next: PersistedJobControl = { ...base, revision: computeJobControlRevision(base) };
  return { ok: true, artifact: next, review };
}

/**
 * Apply a review action to the artifact. PURE — no I/O, no mutation of the input.
 * `ctx.actor` is the acting user (the worker on submit; the admin on
 * approve/reject) — used for the stamps and the independence rule.
 */
export function applyProofReview(
  artifact: PersistedJobControl,
  request: ProofReviewRequest,
  ctx: { id: string; at: string; actor?: string | null },
): ProofReviewApplyResult {
  const existing = findReview(artifact, request.taskRef);

  if (request.action === "submit") {
    // server-verify the TASK's required proof is fully met (never the client gate)
    const proofCtx = buildPhilTaskContext({
      workPackages: artifact.workPackages,
      task: request.taskRef,
      evidenceLinks: artifact.evidenceLinks,
    });
    const summary = summarisePhilTaskProof(proofCtx);
    if (summary == null) return { ok: false, reason: "no_required_proof" };
    if (!summary.eligibleForReview) return { ok: false, reason: "incomplete" };
    if (existing && existing.status === "submitted") return { ok: false, reason: "already_submitted" };

    const review: ProofReview = ProofReviewSchema.parse({
      id: existing?.id ?? ctx.id,
      jobId: artifact.jobId,
      taskRef: request.taskRef,
      status: "submitted",
      submittedBy: ctx.actor ?? null,
      submittedAt: ctx.at,
      // a (re)submit clears any prior review verdict + reason
      reviewedBy: null,
      reviewedAt: null,
      reason: null,
    });
    return committed(artifact, upsertReview(artifact.proofReviews, review), review, ctx.at);
  }

  // approve / reject — only on a submitted review, by someone other than the submitter
  if (!existing) return { ok: false, reason: "no_review" };
  if (existing.status !== "submitted") return { ok: false, reason: "not_submitted" };
  // #579: an anonymous reviewer can't satisfy the independence rule — fail CLOSED,
  // never open. (The route's HMAC gate should make this unreachable; this is the
  // engine's own line.)
  if (ctx.actor == null) return { ok: false, reason: "reviewer_identity_required" };
  if (existing.submittedBy != null && ctx.actor === existing.submittedBy) {
    return { ok: false, reason: "self_review" };
  }

  if (request.action === "reject") {
    const reason = request.reason?.trim();
    if (!reason) return { ok: false, reason: "reason_required" };
    const review: ProofReview = {
      ...existing,
      status: "rejected",
      reviewedBy: ctx.actor ?? null,
      reviewedAt: ctx.at,
      reason,
    };
    return committed(artifact, upsertReview(artifact.proofReviews, review), review, ctx.at);
  }

  // approve
  const review: ProofReview = {
    ...existing,
    status: "approved",
    reviewedBy: ctx.actor ?? null,
    reviewedAt: ctx.at,
    reason: null,
  };
  return committed(artifact, upsertReview(artifact.proofReviews, review), review, ctx.at);
}

// ── Orchestration (I/O via injected deps) ──────────────────────────────────────

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
      reason: "missing" | "unreadable" | "stale_revision" | ProofReviewReason;
      currentRevision?: string;
    };

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
  if (raw == null) return { ok: false, status: 404, reason: "missing" };

  const parsed = PersistedJobControlSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 409, reason: "unreadable" };

  const currentRevision = jobControlRevisionOf(parsed.data);
  if (input.expectedRevision !== currentRevision) {
    return { ok: false, status: 409, reason: "stale_revision", currentRevision };
  }

  const applied = applyProofReview(parsed.data, input.request, {
    id: deps.mintId(),
    at: input.at,
    actor: input.actor,
  });
  if (!applied.ok) return { ok: false, status: 409, reason: applied.reason };

  await deps.save(input.jobId, applied.artifact);
  return { ok: true, status: 200, review: applied.review, revision: jobControlRevisionOf(applied.artifact) };
}

// ── Real deps (Vercel Blob) ─────────────────────────────────────────────────────

export function blobProofReviewDeps(): ProofReviewDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(jobControlKey(jobId), null),
    save: (jobId, artifact) => writeJsonBlob(jobControlKey(jobId), artifact),
    mintId: () => `${ID_PREFIXES.proofReview}${randomUUID()}`,
  };
}
