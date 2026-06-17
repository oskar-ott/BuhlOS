import Link from "next/link";
import { cn } from "@/lib/cn";
import type { TimeEntry } from "@/domains/timesheets/types";
import { buildPhilWeek, type WeekDayCell, type WeekDayState } from "./philWeek";
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

/**
 * Screen-reader label for a tappable day cell. The visible cell already shows
 * the state word; this spells out what the tap leads to (log / fix / open).
 */
function dayTapLabel(d: WeekDayCell, todayISO: string): string {
  const datePart = `${d.weekday} ${dayMonth(d.date)}`;
  if (d.date === todayISO) {
    return d.hours == null
      ? `${datePart} — today, not logged yet. Log today's hours.`
      : `${datePart} — today, ${d.statusWord}. Open today in the hours form.`;
  }
  switch (d.state) {
    case "fix":
      return `${datePart} — rejected. Fix and resubmit this day.`;
    case "miss":
      return d.statusWord === "draft"
        ? `${datePart} — draft. Open this day in the hours form.`
        : `${datePart} — not logged. Log hours for this day.`;
    case "off":
      return `${datePart} — day off. Log hours if you worked.`;
    default:
      return `${datePart} — ${d.statusWord}. Open this day in the hours form.`;
  }
}

/**
 * The SHORT visible label inside a day cell. The full status words ("not logged",
 * "approved", "waiting", …) overflow the ~1-of-7 mobile cell at the 12px font
 * floor, so the cell leans on the hours number + the colour tint: a logged /
 * number-bearing day shows NO word, and a missed day uses the short "miss". The
 * action states stay as short words that fit. The FULL word is unchanged in the
 * tap aria-label (`dayTapLabel`) — this only trims what's painted in the chip, so
 * screen-reader meaning and the office distinction are preserved.
 *
 * Note: "approved" and "waiting" share the green logged tint already, so dropping
 * the word means they read the same at a glance here; the exact status stays on
 * /phil/hours. (Per the chosen "drop word, lean on colour + number" direction.)
 */
function cellStatusLabel(d: WeekDayCell): string {
  switch (d.statusWord) {
    case "not logged":
      return "miss"; // "NOT LOGGED" is far too wide for the cell (~25px overflow)
    case "approved":
    case "waiting":
    case "logged":
    case "draft":
    case "today":
      return ""; // number + tint conveys it; the word would overflow / be redundant
    default:
      return d.statusWord; // "log now" | "off" | "fix" | "—" — already short enough
  }
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
 * The strip is a directory, not just a glance: today and every past day link to
 * `/phil/my-day?fixDate=<date>` — the same deep-link the "Hours rejected" push
 * uses — so a missed day is one tap from the hours form preselected to that
 * date (and a rejected day auto-opens fix-and-resubmit). Future days have
 * nothing to act on, so they stay inert.
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
        {week.days.map((d) => {
          const cell = (
            <>
              <span className={styles.dayLabel}>{d.weekday}</span>
              <div className={styles.box}>
                <span className={styles.hours}>
                  {d.hours != null ? decimalHours(d.hours) : "—"}
                </span>
                <span className={styles.status}>{cellStatusLabel(d)}</span>
              </div>
            </>
          );
          // ISO date strings compare lexicographically; future days are inert.
          const tappable = d.date <= todayISO;
          return (
            <li key={d.date} className={cn(styles.day, DAY_STATE[d.state])}>
              {tappable ? (
                <Link
                  href={`/phil/my-day?fixDate=${d.date}`}
                  prefetch={false}
                  className={styles.dayLink}
                  aria-label={dayTapLabel(d, todayISO)}
                >
                  {cell}
                </Link>
              ) : (
                cell
              )}
            </li>
          );
        })}
      </ul>

      <div className={styles.weekFoot}>
        <Link href="/phil/hours" className={styles.seeHistory}>
          See history →
        </Link>
      </div>
    </section>
  );
}
