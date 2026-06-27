import type { ProofReviewActionResult } from "@/components/phil/jobControlProofReviewClient";

/**
 * Pure decisions for the office Proof-to-sign-off queue (#503), extracted so the
 * result→message + refresh mapping is unit-testable in the node/SSR test harness
 * (the component itself only renders strings via renderToString).
 */

export type ProofActionKind = ProofReviewActionResult["kind"];

/**
 * The honest, site-language message for a non-ok action result, or null when the
 * action succeeded (the row is removed instead). `unauthorized` carries the
 * independence-rule message — the engine returns reason "self_review" which the
 * client maps to "unauthorized" (you can't sign off proof you captured).
 */
export function proofActionMessage(kind: ProofActionKind, verb: string): string | null {
  switch (kind) {
    case "ok":
      return null;
    case "stale":
      return "This job changed since you loaded it — refreshing.";
    case "unauthorized":
      return "You can’t sign off proof you captured — another reviewer must.";
    case "invalid":
      return "Couldn’t do that — it may have been actioned already.";
    case "incomplete":
    case "error":
    default:
      return `Couldn’t ${verb} — try again.`;
  }
}

/** A stale result is the only kind that triggers a server refresh (re-read the
 *  artifact + its revision). */
export function proofActionShouldRefresh(kind: ProofActionKind): boolean {
  return kind === "stale";
}
