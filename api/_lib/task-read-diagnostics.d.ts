// Type surface for the J10 process-local task-read diagnostics (task-read-diagnostics.js).

export interface TaskReadLastDiag {
  source: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  parityPass: boolean | null;
  matched: number;
  mismatched: number;
  orphans: number;
  unresolved: number;
  hashMatch: boolean | null;
  latencyMs: number | null;
  fallbackUsed: boolean;
}

export interface TaskReadDiagnosticsSnapshot {
  resetAt: string;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  parityMismatches: number;
  lastDiag: TaskReadLastDiag | null;
  lastAt: string | null;
}

export function recordTaskRead(diag: Partial<TaskReadLastDiag>): void;
export function getTaskReadDiagnostics(): TaskReadDiagnosticsSnapshot;
export function resetTaskReadDiagnostics(): void;
