// Server-only read of the migration trust layer (public.sync_checks) for the
// admin status view. Honest about the two "no data" states: SUPABASE not wired
// in this environment, or no check recorded yet. Never throws to the page.
import { getDb } from "../../api/_lib/supabase-db.js";

// getDb is typed `unknown` in its .d.ts (it returns a Postgres.js tagged-template
// client). Narrow it to the minimal callable shape this module uses.
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>;

export type HoursSyncCheck = {
  status: string;
  checked_at: string;
  blob_count: number;
  pg_count: number;
  blob_total: number;
  pg_total: number;
  matched: number;
  only_in_blob: number;
  only_in_pg: number;
  mismatched: number;
  allocations_checked: boolean;
  hash_match: boolean;
  details: Record<string, unknown>;
  duration_ms: number | null;
};

export type HoursSyncStatus =
  | { wired: false; check: null; error?: string }
  | { wired: true; check: HoursSyncCheck | null };

/** Latest hours sync-check, or an honest no-data state. Server-only. */
export async function loadHoursSyncStatus(): Promise<HoursSyncStatus> {
  // No Supabase in this runtime (e.g. production today) → honestly "not wired".
  if (!process.env.SUPABASE_DB_URL) return { wired: false, check: null };
  try {
    const sql = getDb({ mode: "read" }) as unknown as SqlTag;
    const rows = await sql`
      select status, checked_at::text as checked_at, blob_count, pg_count,
             blob_total::float8 as blob_total, pg_total::float8 as pg_total,
             matched, only_in_blob, only_in_pg, mismatched,
             allocations_checked, (blob_hash = pg_hash) as hash_match,
             details, duration_ms
      from public.sync_checks
      where domain = 'hours'
      order by checked_at desc
      limit 1
    `;
    return { wired: true, check: (rows[0] as HoursSyncCheck) ?? null };
  } catch (err) {
    return { wired: false, check: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export type HoursSyncSummary =
  | { state: "not_wired" }
  | { state: "none" }
  | {
      state: "pass" | "fail";
      checkedAt: string;
      blobCount: number;
      pgCount: number;
      blobTotal: number;
      pgTotal: number;
      allocationsChecked: boolean;
      hashMatch: boolean;
      onlyInBlob: number;
      onlyInPg: number;
      mismatched: number;
      details: Record<string, unknown>;
    };

/** Pure view model for the status card. */
export function summariseHoursSync(status: HoursSyncStatus): HoursSyncSummary {
  if (!status.wired) return { state: "not_wired" };
  if (!status.check) return { state: "none" };
  const c = status.check;
  return {
    state: c.status === "pass" ? "pass" : "fail",
    checkedAt: c.checked_at,
    blobCount: c.blob_count,
    pgCount: c.pg_count,
    blobTotal: c.blob_total,
    pgTotal: c.pg_total,
    allocationsChecked: c.allocations_checked,
    hashMatch: c.hash_match,
    onlyInBlob: c.only_in_blob,
    onlyInPg: c.only_in_pg,
    mismatched: c.mismatched,
    details: c.details ?? {},
  };
}
