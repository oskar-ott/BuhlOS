import { createHash } from "node:crypto";
import { z } from "zod";
import {
  JobControlSpineSchema,
  TaskRefSchema,
} from "@/domains/job-control/schema";
import {
  compileWorkPackages,
  diffCompile,
  type CompileGap,
  type CompileResult,
  type JobStructure,
} from "@/domains/job-control/compile";
import type { WorkPackage } from "@/domains/job-control/types";
import {
  PersistedScopeReconciliationSchema,
  authorizeAdminViaVerify,
  scopeReconciliationKey,
  type PersistedScopeReconciliation,
  type VerifiedSession,
} from "./reconciliation-producer";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * L1 job-control compile PRODUCER — turns a confirmed `ScopeReconciliation`
 * (L0, #465) into the compiled job-control artifact `jobs/<jobId>/job-control.json`.
 * Runtime boundary per the ADR (docs/architecture/job-control-runtime-adr.md).
 *
 * It reads the persisted reconciliation + the job's structure, runs the tested
 * pure compiler (`src/domains/job-control/compile.ts`, #367), diffs against any
 * existing artifact, and — only on an authoritative-admin confirm — persists the
 * result.
 *
 * Scope discipline (held by review):
 *   - The compiler is the ONLY source of work packages. No package is invented
 *     here; the compiler NEVER mints a task — unclassified / unbacked clauses
 *     become NAMED GAPS, preserved in `compileMeta.gaps`, never tasks.
 *   - Mutates NO job tasks (state stays in `dwellings`), touches NO Phil, no
 *     variation domain, no Supabase.
 *   - Preview persists NOTHING. Confirm writes ONLY `jobs/<jobId>/job-control.json`,
 *     preserving any claim/closeout/evidence arrays an existing artifact carries.
 *   - Confirm uses the authoritative HMAC-verified gate (reused from L0); a
 *     forged cookie cannot reach the write.
 *
 * Design mirrors the L0 producer: pure decision logic + injectable I/O deps
 * (`CompileProducerDeps`) so preview/confirm/persistence/stale/auth are
 * unit-tested without Next; `blobCompileDeps()` wires the real blob helpers.
 */

/** Narrow, additive compiler version stamp (no version existed in the domain). */
export const JOB_CONTROL_COMPILER_VERSION = "1";

/** Per-job home for the compiled artifact. Covered by the `jobs/` backup prefix. */
export function jobControlKey(jobId: string): string {
  return `jobs/${jobId}/job-control.json`;
}

// ── Persisted artifact schema ────────────────────────────────────────────────-

/** Serialisable snapshot of a compile gap (gaps are otherwise derived). */
export const PersistedCompileGapSchema = z
  .object({
    kind: z.string(),
    clauseId: z.string().nullable().optional(),
    ref: TaskRefSchema.nullable().optional(),
    message: z.string(),
  })
  .passthrough();

export const CompileDiffSummarySchema = z
  .object({ added: z.number(), updated: z.number(), removed: z.number() })
  .passthrough();

/** L1 provenance carried alongside the spine. */
export const JobControlCompileMetaSchema = z
  .object({
    generatedAt: z.string(),
    confirmedAt: z.string().nullable().default(null),
    confirmedBy: z.string().nullable().default(null),
    compilerVersion: z.string(),
    /** The L1 compile-source hash (reconciliation + structure) — for stale detection. */
    sourceHash: z.string(),
    /** The L0 envelope's scope source hash — provenance trace. */
    sourceReconciliationHash: z.string(),
    sourceStructureHash: z.string(),
    gaps: z.array(PersistedCompileGapSchema).default([]),
    diff: CompileDiffSummarySchema,
  })
  .passthrough();

/**
 * `jobs/<jobId>/job-control.json` — the domain `JobControlSpine` (so L2 reads
 * top-level `workPackages` / `evidenceLinks`) plus L1 `compileMeta`. `.optional()`
 * on the meta keeps reads of any pre-existing artifact tolerant; the write always
 * stamps it.
 */
export const PersistedJobControlSchema = JobControlSpineSchema.extend({
  compileMeta: JobControlCompileMetaSchema.optional(),
  /** Stale-write precondition token shared by both writers (revision guard).
   *  `.optional()` so pre-guard artifacts read fine; every write after this
   *  stamps it. */
  revision: z.string().optional(),
}).passthrough();

export type PersistedCompileGap = z.infer<typeof PersistedCompileGapSchema>;
export type PersistedJobControl = z.infer<typeof PersistedJobControlSchema>;

// ── Artifact revision (stale-write precondition) ──────────────────────────────

/**
 * Content fingerprint used as the artifact REVISION — the precondition token both
 * `job-control.json` writers (compile + evidence-link) share. Excludes `revision`
 * and `updatedAt` so it is a stable function of meaningful content.
 *
 * NOT atomic CAS: `@vercel/blob` `put` (via `writeJsonBlob`) has no conditional
 * write, so a writer reads → compares this revision → writes. That closes the
 * common stale-write paths (stale preview, sequential writes, recompile-after-
 * link), but a sub-second read-then-write (TOCTOU) race can still slip through.
 * See docs/architecture/job-control-revision-guard.md.
 */
export function computeJobControlRevision(
  a: Pick<
    PersistedJobControl,
    "jobId" | "workPackages" | "evidenceLinks" | "claimLines" | "closeoutRequirements" | "compileMeta"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        jobId: a.jobId,
        workPackages: a.workPackages,
        evidenceLinks: a.evidenceLinks,
        claimLines: a.claimLines,
        closeoutRequirements: a.closeoutRequirements,
        compileMeta: a.compileMeta ?? null,
      }),
    )
    .digest("hex");
}

/** The artifact's revision — its stored token, or computed for a pre-guard
 *  artifact (migration-on-read; no write needed to read a stable revision). */
export function jobControlRevisionOf(a: PersistedJobControl): string {
  return a.revision ?? computeJobControlRevision(a);
}

// ── Source hashing (stale protection) ──────────────────────────────────────--

/** Deterministic fingerprint of the job structure the compile depends on. */
export function computeStructureHash(structure: JobStructure): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: structure.id,
        roughInTasks: structure.roughInTasks ?? null,
        fitOffTasks: structure.fitOffTasks ?? null,
        areaGroups: structure.areaGroups ?? null,
      }),
    )
    .digest("hex");
}

/**
 * The L1 compile SOURCE hash: changes if the confirmed reconciliation OR the job
 * structure changes since preview, so a stale confirm is caught.
 */
export function computeCompileSourceHash(
  persistedReconciliation: PersistedScopeReconciliation,
  structure: JobStructure,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reconciliationSourceHash: persistedReconciliation.sourceHash,
        reconciliation: persistedReconciliation.reconciliation,
        structureHash: computeStructureHash(structure),
      }),
    )
    .digest("hex");
}

// ── Preview (pure) ───────────────────────────────────────────────────────────

export interface CompilePreviewResult {
  ok: true;
  jobId: string;
  draft: true;
  workPackages: WorkPackage[];
  gaps: CompileGap[];
  diff: {
    added: number;
    updated: number;
    removed: number;
    addedPackages: WorkPackage[];
    updatedPackages: Array<{ id: string; before: WorkPackage; after: WorkPackage }>;
    removedPackages: WorkPackage[];
  };
  sourceHash: string;
  sourceReconciliationHash: string;
  sourceStructureHash: string;
  hasPrevious: boolean;
}

/**
 * Compile the confirmed reconciliation against the structure and diff against any
 * existing artifact. PURE — persists nothing, mutates nothing.
 */
export function buildCompilePreview(input: {
  jobId: string;
  persistedReconciliation: PersistedScopeReconciliation;
  structure: JobStructure;
  previous: PersistedJobControl | null;
}): CompilePreviewResult {
  const compile = compileWorkPackages(input.persistedReconciliation.reconciliation, input.structure);
  const previousResult: CompileResult | null = input.previous
    ? { workPackages: input.previous.workPackages, gaps: [] }
    : null;
  const diff = diffCompile(previousResult, compile);

  return {
    ok: true,
    jobId: input.jobId,
    draft: true,
    workPackages: compile.workPackages,
    gaps: compile.gaps,
    diff: {
      added: diff.addedPackages.length,
      updated: diff.updatedPackages.length,
      removed: diff.removedPackages.length,
      addedPackages: diff.addedPackages,
      updatedPackages: diff.updatedPackages,
      removedPackages: diff.removedPackages,
    },
    sourceHash: computeCompileSourceHash(input.persistedReconciliation, input.structure),
    sourceReconciliationHash: input.persistedReconciliation.sourceHash,
    sourceStructureHash: computeStructureHash(input.structure),
    hasPrevious: input.previous != null,
  };
}

// ── Confirm (pure) ───────────────────────────────────────────────────────────

export type CompileConfirmPrep =
  | { ok: true; persisted: PersistedJobControl; preview: CompilePreviewResult }
  | { ok: false; code: "stale_source"; error: string; currentSourceHash: string }
  | { ok: false; code: "stale_revision"; error: string; currentRevision: string };

/**
 * Prepare the artifact to persist. Rebuilds the preview, enforces the optional
 * stale-source check, and assembles the `JobControlSpine` — compiled
 * `workPackages` + PRESERVED claim/closeout/evidence arrays + `compileMeta`
 * (incl. the named gaps). PURE: returns what to persist, never writes.
 */
export function prepareCompileConfirm(input: {
  jobId: string;
  persistedReconciliation: PersistedScopeReconciliation;
  structure: JobStructure;
  previous: PersistedJobControl | null;
  expectedSourceHash?: string | null;
  /** Optional artifact-revision precondition — reject if the existing
   *  job-control.json moved since the caller read it (e.g. an evidence-link
   *  append landed). Optional for compatibility (no UI passes it yet). */
  expectedRevision?: string | null;
  confirmedBy?: string | null;
  at: string;
}): CompileConfirmPrep {
  if (
    input.expectedRevision != null &&
    input.previous != null &&
    jobControlRevisionOf(input.previous) !== input.expectedRevision
  ) {
    return {
      ok: false,
      code: "stale_revision",
      error:
        "The job-control.json artifact changed since it was read (a newer write landed). Re-read it before confirming.",
      currentRevision: jobControlRevisionOf(input.previous),
    };
  }

  const preview = buildCompilePreview({
    jobId: input.jobId,
    persistedReconciliation: input.persistedReconciliation,
    structure: input.structure,
    previous: input.previous,
  });

  if (input.expectedSourceHash != null && input.expectedSourceHash !== preview.sourceHash) {
    return {
      ok: false,
      code: "stale_source",
      error:
        "The reconciliation or job structure changed since this compile was previewed. Re-preview before confirming.",
      currentSourceHash: preview.sourceHash,
    };
  }

  const persisted = PersistedJobControlSchema.parse({
    jobId: input.jobId,
    workPackages: preview.workPackages,
    // L1 produces only work packages; never clobber arrays other producers own.
    claimLines: input.previous?.claimLines ?? [],
    closeoutRequirements: input.previous?.closeoutRequirements ?? [],
    evidenceLinks: input.previous?.evidenceLinks ?? [],
    updatedAt: input.at,
    compileMeta: {
      generatedAt: input.previous?.compileMeta?.generatedAt ?? input.at,
      confirmedAt: input.at,
      confirmedBy: input.confirmedBy ?? null,
      compilerVersion: JOB_CONTROL_COMPILER_VERSION,
      sourceHash: preview.sourceHash,
      sourceReconciliationHash: preview.sourceReconciliationHash,
      sourceStructureHash: preview.sourceStructureHash,
      gaps: preview.gaps.map((g) => ({
        kind: g.kind,
        clauseId: g.clauseId ?? null,
        ref: g.ref ?? null,
        message: g.message,
      })),
      diff: { added: preview.diff.added, updated: preview.diff.updated, removed: preview.diff.removed },
    },
  });

  // Stamp the revision from the parsed content (excludes revision/updatedAt), so a
  // subsequent read recomputes the same token (self-consistent).
  const stamped: PersistedJobControl = { ...persisted, revision: computeJobControlRevision(persisted) };
  return { ok: true, persisted: stamped, preview };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

/**
 * Result of loading the existing artifact. `unreadable` (a blob that exists but
 * fails the schema) is kept DISTINCT from `absent` so confirm can refuse to
 * overwrite — silently treating a corrupt artifact as "no previous" would wipe
 * the claim/closeout/evidence arrays L1 must preserve.
 */
export type LoadPreviousResult =
  | { status: "absent" }
  | { status: "ok"; value: PersistedJobControl }
  | { status: "unreadable" };

export interface CompileProducerDeps {
  loadStructure(jobId: string): Promise<{ found: boolean; structure: JobStructure | null }>;
  loadReconciliation(jobId: string): Promise<PersistedScopeReconciliation | null>;
  loadPrevious(jobId: string): Promise<LoadPreviousResult>;
  savePersisted(jobId: string, persisted: PersistedJobControl): Promise<void>;
}

export type RunCompilePreviewResult =
  | CompilePreviewResult
  | { ok: false; status: 404 | 409; code: "job_not_found" | "no_reconciliation"; error: string };

/** Preview flow: load → compile → diff → return. Writes NOTHING. */
export async function runCompilePreview(
  deps: CompileProducerDeps,
  input: { jobId: string },
): Promise<RunCompilePreviewResult> {
  const { found, structure } = await deps.loadStructure(input.jobId);
  if (!found || !structure) {
    return { ok: false, status: 404, code: "job_not_found", error: "Job not found" };
  }
  const rec = await deps.loadReconciliation(input.jobId);
  if (!rec) {
    return {
      ok: false,
      status: 409,
      code: "no_reconciliation",
      error: "No confirmed reconciliation for this job — confirm scope reconciliation (L0) first",
    };
  }
  // Preview is read-only, so an unreadable existing artifact is treated as "no
  // previous" (diff shows all-added) — it never risks overwriting it.
  const prev = await deps.loadPrevious(input.jobId);
  const previous = prev.status === "ok" ? prev.value : null;
  return buildCompilePreview({ jobId: input.jobId, persistedReconciliation: rec, structure, previous });
}

export type RunCompileConfirmResult =
  | {
      ok: true;
      jobId: string;
      saved: {
        key: string;
        workPackageCount: number;
        gapCount: number;
        sourceHash: string;
        revision: string;
        confirmedBy: string | null;
        confirmedAt: string | null;
        updatedAt: string;
        diff: { added: number; updated: number; removed: number };
      };
    }
  | {
      ok: false;
      status: 404 | 409;
      code?: "job_not_found" | "no_reconciliation" | "stale_source" | "stale_revision" | "unreadable_previous";
      error: string;
      currentSourceHash?: string;
      currentRevision?: string;
    };

/** Confirm flow: load → prepare → (only if fresh) persist. Stale → 409, no write. */
export async function runCompileConfirm(
  deps: CompileProducerDeps,
  input: {
    jobId: string;
    expectedSourceHash?: string | null;
    expectedRevision?: string | null;
    confirmedBy?: string | null;
    at: string;
  },
): Promise<RunCompileConfirmResult> {
  const { found, structure } = await deps.loadStructure(input.jobId);
  if (!found || !structure) {
    return { ok: false, status: 404, code: "job_not_found", error: "Job not found" };
  }
  const rec = await deps.loadReconciliation(input.jobId);
  if (!rec) {
    return {
      ok: false,
      status: 409,
      code: "no_reconciliation",
      error: "No confirmed reconciliation for this job — confirm scope reconciliation (L0) first",
    };
  }
  // Refuse to overwrite an existing-but-unreadable artifact — it may carry
  // claim/closeout/evidence arrays we cannot reconstruct.
  const prev = await deps.loadPrevious(input.jobId);
  if (prev.status === "unreadable") {
    return {
      ok: false,
      status: 409,
      code: "unreadable_previous",
      error:
        "The existing job-control.json is unreadable — not overwriting it. Inspect or restore it before confirming.",
    };
  }
  const previous = prev.status === "ok" ? prev.value : null;

  const prep = prepareCompileConfirm({
    jobId: input.jobId,
    persistedReconciliation: rec,
    structure,
    previous,
    expectedSourceHash: input.expectedSourceHash,
    expectedRevision: input.expectedRevision,
    confirmedBy: input.confirmedBy,
    at: input.at,
  });
  if (!prep.ok) {
    return {
      ok: false,
      status: 409,
      code: prep.code,
      error: prep.error,
      ...(prep.code === "stale_source" ? { currentSourceHash: prep.currentSourceHash } : {}),
      ...(prep.code === "stale_revision" ? { currentRevision: prep.currentRevision } : {}),
    };
  }

  await deps.savePersisted(input.jobId, prep.persisted);
  const meta = prep.persisted.compileMeta;
  return {
    ok: true,
    jobId: input.jobId,
    saved: {
      key: jobControlKey(input.jobId),
      workPackageCount: prep.persisted.workPackages.length,
      gapCount: meta?.gaps.length ?? 0,
      sourceHash: meta?.sourceHash ?? prep.preview.sourceHash,
      revision: jobControlRevisionOf(prep.persisted),
      confirmedBy: meta?.confirmedBy ?? null,
      confirmedAt: meta?.confirmedAt ?? null,
      updatedAt: prep.persisted.updatedAt ?? input.at,
      diff: { added: prep.preview.diff.added, updated: prep.preview.diff.updated, removed: prep.preview.diff.removed },
    },
  };
}

/**
 * Confirm behind the authoritative admin gate (reused from L0): verify → (only
 * if a verified admin) persist. A failed auth returns 401/403 and NEVER reaches
 * `savePersisted`.
 */
export async function confirmCompileAuthorized(
  deps: CompileProducerDeps,
  auth: {
    cookieHeader: string;
    baseUrl: string;
    verify: (cookieHeader: string, baseUrl: string) => Promise<VerifiedSession | null>;
  },
  input: { jobId: string; expectedSourceHash?: string | null; expectedRevision?: string | null; at: string },
): Promise<RunCompileConfirmResult | { ok: false; status: 401 | 403; error: string }> {
  const a = await authorizeAdminViaVerify(auth);
  if (!a.ok) return a;
  return runCompileConfirm(deps, {
    jobId: input.jobId,
    expectedSourceHash: input.expectedSourceHash,
    expectedRevision: input.expectedRevision,
    confirmedBy: a.confirmedBy,
    at: input.at,
  });
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

interface JobsBlob {
  jobs: Array<{ id: string } & Partial<JobStructure>>;
}

/**
 * Production deps: structure comes from the existing `jobs.json` blob; the
 * confirmed reconciliation from L0's `scope-reconciliation.json`; the prior +
 * written artifact at `jobControlKey(jobId)`.
 */
export function blobCompileDeps(): CompileProducerDeps {
  return {
    async loadStructure(jobId) {
      const data = await readJsonBlob<JobsBlob>("jobs.json", { jobs: [] });
      const job = data?.jobs.find((j) => j.id === jobId) ?? null;
      if (!job) return { found: false, structure: null };
      return {
        found: true,
        structure: {
          id: job.id,
          areaGroups: job.areaGroups,
          roughInTasks: job.roughInTasks,
          fitOffTasks: job.fitOffTasks,
        },
      };
    },
    async loadReconciliation(jobId) {
      const raw = await readJsonBlob<unknown>(scopeReconciliationKey(jobId), null);
      if (!raw) return null;
      const parsed = PersistedScopeReconciliationSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async loadPrevious(jobId) {
      const raw = await readJsonBlob<unknown>(jobControlKey(jobId), null);
      if (raw == null) return { status: "absent" };
      const parsed = PersistedJobControlSchema.safeParse(raw);
      // A blob that exists but doesn't parse is UNREADABLE, not absent — confirm
      // must refuse rather than clobber preserved arrays.
      return parsed.success ? { status: "ok", value: parsed.data } : { status: "unreadable" };
    },
    async savePersisted(jobId, persisted) {
      await writeJsonBlob(jobControlKey(jobId), persisted);
    },
  };
}
