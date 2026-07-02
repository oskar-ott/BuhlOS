import { createHash } from "node:crypto";
import { z } from "zod";
import { isAdminRole } from "@/lib/auth/roles";
import type { ScopeOfWorkItem } from "@/domains/jobs/types";
import { QuoteSchema, type Quote } from "@/domains/quoting/schema";
import { boqLineRefKey, taskRefKey } from "@/domains/job-control/spine";
import {
  JobControlStageSchema,
  RequiredEvidenceKindSchema,
  TaskRefSchema,
} from "@/domains/job-control/schema";
import type { BoqLineRef, TaskRef } from "@/domains/job-control/types";
import {
  ScopeClassificationSchema,
  ScopeReconciliationSchema,
  ScopeResolutionSchema,
  applyResolution,
  classifyClause,
  detectFindings,
  reconcile,
  reconciliationStatus,
  seedReconciliation,
  setBoqLineAlternate,
} from "@/domains/job-control/reconciliation";
import type {
  ReconciliationFinding,
  ReconciliationStatus,
  ScopeClassification,
  ScopeClauseClassification,
  ScopeReconciliation,
  ScopeResolution,
} from "@/domains/job-control/reconciliation";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * L0 job-control reconciliation PRODUCER — the first runtime producer on the TS
 * App Router boundary (ADR: docs/architecture/job-control-runtime-adr.md, #463).
 *
 * `compileWorkPackages()` (L1) needs a real, confirmed `ScopeReconciliation`,
 * but nothing yet produces or persists one. This module is that producer: it
 * loads a job's real scope clauses (`Job.scopeOfWork[]`, #200), runs the tested
 * pure reconciliation engine (`src/domains/job-control/reconciliation.ts`, #366)
 * over admin-supplied classifications, and persists the CONFIRMED result to
 * `jobs/<jobId>/scope-reconciliation.json`.
 *
 * Scope discipline (do NOT cross these lines here):
 *   - It compiles NOTHING. No `compileWorkPackages()`, no `jobs/<jobId>/job-control.json`.
 *   - It mutates NO job tasks and touches NO Phil / variation surface.
 *   - It NEVER invents a classification. Any clause the office does not
 *     explicitly classify stays `unclear` (the engine's amber default) and is
 *     surfaced as a warning — unclassified scope never silently becomes field work.
 *
 * Design: the decision logic is PURE (`buildReconciliationPreview`,
 * `prepareReconciliationConfirm`, `computeScopeSourceHash`, `authorizeAdmin`) and
 * unit-tested directly. The I/O is behind an injectable {@link
 * ReconciliationProducerDeps} so preview/confirm/persistence are tested without
 * Next internals; `blobReconciliationDeps()` wires the real blob helpers.
 */

// ── Persistence ───────────────────────────────────────────────────────────────

/** Per-job home for the confirmed reconciliation. L1 reads `.reconciliation`
 *  from here. NOTE: this key is NOT yet registered in
 *  `api/_lib/backup-manifest.js` (which `check-backup-manifest.js` only scans);
 *  register it there before this becomes a trusted production store (ADR). */
export function scopeReconciliationKey(jobId: string): string {
  return `jobs/${jobId}/scope-reconciliation.json`;
}

export const ReconciliationStatusSchema = z.enum(["red", "amber", "green"]);

/** A serialisable snapshot of a finding — the "gaps" persisted alongside the
 *  confirmed reconciliation (findings are otherwise derived, never stored). */
export const ReconciliationWarningSchema = z
  .object({
    key: z.string(),
    kind: z.string(),
    severity: z.string(),
    clauseId: z.string().nullable().optional(),
    message: z.string(),
  })
  .passthrough();

/**
 * The persisted envelope. Wraps the domain `ScopeReconciliation` with the
 * provenance L1/admin need: the source hash it was confirmed against, a status
 * + warnings snapshot, and who/when. `.passthrough()` so later fields survive.
 */
export const PersistedScopeReconciliationSchema = z
  .object({
    jobId: z.string(),
    reconciliation: ScopeReconciliationSchema,
    status: ReconciliationStatusSchema,
    warnings: z.array(ReconciliationWarningSchema).default([]),
    sourceHash: z.string(),
    confirmedBy: z.string().nullable().default(null),
    confirmedAt: z.string().nullable().default(null),
    generatedAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type ReconciliationWarning = z.infer<typeof ReconciliationWarningSchema>;
export type PersistedScopeReconciliation = z.infer<typeof PersistedScopeReconciliationSchema>;

// ── Classification input ───────────────────────────────────────────────────--

/**
 * An admin classification for one clause — either the bare classification
 * (`"by_others"`) or an object carrying the warning text / note and, for a
 * field-delivered clause, the two fields that make the field proof loop
 * reachable: `deliveredBy` (the task coordinate the work happens on) and
 * `requiredEvidence` (the proof the office wants for it). The classification
 * MUST be one of the domain's closed set; an unknown value is rejected at parse
 * time (no fake classifications).
 *
 * `deliveredBy` / `requiredEvidence` are OPTIONAL, so an older client that sends
 * only `classification` / `warningText` / `note` is unchanged (zero regression);
 * the compiler still emits a `no_delivering_task` gap for a priced clause that
 * names no delivering task. A required-evidence item may omit its `id` — one is
 * DERIVED deterministically from the label (see {@link deriveRequiredEvidenceId})
 * so re-authoring the same proof keeps the same id and existing evidence links
 * stay valid; an explicit `id` always wins.
 */
export const ClauseClassificationInputSchema = z.union([
  ScopeClassificationSchema,
  z
    .object({
      classification: ScopeClassificationSchema,
      warningText: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      deliveredBy: z
        .array(
          z.object({
            areaId: z.string().min(1),
            stage: JobControlStageSchema,
            taskId: z.string().min(1),
          }),
        )
        .optional(),
      requiredEvidence: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            label: z.string().trim().min(1),
            kind: RequiredEvidenceKindSchema,
            note: z.string().nullable().optional(),
            /** OPTIONAL per-task scope (#502 authoring): when set, this proof
             *  applies to only this task instance; absent = package-level. */
            taskRef: TaskRefSchema.optional(),
          }),
        )
        .optional(),
      /** The quote half of AC1: the BOQ lines that price this clause. Each ref
       *  is checked against the LINKED quote's real lines — a ref naming a line
       *  the quote doesn't have is ignored and surfaced (never stored), so a
       *  stored link always points at real money. Linking a line marks it owned
       *  (clearing its `priced_line_no_clause` finding); dropping a previously
       *  linked line releases it. */
      boqLineRefs: z
        .array(
          z.object({
            quoteId: z.string().min(1),
            sectionId: z.string().min(1),
            lineId: z.string().min(1),
          }),
        )
        .optional(),
    })
    .passthrough(),
]);

/** Map of clauseId → classification. */
export const ClassificationsInputSchema = z.record(z.string(), ClauseClassificationInputSchema);
export type ClauseClassificationInput = z.infer<typeof ClauseClassificationInputSchema>;
export type ClassificationsInput = z.infer<typeof ClassificationsInputSchema>;

// ── BOQ-line input (the quote half of AC1) ────────────────────────────────────

/**
 * Per-line admin marks, keyed by `boqLineRefKey(ref)` (`quoteId/sectionId/lineId`).
 * Today the only mark is `isAlternate` — a line the workbook priced as an
 * "Alternative" (or the office knows is one) that must NOT count as base scope
 * until confirmed; tying an alternate line to a clause raises the red
 * `alternate_in_base_total` finding. Keys naming no line of the LINKED quote
 * are ignored and surfaced (`unknownBoqLineKeys`) — never stored.
 */
export const BoqLinesInputSchema = z.record(
  z.string(),
  z.object({ isAlternate: z.boolean() }).passthrough(),
);
export type BoqLinesInput = z.infer<typeof BoqLinesInputSchema>;

// ── Resolution input (resolve-or-accept-with-reason, #366 AC2/AC5) ───────────

/** The route-level message for an accept with no reason — exported so the route
 *  can return it verbatim as the 400 body (and tests can assert it). */
export const REASON_REQUIRED_MESSAGE = "A reason is required to accept a finding";

/**
 * One admin decision on a named finding, as it arrives on the wire: the
 * deterministic `findingKey` the engine produced, and the action — `resolved`
 * (the underlying conflict was fixed) or `accepted` (the office lives with it,
 * and MUST say why: an accept with no reason is rejected at parse time, per the
 * issue's "resolve-or-accept-with-reason"). The actor (`by`) and timestamp
 * (`at`) are NEVER client-supplied — the confirm flow stamps them from the
 * authoritative admin verification, mirroring `ScopeResolutionSchema`.
 */
export const ResolutionInputSchema = z
  .object({
    findingKey: z.string().min(1),
    action: z.enum(["resolved", "accepted"]),
    reason: z.string().nullable().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.action === "accepted" && !(r.reason ?? "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: REASON_REQUIRED_MESSAGE, path: ["reason"] });
    }
  });

export const ResolutionsInputSchema = z.array(ResolutionInputSchema);
export type ResolutionInput = z.infer<typeof ResolutionInputSchema>;
export type ResolutionsInput = z.infer<typeof ResolutionsInputSchema>;

/**
 * Deterministic id for an admin-authored required-evidence item when the author
 * omits one. FNV-1a over the trimmed label (the repo's id-derivation idiom, cf.
 * `deriveWorkPackageId`) → a stable `re_…` id: re-authoring the same proof yields
 * the same id, so a previously-recorded `EvidenceLink.requiredEvidenceId` keeps
 * pointing at the same requirement across recompiles (see schema.ts). Distinct
 * labels get distinct ids; never random, never time-based.
 *
 * Per-task authoring (#502): when a `taskRef` is supplied, it is folded into the
 * hash so the SAME label authored for two different task instances yields
 * DISTINCT ids (otherwise compile, which keys `requiredEvidence` by id, would
 * collapse them into one). A package-level item (no `taskRef`) keeps the
 * label-only id unchanged — back-compatible, so existing links keep resolving.
 */
export function deriveRequiredEvidenceId(label: string, taskRef?: TaskRef | null): string {
  const input = taskRef ? `${label.trim()}::${taskRefKey(taskRef)}` : label.trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `re_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

type ClausePatch = Partial<Omit<ScopeClauseClassification, "clauseId">> & {
  classification: ScopeClassification;
};

function normalisePatch(input: ClauseClassificationInput): ClausePatch {
  if (typeof input === "string") return { classification: input };
  const patch: ClausePatch = { classification: input.classification };
  if (input.warningText !== undefined) patch.warningText = input.warningText;
  if (input.note !== undefined) patch.note = input.note;
  if (input.deliveredBy !== undefined) {
    // Copy the task coordinate through verbatim — never a by-name guess; the
    // compiler validates each ref against the live structure (task_not_found).
    patch.deliveredBy = input.deliveredBy.map((t) => ({
      areaId: t.areaId,
      stage: t.stage,
      taskId: t.taskId,
    }));
  }
  if (input.boqLineRefs !== undefined) {
    // Copy the line refs through verbatim — the preview builder validates each
    // against the LINKED quote's real lines and strips (+ surfaces) unknowns.
    patch.boqLineRefs = input.boqLineRefs.map((r) => ({
      quoteId: r.quoteId,
      sectionId: r.sectionId,
      lineId: r.lineId,
    }));
  }
  if (input.requiredEvidence !== undefined) {
    // Preserve the authored proof; derive a stable id only when one is omitted.
    // We never fabricate proof — an absent `requiredEvidence` stays absent.
    patch.requiredEvidence = input.requiredEvidence.map((e) => ({
      id: e.id ?? deriveRequiredEvidenceId(e.label, e.taskRef),
      label: e.label.trim(),
      kind: e.kind,
      ...(e.note !== undefined ? { note: e.note } : {}),
      // carry the per-task scope through verbatim (compile copies the item as-is,
      // so it lands on WorkPackage.requiredEvidence and #506 filters by it).
      ...(e.taskRef ? { taskRef: e.taskRef } : {}),
    }));
  }
  return patch;
}

// ── Source hash (stale protection) ────────────────────────────────────────────

/**
 * Deterministic fingerprint of the reconciliation SOURCE — the scope clauses
 * (id/title/detail/order) and the linked quote's line refs. A confirm carrying
 * a different hash than the current source means the scope moved since preview;
 * the confirm is rejected so a stale classification can't be saved over changed
 * scope. Order-independent (clauses + lines are sorted).
 */
export function computeScopeSourceHash(
  clauses: ReadonlyArray<ScopeOfWorkItem>,
  quote: Quote | null,
): string {
  const norm = {
    clauses: clauses
      .map((c) => ({ id: c.id, title: c.title, detail: c.detail, order: c.order }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    quote: quote
      ? {
          id: quote.id,
          lines: quote.sections
            .flatMap((s) =>
              s.lines.map((l) =>
                boqLineRefKey({ quoteId: quote.id, sectionId: s.id, lineId: l.id }),
              ),
            )
            .sort(),
        }
      : null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

// ── Preview (pure) ─────────────────────────────────────────────────────────--

export interface ReconciliationPreviewResult {
  ok: true;
  jobId: string;
  draft: true;
  reconciliation: ScopeReconciliation;
  status: ReconciliationStatus;
  /** Unresolved findings (incl. every `unclear` clause) — the gaps to resolve. */
  warnings: ReconciliationFinding[];
  /** Clauses still `unclear` after classifications — never become field work silently. */
  unclassifiedClauseIds: string[];
  /** Classifications that named a clause not in the job scope — ignored, surfaced honestly. */
  unknownClauseIds: string[];
  /** Resolutions that named no open finding and no prior resolution — ignored,
   *  surfaced honestly (a resolution is only ever recorded against a real,
   *  engine-named finding; we never store a decision about nothing). */
  unknownFindingKeys: string[];
  /** BOQ line refs/keys that named no line of the linked quote (or arrived with
   *  no quote linked at all) — ignored, surfaced honestly; a stored link always
   *  points at a real priced line (no invented money). */
  unknownBoqLineKeys: string[];
  sourceHash: string;
}

/**
 * Build a reconciliation preview. Seeds (or re-reconciles over a prior), applies
 * the admin classifications, then any resolve-or-accept resolutions, and derives
 * status + warnings. PURE — persists nothing, compiles nothing, mutates no input.
 * All derivation stays in the engine: findings come from `detectFindings`,
 * resolutions land via `applyResolution` (which replaces on the same key and
 * never wipes the others).
 */
export function buildReconciliationPreview(input: {
  jobId: string;
  clauses: ReadonlyArray<ScopeOfWorkItem>;
  quote: Quote | null;
  prior: ScopeReconciliation | null;
  classifications?: ClassificationsInput;
  /** Per-line marks (isAlternate), keyed by boqLineRefKey — see BoqLinesInputSchema. */
  boqLines?: BoqLinesInput;
  /** Full resolution records (by/at already stamped by the confirm flow). */
  resolutions?: ReadonlyArray<ScopeResolution>;
}): ReconciliationPreviewResult {
  const { jobId, clauses, quote, prior, classifications, boqLines, resolutions } = input;

  const base = prior
    ? reconcile(prior, clauses, quote)
    : seedReconciliation(jobId, clauses, quote);

  // The closed set of REAL line keys — seeded 1:1 from the linked quote. Every
  // inbound line ref/key is checked against it; unknowns are surfaced, never
  // stored (no invented money).
  const realLineKeys = new Set(base.boqClassifications.map((b) => boqLineRefKey(b.ref)));
  const unknownBoqLineKeys: string[] = [];
  let rec = base;

  if (boqLines) {
    for (const [key, mark] of Object.entries(boqLines)) {
      const record = rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === key);
      if (!record) {
        unknownBoqLineKeys.push(key);
        continue;
      }
      rec = setBoqLineAlternate(rec, record.ref, mark.isAlternate);
    }
  }

  const clauseIds = new Set(clauses.map((c) => c.id));
  const unknownClauseIds: string[] = [];
  if (classifications) {
    for (const [clauseId, raw] of Object.entries(classifications)) {
      if (!clauseIds.has(clauseId)) {
        unknownClauseIds.push(clauseId); // never invent a clause the job doesn't have
        continue;
      }
      const patch = normalisePatch(raw);
      if (patch.boqLineRefs !== undefined) {
        // Keep only refs that name a real line of the LINKED quote; surface the
        // rest. An empty array is meaningful (unlink everything) and kept.
        // (`Omit` over the passthrough-inferred record widens the field type —
        // normalisePatch built it from the parsed input, so the assertion is sound.)
        const refs = (patch.boqLineRefs ?? []) as ReadonlyArray<BoqLineRef>;
        patch.boqLineRefs = refs.filter((r) => {
          const known = realLineKeys.has(boqLineRefKey(r));
          if (!known) unknownBoqLineKeys.push(boqLineRefKey(r));
          return known;
        });
      }
      rec = classifyClause(rec, clauseId, patch);
    }
  }

  // Apply resolutions AFTER classifications so the valid-key check sees the
  // findings this confirm actually produces. A key is valid when it names an
  // OPEN finding (resolve/accept it) or an already-resolved one (replace the
  // earlier decision — applyResolution is idempotent on the key). Anything else
  // is ignored and surfaced — never silently recorded.
  const unknownFindingKeys: string[] = [];
  if (resolutions && resolutions.length > 0) {
    const validKeys = new Set([
      ...detectFindings(rec).map((f) => f.key),
      ...rec.resolutions.map((r) => r.findingKey),
    ]);
    for (const r of resolutions) {
      if (!validKeys.has(r.findingKey)) {
        unknownFindingKeys.push(r.findingKey);
        continue;
      }
      rec = applyResolution(rec, r);
    }
  }

  const warnings = detectFindings(rec);
  const status = reconciliationStatus(rec);
  const unclassifiedClauseIds = rec.clauseClassifications
    .filter((c) => c.classification === "unclear")
    .map((c) => c.clauseId);

  return {
    ok: true,
    jobId,
    draft: true,
    reconciliation: rec,
    status,
    warnings,
    unclassifiedClauseIds,
    unknownClauseIds,
    unknownFindingKeys,
    unknownBoqLineKeys,
    sourceHash: computeScopeSourceHash(clauses, quote),
  };
}

// ── Confirm (pure) ───────────────────────────────────────────────────────────

export type ReconciliationConfirmPrep =
  | { ok: true; persisted: PersistedScopeReconciliation; preview: ReconciliationPreviewResult }
  | { ok: false; code: "stale_source"; error: string; currentSourceHash: string };

/**
 * Prepare the confirmed envelope to persist. Rebuilds the preview, then — when
 * an `expectedSourceHash` is supplied — rejects if the source has moved. PURE:
 * returns what to persist, never writes.
 */
export function prepareReconciliationConfirm(input: {
  jobId: string;
  clauses: ReadonlyArray<ScopeOfWorkItem>;
  quote: Quote | null;
  prior: PersistedScopeReconciliation | null;
  classifications?: ClassificationsInput;
  boqLines?: BoqLinesInput;
  resolutions?: ResolutionsInput;
  expectedSourceHash?: string | null;
  confirmedBy?: string | null;
  at: string;
}): ReconciliationConfirmPrep {
  // Stamp the actor + timestamp onto the wire resolutions HERE — never
  // client-supplied. `by` is the authoritatively verified admin identity the
  // confirm flow resolved ("office" only when the verified session carries no
  // usable name — the write was still admin-verified).
  const resolutionRecords = (input.resolutions ?? []).map((r) =>
    ScopeResolutionSchema.parse({
      findingKey: r.findingKey,
      action: r.action,
      reason: r.reason ?? null,
      by: input.confirmedBy ?? "office",
      at: input.at,
    }),
  );

  const preview = buildReconciliationPreview({
    jobId: input.jobId,
    clauses: input.clauses,
    quote: input.quote,
    prior: input.prior?.reconciliation ?? null,
    classifications: input.classifications,
    boqLines: input.boqLines,
    resolutions: resolutionRecords,
  });

  if (input.expectedSourceHash != null && input.expectedSourceHash !== preview.sourceHash) {
    return {
      ok: false,
      code: "stale_source",
      error:
        "The job scope changed since this reconciliation was previewed. Re-preview before confirming.",
      currentSourceHash: preview.sourceHash,
    };
  }

  const persisted = PersistedScopeReconciliationSchema.parse({
    jobId: input.jobId,
    reconciliation: { ...preview.reconciliation, updatedAt: input.at },
    status: preview.status,
    warnings: preview.warnings.map((w) => ({
      key: w.key,
      kind: w.kind,
      severity: w.severity,
      clauseId: w.clauseId ?? null,
      message: w.message,
    })),
    sourceHash: preview.sourceHash,
    confirmedBy: input.confirmedBy ?? null,
    confirmedAt: input.at,
    generatedAt: input.prior?.generatedAt ?? input.at,
    updatedAt: input.at,
  });

  return { ok: true, persisted, preview };
}

// ── Auth gate (pure) ──────────────────────────────────────────────────────────

export type AdminAuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

/** Mirror of the runtime-check gate: 401 with no role, 403 for a non-admin,
 *  ok for an admin-tier role. Both producer routes are admin-only. */
export function authorizeAdmin(role: string | null | undefined): AdminAuthResult {
  if (!role) return { ok: false, status: 401, error: "Not signed in" };
  if (!isAdminRole(role)) return { ok: false, status: 403, error: "Admin only" };
  return { ok: true };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

export interface ReconciliationProducerDeps {
  /** Load a job's real scope clauses (and linked quote, when one exists). */
  loadScope(
    jobId: string,
  ): Promise<{ found: boolean; clauses: ScopeOfWorkItem[]; quote: Quote | null }>;
  /** The previously confirmed envelope for this job, or null. */
  loadPrior(jobId: string): Promise<PersistedScopeReconciliation | null>;
  /** Persist a confirmed envelope. Only called by confirm, never preview. */
  savePersisted(jobId: string, persisted: PersistedScopeReconciliation): Promise<void>;
}

export type RunPreviewResult = ReconciliationPreviewResult | { ok: false; status: 404; error: string };

/** Preview flow: load → build → return. Writes NOTHING. */
export async function runReconciliationPreview(
  deps: ReconciliationProducerDeps,
  input: { jobId: string; classifications?: ClassificationsInput; boqLines?: BoqLinesInput },
): Promise<RunPreviewResult> {
  const { found, clauses, quote } = await deps.loadScope(input.jobId);
  if (!found) return { ok: false, status: 404, error: "Job not found" };
  const prior = await deps.loadPrior(input.jobId);
  return buildReconciliationPreview({
    jobId: input.jobId,
    clauses,
    quote,
    prior: prior?.reconciliation ?? null,
    classifications: input.classifications,
    boqLines: input.boqLines,
  });
}

export type RunConfirmResult =
  | {
      ok: true;
      jobId: string;
      saved: {
        key: string;
        status: ReconciliationStatus;
        sourceHash: string;
        confirmedBy: string | null;
        confirmedAt: string | null;
        updatedAt: string;
      };
      /** Resolution inputs that named no real finding — ignored, surfaced. */
      unknownFindingKeys: string[];
      /** BOQ line refs/keys that named no line of the linked quote — ignored, surfaced. */
      unknownBoqLineKeys: string[];
    }
  | { ok: false; status: 404 | 409; code?: "stale_source"; error: string; currentSourceHash?: string };

/** Confirm flow: load → prepare → (only if fresh) persist. A stale source
 *  returns 409 and writes NOTHING. */
export async function runReconciliationConfirm(
  deps: ReconciliationProducerDeps,
  input: {
    jobId: string;
    classifications?: ClassificationsInput;
    boqLines?: BoqLinesInput;
    resolutions?: ResolutionsInput;
    expectedSourceHash?: string | null;
    confirmedBy?: string | null;
    at: string;
  },
): Promise<RunConfirmResult> {
  const { found, clauses, quote } = await deps.loadScope(input.jobId);
  if (!found) return { ok: false, status: 404, error: "Job not found" };
  const prior = await deps.loadPrior(input.jobId);

  const prep = prepareReconciliationConfirm({
    jobId: input.jobId,
    clauses,
    quote,
    prior,
    classifications: input.classifications,
    boqLines: input.boqLines,
    resolutions: input.resolutions,
    expectedSourceHash: input.expectedSourceHash,
    confirmedBy: input.confirmedBy,
    at: input.at,
  });
  if (!prep.ok) {
    return {
      ok: false,
      status: 409,
      code: prep.code,
      error: prep.error,
      currentSourceHash: prep.currentSourceHash,
    };
  }

  await deps.savePersisted(input.jobId, prep.persisted);
  return {
    ok: true,
    jobId: input.jobId,
    saved: {
      key: scopeReconciliationKey(input.jobId),
      status: prep.persisted.status,
      sourceHash: prep.persisted.sourceHash,
      confirmedBy: prep.persisted.confirmedBy,
      confirmedAt: prep.persisted.confirmedAt,
      updatedAt: prep.persisted.updatedAt,
    },
    unknownFindingKeys: prep.preview.unknownFindingKeys,
    unknownBoqLineKeys: prep.preview.unknownBoqLineKeys,
  };
}

// ── Authoritative admin gate for the WRITE route ──────────────────────────────

/** The verified-session shape the authoritative check returns (subset of the
 *  session payload — see `verifyViaApi` / /api/auth?action=me). */
export interface VerifiedSession {
  role?: string | null;
  email?: string | null;
  name?: string | null;
  username?: string | null;
}

export type AuthoritativeAdminResult =
  | { ok: true; confirmedBy: string | null }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Authoritative admin gate for the confirm WRITE (ADR: a real mutation must use
 * the HMAC-verified check, not the unverified cookie decode). `verify` is the
 * injected `verifyViaApi` — it hits /api/auth?action=me, which verifies the
 * cookie's HMAC server-side. A missing / forged / unsigned / expired cookie
 * makes `verify` return null → 401; a verified non-admin → 403. The unverified
 * `decodeSessionCookie` is deliberately NOT used here.
 */
export async function authorizeAdminViaVerify(input: {
  cookieHeader: string;
  baseUrl: string;
  verify: (cookieHeader: string, baseUrl: string) => Promise<VerifiedSession | null>;
}): Promise<AuthoritativeAdminResult> {
  const verified = await input.verify(input.cookieHeader, input.baseUrl);
  const gate = authorizeAdmin(verified?.role ?? null);
  if (!gate.ok) return gate;
  return { ok: true, confirmedBy: verified?.username ?? verified?.email ?? verified?.name ?? null };
}

/**
 * Confirm behind the authoritative gate: verify → (only if a verified admin)
 * persist. A failed auth returns 401/403 and NEVER reaches `savePersisted`.
 * This is the single seam the confirm route uses and the tests exercise.
 */
export async function confirmReconciliationAuthorized(
  deps: ReconciliationProducerDeps,
  auth: {
    cookieHeader: string;
    baseUrl: string;
    verify: (cookieHeader: string, baseUrl: string) => Promise<VerifiedSession | null>;
  },
  input: {
    jobId: string;
    classifications?: ClassificationsInput;
    boqLines?: BoqLinesInput;
    resolutions?: ResolutionsInput;
    expectedSourceHash?: string | null;
    at: string;
  },
): Promise<RunConfirmResult | { ok: false; status: 401 | 403; error: string }> {
  const a = await authorizeAdminViaVerify(auth);
  if (!a.ok) return a;
  return runReconciliationConfirm(deps, {
    jobId: input.jobId,
    classifications: input.classifications,
    boqLines: input.boqLines,
    resolutions: input.resolutions,
    expectedSourceHash: input.expectedSourceHash,
    confirmedBy: a.confirmedBy,
    at: input.at,
  });
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

interface JobsBlob {
  jobs: Array<{ id: string; scopeOfWork?: ScopeOfWorkItem[]; fromQuoteId?: string }>;
}

/**
 * Production deps: scope clauses come from the existing `jobs.json` blob; the
 * prior + confirmed reconciliation live at `scopeReconciliationKey(jobId)`. The
 * job↔quote link is `job.fromQuoteId` → the v2 quote document
 * (`quotes-v2/<id>.json`), recorded by the BOQ-import create-job path and the
 * won-quote conversion (#365/#244). A missing/legacy/malformed quote document
 * yields `quote: null` — the engine never computes on a fabricated quote.
 */
export function blobReconciliationDeps(): ReconciliationProducerDeps {
  return {
    async loadScope(jobId) {
      const data = await readJsonBlob<JobsBlob>("jobs.json", { jobs: [] });
      const job = data?.jobs.find((j) => j.id === jobId) ?? null;
      if (!job) return { found: false, clauses: [], quote: null };
      let quote: Quote | null = null;
      if (job.fromQuoteId) {
        // Legacy fromQuoteId values point at the old quotes.json store — that
        // key simply doesn't exist under quotes-v2/ and safeParse guards the
        // rest, so only a real v2 quote ever reaches the engine.
        const raw = await readJsonBlob<unknown>(`quotes-v2/${job.fromQuoteId}.json`, null);
        const parsed = QuoteSchema.safeParse(raw);
        if (parsed.success) quote = parsed.data;
      }
      return { found: true, clauses: job.scopeOfWork ?? [], quote };
    },
    async loadPrior(jobId) {
      const raw = await readJsonBlob<unknown>(scopeReconciliationKey(jobId), null);
      if (!raw) return null;
      const parsed = PersistedScopeReconciliationSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async savePersisted(jobId, persisted) {
      await writeJsonBlob(scopeReconciliationKey(jobId), persisted);
    },
  };
}
