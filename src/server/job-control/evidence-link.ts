import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EvidenceLinkRoleSchema,
  EvidenceLinkSchema,
  ID_PREFIXES,
  TaskRefSchema,
} from "@/domains/job-control/schema";
import type { EvidenceLink, TaskRef } from "@/domains/job-control/types";
import { taskRefKey } from "@/domains/job-control/spine";
import {
  PersistedJobControlSchema,
  computeJobControlRevision,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * L4 evidence writer — links a captured proof to a compiled required-evidence
 * requirement by appending an `EvidenceLink` to `jobs/<jobId>/job-control.json`.
 * This is the loop closer: Phil shows "proof needed" (L2/L3) → a worker captures
 * → this writes the link → the existing read marks the requirement `met`.
 *
 * It lives in TS (NOT `api/evidence.js`) because, per the runtime ADR (#463), the
 * legacy JS Vercel functions cannot use the typed job-control domain, and the
 * job-control schema/validation must not be duplicated in JS. The normal
 * `EvidenceItem` save in `api/evidence.js` is UNCHANGED; this writer is a
 * separate, additive step invoked with the just-saved evidence id.
 *
 * Hard rules:
 *   - Touches ONLY `evidenceLinks` (+ `updatedAt`). `workPackages`, `compileMeta`,
 *     `claimLines`, `closeoutRequirements` and unrelated links are preserved.
 *   - The link is written ONLY after the target is validated (the work package
 *     exists AND carries the named required-evidence item). No fake package /
 *     requirement record is ever created.
 *   - Idempotent: a duplicate (workPackage + requirement + proof) request makes no
 *     new link and no write.
 *   - The link references the REAL saved proof id (evidence or observation); this
 *     module never invents a proof id.
 *   - A missing artifact ⇒ structured warning, no write (the evidence itself was
 *     already saved by `api/evidence.js`). An unreadable artifact ⇒ structured
 *     warning, artifact left untouched (never overwritten).
 *
 * Design mirrors the L0–L2 producers: pure core (`applyEvidenceLink`) + injectable
 * I/O deps (`EvidenceLinkDeps`), unit-tested without Next; `blobEvidenceLinkDeps()`
 * wires the real blob helpers.
 *
 * Concurrency: this and the admin compile producer share the `job-control.json`
 * key, so both participate in a shared REVISION precondition guard.
 * `writeEvidenceLink` REQUIRES `expectedRevision`; it rejects with
 * `409 stale_revision` when the stored artifact has moved since the caller read
 * it, and stamps the advanced revision on a successful write. This is an
 * application-level read → compare → write check, NOT `@vercel/blob` atomic CAS
 * (its `put` has no conditional write) — a sub-second same-revision (TOCTOU)
 * race still remains. See docs/architecture/job-control-revision-guard.md.
 *
 * Known limitation (deferred to the per-requirement capture micro-slice):
 *   - PROOF EXISTENCE IS TRUSTED, NOT VERIFIED. The writer persists the
 *     caller-supplied `evidenceId`/`observationId` verbatim; it never invents one,
 *     but it also does NOT confirm the referenced proof exists in the job's
 *     evidence store. The intended flow saves the evidence first and passes back
 *     its id. Server-side existence verification (or invoking this writer only
 *     from the evidence-save path) is the next slice — NOT evidence-store I/O here.
 */

// ── Request ────────────────────────────────────────────────────────────────--

export const EvidenceLinkRequestSchema = z.object({
  workPackageId: z.string().min(1),
  requiredEvidenceId: z.string().min(1),
  /** The saved proof — at least one of these is required (see `hasProof`). */
  evidenceId: z.string().min(1).nullable().optional(),
  observationId: z.string().min(1).nullable().optional(),
  /**
   * OPTIONAL per-task-instance scope (#502). Omit (every caller today) → a
   * PACKAGE-LEVEL link, byte-identical to before. Provide a `(areaId, stage,
   * taskId)` tuple → a TASK-SCOPED link that satisfies the requirement for only
   * that task instance (read by `isRequiredEvidenceMetForTask`). Additive and
   * back-compatible; no existing caller passes it.
   */
  taskRef: TaskRefSchema.nullable().optional(),
  role: EvidenceLinkRoleSchema.optional(), // defaults to "progress"
});
export type EvidenceLinkRequest = z.infer<typeof EvidenceLinkRequestSchema>;

/** A link must name a real proof — an evidence item or an observation. */
export function evidenceLinkRequestHasProof(req: EvidenceLinkRequest): boolean {
  return Boolean(req.evidenceId || req.observationId);
}

function proofId(req: EvidenceLinkRequest): string | null {
  return req.evidenceId ?? req.observationId ?? null;
}

/** True when two task scopes are the same. Two absent scopes (package-level)
 *  match; a present scope matches only an equal tuple. Keeps the idempotency key
 *  back-compatible: existing untagged links compare exactly as before. */
function sameTaskScope(a: TaskRef | null | undefined, b: TaskRef | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return taskRefKey(a) === taskRefKey(b);
}

// ── Pure apply ───────────────────────────────────────────────────────────────

export type EvidenceLinkApplyResult =
  | { ok: true; created: boolean; artifact: PersistedJobControl; link: EvidenceLink }
  | { ok: false; reason: "invalid_work_package" | "invalid_requirement" | "missing_proof" };

/**
 * Validate the target against the compiled artifact and return the artifact with
 * the link upserted. PURE — no I/O, no mutation of the input. `created` is false
 * when an equivalent link already exists (idempotent: caller skips the write).
 */
export function applyEvidenceLink(
  artifact: PersistedJobControl,
  request: EvidenceLinkRequest,
  ctx: { id: string; at: string; createdBy?: string | null },
): EvidenceLinkApplyResult {
  if (!evidenceLinkRequestHasProof(request)) return { ok: false, reason: "missing_proof" };

  const wp = artifact.workPackages.find((w) => w.id === request.workPackageId);
  if (!wp) return { ok: false, reason: "invalid_work_package" };

  const requirement = (wp.requiredEvidence ?? []).find((e) => e.id === request.requiredEvidenceId);
  if (!requirement) return { ok: false, reason: "invalid_requirement" };

  const pid = proofId(request);
  const existing = artifact.evidenceLinks.find(
    (el) =>
      el.workPackageId === request.workPackageId &&
      el.requiredEvidenceId === request.requiredEvidenceId &&
      (el.evidenceId ?? el.observationId ?? null) === pid &&
      // task scope is part of identity: the same proof scoped to a different task
      // (or package-level vs task-scoped) is a distinct link, not a duplicate.
      sameTaskScope(el.taskRef, request.taskRef),
  );
  if (existing) {
    // Idempotent — the same proof is already linked to this requirement (and task).
    return { ok: true, created: false, artifact, link: existing };
  }

  const link: EvidenceLink = EvidenceLinkSchema.parse({
    id: ctx.id,
    jobId: artifact.jobId,
    evidenceId: request.evidenceId ?? null,
    observationId: request.observationId ?? null,
    workPackageId: request.workPackageId,
    requiredEvidenceId: request.requiredEvidenceId,
    // only stamp a task scope when the caller opts in — otherwise the link is
    // byte-identical to a pre-#502 package-level link (no `taskRef` key).
    ...(request.taskRef ? { taskRef: request.taskRef } : {}),
    role: request.role ?? "progress",
    createdAt: ctx.at,
    ...(ctx.createdBy ? { createdBy: ctx.createdBy } : {}),
  });

  const base: PersistedJobControl = {
    ...artifact,
    evidenceLinks: [...artifact.evidenceLinks, link],
    updatedAt: ctx.at,
  };
  // Advance the shared revision token from the new content.
  const next: PersistedJobControl = { ...base, revision: computeJobControlRevision(base) };
  return { ok: true, created: true, artifact: next, link };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

export interface EvidenceLinkDeps {
  /** Load the raw compiled artifact, or null when it does not exist. */
  loadRaw(jobId: string): Promise<unknown | null>;
  /** Persist the updated artifact. Called ONLY when a new link is created. */
  save(jobId: string, artifact: PersistedJobControl): Promise<void>;
  /** Mint a fresh `el_…` link id. */
  mintId(): string;
}

export type WriteEvidenceLinkResult =
  | { ok: true; status: 200; created: boolean; link: EvidenceLink; revision: string }
  | {
      ok: false;
      status: 404 | 409;
      reason:
        | "missing"
        | "unreadable"
        | "stale_revision"
        | "invalid_work_package"
        | "invalid_requirement"
        | "missing_proof";
      warning: string;
      /** Present on `stale_revision` — the caller should re-read and retry. */
      currentRevision?: string;
    };

const WARNINGS: Record<Exclude<WriteEvidenceLinkResult, { ok: true }>["reason"], string> = {
  missing:
    "No compiled job-control artifact for this job — the evidence was saved, but not linked to required proof.",
  unreadable:
    "The compiled job-control artifact is unreadable — the evidence was saved, but not linked (artifact left untouched).",
  stale_revision:
    "The job-control artifact changed since it was read — the evidence was saved, but not linked (re-read and retry).",
  invalid_work_package: "That work package is not in the compiled job-control artifact — no link written.",
  invalid_requirement:
    "That required-evidence item is not on the work package in the compiled artifact — no link written.",
  missing_proof: "A saved evidence or observation id is required to link proof — no link written.",
};

/**
 * Write flow: load → validate target → (only if a new link) persist. A missing or
 * unreadable artifact is failed-soft with a structured warning and NO write — the
 * evidence save in `api/evidence.js` has already succeeded independently.
 */
export async function writeEvidenceLink(
  deps: EvidenceLinkDeps,
  input: {
    jobId: string;
    request: EvidenceLinkRequest;
    /** Revision precondition: the artifact revision the caller last read. Reject
     *  if the stored artifact has moved since (stale-write guard). */
    expectedRevision: string;
    at: string;
    createdBy?: string | null;
  },
): Promise<WriteEvidenceLinkResult> {
  const raw = await deps.loadRaw(input.jobId);
  if (raw == null) return { ok: false, status: 404, reason: "missing", warning: WARNINGS.missing };

  const parsed = PersistedJobControlSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 409, reason: "unreadable", warning: WARNINGS.unreadable };
  }

  // Stale-write guard: the artifact must be the revision the caller read.
  const currentRevision = jobControlRevisionOf(parsed.data);
  if (input.expectedRevision !== currentRevision) {
    return { ok: false, status: 409, reason: "stale_revision", warning: WARNINGS.stale_revision, currentRevision };
  }

  const applied = applyEvidenceLink(parsed.data, input.request, {
    id: deps.mintId(),
    at: input.at,
    createdBy: input.createdBy,
  });
  if (!applied.ok) {
    return { ok: false, status: 409, reason: applied.reason, warning: WARNINGS[applied.reason] };
  }

  // Only write when a genuinely new link was created (idempotent no-op otherwise).
  if (applied.created) await deps.save(input.jobId, applied.artifact);
  return {
    ok: true,
    status: 200,
    created: applied.created,
    link: applied.link,
    revision: jobControlRevisionOf(applied.artifact),
  };
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

export function blobEvidenceLinkDeps(): EvidenceLinkDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(jobControlKey(jobId), null),
    save: (jobId, artifact) => writeJsonBlob(jobControlKey(jobId), artifact),
    mintId: () => `${ID_PREFIXES.evidenceLink}${randomUUID()}`,
  };
}
