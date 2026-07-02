import type { z } from "zod";
import type {
  ClaimAttachmentSchema,
  ClaimBoqLineRefSchema,
  ClaimEvidenceManifestSchema,
  ClaimEvidenceRefSchema,
  ProgressClaimLineSchema,
  ProgressClaimSchema,
  ProgressClaimsDocSchema,
  ProgressClaimStatusSchema,
  ProgressClaimTotalsSchema,
} from "./schema";

/** Inferred types for progress claims (#372). Consumers import these, never
 *  the Zod schemas — the validation layer stays an implementation detail
 *  (house pattern, jobs/types.ts, job-control/types.ts). */

export type ProgressClaimStatus = z.infer<typeof ProgressClaimStatusSchema>;
export type ClaimBoqLineRef = z.infer<typeof ClaimBoqLineRefSchema>;
export type ClaimEvidenceRef = z.infer<typeof ClaimEvidenceRefSchema>;
export type ProgressClaimLine = z.infer<typeof ProgressClaimLineSchema>;
export type ClaimAttachment = z.infer<typeof ClaimAttachmentSchema>;
export type ProgressClaimTotals = z.infer<typeof ProgressClaimTotalsSchema>;
export type ClaimEvidenceManifest = z.infer<typeof ClaimEvidenceManifestSchema>;
export type ProgressClaim = z.infer<typeof ProgressClaimSchema>;
export type ProgressClaimsDoc = z.infer<typeof ProgressClaimsDocSchema>;
