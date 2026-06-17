import { taskRefKey } from "./spine";
import type {
  EvidenceLink,
  GoverningDocRef,
  ProofReview,
  ProofReviewStatus,
  RequiredEvidence,
  TaskRef,
  WorkPackageMaterial,
  WorkPackageWarning,
  WorkPackage,
} from "./types";

/**
 * Phil scope-context on a task (#368) — the PURE view-model only.
 *
 * Given the compiled work packages (#367) and a task coordinate, this answers
 * "for THIS task, what scope context did the office compile?" — scope note,
 * governing drawing/spec, materials, required evidence and site warnings.
 *
 * This module ships NO UI. The Phil task-detail surface is double-gated: the
 * job screen is frozen pending the #132 field review, and the substantive
 * provenance values only exist once the compile child (#367) runs on a real
 * job. So the responsible slice is the contract + selector — which returns an
 * HONEST EMPTY context for any task that has no package or no compiled
 * provenance (i.e. it renders exactly as today — zero regression, P10), and
 * never invents a value (P7). The render, the warning rails, the deep-links and
 * the "I'm blocked" affordance land after the freeze lifts.
 */

export interface TaskContextEvidenceReq extends RequiredEvidence {
  /** True ONLY when a real EvidenceLink names this requirement on this package.
   *  Never derived from a photo count; absent links ⇒ unmet, never faked-met. */
  met: boolean;
}

export interface PhilTaskContext {
  /** The package that owns this task, or null when the task belongs to none. */
  workPackageId: string | null;
  scopeNote: string | null;
  governingDocs: GoverningDocRef[];
  materials: WorkPackageMaterial[];
  requiredEvidence: TaskContextEvidenceReq[];
  warnings: WorkPackageWarning[];
  /** True when there's nothing to show → the caller renders the task exactly as
   *  it does today. This is the zero-regression guarantee. */
  isEmpty: boolean;
}

const EMPTY_CONTEXT: PhilTaskContext = {
  workPackageId: null,
  scopeNote: null,
  governingDocs: [],
  materials: [],
  requiredEvidence: [],
  warnings: [],
  isEmpty: true,
};

/** The package that delivers a task coordinate (first match; a task maps to at
 *  most one package by the compile child's area grouping). */
export function workPackageForTask(
  workPackages: ReadonlyArray<WorkPackage>,
  task: TaskRef,
): WorkPackage | null {
  const key = taskRefKey(task);
  return workPackages.find((wp) => wp.taskRefs.some((r) => taskRefKey(r) === key)) ?? null;
}

/**
 * A required-evidence item is MET only when a real EvidenceLink names it on its
 * work package AND carries a proof (an evidence item or an observation) — never
 * inferred from a photo count (P7). SHARED so the Phil task-context and the admin
 * proof-status view derive "met" by the exact same rule (one source of truth, no
 * drift).
 */
export function isRequiredEvidenceMet(
  links: ReadonlyArray<EvidenceLink>,
  workPackageId: string,
  requiredEvidenceId: string,
): boolean {
  return links.some(
    (el) =>
      el.workPackageId === workPackageId &&
      el.requiredEvidenceId === requiredEvidenceId &&
      Boolean(el.evidenceId || el.observationId),
  );
}

/**
 * Build the task-context view-model. Pure, defensive, hidden-when-empty. A
 * required-evidence item is `met` only when a real EvidenceLink ties a proof
 * (evidence or observation) to that specific requirement on this package.
 */
export function buildPhilTaskContext(input: {
  workPackages: ReadonlyArray<WorkPackage>;
  task: TaskRef;
  evidenceLinks?: ReadonlyArray<EvidenceLink>;
}): PhilTaskContext {
  const wp = workPackageForTask(input.workPackages, input.task);
  if (!wp) return EMPTY_CONTEXT;

  const links = input.evidenceLinks ?? [];
  const requiredEvidence: TaskContextEvidenceReq[] = (wp.requiredEvidence ?? []).map((e) => ({
    ...e,
    met: isRequiredEvidenceMet(links, wp.id, e.id),
  }));
  const governingDocs = wp.governingDocRefs ?? [];
  const materials = wp.materials ?? [];
  const warnings = wp.warnings ?? [];
  const scopeNote = wp.scopeNote ?? null;

  const isEmpty =
    !scopeNote &&
    governingDocs.length === 0 &&
    materials.length === 0 &&
    requiredEvidence.length === 0 &&
    warnings.length === 0;

  return { workPackageId: wp.id, scopeNote, governingDocs, materials, requiredEvidence, warnings, isEmpty };
}

/** Segregate warnings so the eventual UI can treat them distinctly. A
 *  variation-trigger ("stop — flag a variation first") is the most urgent. */
export function classifyTaskWarnings(warnings: ReadonlyArray<WorkPackageWarning>): {
  variationTriggers: WorkPackageWarning[];
  byOthers: WorkPackageWarning[];
  reuseExisting: WorkPackageWarning[];
} {
  return {
    variationTriggers: warnings.filter((w) => w.kind === "variation_trigger"),
    byOthers: warnings.filter((w) => w.kind === "by_others"),
    reuseExisting: warnings.filter((w) => w.kind === "reuse_existing"),
  };
}

/** Count of UNMET required-evidence for the command model, or null when the
 *  package carries no required evidence (unknown ≠ zero). Never a fake count. */
export function unmetRequiredEvidenceCount(ctx: PhilTaskContext): number | null {
  if (ctx.requiredEvidence.length === 0) return null;
  return ctx.requiredEvidence.filter((e) => !e.met).length;
}

/**
 * A compact, at-a-glance roll-up of a task's required-proof status, derived
 * PURELY from the already-resolved `requiredEvidence` on its context — each
 * `met` came from the shared `isRequiredEvidenceMet` rule, so this NEVER
 * re-derives "met" and never counts photos (P7). Returns `null` when the package
 * carries no required evidence (unknown ≠ "all done"), mirroring
 * `unmetRequiredEvidenceCount`'s honest-null contract so an un-compiled task
 * surfaces nothing (zero regression, P10).
 *
 * `eligibleForReview` is the first task-level review-readiness signal: true only
 * when there IS required proof and every item is met. It is a READ-MODEL only —
 * there is no task submit action or task review state yet (a later slice).
 *
 * Granularity (be honest — P7): required proof is authored on the AREA work
 * package today (the compiler emits one package per area holding the UNION of its
 * tasks' requirements), and `buildPhilTaskContext` resolves a task to that
 * package without per-task filtering. So this summary is AREA/PACKAGE-granular:
 * every task the package delivers — both stages — shares the same
 * `requiredEvidence` and therefore the SAME summary, and capturing one item flips
 * all of them. The isolation that DOES hold is cross-AREA: a different area is a
 * different package, never cross-satisfied. Per-task-instance proof (distinct
 * requirements keyed to `(areaId,stage,taskId)`) is future work — when compile/
 * keying becomes per-instance this same selector yields per-instance summaries
 * with no change here.
 */
export interface PhilTaskProofSummary {
  /** Total required-evidence items the office compiled for this task. */
  requiredCount: number;
  /** How many are met (a real EvidenceLink names them). */
  metCount: number;
  /** Still outstanding (requiredCount − metCount). */
  missingCount: number;
  /** True iff there is required proof and every item is met. */
  eligibleForReview: boolean;
}

export function summarisePhilTaskProof(ctx: PhilTaskContext): PhilTaskProofSummary | null {
  const reqs = ctx.requiredEvidence;
  if (reqs.length === 0) return null;
  const metCount = reqs.reduce((n, e) => (e.met ? n + 1 : n), 0);
  const requiredCount = reqs.length;
  const missingCount = requiredCount - metCount;
  return { requiredCount, metCount, missingCount, eligibleForReview: missingCount === 0 };
}

// ── Proof review (submit → approve/reject) — read model + shared gate ─────────
// The review lifecycle layered on top of the capture→met loop. The WRITTEN states
// (submitted/approved/rejected) live in `proofReviews` on the artifact, keyed by
// workPackageId (proof is package/area-granular today, #494). The DERIVED states
// (not_required/not_ready/ready) are computed from the proof summary — never
// stored. These pure helpers are the single source of truth shared by the Phil
// display, the Phil submit affordance, and (re-derived against the artifact) the
// server writer, so field and office never disagree (P7).

/** The unified worker-facing proof state for a task. `not_required`/`not_ready`/
 *  `ready` are derived from captured proof; `submitted`/`approved`/`rejected`
 *  come from the office review record on the task's work package. */
export type TaskProofReviewStatus =
  | "not_required"
  | "not_ready"
  | "ready"
  | ProofReviewStatus;

export interface PhilTaskProofView {
  /** The review boundary — the package that owns this task, or null. */
  workPackageId: string | null;
  /** Captured-proof counts, or null when the task has no required proof. */
  summary: PhilTaskProofSummary | null;
  status: TaskProofReviewStatus;
  /** Short worker-readable reason, present only when `status === "rejected"`. */
  reason: string | null;
}

/** The current review record for a work package, or null. The writer keeps ONE
 *  review per package (upsert); if more than one is somehow present, the
 *  most-recently-touched wins. */
function latestReviewForPackage(
  reviews: ReadonlyArray<ProofReview>,
  workPackageId: string | null,
): ProofReview | null {
  if (!workPackageId) return null;
  let latest: ProofReview | null = null;
  for (const r of reviews) {
    if (r.workPackageId !== workPackageId) continue;
    if (!latest) {
      latest = r;
      continue;
    }
    const t = r.reviewedAt ?? r.submittedAt ?? "";
    const lt = latest.reviewedAt ?? latest.submittedAt ?? "";
    if (t >= lt) latest = r;
  }
  return latest;
}

/**
 * Combine the captured-proof summary with the office review record into the one
 * state Phil renders. Pure. A review record (submitted/approved/rejected) takes
 * precedence over the derived ready/not_ready; with no record it's `ready` when
 * all proof is met, else `not_ready`; with no required proof at all it's
 * `not_required` (renders nothing).
 */
export function philTaskProofView(
  ctx: PhilTaskContext,
  proofReviews: ReadonlyArray<ProofReview> = [],
): PhilTaskProofView {
  const summary = summarisePhilTaskProof(ctx);
  const workPackageId = ctx.workPackageId;
  if (!summary) return { workPackageId, summary: null, status: "not_required", reason: null };

  const review = latestReviewForPackage(proofReviews, workPackageId);
  if (review) {
    return {
      workPackageId,
      summary,
      status: review.status,
      reason: review.status === "rejected" ? review.reason ?? null : null,
    };
  }
  return {
    workPackageId,
    summary,
    status: summary.eligibleForReview ? "ready" : "not_ready",
    reason: null,
  };
}

/**
 * Can a worker submit this task's work package for office review right now? The
 * SHARED gate for the Phil affordance; the server writer re-derives the same
 * conditions against the stored artifact (never trusts the client). Submittable
 * only when there IS required proof, every item is met, a package owns the task,
 * and there is no in-flight (`submitted`) or terminal (`approved`) review — a
 * `rejected` review may be resubmitted.
 */
export type CanSubmitProofResult =
  | { ok: true; workPackageId: string }
  | {
      ok: false;
      reason: "not_required" | "no_package" | "incomplete" | "already_submitted" | "already_approved";
    };

export function canSubmitProofForReview(
  ctx: PhilTaskContext,
  proofReviews: ReadonlyArray<ProofReview> = [],
): CanSubmitProofResult {
  const summary = summarisePhilTaskProof(ctx);
  if (!summary) return { ok: false, reason: "not_required" };
  if (!ctx.workPackageId) return { ok: false, reason: "no_package" };
  if (!summary.eligibleForReview) return { ok: false, reason: "incomplete" };
  const review = latestReviewForPackage(proofReviews, ctx.workPackageId);
  if (review?.status === "submitted") return { ok: false, reason: "already_submitted" };
  if (review?.status === "approved") return { ok: false, reason: "already_approved" };
  return { ok: true, workPackageId: ctx.workPackageId };
}
