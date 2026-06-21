// Type surface for the J5/J6 jobs read projection (api/_lib/job-read-projection.js).
// Only the shapes consumed by TypeScript callers are declared.

export interface AdminJobsReadDiag {
  readSource: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  reconstructed: boolean;
  parityMatch: boolean | null;
  pgFaithfulCount: number;
  driftedCount: number;
  onlyInBlobCount: number;
  onlyInPgCount: number;
  matchedCount: number;
  blobHash: string | null;
  pgHash: string | null;
  latencyMs: number | null;
  fallbackUsed: boolean;
  error: string | null;
}

export interface AdminJobsOverlayDeps {
  blobJobs?: unknown[];
  getDb?: (opts?: unknown) => unknown;
  isFlagOn?: (key: string) => Promise<boolean>;
  tenantSlug?: string;
  now?: () => number;
}

export interface ProbeAdminJobsDeps extends AdminJobsOverlayDeps {
  readBlob?: (key: string, fallback?: unknown) => Promise<unknown>;
}

export const MIGRATED_JOB_FIELDS: string[];
export function migratedFieldsHash(job: unknown): string;
export function overlayAdminJobs(
  blobJobs?: unknown[],
  pgJobs?: unknown[],
): {
  jobs: unknown[];
  pgFaithfulCount: number;
  driftedCount: number;
  onlyInBlobCount: number;
  onlyInPgCount: number;
  matchedCount: number;
  parityMatch: boolean;
  blobHash: string;
  pgHash: string;
  driftedIds: string[];
};
export function readAdminJobsWithPgOverlay(
  input?: AdminJobsOverlayDeps,
): Promise<{ jobs: unknown[]; diag: AdminJobsReadDiag }>;
export function probeAdminJobsRead(deps?: ProbeAdminJobsDeps): Promise<AdminJobsReadDiag>;

export function reconstructFromPg(rows?: unknown): { jobs: { jobs: unknown[] }; jobData: Record<string, unknown> };
export function loadJobStructureFromPg(sql: unknown, tenantId: string): Promise<{ jobs: { jobs: unknown[] }; jobData: Record<string, unknown> }>;
export function readJobsFromPgIfEnabled(deps?: unknown): Promise<{ pg: boolean; reason?: string; sources?: unknown }>;
