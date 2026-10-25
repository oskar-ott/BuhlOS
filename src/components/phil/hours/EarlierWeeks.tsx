"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { EARLIER_WEEKS_SHOWN, weekRows, type EarlierWeek } from "@/domains/timesheets/hours-view";
import { HoursWeekCard, type WeekCardProps } from "./HoursWeekCard";

/**
 * Earlier weeks (docs/phil-hours.md): `Back to this week`, then a card of
 * folded weeks ("5–11 Oct · 30h 24m" / "4 days · all approved"). Opening one
 * shows its days in the same row design; days still inside the 14-day window
 * can be picked (the panel then carries the backdated line); older days are
 * read-only except the fix path.
 */
export function EarlierWeeks({
  weeks,
  hidden,
  openWeek,
  onToggleWeek,
  onBack,
  todayISO,
  rowProps,
}: {
  weeks: ReadonlyArray<EarlierWeek>;
  hidden: number;
  openWeek: string | null;
  onToggleWeek: (weekStart: string) => void;
  onBack: () => void;
  todayISO: string;
  rowProps: Omit<WeekCardProps, "rows" | "testIdPrefix">;
}): ReactNode {
  return (
    <div className="space-y-3" data-testid="hours-earlier-weeks">
      <button
        type="button"
        onClick={onBack}
        data-testid="hours-back-to-this-week"
        className="inline-flex min-h-[44px] items-center gap-1 font-display text-[15px] font-semibold text-brand-navy"
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        Back to this week
      </button>

      {weeks.length === 0 ? (
        <p className="rounded-[16px] border border-border bg-surface p-4 text-[14px] text-text-muted">
          No earlier weeks yet.
        </p>
      ) : (
        <ul className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface shadow-card">
          {weeks.map((week) => {
            const open = week.weekStart === openWeek;
            return (
              <li key={week.weekStart} data-testid={`hours-earlier-week-${week.weekStart}`}>
                <button
                  type="button"
                  onClick={() => onToggleWeek(week.weekStart)}
                  aria-expanded={open}
                  className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-subtle"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="font-display text-[16px] font-bold">{week.range}</span>
                      {week.entries.length > 0 ? (
                        <span className="font-display text-[16px] font-bold tabular-nums">
                          {formatHoursLabel(week.totalHours)}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-[14px] text-text-muted">
                      {week.line}
                      {week.hasLoggableDays && week.entries.length < 7
                        ? " · days can still be logged"
                        : ""}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "h-5 w-5 shrink-0 text-text-muted transition-transform",
                      open && "rotate-180"
                    )}
                  />
                </button>
                {open ? (
                  <div className="border-t border-[#eef2f6] bg-surface-subtle p-2">
                    <HoursWeekCard
                      {...rowProps}
                      rows={weekRows(week.weekStart, week.entries, todayISO)}
                      testIdPrefix={`hours-earlier-day`}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 || weeks.length >= EARLIER_WEEKS_SHOWN ? (
        <p className="text-[13px] text-text-muted">
          {`Showing your last ${weeks.length} weeks — the office keeps the rest.`}
        </p>
      ) : null}
    </div>
  );
}
