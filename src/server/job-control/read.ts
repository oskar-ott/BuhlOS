import type { EvidenceLink, ProofReview, WorkPackage } from "@/domains/job-control/types";
import { PersistedJobControlSchema, jobControlKey, jobControlRevisionOf } from "./compile-producer";
import { readJsonBlob } from "./blob";

/**
 * L2 job-control READ boundary — the field-safe view of the compiled artifact
 * `jobs/<jobId>/job-control.json` (L1, #466). Reads, validates, and returns ONLY
 * the subset Phil needs (`workPackages`, `evidenceLinks`, light meta). It does
 * NOT compile, NOT write, NOT mutate, and NEVER surfaces office-only compile
 * internals (the `compileMeta.gaps`, the reconciliation/structure source
 * fingerprints) to the field.
 *
 * Honesty contract (mirrors the task-context model #368): a MISSING artifact is
 * `ready: false` (Phil renders exactly as today — zero regression); an
 * UNREADABLE / mismatched artifact is `ok: false` and is failed-soft by the
 * caller (the worker is never blocked). No value is ever invented.
 *
 * Gating: this is a server-only helper. It performs NO auth of its own — it must
 * be called from an already-authenticated, job-access-checked path (the Phil job
 * page server component, which gates `canAccessSurface(role,'phil')` and only
 * reaches here once `/api/jobs?id=` has confirmed the worker is assigned). That
 * keeps the read no more exposed than the existing Phil job-data fetch, with no
 * new public endpoint.
 */

export interface JobControlReadMeta {
  generatedAt?: string;
  confirmedAt?: string;
  sourceHash?: string;
  /** Stale-write precondition token — a caller passes it back as
   *  `expectedJobControlRevision` when writing (a one-way digest, not office data). */
  revision?: string;
}

export type JobControlReadResult =
  | {
      ok: true;
      ready: true;
      jobId: string;
      workPackages: WorkPackage[];
      evidenceLinks: EvidenceLink[];
      proofReviews: ProofReview[];
      meta: JobControlReadMeta;
    }
  | {
      ok: true;
      ready: false;
      jobId: string;
      reason: "missing";
      workPackages: [];
      evidenceLinks: [];
      proofReviews: [];
    }
  | {
      ok: false;
      jobId: string;
      reason: "unreadable" | "job_mismatch";
      workPackages: [];
      evidenceLinks: [];
      proofReviews: [];
    };

/**
 * Pure: turn a raw blob value (or null when absent) into the field-safe read
 * result. Validates with the L1 schema; distinguishes missing / unreadable /
 * job-mismatch; strips everything outside the field-safe subset.
 */
export function buildJobControlReadResult(jobId: string, raw: unknown | null): JobControlReadResult {
  if (raw == null) {
    return { ok: true, ready: false, jobId, reason: "missing", workPackages: [], evidenceLinks: [], proofReviews: [] };
  }
  const parsed = PersistedJobControlSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, jobId, reason: "unreadable", workPackages: [], evidenceLinks: [], proofReviews: [] };
  }
  if (parsed.data.jobId !== jobId) {
    return { ok: false, jobId, reason: "job_mismatch", workPackages: [], evidenceLinks: [], proofReviews: [] };
  }
  // Field-safe subset only — compileMeta.gaps + source fingerprints stay office-side.
  return {
    ok: true,
    ready: true,
    jobId,
    workPackages: parsed.data.workPackages,
    evidenceLinks: parsed.data.evidenceLinks,
    proofReviews: parsed.data.proofReviews ?? [],
    meta: {
      generatedAt: parsed.data.compileMeta?.generatedAt,
      confirmedAt: parsed.data.compileMeta?.confirmedAt ?? undefined,
      sourceHash: parsed.data.compileMeta?.sourceHash,
      revision: jobControlRevisionOf(parsed.data),
    },
  };
}

export interface JobControlReadDeps {
  /** Load the raw artifact for a job, or null when it does not exist. */
  loadRaw(jobId: string): Promise<unknown | null>;
}

/** Read flow: load → validate → field-safe result. Reads only; never writes. */
export async function readJobControlForField(
  deps: JobControlReadDeps,
  jobId: string,
): Promise<JobControlReadResult> {
  const raw = await deps.loadRaw(jobId);
  return buildJobControlReadResult(jobId, raw);
}

/** Production deps: read the compiled artifact from its per-job blob key. */
export function blobJobControlReadDeps(): JobControlReadDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(jobControlKey(jobId), null),
  };
}
