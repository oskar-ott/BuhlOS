/**
 * The gear-scan URL scheme (#303) — the single source of truth for the URL a
 * printed QR label encodes and the scan landing page parses. Pure functions,
 * no I/O, no React — unit-testable in isolation.
 *
 * ## The sacred URL
 *
 * A printed sticker is forever. The URL it encodes must NEVER change shape, or
 * every label already stuck to a tool stops working. Treat `SCAN_PATH` the way
 * `docs/route-ownership.md` treats `/sw.js`: change behaviour behind it, never
 * the path or its query contract. See docs/route-ownership.md §4 (`/phil/gear/scan`).
 *
 * The QR encodes an ABSOLUTE URL so any phone's default camera app opens it in
 * the browser (no in-app scanner needed for v1) and lands in the Phil login
 * flow when signed out (`/v2/login?next=` round-trips it back).
 *
 * ## The namespace (cross-epic contract with #275)
 *
 * The query PARAM names the label's kind — it IS the namespace that keeps a
 * future non-asset label (a box, a location) from being misread as an asset:
 *
 *   /phil/gear/scan?asset=<id>      ← this issue (#303)
 *   /phil/gear/scan?location=<id>   ← RESERVED for #275 / van + warehouse check-in
 *   /phil/gear/scan?box=<id>        ← RESERVED for #275 / shelf + bin labels
 *
 * Only `asset` is live. `location` / `box` are reserved so #275 can build on the
 * same landing route without a reshape; `parseScanQuery` returns their kind so
 * the page can show an honest "not built yet" instead of a crash. The URL
 * carries the id ONLY — no names or PII (stickers get photographed and shared).
 */

/** The sacred landing path. Never change this — printed stickers depend on it. */
export const SCAN_PATH = "/phil/gear/scan";

/** The label kinds the scheme reserves. Only `asset` is live in v1 (#303). */
export const SCAN_KINDS = ["asset", "location", "box"] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

/** Kinds with a real landing experience today. #275 lights up the rest. */
export const LIVE_SCAN_KINDS: ReadonlyArray<ScanKind> = ["asset"];

export interface ScanTarget {
  kind: ScanKind;
  id: string;
}

/**
 * The relative scan URL for an asset — `/phil/gear/scan?asset=<id>`.
 * The id is URL-encoded so an odd id can never break the query.
 */
export function assetScanPath(assetId: string): string {
  return `${SCAN_PATH}?asset=${encodeURIComponent(assetId)}`;
}

/**
 * The ABSOLUTE scan URL a QR label encodes. `origin` is the production origin
 * (e.g. `https://app.example.com`) with no trailing slash. This is what gets
 * printed — encode the id, not the state, so reprints stay valid forever.
 */
export function assetScanUrl(origin: string, assetId: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${assetScanPath(assetId)}`;
}

/**
 * Parse a scan query into its target. Returns `null` when no recognised label
 * param is present (a non-BuhlOS QR, or a truncated/damaged sticker) so the
 * caller ignores it rather than crashing.
 *
 * Accepts either a `URLSearchParams` or a plain record (Next's `searchParams`).
 * Only the FIRST recognised kind wins, in `SCAN_KINDS` order, so a malformed
 * multi-param URL is still deterministic. An empty id is treated as absent.
 */
export function parseScanQuery(
  query: URLSearchParams | Record<string, string | string[] | undefined>,
): ScanTarget | null {
  const get = (key: string): string | undefined => {
    if (query instanceof URLSearchParams) return query.get(key) ?? undefined;
    const v = query[key];
    return Array.isArray(v) ? v[0] : v;
  };
  for (const kind of SCAN_KINDS) {
    const raw = get(kind);
    if (raw === undefined) continue;
    const id = raw.trim();
    if (!id) continue;
    return { kind, id };
  }
  return null;
}

/** True when a parsed target's kind has a real landing experience today. */
export function isLiveScanKind(kind: ScanKind): boolean {
  return LIVE_SCAN_KINDS.includes(kind);
}
