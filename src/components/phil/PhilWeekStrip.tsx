import Link from "next/link";
import { cn } from "@/lib/cn";
import type { TimeEntry } from "@/domains/timesheets/types";
import { buildPhilWeek, type WeekDayState } from "./philWeek";

// state → day-box classes. The app's state-* tokens are solid colours (no
// tinted fills), so tone is carried by border + text — the same way PhilNotice
// works — never a coloured wash.
const BOX: Record<WeekDayState, string> = {
  logged: "border-state-success text-state-success",
  today: "border-2 border-accent-yellow text-text",
  miss: "border-dashed border-state-warning text-state-warning",
  off: "border-dashed border-border text-text-muted opacity-60",
  upcoming: "border-dashed border-border text-text-muted opacity-60",
};

/** "7.6" — decimal hours, one place, as the design shows in the day cells. */
function decimalHours(h: number): string {
  return h.toFixed(1);
}

function parseUTC(dateISO: string): Date {
  return new Date(dateISO + "T00:00:00Z");
}
function dayNum(dateISO: string): string {
  return parseUTC(dateISO).toLocaleDateString("en-AU", { day: "numeric", timeZone: "UTC" });
}
function dayMonth(dateISO: string): string {
  return parseUTC(dateISO).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
function monthShort(dateISO: string): string {
  return parseUTC(dateISO).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
}

interface Props {
  entries: ReadonlyArray<TimeEntry>;
  todayISO: string;
}

/**
 * "This week" — the payroll timesheet at a glance (Mon–Sun), the lead block of
 * the approved final Phil My Day. Every cell is real (see philWeekStrip.ts);
 * nothing is fabricated, and a day with no entry is shown honestly (missing /
 * off / log now), never as a guessed value.
 */
export function PhilWeekStrip({ entries, todayISO }: Props) {
  const week = buildPhilWeek(entries, { todayISO });
  // "Mon 20 – Sun 26 May", widening to show the start month across a boundary.
  const startLabel =
    monthShort(week.weekStart) === monthShort(week.weekEnd)
      ? dayNum(week.weekStart)
      : dayMonth(week.weekStart);
  const range = `Mon ${startLabel} – Sun ${dayMonth(week.weekEnd)}`;

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-sm font-semibold tracking-tight text-text">
            This week
          </h2>
          <p className="mt-0.5 text-[11px] uppercase tracking-wider text-text-muted">
            {range} · wk {week.weekNumber}
          </p>
        </div>
        <div className="text-right">
          <p className="font-display text-lg font-semibold tabular-nums leading-none text-text">
            {decimalHours(week.totalHours)}h
          </p>
          <p
            className={cn(
              "mt-1 text-[11px] uppercase tracking-wider",
              week.todayLogged ? "text-text-muted" : "text-state-warning",
            )}
          >
            {week.todayLogged ? "Today logged" : "Today not logged"}
          </p>
        </div>
      </header>

      <ul className="flex gap-1.5 px-3 py-3">
        {week.days.map((d) => (
          <li key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              {d.weekday}
            </span>
            <div
              className={cn(
                "flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-card border bg-surface-subtle",
                BOX[d.state],
              )}
            >
              <span className="font-display text-xs font-bold tabular-nums leading-none">
                {d.hours != null ? decimalHours(d.hours) : "—"}
              </span>
              <span className="text-[7px] font-semibold uppercase tracking-wide leading-none">
                {d.statusWord}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="border-t border-border px-4 py-2.5 text-right">
        <Link
          href="/phil/hours"
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          See history →
        </Link>
      </div>
    </section>
  );
}
