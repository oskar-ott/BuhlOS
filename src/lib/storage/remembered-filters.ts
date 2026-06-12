/**
 * Per-device "remembered list filters" — issue #216.
 *
 * Each admin list (jobs, hours) remembers its last-used filter set in
 * localStorage under one key, so the list opens the way the admin left it.
 * Deliberately NOT a saved-view engine: one remembered default per list.
 *
 * Contract (enforced by the helpers + the useApplyRememberedFiltersOnce hook):
 *   - The URL is the only render input. Storage is never read during render —
 *     only inside a mount effect, and only applied via router.replace when
 *     the URL carries none of the list's filter params (URL always wins).
 *   - Write-through happens ON USER INTERACTION only (pill click, select
 *     change, debounced search input) — never on load, so opening someone
 *     else's shared link doesn't overwrite your remembered default.
 *   - Stored values are validated against the live domain sets on read;
 *     anything invalid is dropped (a status retired from the domain, junk
 *     from older builds).
 *   - localStorage unavailable (private mode, blocked, SSR) degrades
 *     silently to URL-only behaviour. Nothing here ever throws.
 *
 * There was no general storage wrapper in src/lib/storage/ to reuse (only
 * the one-shot legacy-key migration), so this module carries its own guarded
 * access. Storage is injectable for node-env tests.
 */

export type RememberedFilterSpec = Readonly<Record<string, (value: string) => boolean>>;

export type RememberedFilters = Readonly<Record<string, string>>;

/** Minimal slice of the Web Storage API the helpers need (test-injectable). */
export interface FilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): FilterStorage | null {
  // `typeof window` guard first: this module is imported by client components
  // that also render on the server, where `window` does not exist at all.
  if (typeof window === "undefined") return null;
  try {
    // Accessing window.localStorage itself can throw (blocked storage).
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Pure validation of a parsed storage payload against the spec. Keeps only
 * known params whose string values pass their validator; everything else —
 * non-objects, non-string values, unknown params, validator rejects — is
 * dropped without error.
 */
export function sanitizeRememberedFilters(
  raw: unknown,
  spec: RememberedFilterSpec
): RememberedFilters {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [param, validate] of Object.entries(spec)) {
    const value = (raw as Record<string, unknown>)[param];
    if (typeof value !== "string") continue;
    if (!validate(value)) continue;
    out[param] = value;
  }
  return out;
}

/** Read + validate the remembered set. {} when absent, invalid, or unavailable. */
export function readRememberedFilters(
  key: string,
  spec: RememberedFilterSpec,
  storage: FilterStorage | null = defaultStorage()
): RememberedFilters {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    return sanitizeRememberedFilters(JSON.parse(raw), spec);
  } catch {
    return {};
  }
}

/**
 * Write-through the CURRENT full filter set. Call from user-interaction
 * handlers only. An all-empty set removes the key (same as a reset).
 */
export function writeRememberedFilters(
  key: string,
  filters: Readonly<Record<string, string | null | undefined>>,
  storage: FilterStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    const entries = Object.entries(filters).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] !== ""
    );
    if (entries.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota / private mode — memory is best-effort, the URL still works.
  }
}

/** One-click "Reset to all" clears the stored default too. */
export function clearRememberedFilters(
  key: string,
  storage: FilterStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Best-effort, as above.
  }
}

/**
 * The mount-time decision, kept pure so the "remembered default applies only
 * when the URL is clean" branch is unit-testable without running effects:
 *
 *   - URL already carries ANY of the list's own filter params → null
 *     (URL wins outright; a shared link shows what the sender saw).
 *   - Nothing remembered (or nothing valid) → null.
 *   - Otherwise → the full query string to router.replace to: the current
 *     params (so non-filter params like ?week= survive) plus the remembered
 *     filter params.
 *
 * Returns the query string WITHOUT the leading "?", or null for "do nothing".
 */
export function rememberedFilterQuery(
  current: URLSearchParams,
  ownParams: ReadonlyArray<string>,
  stored: RememberedFilters
): string | null {
  if (ownParams.some((p) => current.has(p))) return null;
  const toApply: Array<[string, string]> = [];
  for (const p of ownParams) {
    const value = stored[p];
    if (typeof value === "string" && value !== "") toApply.push([p, value]);
  }
  if (toApply.length === 0) return null;
  const next = new URLSearchParams(current.toString());
  for (const [p, value] of toApply) next.set(p, value);
  return next.toString();
}
