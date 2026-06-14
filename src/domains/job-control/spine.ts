import type {
  BoqLineRef,
  ClaimLine,
  ClaimLineStatus,
  CloseoutRequirement,
  EvidenceLink,
  JobControlSpine,
  TaskRef,
  WorkPackage,
} from "./types";

/**
 * Pure helpers over the job-control spine (#364). No I/O, no UI — given a
 * spine (and, where needed, the set of ids that exist on the job) these
 * answer the questions the chain was built to make cheap: trace a clause to
 * its proof and money, total what's been claimed, measure closeout, and find
 * links that point at nothing.
 *
 * Every function here is referenced from `docs/architecture/job-control-spine.md`.
 * The reconciliation (#366), work-package compile (#367), progress-claims
 * (#372) and closeout-matrix (#374) children build on these signatures.
 */

// ── Stable keys for the reference coordinates ────────────────────────────────

/** Canonical string key for an area/stage/task coordinate. */
export function taskRefKey(ref: Pick<TaskRef, "areaId" | "stage" | "taskId">): string {
  return `${ref.areaId}/${ref.stage}/${ref.taskId}`;
}

/** Canonical string key for a quote-line (BOQ) coordinate. */
export function boqLineRefKey(ref: BoqLineRef): string {
  return `${ref.quoteId}/${ref.sectionId}/${ref.lineId}`;
}

/** A fresh, empty spine for a job — the shape a first write persists. */
export function emptySpine(jobId: string): JobControlSpine {
  return {
    jobId,
    workPackages: [],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [],
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural validation for an EvidenceLink: it must connect a piece of PROOF
 * (evidence or observation) to a SPINE NODE (work package, claim line or
 * closeout requirement). A link that does neither is meaningless and is the
 * kind of dangling record that makes closeout "archaeology". Returns the list
 * of problems (empty = valid).
 */
export function validateEvidenceLink(link: EvidenceLink): string[] {
  const errors: string[] = [];
  const hasProof = Boolean(link.evidenceId || link.observationId);
  const hasNode = Boolean(link.workPackageId || link.claimLineId || link.closeoutRequirementId);
  if (!hasProof) {
    errors.push("evidence link needs a proof side: evidenceId or observationId");
  }
  if (!hasNode) {
    errors.push(
      "evidence link needs a spine node: workPackageId, claimLineId or closeoutRequirementId",
    );
  }
  return errors;
}

// ── Tracing one clause through the chain ─────────────────────────────────────

export interface ClauseTrace {
  scopeClauseId: string;
  /** Packages that name this clause in `scopeClauseIds`. */
  workPackages: WorkPackage[];
  /** Priced lines those packages draw on (deduped by boqLineRefKey). */
  boqLineRefs: BoqLineRef[];
  /** Existing tasks those packages deliver (deduped by taskRefKey). */
  taskRefs: TaskRef[];
  /** Claim lines that claim one of those packages. */
  claimLines: ClaimLine[];
  /** Evidence links touching those packages or their claim lines. */
  evidenceLinks: EvidenceLink[];
  /** Closeout requirements that name this clause (or one of its packages). */
  closeoutRequirements: CloseoutRequirement[];
}

/**
 * Walk the spine from one scope clause to everything downstream: the packages
 * that deliver it, the BOQ lines that fund them, the tasks that do the work,
 * the claim lines that bill it, the evidence that proves it and the closeout
 * obligations it carries. This is the "lookup instead of archaeology" the
 * issue's user story asks for.
 */
export function traceClause(spine: JobControlSpine, scopeClauseId: string): ClauseTrace {
  const workPackages = spine.workPackages.filter((wp) =>
    wp.scopeClauseIds.includes(scopeClauseId),
  );
  const packageIds = new Set(workPackages.map((wp) => wp.id));

  const boqLineRefs = dedupeBy(
    workPackages.flatMap((wp) => wp.boqLineRefs),
    boqLineRefKey,
  );
  const taskRefs = dedupeBy(
    workPackages.flatMap((wp) => wp.taskRefs),
    taskRefKey,
  );

  const claimLines = spine.claimLines.filter(
    (cl) => cl.workPackageId != null && packageIds.has(cl.workPackageId),
  );
  const claimLineIds = new Set(claimLines.map((cl) => cl.id));

  const evidenceLinks = spine.evidenceLinks.filter(
    (el) =>
      (el.workPackageId != null && packageIds.has(el.workPackageId)) ||
      (el.claimLineId != null && claimLineIds.has(el.claimLineId)),
  );

  const closeoutRequirements = spine.closeoutRequirements.filter(
    (cr) =>
      cr.scopeClauseIds.includes(scopeClauseId) ||
      (cr.workPackageId != null && packageIds.has(cr.workPackageId)),
  );

  return {
    scopeClauseId,
    workPackages,
    boqLineRefs,
    taskRefs,
    claimLines,
    evidenceLinks,
    closeoutRequirements,
  };
}

// ── Claim totals (sum recorded amounts — never derive a claim) ───────────────

export interface ClaimTotalOptions {
  /** Only count claim lines in these statuses (default: all). */
  statuses?: ReadonlyArray<ClaimLineStatus>;
}

/** Sum of claim-line amounts for one work package, optionally by status. */
export function claimedTotalForPackage(
  spine: JobControlSpine,
  workPackageId: string,
  options: ClaimTotalOptions = {},
): number {
  return sumClaim(
    spine.claimLines.filter((cl) => cl.workPackageId === workPackageId),
    options.statuses,
  );
}

/**
 * Sum of all claim-line amounts on the job, optionally by status. This is the
 * line-level number the scalar `job.claimedToDate` (api/jobs.js, hand-set
 * today) should agree with once #372's claims write here — see
 * reconcileClaimedToDate.
 */
export function jobClaimedTotal(spine: JobControlSpine, options: ClaimTotalOptions = {}): number {
  return sumClaim(spine.claimLines, options.statuses);
}

export interface ClaimedReconciliation {
  /** Line-level total from the spine (approved + paid by default). */
  spineTotal: number;
  /** The hand-set scalar on the job. */
  scalar: number;
  /** scalar − spineTotal, rounded to cents. */
  delta: number;
  /** True when |delta| is within `tolerance` (default 1 cent). */
  matches: boolean;
}

/**
 * Reconcile the hand-set `job.claimedToDate` scalar against the spine's claim
 * lines. Once progress claims (#372) write claim lines, this surfaces drift
 * between the headline number and what the lines actually support — the exact
 * place 100 Arthur St money leaks. By default it counts `approved` + `paid`
 * lines (what's genuinely been claimed-and-stood-up), not drafts.
 */
export function reconcileClaimedToDate(
  spine: JobControlSpine,
  claimedToDate: number,
  options: ClaimTotalOptions & { tolerance?: number } = {},
): ClaimedReconciliation {
  const statuses = options.statuses ?? (["approved", "paid"] as const);
  const tolerance = options.tolerance ?? 0.01;
  const spineTotal = round2(sumClaim(spine.claimLines, statuses));
  const scalar = round2(claimedToDate);
  const delta = round2(scalar - spineTotal);
  return { spineTotal, scalar, delta, matches: Math.abs(delta) <= tolerance };
}

// ── Closeout progress ────────────────────────────────────────────────────────

export interface CloseoutProgress {
  total: number;
  outstanding: number;
  inProgress: number;
  satisfied: number;
  waived: number;
  /** Fraction discharged (satisfied + waived) / total, or null when total = 0
   *  (render "Nothing to close out yet" — never a fake 0% or 100%). */
  fractionDischarged: number | null;
}

/** Tally closeout requirements by status. Mirrors progress.ts's rule that a
 *  percentage exists only where there's something to measure. */
export function closeoutProgress(spine: JobControlSpine): CloseoutProgress {
  let outstanding = 0;
  let inProgress = 0;
  let satisfied = 0;
  let waived = 0;
  for (const cr of spine.closeoutRequirements) {
    switch (cr.status) {
      case "outstanding":
        outstanding += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "satisfied":
        satisfied += 1;
        break;
      case "waived":
        waived += 1;
        break;
    }
  }
  const total = spine.closeoutRequirements.length;
  const fractionDischarged = total === 0 ? null : (satisfied + waived) / total;
  return { total, outstanding, inProgress, satisfied, waived, fractionDischarged };
}

// ── Referential integrity ────────────────────────────────────────────────────

/**
 * The sets of ids that exist on the job, supplied by the caller from the
 * domains the spine references. Each set is OPTIONAL: a field is only checked
 * for dangling refs when the caller provides the relevant set, so a caller
 * that hasn't loaded (say) the quote can still check task and evidence refs
 * without false positives.
 */
export interface SpineKnownIds {
  scopeClauseIds?: Iterable<string>; // Job.scopeOfWork[].id
  taskRefKeys?: Iterable<string>; // taskRefKey() of the job's real tasks
  boqLineRefKeys?: Iterable<string>; // boqLineRefKey() of the quote's real lines
  evidenceIds?: Iterable<string>; // EvidenceItem.id
  observationIds?: Iterable<string>; // ObservationItem.id
  documentIds?: Iterable<string>; // Document.id
  itpInstanceIds?: Iterable<string>; // ITPInstance.id
}

export interface DanglingRef {
  entity: "workPackage" | "claimLine" | "evidenceLink" | "closeoutRequirement";
  /** Owning record id. */
  id: string;
  /** The field carrying the broken reference. */
  field: string;
  /** The id/key that pointed at nothing. */
  value: string;
}

/**
 * Find references that point at nothing. Always checks links INTERNAL to the
 * spine (a claim line's workPackageId must be a real package id, etc.).
 * Additionally checks references OUT to other domains for whichever
 * `SpineKnownIds` sets the caller provides.
 */
export function findDanglingRefs(spine: JobControlSpine, known: SpineKnownIds = {}): DanglingRef[] {
  const out: DanglingRef[] = [];

  const packageIds = new Set(spine.workPackages.map((wp) => wp.id));
  const claimLineIds = new Set(spine.claimLines.map((cl) => cl.id));
  const closeoutIds = new Set(spine.closeoutRequirements.map((cr) => cr.id));
  const evidenceLinkIds = new Set(spine.evidenceLinks.map((el) => el.id));

  const scopeClauseIds = known.scopeClauseIds ? new Set(known.scopeClauseIds) : null;
  const taskRefKeys = known.taskRefKeys ? new Set(known.taskRefKeys) : null;
  const boqLineRefKeys = known.boqLineRefKeys ? new Set(known.boqLineRefKeys) : null;
  const evidenceIds = known.evidenceIds ? new Set(known.evidenceIds) : null;
  const observationIds = known.observationIds ? new Set(known.observationIds) : null;
  const documentIds = known.documentIds ? new Set(known.documentIds) : null;
  const itpInstanceIds = known.itpInstanceIds ? new Set(known.itpInstanceIds) : null;

  const check = (
    cond: boolean,
    entity: DanglingRef["entity"],
    id: string,
    field: string,
    value: string,
  ) => {
    if (cond) out.push({ entity, id, field, value });
  };
  const missingIn = (set: Set<string> | null, value: string | null | undefined): boolean =>
    set != null && value != null && !set.has(value);

  for (const wp of spine.workPackages) {
    for (const cid of wp.scopeClauseIds) {
      check(missingIn(scopeClauseIds, cid), "workPackage", wp.id, "scopeClauseIds", cid);
    }
    for (const ref of wp.boqLineRefs) {
      check(
        missingIn(boqLineRefKeys, boqLineRefKey(ref)),
        "workPackage",
        wp.id,
        "boqLineRefs",
        boqLineRefKey(ref),
      );
    }
    for (const ref of wp.taskRefs) {
      check(
        missingIn(taskRefKeys, taskRefKey(ref)),
        "workPackage",
        wp.id,
        "taskRefs",
        taskRefKey(ref),
      );
    }
  }

  for (const cl of spine.claimLines) {
    check(
      cl.workPackageId != null && !packageIds.has(cl.workPackageId),
      "claimLine",
      cl.id,
      "workPackageId",
      cl.workPackageId ?? "",
    );
    for (const ref of cl.boqLineRefs) {
      check(
        missingIn(boqLineRefKeys, boqLineRefKey(ref)),
        "claimLine",
        cl.id,
        "boqLineRefs",
        boqLineRefKey(ref),
      );
    }
  }

  for (const el of spine.evidenceLinks) {
    check(
      el.workPackageId != null && !packageIds.has(el.workPackageId),
      "evidenceLink",
      el.id,
      "workPackageId",
      el.workPackageId ?? "",
    );
    check(
      el.claimLineId != null && !claimLineIds.has(el.claimLineId),
      "evidenceLink",
      el.id,
      "claimLineId",
      el.claimLineId ?? "",
    );
    check(
      el.closeoutRequirementId != null && !closeoutIds.has(el.closeoutRequirementId),
      "evidenceLink",
      el.id,
      "closeoutRequirementId",
      el.closeoutRequirementId ?? "",
    );
    check(missingIn(evidenceIds, el.evidenceId), "evidenceLink", el.id, "evidenceId", el.evidenceId ?? "");
    check(
      missingIn(observationIds, el.observationId),
      "evidenceLink",
      el.id,
      "observationId",
      el.observationId ?? "",
    );
  }

  for (const cr of spine.closeoutRequirements) {
    for (const cid of cr.scopeClauseIds) {
      check(missingIn(scopeClauseIds, cid), "closeoutRequirement", cr.id, "scopeClauseIds", cid);
    }
    check(
      cr.workPackageId != null && !packageIds.has(cr.workPackageId),
      "closeoutRequirement",
      cr.id,
      "workPackageId",
      cr.workPackageId ?? "",
    );
    check(
      cr.evidenceLinkId != null && !evidenceLinkIds.has(cr.evidenceLinkId),
      "closeoutRequirement",
      cr.id,
      "evidenceLinkId",
      cr.evidenceLinkId ?? "",
    );
    check(missingIn(documentIds, cr.documentId), "closeoutRequirement", cr.id, "documentId", cr.documentId ?? "");
    check(
      missingIn(itpInstanceIds, cr.itpInstanceId),
      "closeoutRequirement",
      cr.id,
      "itpInstanceId",
      cr.itpInstanceId ?? "",
    );
  }

  return out;
}

// ── internals ────────────────────────────────────────────────────────────────

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function sumClaim(lines: ClaimLine[], statuses?: ReadonlyArray<ClaimLineStatus>): number {
  const allow = statuses ? new Set(statuses) : null;
  let total = 0;
  for (const cl of lines) {
    if (allow && !allow.has(cl.status)) continue;
    total += cl.claimedAmount;
  }
  return total;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
