import { TimeEntrySchema } from "./schema";
import type { TimeEntry } from "./types";

/**
 * Lenient parse of a `GET /api/time-entries` response body.
 *
 * The endpoint returns `{ entries: TimeEntry[] }`. The Phil Hours and My Day
 * screens used to run the whole array through one strict schema, so a SINGLE
 * malformed row (e.g. a legacy entry that lost its allocation, or a null hours
 * field) failed the parse and blanked the worker's ENTIRE screen with
 * "Unexpected response shape".
 *
 * This validates each entry independently: valid rows are kept, invalid rows
 * are dropped and counted (the caller can log the count), and the screen keeps
 * working. `ok: false` is reserved for a genuinely wrong TOP-LEVEL shape — not
 * an object with an `entries` array — which is the only case worth surfacing to
 * the worker as an error.
 */
export function parseTimeEntryListLenient(
  body: unknown
): { ok: true; entries: TimeEntry[]; dropped: number } | { ok: false } {
  if (!body || typeof body !== "object") return { ok: false };
  const rawEntries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) return { ok: false };

  const entries: TimeEntry[] = [];
  let dropped = 0;
  for (const raw of rawEntries) {
    const parsed = TimeEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else dropped += 1;
  }
  return { ok: true, entries, dropped };
}
