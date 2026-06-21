import { readJsonBlob } from "@/server/job-control/blob";
import { DayworkSchema } from "@/domains/dayworks/schema";
import {
  compareForRegister,
  summariseRegister,
  type DayworkRegisterSummary,
} from "@/domains/dayworks/service";
import type { Daywork } from "@/domains/dayworks/types";

/**
 * Daywork register READER (#370) — the server-side data loader for the admin
 * register pages. Reads `jobs/<jobId>/dayworks.json` directly over Blob and
 * derives the exception-first ordering + payment-risk summary using the SHARED
 * pure logic (src/domains/dayworks/service.ts) — the exact same ordering and
 * unsigned-aging rule the `api/dayworks.js` GET serves, so the page and the API
 * never disagree.
 *
 * Server-only, like src/server/job-control/status.ts — it has NO auth of its
 * own and reads the Blob directly, so it MUST be called from an already-gated
 * path (the `/v2/jobs/[jobId]/dayworks` page gates job access via the jobs API;
 * the `/v2/dayworks` rollup gates `isAdminRole`). It WRITES NOTHING.
 *
 * `nowMs` is injected so the aging math is deterministic and unit-testable; the
 * page passes `Date.now()`.
 */

export interface DayworkRegisterDeps {
  /** Reads + validates one job's dockets (drops shape-invalid rows, never throws). */
  readDockets: (jobId: string) => Promise<Daywork[]>;
}

/** Production deps — reads the real Blob store. */
export function blobDayworkDeps(): DayworkRegisterDeps {
  return {
    async readDockets(jobId) {
      const store = await readJsonBlob<{ dockets?: unknown[] }>(`jobs/${jobId}/dayworks.json`, {
        dockets: [],
      });
      const raw = Array.isArray(store?.dockets) ? store!.dockets : [];
      const out: Daywork[] = [];
      for (const d of raw) {
        const parsed = DayworkSchema.safeParse(d);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
  };
}

export interface JobDayworkRegister {
  dockets: Daywork[];
  summary: DayworkRegisterSummary;
}

/** One job's register — dockets exception-first, plus the payment-risk summary. */
export async function loadJobDayworkRegister(
  deps: DayworkRegisterDeps,
  jobId: string,
  nowMs: number,
): Promise<JobDayworkRegister> {
  const dockets = await deps.readDockets(jobId);
  const sorted = dockets.slice().sort((a, b) => compareForRegister(a, b, nowMs));
  return { dockets: sorted, summary: summariseRegister(dockets, nowMs) };
}

export interface DayworkRollupJobRow extends DayworkRegisterSummary {
  jobId: string;
  jobName: string | null;
}

export interface DayworkRollup {
  dockets: Daywork[];
  summary: DayworkRegisterSummary;
  byJob: DayworkRollupJobRow[];
}

/** Cross-job rollup — every non-archived job's dockets aggregated, with a
 *  per-job breakdown ordered payment-risk-first (most unsigned-aging on top). */
export async function loadDayworkRollup(
  deps: DayworkRegisterDeps,
  jobs: ReadonlyArray<{ id: string; name?: string | null; archived?: boolean }>,
  nowMs: number,
): Promise<DayworkRollup> {
  const all: Daywork[] = [];
  const byJob: DayworkRollupJobRow[] = [];
  for (const job of jobs) {
    if (!job?.id || job.archived === true) continue;
    const dockets = (await deps.readDockets(job.id)).map((d) => ({
      ...d,
      jobName: job.name ?? d.jobName ?? null,
    }));
    if (dockets.length === 0) continue;
    all.push(...dockets);
    byJob.push({ jobId: job.id, jobName: job.name ?? null, ...summariseRegister(dockets, nowMs) });
  }
  const sorted = all.slice().sort((a, b) => compareForRegister(a, b, nowMs));
  byJob.sort((a, b) => b.unsignedAging - a.unsignedAging || b.total - a.total);
  return { dockets: sorted, summary: summariseRegister(all, nowMs), byJob };
}
