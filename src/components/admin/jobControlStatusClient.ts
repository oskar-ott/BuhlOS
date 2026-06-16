import type { ProofStatusResult } from "@/server/job-control/status";

/**
 * Pure view helpers for the admin proof-status section. The server
 * (`status.ts`) already derives needed/met per requirement (one source of
 * truth); these just normalise counts + plain copy for the read-only display, so
 * the component stays dumb and these stay unit-tested without a browser.
 *
 * Type-only import of `ProofStatusResult` — erased at build, so no server code
 * is bundled into the admin component.
 */

export interface ProofStatusSummary {
  /** True only for a compiled artifact (counts are meaningful). */
  compiled: boolean;
  workPackageCount: number;
  requiredProofTotal: number;
  neededCount: number;
  metCount: number;
  evidenceLinkCount: number;
}

const EMPTY_SUMMARY: ProofStatusSummary = {
  compiled: false,
  workPackageCount: 0,
  requiredProofTotal: 0,
  neededCount: 0,
  metCount: 0,
  evidenceLinkCount: 0,
};

/** Normalise any status result to header counts. Missing/unreadable/load-error
 *  all collapse to zeros (compiled:false) — never a fabricated count. */
export function summariseProofStatus(status: ProofStatusResult): ProofStatusSummary {
  if (!status.ok || status.status !== "compiled") return EMPTY_SUMMARY;
  return {
    compiled: true,
    workPackageCount: status.workPackageCount,
    requiredProofTotal: status.requiredProofTotal,
    neededCount: status.neededCount,
    metCount: status.metCount,
    evidenceLinkCount: status.evidenceLinkCount,
  };
}

/** Plain, admin-readable headline for a status result (no jargon, no raw ids). */
export function proofStatusHeadline(status: ProofStatusResult): string {
  if (!status.ok) return "Could not load compiled proof status.";
  switch (status.status) {
    case "missing":
      return "No compiled proof status yet. Save required proof and Compile for Phil first.";
    case "unreadable":
      return "The compiled job-control record is unreadable. Re-compile, or check with an admin.";
    case "compiled": {
      if (status.requiredProofTotal === 0) {
        return "Compiled for Phil, but no required proof items are present.";
      }
      return `${status.metCount} of ${status.requiredProofTotal} required proofs captured.`;
    }
  }
}
