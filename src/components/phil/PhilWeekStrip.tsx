import Link from "next/link";
import { cn } from "@/lib/cn";
import type { TimeEntry } from "@/domains/timesheets/types";
import { buildPhilWeek, type WeekDayState } from "./philWeek";
import styles from "./myDay.module.css";

// state → the scoped day-cell class (filled tints / yellow ring / dashed),
// faithful to the design's myday-v2.css. See myDay.module.css. (CSS-module
// class lookups are `string | undefined` under noUncheckedIndexedAccess.)
const DAY_STATE: Record<WeekDayState, string | undefined> = {
  logged: styles.logged,
  fix: styles.fix,
  today: styles.today,
  miss: styles.miss,
  off: styles.off,
  upcoming: styles.upcoming,
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
 * the approved final Phil My Day. Every cell is real (see philWeek.ts); nothing
 * is fabricated, and a day with no entry is shown honestly (missing / off / log
 * now), never as a guessed value.
 *
 * Styled to the design via the scoped myDay.module.css (filled state tints +
 * JetBrains Mono microcopy) rather than the app's flat utility defaults.
 */
export function PhilWeekStrip({ entries, todayISO }: Props) {
  const week = buildPhilWeek(entries, { todayISO });
  // "Mon 20 – Sun 26 May", widening to show the start month across a boundary.
  const startLabel =
    monthShort(week.weekStart) === monthShort(week.weekEnd)
      ? dayNum(week.weekStart)
      : dayMonth(week.weekStart);
  // Single strings (not adjacent JSX text) so SSR doesn't split them with
  // comment markers — keeps the rendered copy clean and testable.
  const rangeLabel = `Mon ${startLabel} – Sun ${dayMonth(week.weekEnd)} · wk ${week.weekNumber}`;
  const totalLabel = `${decimalHours(week.totalHours)}h`;

  return (
    <section className={styles.week}>
      <header className={styles.weekHead}>
        <div>
          <div className={styles.weekTitle}>This week</div>
          <div className={styles.weekRange}>{rangeLabel}</div>
        </div>
        <div className={styles.weekTotalWrap}>
          <div className={styles.weekTotal}>{totalLabel}</div>
          <div className={cn(styles.weekTodayFlag, !week.todayLogged && styles.warn)}>
            {week.todayLogged ? "Today logged" : "Today not logged"}
          </div>
        </div>
      </header>

      <ul className={styles.days}>
        {week.days.map((d) => (
          <li key={d.date} className={cn(styles.day, DAY_STATE[d.state])}>
            <span className={styles.dayLabel}>{d.weekday}</span>
            <div className={styles.box}>
              <span className={styles.hours}>
                {d.hours != null ? decimalHours(d.hours) : "—"}
              </span>
              <span className={styles.status}>{d.statusWord}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className={styles.weekFoot}>
        <Link href="/phil/hours" className={styles.seeHistory}>
          See history →
        </Link>
      </div>
    </section>
  );
}
