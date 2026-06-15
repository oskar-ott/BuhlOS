import { createHash } from "node:crypto";
import { z } from "zod";
import { isAdminRole } from "@/lib/auth/roles";
import type { ScopeOfWorkItem } from "@/domains/jobs/types";
import type { Quote } from "@/domains/quoting/schema";
import { boqLineRefKey } from "@/domains/job-control/spine";
import {
  JobControlStageSchema,
  RequiredEvidenceKindSchema,
} from "@/domains/job-control/schema";
import {
  ScopeClassificationSchema,
  ScopeReconciliationSchema,
  classifyClause,
  detectFindings,
  reconcile,
  reconciliationStatus,
  seedReconciliation,
} from "@/domains/job-control/reconciliation";
import type {
  ReconciliationFinding,
  ReconciliationStatus,
  ScopeClassification,
  ScopeClauseClassification,
  ScopeReconciliation,
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

/**
 * Deterministic id for an admin-authored required-evidence item when the author
 * omits one. FNV-1a over the trimmed label (the repo's id-derivation idiom, cf.
 * `deriveWorkPackageId`) → a stable `re_…` id: re-authoring the same proof yields
 * the same id, so a previously-recorded `EvidenceLink.requiredEvidenceId` keeps
 * pointing at the same requirement across recompiles (see schema.ts). Distinct
 * labels get distinct ids; never random, never time-based.
 */
export function deriveRequiredEvidenceId(label: string): string {
  const input = label.trim();
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
  if (input.requiredEvidence !== undefined) {
    // Preserve the authored proof; derive a stable id only when one is omitted.
    // We never fabricate proof — an absent `requiredEvidence` stays absent.
    patch.requiredEvidence = input.requiredEvidence.map((e) => ({
      id: e.id ?? deriveRequiredEvidenceId(e.label),
      label: e.label.trim(),
      kind: e.kind,
      ...(e.note !== undefined ? { note: e.note } : {}),
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
  sourceHash: string;
}

/**
 * Build a reconciliation preview. Seeds (or re-reconciles over a prior), applies
 * the admin classifications, and derives status + warnings. PURE — persists
 * nothing, compiles nothing, mutates no input.
 */
export function buildReconciliationPreview(input: {
  jobId: string;
  clauses: ReadonlyArray<ScopeOfWorkItem>;
  quote: Quote | null;
  prior: ScopeReconciliation | null;
  classifications?: ClassificationsInput;
}): ReconciliationPreviewResult {
  const { jobId, clauses, quote, prior, classifications } = input;

  const base = prior
    ? reconcile(prior, clauses, quote)
    : seedReconciliation(jobId, clauses, quote);

  const clauseIds = new Set(clauses.map((c) => c.id));
  const unknownClauseIds: string[] = [];
  let rec = base;
  if (classifications) {
    for (const [clauseId, raw] of Object.entries(classifications)) {
      if (!clauseIds.has(clauseId)) {
        unknownClauseIds.push(clauseId); // never invent a clause the job doesn't have
        continue;
      }
      rec = classifyClause(rec, clauseId, normalisePatch(raw));
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
  expectedSourceHash?: string | null;
  confirmedBy?: string | null;
  at: string;
}): ReconciliationConfirmPrep {
  const preview = buildReconciliationPreview({
    jobId: input.jobId,
    clauses: input.clauses,
    quote: input.quote,
    prior: input.prior?.reconciliation ?? null,
    classifications: input.classifications,
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
  input: { jobId: string; classifications?: ClassificationsInput },
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
    }
  | { ok: false; status: 404 | 409; code?: "stale_source"; error: string; currentSourceHash?: string };

/** Confirm flow: load → prepare → (only if fresh) persist. A stale source
 *  returns 409 and writes NOTHING. */
export async function runReconciliationConfirm(
  deps: ReconciliationProducerDeps,
  input: {
    jobId: string;
    classifications?: ClassificationsInput;
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
    expectedSourceHash?: string | null;
    at: string;
  },
): Promise<RunConfirmResult | { ok: false; status: 401 | 403; error: string }> {
  const a = await authorizeAdminViaVerify(auth);
  if (!a.ok) return a;
  return runReconciliationConfirm(deps, {
    jobId: input.jobId,
    classifications: input.classifications,
    expectedSourceHash: input.expectedSourceHash,
    confirmedBy: a.confirmedBy,
    at: input.at,
  });
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

interface JobsBlob {
  jobs: Array<{ id: string; scopeOfWork?: ScopeOfWorkItem[] }>;
}

/**
 * Production deps: scope clauses come from the existing `jobs.json` blob; the
 * prior + confirmed reconciliation live at `scopeReconciliationKey(jobId)`. The
 * job↔quote link is #244 (not live), so the quote is always null today — never
 * fabricated.
 */
export function blobReconciliationDeps(): ReconciliationProducerDeps {
  return {
    async loadScope(jobId) {
      const data = await readJsonBlob<JobsBlob>("jobs.json", { jobs: [] });
      const job = data?.jobs.find((j) => j.id === jobId) ?? null;
      if (!job) return { found: false, clauses: [], quote: null };
      return { found: true, clauses: job.scopeOfWork ?? [], quote: null };
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
