import type { z } from "zod";
import type { JobStage } from "../jobs/types";
import type {
  BoqLineRefSchema,
  ClaimLineSchema,
  ClaimLineStatusSchema,
  CloseoutRequirementSchema,
  CloseoutRequirementKindSchema,
  CloseoutRequirementStatusSchema,
  EvidenceLinkSchema,
  EvidenceLinkRoleSchema,
  GoverningDocRefSchema,
  JobControlSpineSchema,
  JobControlStageSchema,
  ProofReviewSchema,
  ProofReviewStatusSchema,
  RequiredEvidenceSchema,
  RequiredEvidenceKindSchema,
  TaskRefSchema,
  WarningKindSchema,
  WorkPackageMaterialSchema,
  WorkPackageSchema,
  WorkPackageWarningSchema,
} from "./schema";

/**
 * Inferred types for the job-control spine (#364). Consumers import these,
 * never the Zod schemas — the validation layer stays an implementation
 * detail (house pattern, jobs/types.ts).
 */

export type JobControlStage = z.infer<typeof JobControlStageSchema>;

// Compile-time guard: the spine's stage enum must stay identical to the jobs
// domain's `JobStage`. If either side gains/loses a stage, this stops
// compiling — forcing the two to be reconciled rather than silently drifting.
type _StageAligned = JobControlStage extends JobStage
  ? JobStage extends JobControlStage
    ? true
    : never
  : never;
const _stageAlignment: _StageAligned = true;
void _stageAlignment;

export type TaskRef = z.infer<typeof TaskRefSchema>;
export type BoqLineRef = z.infer<typeof BoqLineRefSchema>;

export type RequiredEvidenceKind = z.infer<typeof RequiredEvidenceKindSchema>;
export type RequiredEvidence = z.infer<typeof RequiredEvidenceSchema>;
export type WarningKind = z.infer<typeof WarningKindSchema>;
export type WorkPackageWarning = z.infer<typeof WorkPackageWarningSchema>;
export type GoverningDocRef = z.infer<typeof GoverningDocRefSchema>;
export type WorkPackageMaterial = z.infer<typeof WorkPackageMaterialSchema>;
export type WorkPackage = z.infer<typeof WorkPackageSchema>;

export type ClaimLineStatus = z.infer<typeof ClaimLineStatusSchema>;
export type ClaimLine = z.infer<typeof ClaimLineSchema>;

export type EvidenceLinkRole = z.infer<typeof EvidenceLinkRoleSchema>;
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;

export type CloseoutRequirementKind = z.infer<typeof CloseoutRequirementKindSchema>;
export type CloseoutRequirementStatus = z.infer<typeof CloseoutRequirementStatusSchema>;
export type CloseoutRequirement = z.infer<typeof CloseoutRequirementSchema>;
export type ProofReviewStatus = z.infer<typeof ProofReviewStatusSchema>;
export type ProofReview = z.infer<typeof ProofReviewSchema>;

export type JobControlSpine = z.infer<typeof JobControlSpineSchema>;
