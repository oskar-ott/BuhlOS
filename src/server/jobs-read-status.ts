// Server-only read of the J6 admin jobs read-cutover state for the
// /jobs-read-status diagnostics page. READ-ONLY and best-effort: it runs a live
// probe of the PG overlay (no writes, no serving) plus the process-local
// counters, and never throws to the page. Honest about the "not wired" state
// (no Supabase in this environment — e.g. production today).
import { probeAdminJobsRead } from "../../api/_lib/job-read-projection.js";
import type { AdminJobsReadDiag } from "../../api/_lib/job-read-projection";
import { getJobsReadDiagnostics } from "../../api/_lib/job-read-diagnostics.js";
import type { JobsReadDiagnosticsSnapshot } from "../../api/_lib/job-read-diagnostics";
import { isFlagOn } from "../../api/_lib/feature-flags.js";

export type JobsReadStatus = {
  wired: boolean; // SUPABASE_DB_URL present in this runtime
  flagOn: boolean; // raw supabase_read_jobs value (no role targeting)
  probe: AdminJobsReadDiag | null; // live read-only probe; null when not wired
  counters: JobsReadDiagnosticsSnapshot; // process-local, this instance only
  error?: string;
};

const probe = probeAdminJobsRead as (deps?: unknown) => Promise<AdminJobsReadDiag>;
const flagFor = isFlagOn as (key: string) => Promise<boolean>;
const readCounters = getJobsReadDiagnostics as () => JobsReadDiagnosticsSnapshot;

/** Live, read-only snapshot of the admin jobs read cutover. Server-only. */
export async function loadJobsReadStatus(): Promise<JobsReadStatus> {
  const counters = readCounters();
  let flagOn = false;
  try {
    flagOn = (await flagFor("supabase_read_jobs")) === true;
  } catch {
    flagOn = false; // flags blob unavailable → behave as off
  }

  if (!process.env.SUPABASE_DB_URL) {
    return { wired: false, flagOn, probe: null, counters };
  }
  try {
    const result = await probe();
    return { wired: true, flagOn, probe: result, counters };
  } catch (err) {
    return { wired: true, flagOn, probe: null, counters, error: err instanceof Error ? err.message : String(err) };
  }
}

export type JobsReadSummary = {
  state: "not_wired" | "flag_off" | "active" | "fallback" | "error";
  flagOn: boolean;
  readSource: "blob" | "postgres";
  reconstructed: boolean;
  parityMatch: boolean | null;
  pgFaithfulCount: number;
  driftedCount: number;
  onlyInBlobCount: number;
  onlyInPgCount: number;
  matchedCount: number;
  latencyMs: number | null;
  hashMatch: boolean | null;
  fallbackReads: number;
  totalReads: number;
  lastAt: string | null;
  error?: string;
};

/** Pure view model for the diagnostics cards. */
export function summariseJobsRead(status: JobsReadStatus): JobsReadSummary {
  const base = {
    flagOn: status.flagOn,
    fallbackReads: status.counters.fallbackReads,
    totalReads: status.counters.totalReads,
    lastAt: status.counters.lastAt,
  };
  const emptyMetrics = {
    readSource: "blob" as const,
    reconstructed: false,
    parityMatch: null,
    pgFaithfulCount: 0,
    driftedCount: 0,
    onlyInBlobCount: 0,
    onlyInPgCount: 0,
    matchedCount: 0,
    latencyMs: null,
    hashMatch: null,
  };

  if (!status.wired) return { state: "not_wired", ...base, ...emptyMetrics };
  if (status.error) return { state: "error", ...base, ...emptyMetrics, error: status.error };
  const p = status.probe;
  if (!p) return { state: "error", ...base, ...emptyMetrics, error: "no probe result" };

  const metrics = {
    readSource: p.readSource,
    reconstructed: p.reconstructed,
    parityMatch: p.parityMatch,
    pgFaithfulCount: p.pgFaithfulCount,
    driftedCount: p.driftedCount,
    onlyInBlobCount: p.onlyInBlobCount,
    onlyInPgCount: p.onlyInPgCount,
    matchedCount: p.matchedCount,
    latencyMs: p.latencyMs,
    hashMatch: p.matchedCount > 0 ? p.blobHash === p.pgHash : null,
  };

  if (!status.flagOn) return { state: "flag_off", ...base, ...metrics };
  // Flag on but the probe couldn't reconstruct (PG error/no tenant) → fallback.
  if (!p.reconstructed) return { state: "fallback", ...base, ...metrics, error: p.error ?? undefined };
  return { state: "active", ...base, ...metrics };
}
