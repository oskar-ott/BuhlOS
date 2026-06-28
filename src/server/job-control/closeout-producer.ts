import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CloseoutAreaScopeSchema,
  CloseoutFulfilmentLinkSchema,
  CloseoutRequirementKindSchema,
  CloseoutRequirementSchema,
  ID_PREFIXES,
} from "@/domains/job-control/schema";
import type { CloseoutRequirement } from "@/domains/job-control/types";
import {
  deriveCloseoutStatus,
  type CloseoutKnownIds,
} from "@/domains/job-control/closeout-matrix";
import {
  PersistedJobControlSchema,
  computeJobControlRevision,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { loadJobProofIds } from "./evidence-link";
import { loadJobCloseoutKnownIds } from "./closeout-read";
import { readJsonBlob, writeJsonBlob } from "./blob";

/**
 * Closeout matrix WRITER (#374) — applies an add / remove / link / confirm /
 * waive op to a job's `closeoutRequirements[]` on `jobs/<jobId>/job-control.json`
 * (the SPINE — NOT `jobs/<jobId>/closeout.json`, which is #349's numbers-freeze
 * report card and must never be touched here).
 *
 * Hard rules (held by review):
 *   - Touches ONLY `closeoutRequirements[]` (+ `updatedAt` + `revision`).
 *     `workPackages`, `claimLines`, `evidenceLinks`, `proofReviews` and
 *     `compileMeta` are PRESERVED byte-for-byte.
 *   - `satisfied` is NEVER stored as a free verdict: after every op the affected
 *     requirement's status is RE-DERIVED from its links + admin confirmation +
 *     the live id sets (`deriveCloseoutStatus`). A confirm whose link has gone
 *     dangling lands `in_progress`, not `satisfied`.
 *   - Honours the shared REVISION precondition exactly like evidence-link.ts:
 *     `writeCloseout` requires `expectedRevision` and returns `409 stale_revision`
 *     when the stored artifact moved since the caller read it.
 *   - This is application-level read→compare→write, not blob atomic CAS (a
 *     sub-second TOCTOU race remains — see the revision-guard doc).
 *
 * Design mirrors the evidence-link / proof-review writers: pure core
 * (`applyCloseoutOp`) + injectable I/O (`CloseoutDeps`), unit-tested without
 * Next; `blobCloseoutDeps()` wires the real blob helpers.
 */

// ── Op request ─────────────────────────────────────────────────────────────--

export const CloseoutOpSchema = z.discriminatedUnion("op", [
  /** Add a new (manual) requirement. */
  z
    .object({
      op: z.literal("add"),
      title: z.string().trim().min(1),
      kind: CloseoutRequirementKindSchema,
      scopeClauseIds: z.array(z.string()).optional(),
      areaScope: CloseoutAreaScopeSchema.optional(),
    })
    .strict(),
  /** Remove a requirement by id. */
  z.object({ op: z.literal("remove"), requirementId: z.string().min(1) }).strict(),
  /** Set the fulfilment links on a requirement (replace; pass [] to clear). A
   *  confirmed requirement whose links change has its confirmation CLEARED — the
   *  office must re-confirm against the new evidence, never inherit a stale tick. */
  z
    .object({
      op: z.literal("link"),
      requirementId: z.string().min(1),
      links: z.array(CloseoutFulfilmentLinkSchema),
    })
    .strict(),
  /** Confirm (admin) — stamps confirmedAt/By; status re-derives to satisfied
   *  ONLY if a link also resolves. `confirmed: false` un-confirms. */
  z
    .object({
      op: z.literal("confirm"),
      requirementId: z.string().min(1),
      confirmed: z.boolean().default(true),
    })
    .strict(),
  /** Waive (an explicit office decision); `waived: false` un-waives → re-derives. */
  z
    .object({
      op: z.literal("waive"),
      requirementId: z.string().min(1),
      waived: z.boolean().default(true),
    })
    .strict(),
]);
export type CloseoutOp = z.infer<typeof CloseoutOpSchema>;

// ── Pure apply ───────────────────────────────────────────────────────────────

export type CloseoutApplyResult =
  | { ok: true; artifact: PersistedJobControl; requirement: CloseoutRequirement | null }
  | { ok: false; reason: "not_found" };

/** Re-stamp status from links + confirmation + live ids — the single place a
 *  requirement's status is set (never trusted off the stored flag). Re-parses
 *  through the schema so the output is a clean, fully-defaulted requirement. */
function reStatus(req: unknown, known: CloseoutKnownIds): CloseoutRequirement {
  const parsed = CloseoutRequirementSchema.parse(req);
  return CloseoutRequirementSchema.parse({ ...parsed, status: deriveCloseoutStatus(parsed, known) });
}

function bump(artifact: PersistedJobControl, requirements: CloseoutRequirement[], at: string): PersistedJobControl {
  const base: PersistedJobControl = { ...artifact, closeoutRequirements: requirements, updatedAt: at };
  return { ...base, revision: computeJobControlRevision(base) };
}

/**
 * Apply one op to the artifact and re-derive the affected requirement's status.
 * PURE — no I/O, no mutation of the input. `known` is the job's live id sets so
 * `satisfied`/reverted is computed honestly here too (the route loads them).
 */
export function applyCloseoutOp(
  artifact: PersistedJobControl,
  op: CloseoutOp,
  ctx: { id: string; at: string; actor?: string | null; known: CloseoutKnownIds },
): CloseoutApplyResult {
  const requirements: CloseoutRequirement[] = artifact.closeoutRequirements.map((r) =>
    CloseoutRequirementSchema.parse(r),
  );

  if (op.op === "add") {
    const maxOrder = requirements.reduce((m, r) => Math.max(m, r.order ?? 0), -1);
    const req = reStatus(
      {
        id: ctx.id,
        jobId: artifact.jobId,
        title: op.title.trim(),
        kind: op.kind,
        scopeClauseIds: op.scopeClauseIds ?? [],
        fulfilmentLinks: [],
        areaScope: op.areaScope ?? "job_wide",
        source: "manual",
        status: "outstanding",
        order: maxOrder + 1,
        createdAt: ctx.at,
        ...(ctx.actor ? { createdBy: ctx.actor } : {}),
      },
      ctx.known,
    );
    return { ok: true, artifact: bump(artifact, [...requirements, req], ctx.at), requirement: req };
  }

  const idx = requirements.findIndex((r) => r.id === op.requirementId);
  if (idx === -1) return { ok: false, reason: "not_found" };
  const current = requirements[idx];

  if (op.op === "remove") {
    const next = requirements.filter((r) => r.id !== op.requirementId);
    return { ok: true, artifact: bump(artifact, next, ctx.at), requirement: null };
  }

  let updated: CloseoutRequirement;
  if (op.op === "link") {
    // Changing the links invalidates a prior confirmation — re-confirm against
    // the new evidence, never inherit a stale tick.
    updated = reStatus(
      { ...current, fulfilmentLinks: op.links, confirmedAt: null, confirmedBy: null },
      ctx.known,
    );
  } else if (op.op === "confirm") {
    updated = reStatus(
      op.confirmed
        ? { ...current, confirmedAt: ctx.at, confirmedBy: ctx.actor ?? null }
        : { ...current, confirmedAt: null, confirmedBy: null },
      ctx.known,
    );
  } else if (op.waived) {
    // waive — an explicit verdict that bypasses link/confirm derivation.
    updated = CloseoutRequirementSchema.parse({ ...current, status: "waived" });
  } else {
    // un-waive — re-derive from whatever links/confirmation remain.
    updated = reStatus({ ...current, status: "outstanding" }, ctx.known);
  }

  const next = [...requirements];
  next[idx] = updated;
  return { ok: true, artifact: bump(artifact, next, ctx.at), requirement: updated };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

export interface CloseoutDeps {
  loadRaw(jobId: string): Promise<unknown | null>;
  save(jobId: string, artifact: PersistedJobControl): Promise<void>;
  mintId(): string;
  /** Live id sets for honest status derivation (so a dangling link can't go
   *  green). Optional for pure unit callers; the route wires the real loader. */
  loadKnownIds?(jobId: string): Promise<CloseoutKnownIds>;
}

export type WriteCloseoutResult =
  | { ok: true; status: 200; requirement: CloseoutRequirement | null; revision: string }
  | {
      ok: false;
      status: 404 | 409;
      reason: "missing" | "unreadable" | "stale_revision" | "not_found";
      currentRevision?: string;
    };

/**
 * Write flow: load → revision-check → apply op (re-deriving status) → persist.
 * A missing/unreadable artifact fails-soft with a structured reason and NO write
 * (closeout requirements only exist once the spine has been compiled).
 */
export async function writeCloseout(
  deps: CloseoutDeps,
  input: {
    jobId: string;
    op: CloseoutOp;
    /** Revision precondition: the artifact revision the caller last read. */
    expectedRevision: string;
    at: string;
    actor?: string | null;
  },
): Promise<WriteCloseoutResult> {
  const raw = await deps.loadRaw(input.jobId);
  if (raw == null) return { ok: false, status: 404, reason: "missing" };

  const parsed = PersistedJobControlSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 409, reason: "unreadable" };

  const currentRevision = jobControlRevisionOf(parsed.data);
  if (input.expectedRevision !== currentRevision) {
    return { ok: false, status: 409, reason: "stale_revision", currentRevision };
  }

  const known = deps.loadKnownIds ? await deps.loadKnownIds(input.jobId) : {};
  const applied = applyCloseoutOp(parsed.data, input.op, {
    id: deps.mintId(),
    at: input.at,
    actor: input.actor,
    known,
  });
  if (!applied.ok) return { ok: false, status: 409, reason: applied.reason };

  await deps.save(input.jobId, applied.artifact);
  return {
    ok: true,
    status: 200,
    requirement: applied.requirement,
    revision: jobControlRevisionOf(applied.artifact),
  };
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

export function blobCloseoutDeps(): CloseoutDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(jobControlKey(jobId), null),
    save: (jobId, artifact) => writeJsonBlob(jobControlKey(jobId), artifact),
    mintId: () => `${ID_PREFIXES.closeoutRequirement}${randomUUID()}`,
    loadKnownIds: (jobId) => loadCloseoutKnownIdsForWrite(jobId),
  };
}

/** Assemble the live id sets a write derives status against: certificates,
 *  documents (incl. as-builts), ITP instances and evidence. Best-effort and
 *  total — a missing store yields an empty set, so a link against it simply
 *  fails to resolve (fail-closed), never throws. */
async function loadCloseoutKnownIdsForWrite(jobId: string): Promise<CloseoutKnownIds> {
  const [recordIds, proofIds] = await Promise.all([
    loadJobCloseoutKnownIds(jobId),
    loadJobProofIds(jobId),
  ]);
  return {
    certificateIds: recordIds.certificateIds,
    documentIds: recordIds.documentIds,
    itpInstanceIds: recordIds.itpInstanceIds,
    evidenceIds: proofIds.evidenceIds,
  };
}
