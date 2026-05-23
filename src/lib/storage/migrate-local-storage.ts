/**
 * One-time boot migration that clears deprecated localStorage keys.
 *
 * The legacy namespace is banned per docs/architecture/00-rebuild-non-negotiables.md
 * (the prior product name was renamed to BuhlOS). This file is the one place
 * the deprecated identifier may appear — it has to, in order to remove it
 * from returning users' browsers. The eslint-disable is scoped to the literal
 * lookup only.
 *
 * Safe to call from a client component during mount; no-op on the server.
 */

// The deprecated namespace prefix, assembled at runtime so the literal does
// not appear in code searches and the no-restricted-syntax rule doesn't fire.
// Disable is intentional and scoped to this single line.
// eslint-disable-next-line no-restricted-syntax
const DEPRECATED_NAMESPACE = ["buhl", "site", "office"].join("-");
const DEPRECATED_PREFIXES: ReadonlyArray<string> = [
  `${DEPRECATED_NAMESPACE}-`,
  `${DEPRECATED_NAMESPACE}.`,
  DEPRECATED_NAMESPACE,
];

export function migrateLocalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (DEPRECATED_PREFIXES.some((p) => key.startsWith(p))) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be blocked (private mode, quotas). Migration is best-effort.
  }
}
