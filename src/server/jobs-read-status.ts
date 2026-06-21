// Server-only read of the J6/J7 jobs read-cutover state for the /jobs-read-status
// diagnostics page. READ-ONLY and best-effort: it runs a live probe of the ADMIN
// PG overlay (no writes, no serving) plus the process-local counters for both the
// admin (J6) and Phil/field (J7) audiences, and never throws to the page. Honest
// about the "not wired" state (no Supabase in this environment — e.g. production).
//
// There is no live PHIL probe: the Phil overlay is scoped to a specific worker's
// visible jobs, and this admin page has no worker context. The Phil section shows
// the flag state + the process-local counters of field reads served by this
// instance.
import { probeAdminJobsRead } from "../../api/_lib/job-read-projection.js";
import type { AdminJobsReadDiag } from "../../api/_lib/job-read-projection";
import { getJobsReadDiagnostics } from "../../api/_lib/job-read-diagnostics.js";
import type { JobsReadDiagnosticsSnapshot } from "../../api/_lib/job-read-diagnostics";
import { getTaskReadDiagnostics } from "../../api/_lib/task-read-diagnostics.js";
import type { TaskReadDiagnosticsSnapshot } from "../../api/_lib/task-read-diagnostics";
import { getAdminTaskReadDiagnostics } from "../../api/_lib/admin-task-read-diagnostics.js";
import { probeTaskReadParity } from "../../api/_lib/task-read.js";
import type { TaskReadProbeResult } from "../../api/_lib/task-read";
import { probeEvidenceReadParity } from "../../api/_lib/evidence-read.js";
import type { EvidenceReadProbeResult } from "../../api/_lib/evidence-read";
import { isFlagOn } from "../../api/_lib/feature-flags.js";

export type JobsReadStatus = {
  wired: boolean; // SUPABASE_DB_URL present in this runtime
  flagOn: boolean; // raw supabase_read_jobs value (admin, J6)
  philFlagOn: boolean; // raw supabase_read_phil_jobs value (field, J7)
  probe: AdminJobsReadDiag | null; // live read-only ADMIN probe; null when not wired
  counters: JobsReadDiagnosticsSnapshot; // process-local, this instance only
  error?: string;
};

const probe = probeAdminJobsRead as (deps?: unknown) => Promise<AdminJobsReadDiag>;
const flagFor = isFlagOn as (key: string) => Promise<boolean>;
const readCounters = getJobsReadDiagnostics as () => JobsReadDiagnosticsSnapshot;

async function flagOrFalse(key: string): Promise<boolean> {
  try {
    return (await flagFor(key)) === true;
  } catch {
    return false; // flags blob unavailable → behave as off
  }
}

/** Live, read-only snapshot of the jobs read cutover. Server-only. */
export async function loadJobsReadStatus(): Promise<JobsReadStatus> {
  const counters = readCounters();
  const flagOn = await flagOrFalse("supabase_read_jobs");
  const philFlagOn = await flagOrFalse("supabase_read_phil_jobs");

  if (!process.env.SUPABASE_DB_URL) {
    return { wired: false, flagOn, philFlagOn, probe: null, counters };
  }
  try {
    const result = await probe();
    return { wired: true, flagOn, philFlagOn, probe: result, counters };
  } catch (err) {
    return { wired: true, flagOn, philFlagOn, probe: null, counters, error: err instanceof Error ? err.message : String(err) };
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

/** Pure view model for the ADMIN diagnostics cards (J6 — live probe). */
export function summariseJobsRead(status: JobsReadStatus): JobsReadSummary {
  const admin = status.counters.admin;
  const base = {
    flagOn: status.flagOn,
    fallbackReads: admin.fallbackReads,
    totalReads: admin.totalReads,
    lastAt: admin.lastAt,
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

export type PhilReadSummary = {
  flagOn: boolean;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  lastAt: string | null;
  lastPgFaithful: number | null; // PG-served visible jobs on the last field read
  lastMatched: number | null; // matched visible jobs on the last field read
};

/** Pure view model for the PHIL (field) diagnostics card (J7 — counters only). */
export function summarisePhilRead(status: JobsReadStatus): PhilReadSummary {
  const phil = status.counters.phil;
  const last = phil.lastDiag;
  return {
    flagOn: status.philFlagOn,
    totalReads: phil.totalReads,
    pgServedReads: phil.pgServedReads,
    blobServedReads: phil.blobServedReads,
    fallbackReads: phil.fallbackReads,
    lastAt: phil.lastAt,
    lastPgFaithful: last && typeof last.pgFaithfulCount === "number" ? last.pgFaithfulCount : null,
    lastMatched: last && typeof last.matchedCount === "number" ? last.matchedCount : null,
  };
}

// ── J10: Phil task-status read diagnostics (process-local counters; no live probe,
//    the overlay is per-job/worker-scoped and this admin page has no such context).
export type TaskReadStatus = { flagOn: boolean; counters: TaskReadDiagnosticsSnapshot };

const readTaskCounters = getTaskReadDiagnostics as () => TaskReadDiagnosticsSnapshot;

export async function loadTaskReadStatus(): Promise<TaskReadStatus> {
  return { flagOn: await flagOrFalse("supabase_read_phil_tasks"), counters: readTaskCounters() };
}

export type TaskReadSummary = {
  flagOn: boolean;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  parityMismatches: number;
  lastAt: string | null;
  lastSource: "blob" | "postgres" | null;
  lastParityPass: boolean | null;
};

/** Pure view model for the Phil task-status read card (J10). */
export function summariseTaskRead(s: TaskReadStatus): TaskReadSummary {
  const c = s.counters;
  return {
    flagOn: s.flagOn,
    totalReads: c.totalReads,
    pgServedReads: c.pgServedReads,
    blobServedReads: c.blobServedReads,
    fallbackReads: c.fallbackReads,
    parityMismatches: c.parityMismatches,
    lastAt: c.lastAt,
    lastSource: c.lastDiag ? c.lastDiag.source : null,
    lastParityPass: c.lastDiag ? c.lastDiag.parityPass : null,
  };
}

// ── J11: Admin task-status read diagnostics. Same shape as J10 (separate
//    process-local counter, no live probe), behind supabase_read_admin_tasks.
export type AdminTaskReadStatus = { flagOn: boolean; counters: TaskReadDiagnosticsSnapshot };

const readAdminTaskCounters = getAdminTaskReadDiagnostics as () => TaskReadDiagnosticsSnapshot;

export async function loadAdminTaskReadStatus(): Promise<AdminTaskReadStatus> {
  return { flagOn: await flagOrFalse("supabase_read_admin_tasks"), counters: readAdminTaskCounters() };
}

/** Pure view model for the admin task-status read card (J11). Same shape as J10. */
export function summariseAdminTaskRead(s: AdminTaskReadStatus): TaskReadSummary {
  const c = s.counters;
  return {
    flagOn: s.flagOn,
    totalReads: c.totalReads,
    pgServedReads: c.pgServedReads,
    blobServedReads: c.blobServedReads,
    fallbackReads: c.fallbackReads,
    parityMismatches: c.parityMismatches,
    lastAt: c.lastAt,
    lastSource: c.lastDiag ? c.lastDiag.source : null,
    lastParityPass: c.lastDiag ? c.lastDiag.parityPass : null,
  };
}

// ── J12: live, read-only task-status parity probe (cutover READINESS). Unlike the
//    J10/J11 reactive counters this is an on-demand probe (mirrors the J6 admin
//    jobs probe): it runs the SAME engine flag-forced-on across a bounded sample
//    and reports how byte-faithful the PG mirror is to Blob. Nothing is served,
//    nothing is written. This is audience-agnostic — parity is the same data for
//    Phil and admin; only SERVING differs (and serving is unchanged in J12).
export type TaskReadProbeStatus = { wired: boolean; probe: TaskReadProbeResult | null; error?: string };

const runTaskReadProbe = probeTaskReadParity as (deps?: unknown) => Promise<TaskReadProbeResult>;

export async function loadTaskReadProbe(): Promise<TaskReadProbeStatus> {
  if (!process.env.SUPABASE_DB_URL) return { wired: false, probe: null };
  try {
    return { wired: true, probe: await runTaskReadProbe() };
  } catch (err) {
    return { wired: true, probe: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export type TaskReadProbeSummary = {
  state: "not_wired" | "error" | "all_faithful" | "drift" | "empty";
  jobsTotal: number;
  jobsSampled: number;
  pgFaithful: number;
  drifted: number;
  errored: number;
  unavailable: number;
  totalMismatched: number;
  totalUnresolved: number;
  totalOrphans: number;
  hashDriftJobs: number;
  latencyMs: number | null;
  readyForPromotion: boolean; // every sampled job PG-faithful → a served-source flip would be byte-safe for the sample
  error?: string;
};

/** Pure view model for the J12 task-status parity (live probe) card. */
export function summariseTaskReadProbe(s: TaskReadProbeStatus): TaskReadProbeSummary {
  const empty = {
    jobsTotal: 0, jobsSampled: 0, pgFaithful: 0, drifted: 0, errored: 0, unavailable: 0,
    totalMismatched: 0, totalUnresolved: 0, totalOrphans: 0, hashDriftJobs: 0,
    latencyMs: null as number | null, readyForPromotion: false,
  };
  if (!s.wired) return { state: "not_wired", ...empty };
  if (s.error || !s.probe) return { state: "error", ...empty, error: s.error ?? "no probe result" };
  const p = s.probe;
  const metrics = {
    jobsTotal: p.jobsTotal, jobsSampled: p.jobsSampled, pgFaithful: p.pgFaithful,
    drifted: p.drifted, errored: p.errored, unavailable: p.unavailable,
    totalMismatched: p.totalMismatched, totalUnresolved: p.totalUnresolved,
    totalOrphans: p.totalOrphans, hashDriftJobs: p.hashDriftJobs, latencyMs: p.latencyMs,
  };
  if (p.jobsSampled === 0) return { state: "empty", ...metrics, readyForPromotion: false };
  const readyForPromotion = p.drifted === 0 && p.errored === 0 && p.unavailable === 0 && p.pgFaithful === p.jobsSampled;
  return { state: readyForPromotion ? "all_faithful" : "drift", ...metrics, readyForPromotion };
}

// ── Evidence-metadata read-cutover READINESS probe (the next domain after
//    task-status; see docs/architecture/proof-evidence-read-cutover-audit.md).
//    Diagnostics-only, live, read-only — there is NO served evidence overlay and
//    NO flag yet. Measures normalised parity of data.json.evidence[] vs the PG
//    evidence_files mirror across a bounded sample. Evidence METADATA only —
//    proof-status (job-control.json) is Blob-only and not touched here.
export type EvidenceReadProbeStatus = { wired: boolean; probe: EvidenceReadProbeResult | null; error?: string };

const runEvidenceReadProbe = probeEvidenceReadParity as (deps?: unknown) => Promise<EvidenceReadProbeResult>;

export async function loadEvidenceReadProbe(): Promise<EvidenceReadProbeStatus> {
  if (!process.env.SUPABASE_DB_URL) return { wired: false, probe: null };
  try {
    return { wired: true, probe: await runEvidenceReadProbe() };
  } catch (err) {
    return { wired: true, probe: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export type EvidenceReadProbeSummary = {
  state: "not_wired" | "error" | "all_faithful" | "drift" | "empty";
  jobsTotal: number;
  jobsSampled: number;
  faithful: number;
  drifted: number;
  unavailable: number;
  matchedEvidence: number;
  mismatchedEvidence: number;
  missingInPg: number;
  missingInBlob: number;
  latencyMs: number | null;
  readyForOverlay: boolean; // every sampled job evidence-faithful → a dark evidence overlay would be byte-safe for the sample
  error?: string;
};

/** Pure view model for the evidence-metadata parity (live probe) card. */
export function summariseEvidenceReadProbe(s: EvidenceReadProbeStatus): EvidenceReadProbeSummary {
  const empty = {
    jobsTotal: 0, jobsSampled: 0, faithful: 0, drifted: 0, unavailable: 0,
    matchedEvidence: 0, mismatchedEvidence: 0, missingInPg: 0, missingInBlob: 0,
    latencyMs: null as number | null, readyForOverlay: false,
  };
  if (!s.wired) return { state: "not_wired", ...empty };
  if (s.error || !s.probe) return { state: "error", ...empty, error: s.error ?? "no probe result" };
  const p = s.probe;
  // probeEvidenceReadParity never throws; a captured fallbackReason of 'error' /
  // 'no tenant' is surfaced as the error state so the card reads honestly.
  if (!p.available || p.fallbackReason === "error" || p.fallbackReason === "no tenant") {
    return { state: "error", ...empty, error: p.error ?? p.fallbackReason ?? "unavailable" };
  }
  const metrics = {
    jobsTotal: p.jobsTotal, jobsSampled: p.jobsSampled, faithful: p.faithful,
    drifted: p.drifted, unavailable: p.unavailable, matchedEvidence: p.matchedEvidence,
    mismatchedEvidence: p.mismatchedEvidence, missingInPg: p.missingInPg,
    missingInBlob: p.missingInBlob, latencyMs: p.latencyMs,
  };
  if (p.jobsSampled === 0) return { state: "empty", ...metrics, readyForOverlay: false };
  return { state: p.readyForOverlay ? "all_faithful" : "drift", ...metrics, readyForOverlay: p.readyForOverlay };
}
