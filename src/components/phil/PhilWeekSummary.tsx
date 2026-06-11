import Link from "next/link";
import type { Route } from "next";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import type { TimeEntry } from "@/domains/timesheets/types";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { buildPhilWeek, type WeekDayCell } from "./philWeek";

/**
 * "This week" for the worker — the fuller weekly view on /phil/hours that the
 * My Day strip links to. Answers, in worker words, within a glance:
 *   what's approved · what's waiting · what needs fixing · what to log.
 *
 * Honest by construction (same rules as the strip / philWeek.ts):
 *   - every row is a real entry or a real calendar day;
 *   - a past weekday with no entry is "Not logged" (a nudge, with a one-tap
 *     Log action) — today is prompted separately and future days are never
 *     flagged;
 *   - weekends only appear when actually worked;
 *   - a draft (logged, never submitted) is shown truthfully WITHOUT an
 *     action — modern Phil has no draft-edit flow yet, so we don't render a
 *     button that dead-ends (drafts are edited on the legacy My day).
 *
 * No admin or payroll language — that lives in BuhlOS (/hours/weekly).
 */

type Verdict = "needs-action" | "waiting" | "all-approved" | "nothing-yet";

function weekVerdict(counts: {
  approvedHours: number;
  waiting: number;
  fix: number;
  draft: number;
  missed: number;
}): Verdict {
  if (counts.fix > 0 || counts.missed > 0 || counts.draft > 0) return "needs-action";
  if (counts.waiting > 0) return "waiting";
  if (counts.approvedHours > 0) return "all-approved";
  return "nothing-yet";
}

const VERDICT_LABEL: Record<Verdict, string> = {
  "needs-action": "Needs action",
  waiting: "Waiting for approval",
  "all-approved": "All approved",
  "nothing-yet": "Nothing logged yet",
};

const VERDICT_TONE: Record<Verdict, StatusTone> = {
  "needs-action": "danger",
  waiting: "info",
  "all-approved": "success",
  "nothing-yet": "neutral",
};

/** "20" — day-of-month for a YYYY-MM-DD, matching the strip's UTC parsing. */
function dayNum(dateISO: string): string {
  return new Date(dateISO + "T00:00:00Z").toLocaleDateString("en-AU", {
    day: "numeric",
    timeZone: "UTC",
  });
}

interface DayRowView {
  label: string;
  hours: string | null;
  status: string;
  muted: boolean;
  danger: boolean;
  action: { label: string; href: string } | null;
}

function rowFor(day: WeekDayCell, todayISO: string): DayRowView | null {
  const label = `${day.weekday} ${dayNum(day.date)}`;
  const hours = day.hours != null ? formatHoursLabel(day.hours) : null;
  const logHref = `/phil/my-day?fixDate=${encodeURIComponent(day.date)}`;

  switch (day.state) {
    case "fix":
      return {
        label,
        hours,
        status: "Rejected — fix needed",
        muted: false,
        danger: true,
        action: { label: "Fix", href: logHref },
      };
    case "today":
      if (day.hours == null) {
        return {
          label,
          hours: null,
          status: "Not logged yet",
          muted: false,
          danger: false,
          action: { label: "Log today", href: logHref },
        };
      }
      return {
        label,
        hours,
        status: statusText(day.statusWord),
        muted: false,
        danger: false,
        action: null,
      };
    case "logged":
      return { label, hours, status: statusText(day.statusWord), muted: false, danger: false, action: null };
    case "miss":
      // Draft entries borrow the amber "miss" styling on the strip but carry
      // hours — show them truthfully, with no dead-end action.
      if (day.hours != null) {
        return {
          label,
          hours,
          status: "Draft — not submitted",
          muted: false,
          danger: false,
          action: null,
        };
      }
      return {
        label,
        hours: null,
        status: "Not logged",
        muted: false,
        danger: false,
        action: { label: "Log", href: logHref },
      };
    case "upcoming":
      return { label, hours: null, status: "—", muted: true, danger: false, action: null };
    case "off":
      // Weekends appear only when worked (handled by `logged`/`fix` above).
      return day.date <= todayISO && day.hours != null
        ? { label, hours, status: statusText(day.statusWord), muted: false, danger: false, action: null }
        : null;
  }
}

function statusText(statusWord: string): string {
  switch (statusWord) {
    case "approved":
      return "Approved";
    case "waiting":
      return "Waiting for approval";
    case "draft":
      return "Draft — not submitted";
    default:
      return "Logged";
  }
}

export function PhilWeekSummary({
  entries,
  todayISO,
}: {
  entries: ReadonlyArray<TimeEntry>;
  todayISO: string;
}) {
  const week = buildPhilWeek(entries, { todayISO });
  const verdict = weekVerdict(week.counts);
  const rows = week.days
    .map((d) => rowFor(d, todayISO))
    .filter((r): r is DayRowView => r !== null);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle>This week</CardTitle>
          <p className="mt-0.5 text-xs text-text-muted">
            {formatHoursLabel(week.counts.approvedHours)} approved
            {week.counts.waiting > 0
              ? ` · ${week.counts.waiting} waiting`
              : ""}
          </p>
        </div>
        <StatusChip tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</StatusChip>
      </div>

      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex min-h-[44px] items-center justify-between gap-3 py-2"
          >
            <div className={cn("min-w-0", row.muted && "opacity-50")}>
              <span className="font-medium text-text">{row.label}</span>
              <span
                className={cn(
                  "ml-2 text-sm",
                  row.danger ? "font-medium text-state-danger" : "text-text-muted"
                )}
              >
                {/* one string, not adjacent JSX text — SSR comment markers
                    would split the copy (same trick as PhilWeekStrip). */}
                {row.hours ? `${row.status} · ${row.hours}` : row.status}
              </span>
            </div>
            {row.action ? (
              <Link
                href={row.action.href as Route}
                className={cn(
                  "shrink-0 rounded-pill border px-4 py-2 text-sm font-medium",
                  row.danger
                    ? "border-state-danger text-state-danger"
                    : "border-border text-text hover:border-brand-navy"
                )}
              >
                {row.action.label}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
