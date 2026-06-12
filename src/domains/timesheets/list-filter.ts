import { statusLabel } from "./format";
import type { TimeEntry, TimeEntryStatus } from "./types";

/**
 * Pure filtering for the admin /hours overview — issue #216.
 *
 * The page already loads the three approver queues (submitted / approved /
 * rejected) plus the weekly rollup; these helpers narrow that ALREADY-LOADED
 * data by `?status=` + `?person=` server-side. No new endpoints, no extra
 * fetch params — the fetches stay byte-identical to before.
 *
 * The filterable status set is the queues the page actually loads. `draft`
 * is a real TimeEntryStatus but deliberately NOT offered: drafts live on
 * workers' devices-of-record and the page only ever sees their COUNT via
 * /api/today-pulse — offering a draft filter would be a dead control over
 * data this page never holds.
 *
 * Cross-ref:
 *   src/app/(admin)/hours/page.tsx — the consumer (server component)
 *   src/components/admin/HoursFilterBar.tsx — writes the query string
 *   src/domains/timesheets/format.ts — statusLabel / statusTone
 */

export const HOURS_FILTER_STATUSES = [
  "submitted",
  "approved",
  "rejected",
] as const satisfies ReadonlyArray<TimeEntryStatus>;

export type HoursFilterStatus = (typeof HOURS_FILTER_STATUSES)[number];

export interface HoursListFilter {
  /** null = all three loaded queues (no `?status=` param). */
  status: HoursFilterStatus | null;
  /** userId from `?person=`; null = everyone. */
  person: string | null;
}

/** True when the raw value is one of the loaded, filterable statuses. */
export function isHoursFilterStatus(raw: string): raw is HoursFilterStatus {
  return (HOURS_FILTER_STATUSES as ReadonlyArray<string>).includes(raw);
}

/**
 * Sanity bound for `?person=` / remembered person ids — they're opaque user
 * ids, so the only validation possible is "a sane non-empty string".
 */
export function isPersonParam(raw: string): boolean {
  return raw.trim() !== "" && raw.length <= 200;
}

/**
 * Validate raw query params into a filter. Unknown status (stale deep link,
 * retired value) and blank/absurd person values degrade silently to null —
 * the page renders unfiltered rather than erroring.
 */
export function parseHoursFilterParams(sp: {
  status?: string;
  person?: string;
}): HoursListFilter {
  const status = sp.status && isHoursFilterStatus(sp.status) ? sp.status : null;
  const person = sp.person && isPersonParam(sp.person) ? sp.person : null;
  return { status, person };
}

/**
 * Narrow entries by status + person + the viewed week (dates inclusive).
 * The approver queues are all-time, so the week bound is what makes the
 * filtered view compose with `?week=` navigation. Pure; sorts a copy by
 * date descending (most recent first within the week).
 */
export function filterTimeEntries(
  entries: ReadonlyArray<TimeEntry>,
  filter: HoursListFilter,
  range?: { fromDate: string; toDate: string }
): ReadonlyArray<TimeEntry> {
  return entries
    .filter((e) => {
      if (filter.status && e.status !== filter.status) return false;
      if (filter.person && e.userId !== filter.person) return false;
      if (range && (e.date < range.fromDate || e.date > range.toDate)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface PersonOption {
  id: string;
  name: string;
}

interface PersonSource {
  userId: string;
  userName?: string | null;
}

/**
 * Build the person-filter options from the viewer-scoped data the page has
 * ALREADY fetched — queue entries, the rollup's by-worker totals and the
 * missing-hours list. Never fetches users itself, so the options can't be
 * wider than what this viewer is allowed to see (#351 tier scoping).
 * De-duped by id (first non-empty name wins), sorted by name.
 */
export function buildPersonOptions(
  sources: ReadonlyArray<ReadonlyArray<PersonSource>>
): ReadonlyArray<PersonOption> {
  const byId = new Map<string, string>();
  for (const source of sources) {
    for (const row of source) {
      if (!row.userId) continue;
      const existing = byId.get(row.userId);
      const name = (row.userName ?? "").trim();
      if (existing === undefined) {
        byId.set(row.userId, name);
      } else if (existing === "" && name !== "") {
        byId.set(row.userId, name);
      }
    }
  }
  return Array.from(byId.entries())
    .map(([id, name]) => ({ id, name: name === "" ? id : name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Display name for the active person filter; honest fallback when the id
 *  isn't in the viewer's options (disabled worker, foreign deep link). */
export function personDisplayName(
  person: string,
  options: ReadonlyArray<PersonOption>
): string {
  return options.find((o) => o.id === person)?.name ?? "the selected person";
}

/**
 * Filter-aware empty-state copy naming the active narrowing — "No submitted
 * entries for Ben this week", never a bare "nothing here" (issue #216 AC).
 */
export function hoursEmptyStateMessage(
  filter: HoursListFilter,
  personName: string | null,
  weekLabel: string
): string {
  const statusPart = filter.status ? `${statusLabel(filter.status).toLowerCase()} ` : "";
  const personPart = filter.person && personName ? ` for ${personName}` : "";
  return `No ${statusPart}entries${personPart} ${weekLabel}.`;
}
