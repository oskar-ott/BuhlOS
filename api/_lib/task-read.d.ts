// Type surface for the J10/J11/J12 task-status read engine (task-read.js), so
// the server-only /jobs-read-status loader (src/server/jobs-read-status.ts) can
// consume the J12 readiness probe type-checked. The parity engine
// (readTaskStatusOverlay) is INTERNAL and deliberately not exported.

export interface TaskReadResult {
  data: unknown;
  diag: Record<string, unknown>;
}

/** Aggregate of the J12 read-only cutover-readiness probe. Counts/booleans only. */
export interface TaskReadProbeResult {
  wired: boolean; // SUPABASE_DB_URL present in this runtime
  jobsTotal: number; // jobs in jobs.json
  jobsSampled: number; // how many were actually probed (bounded; ≤ jobsTotal)
  pgFaithful: number; // sampled jobs whose PG mirror is byte-faithful to Blob (parity PASS)
  drifted: number; // sampled jobs with a real parity divergence
  errored: number; // sampled jobs where PG was unreachable
  unavailable: number; // sampled jobs not yet in PG / projection unclean
  totalMismatched: number; // summed mismatched tasks across drifted jobs
  totalUnresolved: number; // summed unresolved instances across drifted jobs
  totalOrphans: number; // summed orphan PG tasks across drifted jobs
  hashDriftJobs: number; // drifted jobs whose status hash differed
  latencyMs: number;
  error: string | null;
}

export function readPhilTaskStatus(input?: Record<string, unknown>): Promise<TaskReadResult>;
export function readAdminTaskStatus(input?: Record<string, unknown>): Promise<TaskReadResult>;
export function probeTaskReadParity(input?: Record<string, unknown>): Promise<TaskReadProbeResult>;
