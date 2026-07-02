// Type surface for the ADMIN single-job PG direct read (api/_lib/job-detail-pg.js).
// Only the shapes consumed by TypeScript callers are declared.

export interface AdminJobDetailReadDiag {
  source: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  parityPass: boolean | null;
  uploadedAt: string | null;
  rebuildExtras: boolean;
  latencyMs: number | null;
  fallbackUsed: boolean;
  error: string | null;
}

export interface AdminJobDetailExtrasRecord {
  keyOrder: string[];
  extras: Record<string, unknown>;
  migratedHash: string;
}

export interface AdminJobDetailReadDeps {
  readBlob?: (key: string, fallback?: unknown) => Promise<unknown>;
  writeBlob?: (key: string, data: unknown) => Promise<unknown>;
  blobUploadedAt?: (key: string) => Promise<string | null>;
  getDb?: (opts?: unknown) => unknown;
  isFlagOn?: (key: string) => Promise<boolean>;
  tenantSlug?: string;
  now?: () => number;
  sampleLimit?: number;
}

export interface AdminJobDetailProbeResult {
  wired: boolean;
  jobsTotal: number;
  jobsSampled: number;
  faithful: number;
  byteEqual: number;
  drifted: number;
  mergeDrift: number;
  unavailable: number;
  errored: number;
  latencyMs: number;
  error: string | null;
}

export const FLAG_KEY: "supabase_read_job_detail";
export function adminExtrasKey(jobId: string): string;
export function buildAdminExtrasRecord(job: Record<string, unknown>): AdminJobDetailExtrasRecord;
export function mergeAdminJobDetail(
  record: AdminJobDetailExtrasRecord,
  pgJob: Record<string, unknown>,
): Record<string, unknown>;
export function loadOneJobStructureFromPg(
  sql: unknown,
  tenantId: string,
  jobId: string,
): Promise<Record<string, unknown> | null>;
export function readAdminJobDetailFromPg(
  jobId: string,
  deps?: AdminJobDetailReadDeps,
): Promise<{ job: Record<string, unknown> | null; diag: AdminJobDetailReadDiag }>;
export function persistAdminExtras(
  jobId: string,
  job: Record<string, unknown>,
  uploadedAt: string,
  deps?: AdminJobDetailReadDeps,
): Promise<{ persisted: boolean }>;
export function probeAdminJobDetailParity(
  deps?: AdminJobDetailReadDeps,
): Promise<AdminJobDetailProbeResult>;
