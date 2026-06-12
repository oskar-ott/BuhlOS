import { z } from "zod";
import { SNAG_PRIORITIES, SNAG_STATUSES, SnagPrioritySchema, SnagStatusSchema } from "./schema";
import { isActive } from "./format";
import type { SnagPriority, SnagStatus } from "./types";

/**
 * Cross-job defects register (#414) — the pure normalisation contract
 * between the TWO per-job snag stores and the one register shape that
 * /api/snags-all serves and /defects renders.
 *
 * Each job's jobs/<id>/data.json carries:
 *   - `snags[]`   — LEGACY store: { id, desc, priority: High|Medium|Low,
 *                   status: Open|Closed, dwelling, by, createdAt, photos[],
 *                   assignedToUserId?, assignedToName? }. Written by the
 *                   pre-cutover endpoints (api/snag-quick-raise.js etc.).
 *   - `snagsV2[]` — LIVE store written by api/snags.js (SnagItemSchema in
 *                   ./schema.ts): six-status lifecycle, low|normal|high|urgent
 *                   priority, denormalised areaName, evidenceIds links.
 *
 * The register normalises BOTH into one shape so the office sees every
 * defect in one queue. No new status vocabulary is invented: the register
 * speaks the v2 vocabulary (SNAG_STATUSES / SNAG_PRIORITIES) and legacy
 * values map INTO it (Open→open, Closed→closed; High→high, Medium→normal,
 * Low→low).
 *
 * api/snags-all.js implements this exact mapping in CJS (it cannot import
 * TS). The API-harness test (snags-all-api.test.ts) uses the functions in
 * this module as the oracle — handler output must equal what
 * normaliseLegacySnag / normaliseV2Snag produce — so the two copies cannot
 * drift silently. Same keep-in-sync convention as the snag state machine
 * (api/snags.js ↔ src/domains/snags/service.ts).
 *
 * Cross-ref:
 *   api/snags-all.js — the serving endpoint (admin: all jobs; LH: assigned)
 *   api/snags-bulk-close.js — per-job bulk close, both stores
 *   src/components/admin/DefectsRegister.tsx — the /defects client
 */

// ── Register shape ────────────────────────────────────────────────────

export const REGISTER_SOURCES = ["v2", "legacy"] as const;
export const RegisterSourceSchema = z.enum(REGISTER_SOURCES);
export type RegisterSource = z.infer<typeof RegisterSourceSchema>;

/** One normalised snag as served by GET /api/snags-all. */
export const RegisterSnagSchema = z
  .object({
    id: z.string(),
    source: RegisterSourceSchema,
    jobId: z.string(),
    jobName: z.string(),
    jobStatus: z.string(),
    /** v2 title / legacy desc. */
    title: z.string(),
    /** Always the v2 vocabulary — legacy Open→open, Closed→closed. */
    status: SnagStatusSchema,
    /** Always the v2 vocabulary — legacy High→high, Medium→normal, Low→low. */
    priority: SnagPrioritySchema,
    /** v2 areaName / legacy dwelling display name. */
    areaName: z.string().nullable(),
    assignedToName: z.string().nullable(),
    createdAt: z.string(),
    /** v2 evidenceIds count / legacy photos count. */
    evidenceCount: z.number(),
  })
  .passthrough();

export type RegisterSnag = z.infer<typeof RegisterSnagSchema>;

/** GET /api/snags-all response — `jobs` is the viewer-visible job list
 *  (admin: all; LH: assigned only) for the register's job filter. */
export const DefectsRegisterResponseSchema = z.object({
  snags: z.array(RegisterSnagSchema),
  jobs: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
});

export type DefectsRegisterResponse = z.infer<typeof DefectsRegisterResponseSchema>;
export type RegisterJobRef = DefectsRegisterResponse["jobs"][number];

// ── Normalisation (the contract api/snags-all.js mirrors) ────────────

/** Job-level context the per-snag mappers need. */
export interface RegisterJobContext {
  jobId: string;
  jobName: string;
  jobStatus: string;
  /** Legacy `dwelling` is an area id; the job's areaGroups resolve it to a
   *  display name. Absent/unknown ids fall back to the raw id (matches the
   *  pre-#414 snags-all dwellingName behaviour). */
  areaNameById?: Readonly<Record<string, string>>;
}

export function legacyStatusToRegister(raw: unknown): SnagStatus {
  // Legacy vocabulary is exactly Open|Closed with Open the historical
  // default for missing/odd values.
  return raw === "Closed" ? "closed" : "open";
}

export function legacyPriorityToRegister(raw: unknown): SnagPriority {
  if (raw === "High") return "high";
  if (raw === "Low") return "low";
  // Medium was the legacy default — and the legacy writers defaulted
  // missing priority to Medium too.
  return "normal";
}

const STATUS_SET = new Set<string>(SNAG_STATUSES);
const PRIORITY_SET = new Set<string>(SNAG_PRIORITIES);

/** Minimal slices of the raw store rows the mappers read. Kept loose
 *  (unknown-tolerant) because data.json rows predate every schema. */
export interface RawLegacySnag {
  id?: unknown;
  desc?: unknown;
  status?: unknown;
  priority?: unknown;
  dwelling?: unknown;
  assignedToName?: unknown;
  createdAt?: unknown;
  date?: unknown;
  photos?: unknown;
  /** Real rows carry more (by, stage, assignedToUserId, …) — ignored here. */
  [key: string]: unknown;
}

export interface RawV2Snag {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  priority?: unknown;
  areaName?: unknown;
  assignedToName?: unknown;
  createdAt?: unknown;
  evidenceIds?: unknown;
  /** Real rows carry the full SnagItem shape — ignored here. */
  [key: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function normaliseLegacySnag(raw: RawLegacySnag, ctx: RegisterJobContext): RegisterSnag {
  const dwelling = str(raw.dwelling);
  const resolved = dwelling ? (ctx.areaNameById?.[dwelling] ?? dwelling) : null;
  return {
    id: str(raw.id),
    source: "legacy",
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    jobStatus: ctx.jobStatus,
    title: str(raw.desc),
    status: legacyStatusToRegister(raw.status),
    priority: legacyPriorityToRegister(raw.priority),
    areaName: resolved,
    assignedToName: str(raw.assignedToName) || null,
    createdAt: str(raw.createdAt) || str(raw.date),
    evidenceCount: Array.isArray(raw.photos) ? raw.photos.length : 0,
  };
}

export function normaliseV2Snag(raw: RawV2Snag, ctx: RegisterJobContext): RegisterSnag {
  const status = str(raw.status);
  const priority = str(raw.priority);
  return {
    id: str(raw.id),
    source: "v2",
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    jobStatus: ctx.jobStatus,
    title: str(raw.title),
    // api/snags.js only ever writes valid values; tolerate hand-edited
    // blobs by falling back to the store defaults rather than throwing.
    status: (STATUS_SET.has(status) ? status : "open") as SnagStatus,
    priority: (PRIORITY_SET.has(priority) ? priority : "normal") as SnagPriority,
    areaName: str(raw.areaName) || null,
    assignedToName: str(raw.assignedToName) || null,
    createdAt: str(raw.createdAt),
    evidenceCount: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.length : 0,
  };
}

// ── Bulk close (POST /api/snags-bulk-close?jobId=) ───────────────────

/** Response shape of api/snags-bulk-close.js (per-snag results, never
 *  all-or-nothing). `source` was added in #414 when the endpoint learned
 *  to close v2 snags; `desc` carries the v2 title / legacy desc. */
export const BulkCloseSnagsResponseSchema = z.object({
  jobId: z.string(),
  closedCount: z.number(),
  failedCount: z.number(),
  closed: z.array(
    z
      .object({
        snagId: z.string(),
        source: RegisterSourceSchema,
        desc: z.string(),
      })
      .passthrough()
  ),
  failed: z.array(
    z
      .object({
        snagId: z.string().nullable(),
        error: z.string(),
      })
      .passthrough()
  ),
});

export type BulkCloseSnagsResponse = z.infer<typeof BulkCloseSnagsResponseSchema>;

/**
 * Can the bulk-close endpoint close this row? Closed rows are done;
 * rejected (v2 only) means admin ruled it NOT a defect — the endpoint
 * refuses both, so the register never offers a checkbox it knows will
 * fail. Legacy rows only ever map to open|closed, so the one rule
 * covers both stores.
 */
export function isRegisterSnagClosable(item: Pick<RegisterSnag, "status">): boolean {
  return item.status !== "closed" && item.status !== "rejected";
}

// ── Default filter + sort ─────────────────────────────────────────────

/**
 * The register's default ("open-ish") statuses — derived from the domain's
 * isActive() (open | in_progress | resolved), never hand-listed. Verified
 * and closed are isDone(); rejected is the admin-already-pushed-back branch
 * that needs the WORKER, not the office — all three stay out of the default
 * chasing queue and remain reachable via their own filter / "All".
 */
export const REGISTER_DEFAULT_STATUSES: ReadonlyArray<SnagStatus> =
  SNAG_STATUSES.filter(isActive);

const DEFAULT_STATUS_SET = new Set<SnagStatus>(REGISTER_DEFAULT_STATUSES);

const PRIORITY_RANK: Record<SnagPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Register attention order: still-active rows first, then priority
 * (urgent→low), then OLDEST first (the queue is "what's been waiting
 * longest"), then id for a stable total order. Mirrored by the sort in
 * api/snags-all.js.
 */
export function compareRegisterSnags(a: RegisterSnag, b: RegisterSnag): number {
  const activeDelta = (isActive(a.status) ? 0 : 1) - (isActive(b.status) ? 0 : 1);
  if (activeDelta !== 0) return activeDelta;
  const prioDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (prioDelta !== 0) return prioDelta;
  const createdDelta = a.createdAt.localeCompare(b.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return a.id.localeCompare(b.id);
}

// ── URL / query-param contract (?status= · ?priority= · ?jobId=) ─────

/** null = no/invalid param → the REGISTER_DEFAULT_STATUSES set. */
export type RegisterStatusFilter = SnagStatus | "all" | null;

/**
 * Parse a ?status= value. Case-insensitive so the endpoint's pre-#414
 * callers' vocabulary still lands somewhere sensible: "Open" → open,
 * "Closed" → closed. Unknown/absent → null (default = active statuses).
 */
export function parseRegisterStatusParam(v: string | null): RegisterStatusFilter {
  if (!v) return null;
  const low = v.toLowerCase();
  if (low === "all") return "all";
  return STATUS_SET.has(low) ? (low as SnagStatus) : null;
}

/**
 * Parse a ?priority= value into the v2 vocabulary. Case-insensitive;
 * legacy "Medium" maps to normal (the same mapping the rows get).
 */
export function parseRegisterPriorityParam(v: string | null): SnagPriority | null {
  if (!v) return null;
  const low = v.toLowerCase();
  if (low === "medium") return "normal";
  return PRIORITY_SET.has(low) ? (low as SnagPriority) : null;
}

// ── Client-side filtering over the loaded register ────────────────────

export interface RegisterFilters {
  status: RegisterStatusFilter;
  priority: SnagPriority | null;
  jobId: string | null;
}

export function matchesRegisterFilters(item: RegisterSnag, f: RegisterFilters): boolean {
  if (f.status === null) {
    if (!DEFAULT_STATUS_SET.has(item.status)) return false;
  } else if (f.status !== "all" && item.status !== f.status) {
    return false;
  }
  if (f.priority && item.priority !== f.priority) return false;
  if (f.jobId && item.jobId !== f.jobId) return false;
  return true;
}

export function filterRegisterSnags(
  items: ReadonlyArray<RegisterSnag>,
  f: RegisterFilters
): RegisterSnag[] {
  return items.filter((item) => matchesRegisterFilters(item, f));
}

/** Per-status counts across the WHOLE loaded register (pill badges). */
export function registerStatusCounts(
  items: ReadonlyArray<RegisterSnag>
): Map<SnagStatus, number> {
  const counts = new Map<SnagStatus, number>();
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return counts;
}

/** Count of rows the DEFAULT (active) filter shows — the "Active" pill badge. */
export function registerActiveCount(items: ReadonlyArray<RegisterSnag>): number {
  return items.reduce((n, item) => n + (DEFAULT_STATUS_SET.has(item.status) ? 1 : 0), 0);
}

/**
 * Honest, filter-aware empty copy. Never a bare "nothing here" when a
 * filter is narrowing the list (#216 convention — see jobsEmptyStateMessage).
 */
export function registerEmptyStateMessage(
  f: RegisterFilters,
  opts: { jobName?: string | null; statusLabelOf: (s: SnagStatus) => string } = {
    statusLabelOf: (s) => s,
  }
): string {
  const parts: string[] = [];
  if (f.status === null) parts.push("active");
  else if (f.status !== "all") parts.push(opts.statusLabelOf(f.status).toLowerCase());
  const what = `${parts.length ? `${parts.join(" ")} ` : ""}defects`;
  const scope = f.jobId ? ` on ${opts.jobName || "that job"}` : " across your jobs";
  const prio = f.priority ? ` with ${f.priority} priority` : "";
  return `No ${what}${prio}${scope}.`;
}
