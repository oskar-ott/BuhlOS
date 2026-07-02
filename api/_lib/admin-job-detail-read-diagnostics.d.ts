// Type surface for the admin single-job PG read diagnostics counters
// (api/_lib/admin-job-detail-read-diagnostics.js).

import type { AdminJobDetailReadDiag } from "./job-detail-pg";

export interface AdminJobDetailReadLastDiag {
  source: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  parityPass: boolean | null;
  rebuildExtras: boolean;
  latencyMs: number | null;
  fallbackUsed: boolean;
}

export interface AdminJobDetailReadDiagnosticsSnapshot {
  resetAt: string;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  parityMismatches: number;
  extrasRebuilds: number;
  lastDiag: AdminJobDetailReadLastDiag | null;
  lastAt: string | null;
}

export function recordAdminJobDetailRead(diag: AdminJobDetailReadDiag): void;
export function getAdminJobDetailReadDiagnostics(): AdminJobDetailReadDiagnosticsSnapshot;
export function resetAdminJobDetailReadDiagnostics(): void;
