import type { EvidenceLink, TaskRef } from "@/domains/job-control/types";
import {
  boundedFetch,
  PhilWriteTimeoutError,
  PHIL_NETWORK_MESSAGE,
} from "@/domains/phil/write-client";

/**
 * Phil client for the L4 evidence-link route — the worker-facing half of the
 * per-requirement Capture proof loop. After the existing evidence save returns a
 * real `EvidenceItem` id, this POSTs it (with the current job-control revision)
 * so the required-evidence item can flip needed → met.
 *
 * Narrow on purpose: one POST + a status mapping. It NEVER invents an evidence
 * id (the caller passes the real saved one) and NEVER reports `met` — only the
 * `EvidenceLink` model does, and only after a 200 (see `applyProofLinkResult`).
 */

export interface LinkRequiredProofInput {
  jobId: string;
  workPackageId: string;
  requiredEvidenceId: string;
  /** The REAL saved EvidenceItem id (from the existing evidence save). */
  evidenceId: string;
  /** The artifact revision the worker last read — the stale-write precondition (#469). */
  expectedJobControlRevision: string;
  /** Per-task scope (#502 producer): present ONLY when the requirement being
   *  captured is itself task-scoped (its `RequiredEvidence.taskRef` is set), so
   *  the link satisfies only that task. Absent for a package-level requirement →
   *  a package-level link, exactly as before. */
  taskRef?: TaskRef;
}

export type LinkProofResult =
  | { kind: "linked"; revision: string }
  /** The artifact moved since it was read — re-read + retry. */
  | { kind: "stale"; currentRevision?: string }
  /** Target not in the compiled artifact, or no artifact yet — not linkable now. */
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

/** POST the link. `fetchImpl` is injectable for tests. */
export async function linkRequiredProof(
  input: LinkRequiredProofInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkProofResult> {
  let res: Response;
  try {
    // Bounded (#139): runs right after a capture on site — never hang. The
    // evidence itself is already saved by this point; a manual retry of the
    // LINK after an ambiguous timeout is replay-safe (revision precondition
    // 409s stale if the first attempt landed).
    res = await boundedFetch(fetchImpl)("/api/job-control/evidence-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        jobId: input.jobId,
        workPackageId: input.workPackageId,
        requiredEvidenceId: input.requiredEvidenceId,
        evidenceId: input.evidenceId,
        expectedJobControlRevision: input.expectedJobControlRevision,
        ...(input.taskRef ? { taskRef: input.taskRef } : {}),
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
  const b = (body ?? {}) as { ok?: boolean; reason?: string; revision?: string; currentRevision?: string };

  if (res.ok && b.ok && typeof b.revision === "string") {
    return { kind: "linked", revision: b.revision };
  }
  if (res.status === 409 && b.reason === "stale_revision") {
    return { kind: "stale", currentRevision: b.currentRevision };
  }
  if (
    res.status === 404 ||
    b.reason === "missing" ||
    b.reason === "invalid_work_package" ||
    b.reason === "invalid_requirement"
  ) {
    return { kind: "invalid", message: "Couldn’t link to this proof item." };
  }
  return { kind: "error", message: "Couldn’t link the proof." };
}

// ── Pure result → UI/state mapping ────────────────────────────────────────────

/** Per-requirement UI status while/after a proof-link attempt. (Success is
 *  reflected by the new EvidenceLink → `met`, so it carries no status.) */
export type ProofActionStatus = "saving" | "saved_not_linked" | "stale" | "error";

export interface ProofLinkApplied {
  /** A real EvidenceLink to append to state — present ONLY on success. Built from
   *  the REAL saved evidenceId; the server has already persisted the link. */
  link?: EvidenceLink;
  /** Per-requirement status to show (absent on success). */
  status?: ProofActionStatus;
  /** Advance the local revision after a successful write (or to the server's
   *  current revision on a stale conflict, to inform a future re-read). */
  revision?: string;
}

/**
 * Pure mapping from a link result to the local state changes. Marking `met`
 * happens ONLY here, ONLY on `linked` — never optimistically before the route
 * confirms.
 */
export function applyProofLinkResult(
  result: LinkProofResult,
  ctx: { jobId: string; workPackageId: string; requiredEvidenceId: string; evidenceId: string; taskRef?: TaskRef },
): ProofLinkApplied {
  switch (result.kind) {
    case "linked":
      return {
        revision: result.revision,
        link: {
          // Local reflection of the server-persisted link (next full load gets the
          // canonical `el_…` id); the proof id is the REAL saved evidence id.
          id: `el_local_${ctx.evidenceId}`,
          jobId: ctx.jobId,
          workPackageId: ctx.workPackageId,
          requiredEvidenceId: ctx.requiredEvidenceId,
          evidenceId: ctx.evidenceId,
          // mirror the task scope so the optimistic "met" matches the persisted
          // link (a task-scoped link satisfies only its task — #502 met rule).
          ...(ctx.taskRef ? { taskRef: ctx.taskRef } : {}),
          role: "progress",
        },
      };
    case "stale":
      return { status: "stale", revision: result.currentRevision };
    case "invalid":
    case "unauthorized":
      return { status: "error" };
    case "error":
      // The evidence was saved (we only link after a successful save); the link
      // itself failed → tell the worker proof is saved but not yet linked.
      return { status: "saved_not_linked" };
  }
}

/**
 * The full per-requirement link orchestration the UI runs after a successful
 * capture: POST the saved evidence id (with the precondition revision), then map
 * the result to the local state change. Exposing it as one function lets the
 * component call exactly what the tests exercise — `met` is reflected ONLY when
 * the route confirmed the link.
 */
export async function linkAndApply(
  input: LinkRequiredProofInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProofLinkApplied> {
  const result = await linkRequiredProof(input, fetchImpl);
  return applyProofLinkResult(result, {
    jobId: input.jobId,
    workPackageId: input.workPackageId,
    requiredEvidenceId: input.requiredEvidenceId,
    evidenceId: input.evidenceId,
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
  });
}

/** Worker-facing copy for a per-requirement proof status (no raw ids, no jargon). */
export function proofStatusMessage(status: ProofActionStatus): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved_not_linked":
      return "Evidence saved but not linked. Try again.";
    case "stale":
      return "Proof list changed. Refresh and try again.";
    case "error":
      return "Couldn’t link. Try again.";
  }
}
