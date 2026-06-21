// Type surface for the admin evidence-read overlay diagnostics
// (admin-evidence-read-diagnostics.js). Counts/booleans only — no evidence
// ids/URLs/note bodies.

export interface AdminEvidenceReadLastDiag {
  source: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  parityPass: boolean | null;
  matched: number;
  mismatched: number;
  missingInPg: number;
  missingInBlob: number;
  latencyMs: number | null;
  fallbackUsed: boolean;
}

export interface AdminEvidenceReadDiagnosticsSnapshot {
  resetAt: string;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  parityMismatches: number;
  lastDiag: AdminEvidenceReadLastDiag | null;
  lastAt: string | null;
}

export function recordAdminEvidenceRead(diag: Partial<AdminEvidenceReadLastDiag>): void;
export function getAdminEvidenceReadDiagnostics(): AdminEvidenceReadDiagnosticsSnapshot;
export function resetAdminEvidenceReadDiagnostics(): void;
