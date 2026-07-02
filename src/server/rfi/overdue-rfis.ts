import { RfisResponseSchema, type Rfi } from "@/domains/rfi/schema";
import { readJsonBlob } from "@/server/job-control/blob";

/**
 * Cross-job RFI scan (#276 "chase") — the read that lets the Command Centre
 * surface overdue RFIs where the office starts its day. Server-only, like
 * proof-queue.ts: it has NO auth of its own and reads the Blob directly, so it
 * MUST run from an already-admin-gated path, and the CALLER must gate it on
 * the `rfi_register` flag (flag off ⇒ this never runs ⇒ zero extra reads).
 *
 * Aggregation: rfis.json is per-job with no cross-job index (schema.ts), so
 * this fans out over `jobs/<jobId>/rfis.json` — BOUNDED to the LIVE jobs
 * (active + on_hold, the same "live work states" rationale as the proof
 * queue) from the job list the page ALREADY loaded, all reads in parallel.
 * A single job whose register can't be read/parsed lands in `failedJobs` and
 * is skipped — the caller must disclose the undercount, never present a
 * partial read as the total (P7).
 *
 * Only RFIs still awaiting an answer (open/sent) are returned — the statuses
 * that can ever be overdue; the pure overdue judgement itself lives in the
 * exceptions mapper (rfiExceptions) against an injected `today`.
 */

/** An RFI joined with its job's display name (rfis.json stores only jobId). */
export type RfiWithJob = Rfi & { jobName: string };

export interface RfiScanDeps {
  /** One job's RFI register (jobs/<id>/rfis.json); null = unreadable/malformed. */
  loadRfis(jobId: string): Promise<Rfi[] | null>;
}

export interface RfiScanResult {
  /** RFIs awaiting an answer (open/sent) across the scanned live jobs. */
  rfis: RfiWithJob[];
  scannedJobs: number;
  /** Jobs whose register couldn't be read — disclose, don't undercount silently. */
  failedJobs: string[];
}

/** Live work states — where an unanswered question is actually stalling work.
 *  (draft isn't published; complete/archived are closed out.) Mirrors the
 *  proof queue's active-set boundary. */
const LIVE_STATUSES = new Set(["active", "on_hold"]);

/** Scan the live subset of `jobs` for RFIs awaiting an answer. `jobs` is the
 *  list the caller already loaded (no second jobs fetch); reads run in
 *  parallel and a per-job failure is isolated into `failedJobs`. */
export async function runRfiScan(
  jobs: ReadonlyArray<{ id: string; name?: string; status?: string }>,
  deps: RfiScanDeps,
): Promise<RfiScanResult> {
  const live = jobs.filter((j) => LIVE_STATUSES.has(j.status ?? ""));

  const settled = await Promise.all(
    live.map(
      async (job): Promise<{ ok: true; rfis: RfiWithJob[] } | { ok: false; jobId: string }> => {
        try {
          const rfis = await deps.loadRfis(job.id);
          if (rfis == null) return { ok: false, jobId: job.id };
          return {
            ok: true,
            rfis: rfis
              .filter((r) => r.status === "open" || r.status === "sent")
              .map((r) => ({ ...r, jobName: job.name ?? job.id })),
          };
        } catch {
          return { ok: false, jobId: job.id };
        }
      },
    ),
  );

  return {
    rfis: settled.flatMap((s) => (s.ok ? s.rfis : [])),
    scannedJobs: live.length,
    failedJobs: settled.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.jobId)),
  };
}

/** Production deps: one job's register from `jobs/<jobId>/rfis.json`, parsed
 *  strictly (RfisResponseSchema — the exact shape api/rfis.js writes). A
 *  missing blob is an EMPTY register (most jobs never raise an RFI); a blob
 *  that exists but doesn't parse returns null → failedJobs. */
export function blobRfiScanDeps(): RfiScanDeps {
  return {
    async loadRfis(jobId) {
      const raw = await readJsonBlob<unknown>(`jobs/${jobId}/rfis.json`, { rfis: [] });
      const parsed = RfisResponseSchema.safeParse(raw);
      return parsed.success ? parsed.data.rfis : null;
    },
  };
}
