import type { TagItem } from "./schema";

/**
 * Expiry state for test & tag entries (#388) — the TS mirror of the window
 * semantics in api/_lib/tag-compliance.js (#305), so the field register, the
 * /gear compliance board and the daily alerts can never disagree about what
 * "expired" means. Parity is pinned by expiry.test.ts.
 *
 * Dates are dd/mm/yyyy (the register's canonical storage format); ISO
 * yyyy-mm-dd is accepted defensively. The window matches the alert loop's
 * 14 days.
 */

export const TAG_EXPIRY_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse "dd/mm/yyyy" (or ISO fallback) → ms at local midnight; NaN if unparseable. */
export function parseTagDate(value: string | undefined | null): number {
  if (!value) return NaN;
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return NaN;
}

export type TagExpiryStatus = "expired" | "expiring" | "ok" | "none";

export interface TagExpiryState {
  status: TagExpiryStatus;
  /** Signed days to expiry (<0 = overdue). Null when no parseable date. */
  daysToExpiry: number | null;
}

/** Expiry state relative to `now` (defaults to the real clock). */
export function tagExpiryState(
  expiryDate: string | undefined | null,
  now: Date = new Date(),
): TagExpiryState {
  const ms = parseTagDate(expiryDate);
  if (!Number.isFinite(ms)) return { status: "none", daysToExpiry: null };
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysToExpiry = Math.round((ms - today.getTime()) / DAY_MS);
  if (daysToExpiry < 0) return { status: "expired", daysToExpiry };
  if (daysToExpiry <= TAG_EXPIRY_WINDOW_DAYS) return { status: "expiring", daysToExpiry };
  return { status: "ok", daysToExpiry };
}

/** Display name: applianceType with the legacy `name` mirror as fallback. */
export function tagDisplayName(tag: Pick<TagItem, "applianceType" | "name" | "tagNumber">): string {
  return tag.applianceType?.trim() || tag.name?.trim() || tag.tagNumber?.trim() || "Untagged item";
}

export interface TagRegisterCounts {
  total: number;
  expired: number;
  expiring: number;
}

export function countTagRegister(
  tags: ReadonlyArray<TagItem>,
  now: Date = new Date(),
): TagRegisterCounts {
  let expired = 0;
  let expiring = 0;
  for (const t of tags) {
    const { status } = tagExpiryState(t.expiryDate, now);
    if (status === "expired") expired++;
    else if (status === "expiring") expiring++;
  }
  return { total: tags.length, expired, expiring };
}

/**
 * Register order: expired first (most overdue first), then expiring
 * (soonest first), then ok (soonest first), then dateless rows. Stable
 * within bands.
 */
export function sortTagsForRegister(
  tags: ReadonlyArray<TagItem>,
  now: Date = new Date(),
): TagItem[] {
  const rank: Record<TagExpiryStatus, number> = { expired: 0, expiring: 1, ok: 2, none: 3 };
  return [...tags].sort((a, b) => {
    const sa = tagExpiryState(a.expiryDate, now);
    const sb = tagExpiryState(b.expiryDate, now);
    if (rank[sa.status] !== rank[sb.status]) return rank[sa.status] - rank[sb.status];
    return (sa.daysToExpiry ?? 0) - (sb.daysToExpiry ?? 0);
  });
}
