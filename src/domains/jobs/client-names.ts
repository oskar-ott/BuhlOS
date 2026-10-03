import type { Job } from "./types";

/**
 * Client names (owner pull 2026-10-03: "choose, when setting up a job, what
 * builder it is for" — "have it as client"). A job's client is free text —
 * there is no clients register — so the picker suggests the names ALREADY
 * used on other jobs. That keeps one spelling per client without a settings
 * page to maintain: type a new name once and it's a suggestion from then on.
 *
 * Pure (no fetch, no React) so both create + edit forms and the tests share it.
 */

/** Case- and spacing-insensitive identity: "hutchinson  builders" ≡ "Hutchinson Builders". */
export function clientNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The distinct client names in use, most-used first (ties A→Z). Spellings
 * that differ only by case/spacing collapse to the one used most often.
 */
export function clientNameSuggestions(
  jobs: ReadonlyArray<Pick<Job, "clientName">>
): string[] {
  // key → (spelling → count)
  const byKey = new Map<string, Map<string, number>>();
  for (const j of jobs) {
    const raw = typeof j.clientName === "string" ? j.clientName.trim().replace(/\s+/g, " ") : "";
    if (!raw) continue;
    const key = clientNameKey(raw);
    const spellings = byKey.get(key) ?? new Map<string, number>();
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
    byKey.set(key, spellings);
  }
  const rows = [...byKey.values()].map((spellings) => {
    let best = "";
    let bestCount = 0;
    let total = 0;
    for (const [spelling, count] of spellings) {
      total += count;
      if (count > bestCount || (count === bestCount && spelling < best)) {
        best = spelling;
        bestCount = count;
      }
    }
    return { name: best, total };
  });
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return rows.map((r) => r.name);
}

/**
 * Snap a typed name onto an existing client's spelling when it's the same
 * client ("hutchinson builders" → "Hutchinson Builders"); otherwise the
 * typed name, tidied. Blank stays blank.
 */
export function canonicalClientName(typed: string, suggestions: ReadonlyArray<string>): string {
  const tidy = typed.trim().replace(/\s+/g, " ");
  if (!tidy) return "";
  const key = clientNameKey(tidy);
  return suggestions.find((s) => clientNameKey(s) === key) ?? tidy;
}
