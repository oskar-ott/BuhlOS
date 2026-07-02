import { z } from "zod";
import type { ScopeOfWorkItem } from "../jobs/types";
import type { Quote } from "../quoting/schema";
import { BoqLineRefSchema, RequiredEvidenceSchema, TaskRefSchema } from "./schema";
import { boqLineRefKey } from "./spine";
import type { BoqLineRef } from "./types";

/**
 * Scope-vs-quote reconciliation (#366) — the first behavioural layer on the
 * job-control spine (#364). Before work starts, every agreed scope clause
 * (`Job.scopeOfWork[]`, #200) and every priced quote line (quotes-v2
 * `QuoteLine`) is FORCED into a classification, with NO silent gaps. The
 * office resolves the conflicts the engine names; the survivor is a clean map
 * the compile child (#367) turns into work packages.
 *
 * Pure engine — no I/O, no UI, no persistence. The admin surface
 * (/v2/jobs/[jobId]/scope) and its API are a follow-up gated on a live
 * quote↔job link (#244); this slice ships the classification/conflict engine
 * the issue's technical notes call for ("the UI renders findings, never
 * computes them"). Findings are DERIVED, never stored.
 *
 * House pattern: `.passthrough()` on the persisted records (mirrors
 * jobs/schema.ts) so later fields don't break older parsers.
 */

// ── The closed classification set ────────────────────────────────────────────
// Forced classification: every clause carries exactly one of these. `unclear`
// is the explicit NOT-YET-CLASSIFIED state — it must never silently persist as
// "fine"; it renders amber until an admin resolves it.

export const SCOPE_CLASSIFICATIONS = [
  "priced", // matched to ≥1 BOQ line
  "general_allowance", // covered by a general / PS allowance, not a specific line
  "excluded", // explicitly out of scope and price
  "by_others", // another trade supplies/installs (e.g. A/V hardware) — cabling only
  "reuse_existing", // existing kit reused (verify, don't replace)
  "pc_provisional", // PC sum / provisional / "Alternative" — confirm before install
  "variation_trigger", // performing it is a variation — flag before extra work
  "closeout", // an obligation discharged at closeout (certs, as-builts)
  "admin_only", // paperwork (CAD as-builts, sign-off) with no field task
  "unclear", // NOT YET CLASSIFIED — never silently persists (amber)
] as const;
export const ScopeClassificationSchema = z.enum(SCOPE_CLASSIFICATIONS);

/** Classifications that carry a worker-facing warning the compile child (#367)
 *  stamps onto the delivering task so the field is warned before a trap. */
export const WARNING_CLASSIFICATIONS: ReadonlyArray<ScopeClassification> = [
  "by_others",
  "reuse_existing",
  "variation_trigger",
];

// ── Persisted records (the reconciliation overlay) ───────────────────────────

export const ScopeClauseClassificationSchema = z
  .object({
    /** → Job.scopeOfWork[].id (#200). */
    clauseId: z.string(),
    classification: ScopeClassificationSchema,
    /** Priced lines that satisfy this clause (for `priced`). */
    boqLineRefs: z.array(BoqLineRefSchema).default([]),
    /** Supporting documents (spec/drawing/cert) where relevant. */
    documentIds: z.array(z.string()).default([]),
    /** Existing tasks the office confirms deliver this clause — area/stage/task
     *  coordinates the compile child (#367) groups into work packages. Never a
     *  by-name guess; admin-confirmed. */
    deliveredBy: z.array(TaskRefSchema).default([]),
    /** Proof the office wants for this clause — compiled onto the package (#367)
     *  and shown on the task in Phil (#368). */
    requiredEvidence: z.array(RequiredEvidenceSchema).default([]),
    /** Worker-facing warning text (for by_others / reuse_existing / variation_trigger). */
    warningText: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .passthrough();

export const BoqLineClassificationSchema = z
  .object({
    ref: BoqLineRefSchema,
    /** The clause this line prices, when known. */
    owningClauseId: z.string().nullable().default(null),
    /** Marked alternate / PC: priced but NOT part of the base scope until
     *  confirmed. The v2 QuoteLine carries no alternate flag, so it lives here. */
    isAlternate: z.boolean().default(false),
  })
  .passthrough();

export const ScopeResolutionSchema = z
  .object({
    /** Deterministic key of the finding this resolves (see findingKey). */
    findingKey: z.string(),
    action: z.enum(["resolved", "accepted"]),
    reason: z.string().nullable().optional(),
    by: z.string(),
    at: z.string(),
  })
  .passthrough();

export const ScopeReconciliationSchema = z
  .object({
    jobId: z.string(),
    /** The quote reconciled against, or null when none is linked yet (#244). */
    quoteId: z.string().nullable().default(null),
    clauseClassifications: z.array(ScopeClauseClassificationSchema).default([]),
    boqClassifications: z.array(BoqLineClassificationSchema).default([]),
    resolutions: z.array(ScopeResolutionSchema).default([]),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type ScopeClassification = z.infer<typeof ScopeClassificationSchema>;
export type ScopeClauseClassification = z.infer<typeof ScopeClauseClassificationSchema>;
export type BoqLineClassification = z.infer<typeof BoqLineClassificationSchema>;
export type ScopeResolution = z.infer<typeof ScopeResolutionSchema>;
export type ScopeReconciliation = z.infer<typeof ScopeReconciliationSchema>;

// ── Findings (derived, never stored) ─────────────────────────────────────────

export const FINDING_KINDS = [
  "excluded_with_obligation", // an excluded clause still carrying an obligation
  "alternate_in_base_total", // an alternate-classified line sitting in the base total
  "priced_line_no_clause", // a priced line owned by no clause
  "clause_unpriced_unclassified", // a clause with no price and no classification → unclear
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type ReconciliationSeverity = "red" | "amber";

export interface ReconciliationFinding {
  /** Stable, deterministic id so a resolution survives re-reconciliation. */
  key: string;
  kind: FindingKind;
  severity: ReconciliationSeverity;
  clauseId?: string;
  ref?: BoqLineRef;
  message: string;
}

export type ReconciliationStatus = "red" | "amber" | "green";

// ── Engine ───────────────────────────────────────────────────────────────────

/** Every quote line as a flat list of refs, with a stable key. */
function quoteLineRefs(quote: Quote | null): Array<{ ref: BoqLineRef; key: string }> {
  if (!quote) return [];
  const out: Array<{ ref: BoqLineRef; key: string }> = [];
  for (const section of quote.sections) {
    for (const line of section.lines) {
      const ref = { quoteId: quote.id, sectionId: section.id, lineId: line.id };
      out.push({ ref, key: boqLineRefKey(ref) });
    }
  }
  return out;
}

/**
 * Seed a fresh reconciliation: every clause starts `unclear`, every quote line
 * starts unowned. This is forced classification — one record per clause, one
 * per line, no omissions. The amber `unclear` default is a correctness
 * requirement (missing data is named, never faked green).
 */
export function seedReconciliation(
  jobId: string,
  clauses: ReadonlyArray<ScopeOfWorkItem>,
  quote: Quote | null,
): ScopeReconciliation {
  return ScopeReconciliationSchema.parse({
    jobId,
    quoteId: quote?.id ?? null,
    clauseClassifications: clauses.map((c) => ({ clauseId: c.id, classification: "unclear" })),
    boqClassifications: quoteLineRefs(quote).map(({ ref }) => ({ ref, owningClauseId: null })),
  });
}

/**
 * Re-apply a saved reconciliation over the CURRENT clauses/quote: surviving
 * clause/line classifications and all resolutions are preserved; newly-added
 * clauses/lines come in `unclear`/unowned; classifications for deleted
 * clauses/lines drop. Resolutions are NEVER wiped (AC5) — a stale resolution
 * simply no longer matches an open finding.
 */
export function reconcile(
  prior: ScopeReconciliation,
  clauses: ReadonlyArray<ScopeOfWorkItem>,
  quote: Quote | null,
): ScopeReconciliation {
  const priorClause = new Map(prior.clauseClassifications.map((c) => [c.clauseId, c]));
  const priorLine = new Map(prior.boqClassifications.map((b) => [boqLineRefKey(b.ref), b]));

  const clauseClassifications = clauses.map(
    (c) => priorClause.get(c.id) ?? { clauseId: c.id, classification: "unclear" as const },
  );
  const boqClassifications = quoteLineRefs(quote).map(
    ({ ref, key }) => priorLine.get(key) ?? { ref, owningClauseId: null },
  );

  return ScopeReconciliationSchema.parse({
    jobId: prior.jobId,
    quoteId: quote?.id ?? null,
    clauseClassifications,
    boqClassifications,
    resolutions: prior.resolutions,
    updatedAt: prior.updatedAt,
  });
}

/**
 * The clause that owns each quote line, from EITHER half of the stored link:
 * the line record's `owningClauseId`, or a clause classification whose
 * `boqLineRefs` name the line ({@link classifyClause} keeps the two in sync;
 * this stays defensive so a hand-edited or partially-written overlay never
 * makes a genuinely-linked line look unattributed).
 */
function effectiveLineOwners(rec: ScopeReconciliation): Map<string, string> {
  const owners = new Map<string, string>();
  for (const cc of rec.clauseClassifications) {
    for (const ref of cc.boqLineRefs) {
      const key = boqLineRefKey(ref);
      if (!owners.has(key)) owners.set(key, cc.clauseId);
    }
  }
  for (const bc of rec.boqClassifications) {
    if (bc.owningClauseId != null) owners.set(boqLineRefKey(bc.ref), bc.owningClauseId);
  }
  return owners;
}

/**
 * Derive the open conflicts. Deterministic finding keys mean a resolution
 * recorded against a key stays matched across re-reconciliation. A finding is
 * "open" only when no resolution names its key.
 */
export function detectFindings(rec: ScopeReconciliation): ReconciliationFinding[] {
  const resolved = new Set(rec.resolutions.map((r) => r.findingKey));
  const findings: ReconciliationFinding[] = [];
  const push = (f: ReconciliationFinding) => {
    if (!resolved.has(f.key)) findings.push(f);
  };

  for (const cc of rec.clauseClassifications) {
    // A clause with no price and no real classification is unresolved scope.
    if (cc.classification === "unclear") {
      push({
        key: `clause_unpriced_unclassified:${cc.clauseId}`,
        kind: "clause_unpriced_unclassified",
        severity: "amber",
        clauseId: cc.clauseId,
        message: `Scope clause ${cc.clauseId} is not yet classified`,
      });
    }
    // An excluded clause that still names an obligation (a document or a note)
    // is the disposal/make-safe trap — excluded on price, owed on site.
    if (cc.classification === "excluded" && (cc.documentIds.length > 0 || cc.note)) {
      push({
        key: `excluded_with_obligation:${cc.clauseId}`,
        kind: "excluded_with_obligation",
        severity: "red",
        clauseId: cc.clauseId,
        message: `Clause ${cc.clauseId} is excluded but still carries an obligation`,
      });
    }
  }

  const owners = effectiveLineOwners(rec);
  for (const bc of rec.boqClassifications) {
    const key = boqLineRefKey(bc.ref);
    const owner = owners.get(key) ?? null;
    // An alternate line that's been tied to a clause (i.e. treated as base) is
    // double-counted in the base total until confirmed.
    if (bc.isAlternate && owner != null) {
      push({
        key: `alternate_in_base_total:${key}`,
        kind: "alternate_in_base_total",
        severity: "red",
        ref: bc.ref,
        message: `Alternate line ${key} is counted in the base scope`,
      });
    }
    // A priced line nobody claims is unattributed money.
    if (owner == null && !bc.isAlternate) {
      push({
        key: `priced_line_no_clause:${key}`,
        kind: "priced_line_no_clause",
        severity: "amber",
        ref: bc.ref,
        message: `Priced line ${key} is not tied to any scope clause`,
      });
    }
  }

  return findings;
}

/**
 * RAG rollup. Red = any unresolved red finding; amber = any unresolved finding
 * (incl. `unclear` clauses); green = fully classified and all conflicts
 * resolved. An empty reconciliation (no clauses, no lines) is green.
 */
export function reconciliationStatus(rec: ScopeReconciliation): ReconciliationStatus {
  const findings = detectFindings(rec);
  if (findings.some((f) => f.severity === "red")) return "red";
  if (findings.length > 0) return "amber";
  return "green";
}

/**
 * The hand-off seam to the compile child (#367): the worker-facing warning
 * text the office authored on warning-bearing classifications. #367 stamps
 * these onto the delivering work package / task.
 */
export function warningsForCompile(
  rec: ScopeReconciliation,
): Array<{ clauseId: string; classification: ScopeClassification; warningText: string }> {
  const out: Array<{ clauseId: string; classification: ScopeClassification; warningText: string }> =
    [];
  for (const cc of rec.clauseClassifications) {
    if (WARNING_CLASSIFICATIONS.includes(cc.classification) && cc.warningText) {
      out.push({
        clauseId: cc.clauseId,
        classification: cc.classification,
        warningText: cc.warningText,
      });
    }
  }
  return out;
}

/** Record a resolve-or-accept against a finding key (idempotent on the key —
 *  a second resolution for the same key replaces the first). */
export function applyResolution(
  rec: ScopeReconciliation,
  resolution: ScopeResolution,
): ScopeReconciliation {
  const resolutions = [
    ...rec.resolutions.filter((r) => r.findingKey !== resolution.findingKey),
    resolution,
  ];
  return ScopeReconciliationSchema.parse({ ...rec, resolutions });
}

/** Set a clause's classification (and optional warning/boq/docs), preserving
 *  everything else. Pure — returns a new reconciliation.
 *
 *  When the patch carries `boqLineRefs` (the clause↔line link, the quote half
 *  of #366 AC1), the line records are kept in sync: every referenced line
 *  becomes owned by this clause (`owningClauseId`), and a line this clause
 *  previously owned but no longer references is released back to unowned — so
 *  linking a priced clause to its BOQ lines clears their
 *  `priced_line_no_clause` findings in the same operation, and unlinking
 *  reopens them. Only lines that exist in the linked quote are ever touched
 *  (the seeded records are the closed set — a ref to a line the quote doesn't
 *  have owns nothing). */
export function classifyClause(
  rec: ScopeReconciliation,
  clauseId: string,
  patch: Partial<Omit<ScopeClauseClassification, "clauseId">> & {
    classification: ScopeClassification;
  },
): ScopeReconciliation {
  const clauseClassifications = rec.clauseClassifications.map((cc) =>
    cc.clauseId === clauseId ? { ...cc, ...patch } : cc,
  );
  let boqClassifications = rec.boqClassifications;
  if (patch.boqLineRefs !== undefined) {
    // `Omit` over the passthrough-inferred record widens the field type — the
    // schema pins it to BoqLineRef[] (parsed below), so the assertion is sound.
    const refs = (patch.boqLineRefs ?? []) as ReadonlyArray<BoqLineRef>;
    const linked = new Set(refs.map((r) => boqLineRefKey(r)));
    boqClassifications = rec.boqClassifications.map((bc) => {
      const key = boqLineRefKey(bc.ref);
      if (linked.has(key)) return { ...bc, owningClauseId: clauseId };
      if (bc.owningClauseId === clauseId) return { ...bc, owningClauseId: null };
      return bc;
    });
  }
  return ScopeReconciliationSchema.parse({ ...rec, clauseClassifications, boqClassifications });
}

/** Mark (or unmark) a quote line as an alternate — priced but NOT part of the
 *  base scope until confirmed (the v2 QuoteLine carries no alternate flag, so
 *  the overlay is where it lives). A ref naming no seeded line changes nothing
 *  — the caller surfaces that honestly. Pure — returns a new reconciliation. */
export function setBoqLineAlternate(
  rec: ScopeReconciliation,
  ref: BoqLineRef,
  isAlternate: boolean,
): ScopeReconciliation {
  const key = boqLineRefKey(ref);
  const boqClassifications = rec.boqClassifications.map((bc) =>
    boqLineRefKey(bc.ref) === key ? { ...bc, isAlternate } : bc,
  );
  return ScopeReconciliationSchema.parse({ ...rec, boqClassifications });
}
