// Type surface for the J6/J7 process-local read diagnostics (job-read-diagnostics.js).
import type { AdminJobsReadDiag } from "./job-read-projection";

export interface JobsReadAudienceCounters {
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  driftObservations: number;
  lastDiag: Partial<AdminJobsReadDiag> | null;
  lastAt: string | null;
}

export interface JobsReadDiagnosticsSnapshot {
  resetAt: string;
  admin: JobsReadAudienceCounters;
  phil: JobsReadAudienceCounters;
}

export function recordJobsRead(diag: Partial<AdminJobsReadDiag>, audience?: "admin" | "phil"): void;
export function getJobsReadDiagnostics(): JobsReadDiagnosticsSnapshot;
export function resetJobsReadDiagnostics(): void;
