import type { TaskRef } from "@/domains/job-control/types";
import {
  isRequiredEvidenceMet,
  requiredEvidenceForTask,
  workPackageForTask,
} from "@/domains/job-control/task-context";
import {
  PersistedJobControlSchema,
  jobControlKey,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";
import { readJsonBlob } from "./blob";

/**
 * Cross-job "Proof to sign off" READ-MODEL (#503) — the office-side list of
 * task proof a worker has submitted for review. Server-only, like qa-status.ts
 * and status.ts: it has NO auth of its own and reads the Blob directly, so it
 * MUST run from an already-admin-gated path (the flag-gated Command Centre /
 * Approvals surface). Read-only — it WRITES NOTHING (the approve/send-back
 * action goes through the existing proof-review engine + route).
 *
 * Aggregation: there is no cross-job proofReviews index, so this SCANS
 * `jobs/<jobId>/job-control.json` for every ACTIVE job (the same per-job-blob
 * fan-out qa-status.ts pays), plus `jobs/<jobId>/data.json#evidence[]` to join
 * the captured photo URLs. Reads run in parallel; a single job whose blob fails
 * is recorded in `failedJobs` and skipped — never crashing the whole queue.
 *
 * Granularity honesty (proof-review-model.md): required proof is AREA/PACKAGE
 * granular by default in prod — multiple task instances in an area share the
 * same package requirements + captures. We render at whatever granularity the
 * requirement was authored (the shared `isRequiredEvidenceMet` predicate, the
 * package-level rule) and never claim universal per-task proof.
 */

export interface ProofQueuePhoto {
  evidenceId: string;
  photoUrl: string | null;
  capturedByName: string | null;
  capturedAt: string | null;
}

export interface ProofQueueRequirement {
  id: string;
  label: string;
  kind: string;
  met: boolean;
}

export interface ProofQueueItem {
  /** The ProofReview record id (pr_…). */
  reviewId: string;
  jobId: string;
  jobName: string;
  taskRef: TaskRef;
  workPackageId: string | null;
  /** The package that delivers the task — "what this proves" comes from it. */
  workPackageTitle: string | null;
  requirements: ProofQueueRequirement[];
  /** Captured photos joined from data.json#evidence (best-effort). */
  photos: ProofQueuePhoto[];
  /** The worker who pressed submit (a user id; resolve a name UI-side or show id). */
  submittedBy: string | null;
  submittedAt: string | null;
  /** This job's artifact revision — the precondition for the approve/reject POST. */
  jobControlRevision: string;
}

export type ProofQueueResult =
  | { ok: true; items: ProofQueueItem[]; scannedJobs: number; failedJobs: string[] }
  | { ok: false; error: string };

/** One job's captured evidence, keyed by id (photoUrl + who/when). */
export type EvidenceById = Map<
  string,
  { photoUrl: string | null; capturedByName: string | null; capturedAt: string | null }
>;

export interface ProofQueueDeps {
  /** Active jobs only (id + display name). */
  listActiveJobs(): Promise<Array<{ id: string; name: string }>>;
  /** The compiled artifact for one job, or null when none/unreadable. */
  loadArtifact(jobId: string): Promise<PersistedJobControl | null>;
  /** Captured evidence for one job, keyed by evidence id. */
  loadEvidence(jobId: string): Promise<EvidenceById>;
}

/**
 * PURE shaper: one job's submitted proof reviews → queue items. Exported for
 * unit testing. Only `submitted` reviews appear; approved/rejected are excluded.
 */
export function shapeJobProofItems(
  job: { id: string; name: string },
  artifact: PersistedJobControl,
  evidenceById: EvidenceById,
): ProofQueueItem[] {
  const revision = jobControlRevisionOf(artifact);
  const out: ProofQueueItem[] = [];

  for (const review of artifact.proofReviews) {
    if (review.status !== "submitted") continue;
    const wp = workPackageForTask(artifact.workPackages, review.taskRef);

    const requirements: ProofQueueRequirement[] = wp
      ? requiredEvidenceForTask(wp, review.taskRef).map((e) => ({
          id: e.id,
          label: e.label,
          kind: e.kind,
          met: isRequiredEvidenceMet(artifact.evidenceLinks, wp.id, e.id),
        }))
      : [];

    // Captured photos: proof-bearing links on this package → the evidence item.
    const photos: ProofQueuePhoto[] = [];
    const seen = new Set<string>();
    if (wp) {
      for (const link of artifact.evidenceLinks) {
        if (link.workPackageId !== wp.id) continue;
        const evId = link.evidenceId ?? null;
        if (!evId || seen.has(evId)) continue;
        seen.add(evId);
        const ev = evidenceById.get(evId);
        if (!ev) continue;
        photos.push({
          evidenceId: evId,
          photoUrl: ev.photoUrl,
          capturedByName: ev.capturedByName,
          capturedAt: ev.capturedAt,
        });
      }
    }

    out.push({
      reviewId: review.id,
      jobId: job.id,
      jobName: job.name,
      taskRef: review.taskRef,
      workPackageId: wp?.id ?? null,
      workPackageTitle: wp?.title ?? null,
      requirements,
      photos,
      submittedBy: review.submittedBy ?? null,
      submittedAt: review.submittedAt ?? null,
      jobControlRevision: revision,
    });
  }

  return out;
}

/** List active jobs → scan each job's artifact + evidence (parallel, per-job
 *  safe) → flatten the submitted proof reviews. A failure listing jobs returns
 *  ok:false; a single job read failure is isolated into failedJobs. */
export async function runProofQueue(deps: ProofQueueDeps): Promise<ProofQueueResult> {
  let jobs: Array<{ id: string; name: string }>;
  try {
    jobs = await deps.listActiveJobs();
  } catch {
    return { ok: false, error: "Could not load jobs for the proof queue." };
  }

  const settled = await Promise.all(
    jobs.map(
      async (
        job,
      ): Promise<{ ok: true; items: ProofQueueItem[] } | { ok: false; jobId: string }> => {
        try {
          const artifact = await deps.loadArtifact(job.id);
          if (!artifact) return { ok: true, items: [] };
          // Short-circuit the evidence read for jobs with no submitted proof —
          // shapeJobProofItems only joins evidence for submitted reviews, so the
          // data.json read is wasted on every other job.
          if (!artifact.proofReviews.some((r) => r.status === "submitted")) {
            return { ok: true, items: [] };
          }
          const evidence = await deps.loadEvidence(job.id);
          return { ok: true, items: shapeJobProofItems(job, artifact, evidence) };
        } catch {
          return { ok: false, jobId: job.id };
        }
      },
    ),
  );

  const items = settled.flatMap((s) => (s.ok ? s.items : []));
  const failedJobs = settled.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.jobId));

  // Oldest first (the office clears the longest-waiting proof first).
  items.sort((a, b) => {
    const at = a.submittedAt ?? "";
    const bt = b.submittedAt ?? "";
    if (at && bt && at !== bt) return at < bt ? -1 : 1;
    return a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : 0;
  });

  return { ok: true, items, scannedJobs: jobs.length, failedJobs };
}

interface JobsBlob {
  jobs: Array<{ id: string; name?: string; status?: string }>;
}

/** Production deps: active jobs from `jobs.json`; the compiled artifact + the
 *  captured evidence map from each job's blobs (read-only, parsed leniently). */
export function blobProofQueueDeps(): ProofQueueDeps {
  return {
    async listActiveJobs() {
      // Live work states where a worker's proof can be waiting on the office:
      // active + on_hold. (draft isn't published; complete/archived are closed
      // out — proof there is reviewed per-job, not in the cross-job queue.)
      const data = await readJsonBlob<JobsBlob>("jobs.json", { jobs: [] });
      return (data?.jobs ?? [])
        .filter((j) => j.status === "active" || j.status === "on_hold")
        .map((j) => ({ id: j.id, name: j.name ?? j.id }));
    },
    async loadArtifact(jobId) {
      const raw = await readJsonBlob<unknown>(jobControlKey(jobId), null);
      if (raw == null) return null;
      const parsed = PersistedJobControlSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async loadEvidence(jobId) {
      const data = await readJsonBlob<{
        evidence?: Array<{
          id?: unknown;
          photoUrl?: unknown;
          capturedByName?: unknown;
          capturedAt?: unknown;
        }>;
      }>(`jobs/${jobId}/data.json`, { evidence: [] });
      const map: EvidenceById = new Map();
      for (const e of data?.evidence ?? []) {
        if (typeof e?.id !== "string" || !e.id) continue;
        map.set(e.id, {
          photoUrl: typeof e.photoUrl === "string" ? e.photoUrl : null,
          capturedByName: typeof e.capturedByName === "string" ? e.capturedByName : null,
          capturedAt: typeof e.capturedAt === "string" ? e.capturedAt : null,
        });
      }
      return map;
    },
  };
}
