import { PhilOfflineLink } from "./PhilOfflineLink";
import type { Route } from "next";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import type { TimeEntry } from "@/domains/timesheets/types";
import { formatHoursLabel, otSplitLabel } from "@/domains/timesheets/format";
import { addDays, weekStartOf } from "@/domains/timesheets/service";
import { STATUS_WORDS } from "@/domains/timesheets/status-words";
import { draftSendBlockReason, type HoursJobRef } from "./philHoursWeeks";
import { SendDraftDayButton } from "./SendDraftDayButton";
import { buildPhilWeek, isWeekSquaredAway, type WeekDayCell } from "./philWeek";

/**
 * "This week" for the worker — the fuller weekly view on /phil/hours that the
 * My Day strip links to. Answers, in worker words, within a glance:
 *   what's approved · what's waiting · what needs fixing · what to log.
 *
 * Status copy comes from the ONE worker vocabulary (status-words.ts,
 * 2026-07-26 owner-directed).
 *
 * Honest by construction (same rules as the strip / philWeek.ts):
 *   - every row is a real entry or a real calendar day;
 *   - a past weekday with no entry is "Not logged" (a nudge, with a one-tap
 *     Log action) — today is prompted separately and future days are never
 *     flagged;
 *   - weekends only appear when actually worked;
 *   - a draft (logged, never sent) gets a real "Send" action (2026-07-26
 *     owner-directed — the draft→submitted PATCH the server already
 *     supports); when it can't be sent from here (no job attached / jobs
 *     failed to load) the reason is named instead — never a dead button.
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
  // The one submitted word (status-words.ts, 2026-07-26 owner-directed).
  waiting: STATUS_WORDS.submitted,
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

/**
 * Compact Mon–Sun label for a navigated week, e.g. "13–19 May 2024" (same
 * month) or "30 Jun – 6 Jul 2024" (spanning two months). UTC parsing matches
 * dayNum so it never drifts a day on non-UTC hosts.
 */
function weekRangeLabel(startISO: string, endISO: string): string {
  const start = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  const day = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", timeZone: "UTC" });
  const mon = (d: Date) => d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  const year = end.toLocaleDateString("en-AU", { year: "numeric", timeZone: "UTC" });
  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth();
  return sameMonth
    ? `${day(start)}–${day(end)} ${mon(end)} ${year}`
    : `${day(start)} ${mon(start)} – ${day(end)} ${mon(end)} ${year}`;
}

interface DayRowView {
  /** YYYY-MM-DD — keys the row and resolves the draft entry for Send. */
  date: string;
  label: string;
  hours: string | null;
  status: string;
  /** #130: quiet worker-words overtime line, e.g. "8h + 2h overtime", or null
   *  for a ≤8h day (zero noise — the line simply isn't there). */
  overtime: string | null;
  muted: boolean;
  danger: boolean;
  action: { label: string; href: string } | null;
  /** True for a draft (logged, never sent) day — renders the Send affordance
   *  (2026-07-26 owner-directed) instead of a link action. */
  draft?: boolean;
}

/** Worker-words OT split for a logged cell, from the STORED portions only. */
function overtimeFor(day: WeekDayCell): string | null {
  if (day.hours == null || day.overtimeHours == null || day.ordinaryHours == null) return null;
  return otSplitLabel(
    {
      ordinaryHours: day.ordinaryHours,
      overtimeHours: day.overtimeHours,
      totalHours: day.hours,
    },
    { audience: "worker" },
  );
}

function rowFor(day: WeekDayCell, todayISO: string): DayRowView | null {
  const date = day.date;
  const label = `${day.weekday} ${dayNum(day.date)}`;
  const hours = day.hours != null ? formatHoursLabel(day.hours) : null;
  const overtime = overtimeFor(day);
  const logHref = `/phil/my-day?fixDate=${encodeURIComponent(day.date)}`;

  switch (day.state) {
    case "fix":
      return {
        date,
        label,
        hours,
        overtime,
        status: STATUS_WORDS.rejected,
        muted: false,
        danger: true,
        action: { label: "Fix", href: logHref },
      };
    case "today":
      if (day.hours == null) {
        return {
          date,
          label,
          hours: null,
          overtime: null,
          status: "Not logged yet",
          muted: false,
          danger: false,
          action: { label: "Log today", href: logHref },
        };
      }
      return {
        date,
        label,
        hours,
        overtime,
        status: statusText(day.statusWord),
        muted: false,
        danger: false,
        action: null,
      };
    case "logged":
      return { date, label, hours, overtime, status: statusText(day.statusWord), muted: false, danger: false, action: null };
    case "miss":
      // Draft entries borrow the amber "miss" styling on the strip but carry
      // hours — shown truthfully, with a real Send action (2026-07-26
      // owner-directed; the component resolves sendability honestly).
      if (day.hours != null) {
        return {
          date,
          label,
          hours,
          overtime,
          status: STATUS_WORDS.draft,
          muted: false,
          danger: false,
          action: null,
          draft: true,
        };
      }
      return {
        date,
        label,
        hours: null,
        overtime: null,
        status: "Not logged",
        muted: false,
        danger: false,
        action: { label: "Log", href: logHref },
      };
    case "upcoming":
      return { date, label, hours: null, overtime: null, status: "—", muted: true, danger: false, action: null };
  }
}

/** philWeek's short cell word → the full site word (status-words.ts). */
function statusText(statusWord: string): string {
  switch (statusWord) {
    case "approved":
      return STATUS_WORDS.approved;
    case "waiting":
      return STATUS_WORDS.submitted;
    case "not sent":
      return STATUS_WORDS.draft;
    default:
      return "Logged";
  }
}

export function PhilWeekSummary({
  entries,
  todayISO,
  weekAnchorISO,
  assignedJobs = [],
  jobsError = false,
}: {
  entries: ReadonlyArray<TimeEntry>;
  todayISO: string;
  /** Any date inside the week to show; omit for the current week. */
  weekAnchorISO?: string;
  /** The worker's ACTIVE assigned jobs — gates the draft Send honestly
   *  (a null-job / stale-job draft names its reason instead of a button). */
  assignedJobs?: ReadonlyArray<HoursJobRef>;
  /** True when the assigned-jobs fetch failed — Send is blocked, not nulled. */
  jobsError?: boolean;
}) {
  const week = buildPhilWeek(entries, { todayISO, weekAnchorISO });
  const entriesByDate = new Map(entries.map((e) => [e.date, e]));
  const verdict = weekVerdict(week.counts);
  // Calm completion (#427): a single quiet "Week squared away" acknowledgement
  // when every loggable day is approved and nothing's left for the worker — and
  // only on real, loaded approved hours (P7). The "All approved" chip above
  // already carries the status; this is one warm line + a tick, no new metric.
  const squaredAway = isWeekSquaredAway(week.counts);
  const rows = week.days
    .map((d) => rowFor(d, todayISO))
    .filter((r): r is DayRowView => r !== null);

  // Week navigation — flip back through past pay weeks. The page already loads
  // every entry, so no week needs an extra fetch. You can step back without
  // limit but never forward past the current week (a worker has no future).
  const currentMonday = weekStartOf(todayISO);
  const isCurrentWeek = week.weekStart === currentMonday;
  const isPastWeek = week.weekStart < currentMonday;
  const prevHref: Route = `/phil/hours?week=${addDays(week.weekStart, -7)}` as Route;
  const nextHref: Route = `/phil/hours?week=${addDays(week.weekStart, 7)}` as Route;
  const centerLabel = isCurrentWeek
    ? "This week"
    : weekRangeLabel(week.weekStart, week.weekEnd);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <PhilOfflineLink
          href={prevHref}
          aria-label="Previous week"
          className="shrink-0 rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        </PhilOfflineLink>

        <CardTitle className="min-w-0 flex-1 truncate text-center text-base">
          {centerLabel}
        </CardTitle>

        <div className="flex shrink-0 items-center gap-1">
          {!isCurrentWeek ? (
            <PhilOfflineLink
              href={"/phil/hours" as Route}
              className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
            >
              This week
            </PhilOfflineLink>
          ) : null}
          {isPastWeek ? (
            <PhilOfflineLink
              href={nextHref}
              aria-label="Next week"
              className="shrink-0 rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
            >
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </PhilOfflineLink>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {formatHoursLabel(week.counts.approvedHours)} approved
          {week.counts.waiting > 0 ? ` · ${week.counts.waiting} waiting` : ""}
        </p>
        <StatusChip tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</StatusChip>
      </div>

      {squaredAway ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-state-success">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>Week squared away</span>
        </p>
      ) : null}

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
              {/* #130: one quiet line showing the overtime the worker worked.
                  Only present on a day that has overtime — zero noise on a
                  normal ≤8h day (cognitive budget, P10). */}
              {row.overtime ? (
                <span className="mt-0.5 block text-xs text-text-muted">{row.overtime}</span>
              ) : null}
            </div>
            {row.action ? (
              <PhilOfflineLink
                href={row.action.href as Route}
                className={cn(
                  "shrink-0 rounded-pill border px-4 py-2 text-sm font-medium",
                  row.danger
                    ? "border-state-danger text-state-danger"
                    : "border-border text-text hover:border-brand-navy"
                )}
              >
                {row.action.label}
              </PhilOfflineLink>
            ) : row.draft ? (
              // 2026-07-26 owner-directed: the draft dead-end gets a real
              // Send (draft → submitted PATCH), gated honestly — a draft
              // that can't be sent from here names its reason instead.
              <DraftSendCell
                entry={entriesByDate.get(row.date) ?? null}
                assignedJobs={assignedJobs}
                jobsError={jobsError}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The action cell for a draft row: a real Send when the draft is sendable
 * (every allocation on an active assigned job — the same
 * `draftSendBlockReason` gate the sharpened week-send uses), otherwise the
 * honest reason it can't be sent from here. Never a dead button (P7).
 */
function DraftSendCell({
  entry,
  assignedJobs,
  jobsError,
}: {
  entry: TimeEntry | null;
  assignedJobs: ReadonlyArray<HoursJobRef>;
  jobsError: boolean;
}) {
  if (!entry) return null;
  const blockReason = draftSendBlockReason(entry, assignedJobs, jobsError);
  if (blockReason) {
    return (
      <p className="max-w-[45%] shrink-0 text-right text-xs text-text-muted">
        Can&rsquo;t be sent from here — {blockReason.charAt(0).toLowerCase() + blockReason.slice(1)}
      </p>
    );
  }
  return <SendDraftDayButton entry={entry} />;
}
