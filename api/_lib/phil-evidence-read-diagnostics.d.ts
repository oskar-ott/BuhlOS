// Type surface for the FIELD/Phil evidence-read overlay diagnostics
// (phil-evidence-read-diagnostics.js). Counts/booleans only — no evidence
// ids/URLs/note bodies. Same shape as the admin evidence diagnostics.

export interface PhilEvidenceReadLastDiag {
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

export interface PhilEvidenceReadDiagnosticsSnapshot {
  resetAt: string;
  totalReads: number;
  pgServedReads: number;
  blobServedReads: number;
  fallbackReads: number;
  parityMismatches: number;
  lastDiag: PhilEvidenceReadLastDiag | null;
  lastAt: string | null;
}

export function recordPhilEvidenceRead(diag: Partial<PhilEvidenceReadLastDiag>): void;
export function getPhilEvidenceReadDiagnostics(): PhilEvidenceReadDiagnosticsSnapshot;
export function resetPhilEvidenceReadDiagnostics(): void;
