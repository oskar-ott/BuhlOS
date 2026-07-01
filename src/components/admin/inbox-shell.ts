/**
 * Shared field-to-office inbox shell — pure shaping helpers (brief §6).
 *
 * The five cross-job inboxes (Defects · From-site/Observations · Material
 * requests · Expenses · Dayworks) are each a filterable register over LIVE
 * source data. Their CHROME — the glanceable stat strip, the filter bar, the
 * "N of M" count, the success/error banners — was duplicated byte-for-byte
 * across the registers (ObservationsInbox + MaterialRequestsInbox each carried
 * a private `SummaryCard` + `FilterSelect`). This module + InboxShell.tsx hoist
 * that one shell so the instances share it and only own their data + row logic.
 *
 * Pure + deterministic so the colour logic is unit-tested in isolation; the
 * components import these helpers and render. No source of truth, no fetch.
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers): the stat
 * strip renders the value it is HANDED. A signal that didn't load passes "—"
 * (see `INBOX_STAT_DASH`), never a fabricated 0; a real zero stays a calm,
 * muted "0" (toneClass collapses to neutral) so an empty queue never lights up
 * a warning/danger colour it hasn't earned.
 */

/**
 * Semantic tone for a stat tile's value. Mirrors the register palette:
 *   - neutral — calm default / a plain count
 *   - warning — needs-attention amber (e.g. awaiting review)
 *   - danger  — loud red (e.g. urgent / high, blockers, payment risk)
 *   - success — done/green (e.g. delivered, reimbursed)
 *   - info    — in-flight blue (e.g. on order)
 */
export type InboxStatTone = "neutral" | "warning" | "danger" | "success" | "info";

/** The honest "didn't load" placeholder for a stat value (never a fake 0). */
export const INBOX_STAT_DASH = "—";

/**
 * Text-colour class for a stat value.
 *
 * `muted` is true when the tile carries no live signal yet — a real zero count
 * OR the dash placeholder. Both render calm/muted so an empty queue never lights
 * up an unearned warning/danger colour (matches the existing inboxes, where a
 * `value === 0` tile fell back to `text-text-muted`).
 *
 * The non-muted classes reuse the exact palette the registers already shipped
 * (rose/amber/emerald/sky 700) so adoption is pixel-identical, not a re-theme.
 */
export function inboxStatToneClass(tone: InboxStatTone, muted: boolean): string {
  if (muted) return "text-text-muted";
  switch (tone) {
    case "danger":
      return "text-rose-700";
    case "warning":
      return "text-amber-700";
    case "success":
      return "text-emerald-700";
    case "info":
      return "text-sky-700";
    case "neutral":
    default:
      return "text-text";
  }
}

/**
 * Whether a stat value should read as "muted" (no earned colour). A numeric 0
 * is muted; the dash placeholder is muted; any other value carries its tone.
 * Centralised so every inbox treats an empty queue the same way.
 */
export function isMutedStatValue(value: string | number): boolean {
  if (typeof value === "number") return value === 0;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "0" || trimmed === INBOX_STAT_DASH;
}

/** "N of M" filter-count label — the count slot every inbox filter bar shows. */
export function inboxFilterCountLabel(shown: number, total: number): string {
  return `${shown} of ${total}`;
}
