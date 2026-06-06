import { JobDetailResponseSchema } from "@/domains/jobs/schema";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import { EvidenceListResponseSchema } from "@/domains/evidence/schema";
import { AuditLogListResponseSchema } from "@/domains/audit-log/schema";
import type { Job } from "@/domains/jobs/types";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { AuditLogEntry } from "@/domains/audit-log/types";

/**
 * Response parsers for the admin Job hub's operational-loop loader.
 *
 * Each takes a settled `fetch` (the hub fires job + hours + evidence + activity
 * in one `Promise.allSettled` pass — see `loadJobInterface` in
 * src/app/v2/jobs/[jobId]/page.tsx) and turns it into a typed, defensive slice:
 *   - a rejected settle  → an error string (never throws)
 *   - a non-ok response  → an error string with the status
 *   - a malformed body   → "Unexpected … shape" (schema safeParse failure)
 *   - success            → the validated payload
 *
 * The job slice gates the page (not_found / forbidden / error full-page
 * states); the three operational slices are best-effort and degrade to their
 * own card's error state. These are framework-agnostic (no next/headers, no
 * fetch) so they can be unit-tested without a server — the loader keeps the
 * header/fetch wiring.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/page.tsx — loadJobInterface (the caller)
 *   src/app/v2/jobs/[jobId]/history/page.tsx — the Promise.allSettled precedent
 */

export type LoadResult =
  | { kind: "ok"; job: Job }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export interface HoursSlice {
  entries: TimeEntry[];
  error: string | null;
}
export interface EvidenceSlice {
  evidence: EvidenceItem[];
  error: string | null;
}
export interface ActivitySlice {
  entries: AuditLogEntry[];
  error: string | null;
}

export interface JobInterfaceData {
  /** Gates the page. */
  job: LoadResult;
  /** Approver SUBMITTED queue — hours awaiting approval (cross-job; the Labour
   *  card filters to this job). */
  hours: HoursSlice;
  /** Per-job evidence captures (already job-scoped server-side). */
  evidence: EvidenceSlice;
  /** Per-job audit-log activity (scope=job). */
  activity: ActivitySlice;
}

function rejectionMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Network error";
}

export async function parseJobResult(
  settled: PromiseSettledResult<Response>,
): Promise<LoadResult> {
  if (settled.status === "rejected") {
    return { kind: "error", message: rejectionMessage(settled.reason) };
  }
  const res = settled.value;
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 403) return { kind: "forbidden" };
  if (!res.ok) return { kind: "error", message: `API returned ${res.status}` };
  const body = await res.json().catch(() => null);
  const parsed = JobDetailResponseSchema.safeParse(body);
  if (!parsed.success) return { kind: "error", message: "Unexpected response shape" };
  return { kind: "ok", job: parsed.data.job };
}

export async function parseHoursResult(
  settled: PromiseSettledResult<Response>,
): Promise<HoursSlice> {
  if (settled.status === "rejected") {
    return { entries: [], error: rejectionMessage(settled.reason) };
  }
  const res = settled.value;
  if (!res.ok) return { entries: [], error: `Hours API returned ${res.status}` };
  const body = await res.json().catch(() => null);
  const parsed = TimeEntryListResponseSchema.safeParse(body);
  if (!parsed.success) return { entries: [], error: "Unexpected hours response shape" };
  return { entries: parsed.data.entries, error: null };
}

export async function parseEvidenceResult(
  settled: PromiseSettledResult<Response>,
): Promise<EvidenceSlice> {
  if (settled.status === "rejected") {
    return { evidence: [], error: rejectionMessage(settled.reason) };
  }
  const res = settled.value;
  if (!res.ok) return { evidence: [], error: `Evidence API returned ${res.status}` };
  const body = await res.json().catch(() => null);
  const parsed = EvidenceListResponseSchema.safeParse(body);
  if (!parsed.success) return { evidence: [], error: "Unexpected evidence response shape" };
  return { evidence: parsed.data.evidence, error: null };
}

export async function parseActivityResult(
  settled: PromiseSettledResult<Response>,
): Promise<ActivitySlice> {
  if (settled.status === "rejected") {
    return { entries: [], error: rejectionMessage(settled.reason) };
  }
  const res = settled.value;
  if (!res.ok) return { entries: [], error: `Activity API returned ${res.status}` };
  const body = await res.json().catch(() => null);
  const parsed = AuditLogListResponseSchema.safeParse(body);
  if (!parsed.success) return { entries: [], error: "Unexpected activity response shape" };
  return { entries: parsed.data.entries, error: null };
}
