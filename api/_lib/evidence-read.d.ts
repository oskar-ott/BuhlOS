// Type surface for the evidence-metadata read-cutover readiness probe
// (evidence-read.js). Diagnostics-only; counts + booleans, never field values.

export interface EvidenceReadProbeResult {
  available: boolean; // SUPABASE_DB_URL present in this runtime
  jobsTotal: number;
  jobsSampled: number;
  faithful: number; // sampled jobs whose evidence is fully PG-faithful (normalised parity)
  drifted: number; // sampled jobs with any mismatch / missing either side
  unavailable: number; // sampled jobs not present in the PG reconstruction (not mirrored)
  matchedEvidence: number; // evidence items matched (id + migrated-field signature)
  mismatchedEvidence: number; // id in both, migrated fields differ
  missingInPg: number; // Blob evidence id with no PG counterpart
  missingInBlob: number; // PG evidence id with no Blob counterpart (orphan)
  readyForOverlay: boolean; // strict gate: jobsSampled>0 && drifted===0 && unavailable===0
  latencyMs: number;
  fallbackReason: string | null; // 'no supabase env' | 'no tenant' | 'error' | null
  error?: string;
}

export interface EvidenceItemLike {
  id?: string | null;
  kind?: string | null;
  areaId?: string | null;
  stage?: string | null;
  taskId?: string | null;
  status?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

export function compareEvidence(
  blobEv?: EvidenceItemLike[],
  pgEv?: EvidenceItemLike[],
): { matched: number; mismatched: number; missingInPg: number; missingInBlob: number };

export interface EvidenceOverlayDiag {
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
  error?: string | null;
}

export function readAdminEvidence(input?: {
  jobId: string;
  data: { evidence?: EvidenceItemLike[]; [key: string]: unknown };
  getDb?: unknown;
  isFlagOn?: (key: string) => Promise<boolean>;
  tenantSlug?: string;
  now?: () => number;
}): Promise<{ data: unknown; diag: EvidenceOverlayDiag }>;

export function probeEvidenceReadParity(input?: {
  getDb?: unknown;
  readBlob?: (key: string, fallback: unknown) => Promise<unknown>;
  tenantSlug?: string;
  now?: () => number;
  sampleLimit?: number;
  loadStructure?: (sql: unknown, tenantId: string) => Promise<{ jobs: { jobs: Array<{ id: string }> }; jobData: Record<string, { evidence?: EvidenceItemLike[] }> }>;
}): Promise<EvidenceReadProbeResult>;
