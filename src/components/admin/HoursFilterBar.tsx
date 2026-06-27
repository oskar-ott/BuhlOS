"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { statusLabel } from "@/domains/timesheets/format";
import {
  HOURS_FILTER_STATUSES,
  isHoursFilterStatus,
  isPersonParam,
  parseHoursFilterParams,
  type HoursListFilter,
  type PersonOption,
} from "@/domains/timesheets/list-filter";
import {
  clearRememberedFilters,
  writeRememberedFilters,
  type RememberedFilterSpec,
} from "@/lib/storage/remembered-filters";
import { useApplyRememberedFiltersOnce } from "@/lib/storage/use-remembered-filters";
import { cn } from "@/lib/cn";

/** Per-device remembered default for /hours (issue #216). Exported for the
 *  render test so it exercises the real key + validators. */
export const HOURS_FILTERS_STORAGE_KEY = "buhlos.hours-list.filters";
export const HOURS_FILTER_SPEC: RememberedFilterSpec = {
  status: isHoursFilterStatus,
  person: isPersonParam,
};

interface Props {
  /**
   * Person options built server-side from the data the page ALREADY fetched
   * (queue entries + weekly rollup + missing list) — viewer-scoped by
   * construction. This bar never fetches users itself, so it can't widen
   * what a leading hand is allowed to see (#351 tier scoping).
   */
  personOptions: ReadonlyArray<PersonOption>;
}

/**
 * Filter bar for the /hours overview — issue #216.
 *
 * The page is a server component and stays that way: this bar only WRITES
 * the query string (`?status=` + `?person=`, preserving `?week=`); the
 * server re-renders and filters the data it already loaded. Filter state is
 * read LIVE from useSearchParams() — never snapshotted into useState — so
 * same-route deep links re-filter correctly (the soft-nav pitfall,
 * #116→#118).
 *
 * Per-device memory: write-through happens in the interaction handlers
 * below (never on load, so opening a colleague's shared link doesn't
 * overwrite your default); the remembered set is applied once per mount via
 * useApplyRememberedFiltersOnce, and only when the URL carries neither
 * filter param — the URL always wins. "Reset to all" clears both the URL
 * params and the stored default in one click.
 *
 * Hydration safety: the server renders this bar from the URL params and the
 * client reads the same params — no storage is touched during render, so
 * the two can never disagree (no layout shift on hydrate).
 */
export function HoursFilterBar({ personOptions }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filter = parseHoursFilterParams({
    status: searchParams.get("status") ?? undefined,
    person: searchParams.get("person") ?? undefined,
  });

  useApplyRememberedFiltersOnce(HOURS_FILTERS_STORAGE_KEY, HOURS_FILTER_SPEC);

  /** Round-trip the next filter set through the URL (server re-filters) and
   *  write-through the per-device memory. Interaction handlers only. */
  const applyFilters = (next: HoursListFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.status) params.set("status", next.status);
    else params.delete("status");
    if (next.person) params.set("person", next.person);
    else params.delete("person");
    const qs = params.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
    writeRememberedFilters(HOURS_FILTERS_STORAGE_KEY, {
      status: next.status,
      person: next.person,
    });
  };

  const handleReset = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("status");
    params.delete("person");
    const qs = params.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
    clearRememberedFilters(HOURS_FILTERS_STORAGE_KEY);
  };

  // An active `?person=` that isn't in the viewer's options (worker since
  // disabled, foreign deep link) still has to be visible + clearable — render
  // it as an explicit extra option instead of silently showing "Everyone".
  const personKnown =
    filter.person === null || personOptions.some((o) => o.id === filter.person);

  const filtersActive = filter.status !== null || filter.person !== null;

  return (
    <div className="rounded-card border border-border bg-surface-raised p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="group"
          aria-label="Filter hours by status"
          className="flex flex-wrap items-center gap-1.5"
        >
          <StatusPill
            label="All"
            selected={filter.status === null}
            onClick={() => applyFilters({ ...filter, status: null })}
          />
          {HOURS_FILTER_STATUSES.map((s) => (
            <StatusPill
              key={s}
              label={statusLabel(s)}
              selected={filter.status === s}
              onClick={() => applyFilters({ ...filter, status: s })}
            />
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <span className="font-display text-xs uppercase tracking-wider text-text-muted">
            Person
          </span>
          <select
            value={filter.person ?? ""}
            onChange={(e) =>
              applyFilters({
                ...filter,
                person: e.target.value === "" ? null : e.target.value,
              })
            }
            disabled={personOptions.length === 0 && personKnown}
            aria-label="Filter hours by person"
            className="block h-9 w-full min-w-0 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60 sm:w-auto sm:min-w-[10rem] sm:max-w-[11rem]"
          >
            <option value="">Everyone</option>
            {personOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            {!personKnown && filter.person ? (
              <option value={filter.person}>Unknown person</option>
            ) : null}
          </select>
        </label>

        {filtersActive ? (
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            Reset to all
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Status filter pill. Selection uses the navy brand accent (doc 27 §6 —
 * brand accents mark SELECTION, never entity state; entry rows keep the
 * five-tone palette via timesheets statusTone).
 */
function StatusPill({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        selected
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      {label}
    </button>
  );
}
