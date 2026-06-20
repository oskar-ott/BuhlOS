// Type surface for the J6 process-local read diagnostics (job-read-diagnostics.js).
import type { AdminJobsReadDiag } from "./job-read-projection";

export interface JobsReadDiagnosticsSnapshot {
  resetAt: string;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  driftObservations: number;
  lastDiag: Partial<AdminJobsReadDiag> | null;
  lastAt: string | null;
}

export function recordJobsRead(diag: Partial<AdminJobsReadDiag>): void;
export function getJobsReadDiagnostics(): JobsReadDiagnosticsSnapshot;
export function resetJobsReadDiagnostics(): void;
