import { ITPInstanceSchema } from "@/domains/itp/schema";
import type { ITPInstance } from "@/domains/itp/types";
import { buildQaDashboard, type QaDashboard } from "@/domains/itp/qa-rollup";
import { readJsonBlob } from "@/server/job-control/blob";

/**
 * Cross-job QA status READER (#290, narrow first increment) — the office-side
 * QA-exposure dashboard data. Server-only, like the proof-status reader: it has
 * no auth of its own and reads the Blob directly, so it MUST run from an
 * already-admin-gated path (the `/qa` admin page). Read-only — writes nothing.
 *
 * Aggregation strategy (the #290 AC's "documented + cost"): there is NO cross-job
 * ITP index, so this SCANS `jobs/<jobId>/itps.json` for every ACTIVE job (the
 * same per-job-blob fan-out the legacy dashboard and the `withStats=1` hours-style
 * scan already pay). The reads run in parallel; a single job whose blob fails to
 * read is recorded in `failedJobs` and skipped — never crashing the whole board.
 * A future cross-job index (the hours-ledger pattern, PR #89) is the deferred
 * optimization; until then the cost is one blob read per active job.
 */

export type QaStatusResult =
  | { ok: true; dashboard: QaDashboard; scannedJobs: number; failedJobs: string[] }
  | { ok: false; error: string };

export interface QaStatusDeps {
  /** Active jobs only (id + display name). */
  listActiveJobs(): Promise<Array<{ id: string; name: string }>>;
  /** Parsed, non-archived-aware ITP instances for one job (rollup filters archived). */
  loadInstances(jobId: string): Promise<ITPInstance[]>;
}

type JobLoad =
  | { ok: true; jobId: string; jobName: string; instances: ITPInstance[] }
  | { ok: false; jobId: string };

/** List active jobs → scan each job's ITPs (parallel, per-job safe) → aggregate.
 *  Total: a failure listing jobs returns ok:false; a single job read failure is
 *  isolated into failedJobs. */
export async function runQaStatus(deps: QaStatusDeps, now: string): Promise<QaStatusResult> {
  let jobs: Array<{ id: string; name: string }>;
  try {
    jobs = await deps.listActiveJobs();
  } catch {
    return { ok: false, error: "Could not load jobs for the QA dashboard." };
  }

  const settled: JobLoad[] = await Promise.all(
    jobs.map(async (job): Promise<JobLoad> => {
      try {
        return { ok: true, jobId: job.id, jobName: job.name, instances: await deps.loadInstances(job.id) };
      } catch {
        return { ok: false, jobId: job.id };
      }
    }),
  );

  const perJob = settled
    .filter((s): s is Extract<JobLoad, { ok: true }> => s.ok)
    .map((s) => ({ jobId: s.jobId, jobName: s.jobName, instances: s.instances }));
  const failedJobs = settled.filter((s) => !s.ok).map((s) => s.jobId);

  return { ok: true, dashboard: buildQaDashboard(perJob, now), scannedJobs: jobs.length, failedJobs };
}

interface JobsBlob {
  jobs: Array<{ id: string; name?: string; status?: string }>;
}

/** Production deps: active jobs from `jobs.json`; instances from each
 *  `jobs/<jobId>/itps.json` (read-only), parsed leniently (a bad row drops, the
 *  scan never fails on one legacy instance). */
export function blobQaStatusDeps(): QaStatusDeps {
  return {
    async listActiveJobs() {
      const data = await readJsonBlob<JobsBlob>("jobs.json", { jobs: [] });
      return (data?.jobs ?? [])
        .filter((j) => j.status === "active")
        .map((j) => ({ id: j.id, name: j.name ?? j.id }));
    },
    async loadInstances(jobId) {
      const data = await readJsonBlob<{ instances?: unknown[] }>(`jobs/${jobId}/itps.json`, {
        instances: [],
      });
      const raw = Array.isArray(data?.instances) ? data!.instances : [];
      const out: ITPInstance[] = [];
      for (const r of raw) {
        const parsed = ITPInstanceSchema.safeParse(r);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
  };
}
