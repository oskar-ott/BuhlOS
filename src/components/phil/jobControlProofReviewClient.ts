import type { ProofReview } from "@/domains/job-control/types";

/**
 * Phil client for the proof-review route — the worker-facing SUBMIT half (the
 * admin approve/reject UI is a later slice; the route already supports it).
 * After all required proof is met, the worker submits the work package for office
 * review; this POSTs `action=submit` with the current job-control revision.
 *
 * Narrow on purpose: one POST + a result mapping. The server re-verifies proof
 * is complete, so this never claims a state the artifact doesn't hold.
 */

export interface SubmitProofReviewInput {
  jobId: string;
  workPackageId: string;
  /** The artifact revision the worker last read — stale-write precondition (#469). */
  expectedJobControlRevision: string;
}

export type SubmitProofReviewResult =
  | { kind: "submitted"; review: ProofReview; revision: string }
  | { kind: "stale"; currentRevision?: string }
  | { kind: "incomplete" }
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export async function submitProofForReview(
  input: SubmitProofReviewInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitProofReviewResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/job-control/proof-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        jobId: input.jobId,
        action: "submit",
        workPackageId: input.workPackageId,
        expectedJobControlRevision: input.expectedJobControlRevision,
      }),
    });
  } catch {
    return { kind: "error", message: "Network error" };
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
    return { kind: "submitted", review: b.review, revision: b.revision };
  }
  if (res.status === 409 && b.reason === "stale_revision") {
    return { kind: "stale", currentRevision: b.currentRevision };
  }
  if (b.reason === "incomplete") return { kind: "incomplete" };
  if (res.status === 404 || b.reason === "missing" || b.reason === "invalid_work_package" || b.reason === "no_required_proof") {
    return { kind: "invalid", message: "Couldn’t submit this work for review." };
  }
  return { kind: "error", message: "Couldn’t submit for review." };
}

// ── Pure result → local-state mapping ────────────────────────────────────────

/** Per-work-package UI status while/after a submit attempt. Success carries no
 *  status — it's reflected by the new ProofReview in state. */
export type SubmitActionStatus = "saving" | "stale" | "incomplete" | "error";

export interface SubmitApplied {
  /** The new ProofReview to upsert into local state — present ONLY on success. */
  review?: ProofReview;
  /** Per-package status to show (absent on success). */
  status?: SubmitActionStatus;
  /** Advance the local revision after success (or to the server's current
   *  revision on a stale conflict). */
  revision?: string;
}

export function applySubmitResult(result: SubmitProofReviewResult): SubmitApplied {
  switch (result.kind) {
    case "submitted":
      return { review: result.review, revision: result.revision };
    case "stale":
      return { status: "stale", revision: result.currentRevision };
    case "incomplete":
      return { status: "incomplete" };
    case "invalid":
    case "unauthorized":
      return { status: "error" };
    case "error":
      return { status: "error" };
  }
}

export function submitStatusMessage(status: SubmitActionStatus): string {
  switch (status) {
    case "saving":
      return "Submitting…";
    case "stale":
      return "Proof list changed. Refresh and try again.";
    case "incomplete":
      return "Capture all required proof first.";
    case "error":
      return "Couldn’t submit. Try again.";
  }
}
