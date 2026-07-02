import type { ProofReview, TaskRef } from "@/domains/job-control/types";
import {
  boundedFetch,
  PhilWriteTimeoutError,
  PHIL_NETWORK_MESSAGE,
} from "@/domains/phil/write-client";

/**
 * Client for the task-instance proof review/approval route (#503). Narrow: one
 * POST + a result mapping. The worker-facing half wires `submit`; the admin
 * approve/reject UI (a later slice) reuses `postProofReview` with the same shape.
 * It NEVER reports a status optimistically — the new `ProofReview` is reflected
 * only after the route confirms (200).
 */

export interface ProofReviewActionInput {
  jobId: string;
  action: "submit" | "approve" | "reject";
  taskRef: TaskRef;
  /** Required for `reject`. */
  reason?: string;
  /** The artifact revision last read — the stale-write precondition (#469). */
  expectedJobControlRevision: string;
}

export type ProofReviewActionResult =
  | { kind: "ok"; review: ProofReview; revision: string }
  /** The artifact moved since it was read — re-read + retry. */
  | { kind: "stale"; currentRevision?: string }
  /** Submit blocked: the task's required proof isn't all captured. */
  | { kind: "incomplete" }
  /** Target not actionable now (no artifact / no review / not submitted / etc). */
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export async function postProofReview(
  input: ProofReviewActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProofReviewActionResult> {
  let res: Response;
  try {
    // Bounded (#139): submitted from site — never hang on bad signal. A manual
    // retry after an ambiguous timeout is replay-safe: the revision
    // precondition 409s (stale) if the first attempt actually landed.
    res = await boundedFetch(fetchImpl)("/api/job-control/proof-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        jobId: input.jobId,
        action: input.action,
        taskRef: input.taskRef,
        ...(input.reason ? { reason: input.reason } : {}),
        expectedJobControlRevision: input.expectedJobControlRevision,
      }),
    });
  } catch (err) {
    if (err instanceof PhilWriteTimeoutError) {
      return { kind: "error", message: err.message };
    }
    return { kind: "error", message: PHIL_NETWORK_MESSAGE };
  }

  if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to status-based mapping */
  }
  const b = (body ?? {}) as {
    ok?: boolean;
    reason?: string;
    review?: ProofReview;
    revision?: string;
    currentRevision?: string;
  };

  if (res.ok && b.ok && b.review && typeof b.revision === "string") {
    return { kind: "ok", review: b.review, revision: b.revision };
  }
  if (res.status === 409 && b.reason === "stale_revision") {
    return { kind: "stale", currentRevision: b.currentRevision };
  }
  if (b.reason === "incomplete") return { kind: "incomplete" };
  // The independence rule (a reviewer can't sign off proof they captured) is an
  // authorization failure, not a "not actionable" one — surface it as such so
  // the office UI can show the dedicated independence message (#503).
  if (b.reason === "self_review") return { kind: "unauthorized" };
  if (
    res.status === 404 ||
    b.reason === "missing" ||
    b.reason === "no_required_proof" ||
    b.reason === "no_review" ||
    b.reason === "not_submitted" ||
    b.reason === "already_submitted" ||
    b.reason === "invalid_task" ||
    b.reason === "reason_required" ||
    b.reason === "unreadable"
  ) {
    return { kind: "invalid", message: "Couldn’t do that right now." };
  }
  return { kind: "error", message: "Couldn’t submit. Try again." };
}

/** Submit a task's captured proof for review. */
export function submitProofForReview(
  input: { jobId: string; taskRef: TaskRef; expectedJobControlRevision: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ProofReviewActionResult> {
  return postProofReview({ ...input, action: "submit" }, fetchImpl);
}

// ── Pure view helpers ──────────────────────────────────────────────────────────

/** Worker-facing status line for a task's review (no raw ids, site language). */
export function proofReviewStatusLabel(review: Pick<ProofReview, "status" | "reason"> | null): string | null {
  if (!review) return null;
  switch (review.status) {
    case "submitted":
      return "Submitted for review";
    case "approved":
      return "Approved";
    case "rejected":
      return review.reason ? `Sent back — ${review.reason}` : "Sent back";
  }
}

/** Transient per-task action feedback while/after a submit attempt. */
export type ProofSubmitStatus = "submitting" | "stale" | "error";

export function proofSubmitMessage(status: ProofSubmitStatus): string {
  switch (status) {
    case "submitting":
      return "Submitting…";
    case "stale":
      return "Proof list changed. Refresh and try again.";
    case "error":
      return "Couldn’t submit. Try again.";
  }
}
