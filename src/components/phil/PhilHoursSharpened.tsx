"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilStatusBadge } from "./ui/PhilStatusBadge";
import { PhilSyncBanner } from "./ui/PhilSyncBanner";
import { PhilNotice } from "./ui/PhilNotice";
import { LogHoursSheet } from "./LogHoursSheet";
import { RejectedHoursResubmitSheet } from "./RejectedHoursResubmitSheet";
import { timesheetsClient } from "@/domains/timesheets/client";
import {
  readSavedEntries,
  recordSavedEntry,
} from "@/domains/timesheets/saved-entries-journal";
import { amendmentLine, formatHoursLabel, otSplitLabel } from "@/domains/timesheets/format";
import { STATUS_WORDS } from "@/domains/timesheets/status-words";
import { canResubmitInPhil } from "@/domains/timesheets/resubmit";
import {
  STANDARD_DAY_HOURS,
  addDays,
  isWithinBackdateWindow,
  lastLoggedJobFor,
} from "@/domains/timesheets/service";
import type { TimeEntry, TimeEntryAllocation } from "@/domains/timesheets/types";
import {
  buildDraftSendPayload,
  buildHoursWeeks,
  defaultOpenWeeks,
  hoursDayLabel,
  hoursWeekLabel,
  mergeSavedEntries,
  toggleWeek,
  NO_JOB_LABEL,
  UNKNOWN_JOB_LABEL,
  type HoursJobRef,
  type HoursWeek,
  type HoursWeekDot,
} from "./philHoursWeeks";

/**
 * Phil Hours — sharpened re-skin (phil_sharpened, dark; Wave 2c of the
 * field-surface redesign). "A receipt of the day, not a timesheet."
 *
 * Rendered ONLY when the server-resolved flag is on
 * (src/app/phil/hours/page.tsx branches; flag off = the current history
 * screen, byte-identical). Everything here is real or honestly absent (P7):
 *
 *   - Weeks are collapsible cards built from the worker's REAL entries (the
 *     page already loads the full history). This week is expanded by
 *     default; prior weeks are folded. Only weeks that truly have entries
 *     are shown (capped — the cap is disclosed).
 *   - Day rows carry the entry's real job attribution (split days list each
 *     allocation) and its real status badge. A rejected day expands with the
 *     REAL rejection reason and the EXISTING fix-and-resubmit sheet.
 *   - Logging lives HERE in sharpened mode (the tab is the worker's hours
 *     home): the existing LogHoursSheet — standard day / custom / split —
 *     is mounted in the current week's card, unchanged mechanics. Because
 *     every Phil logging path already submits at creation, a logged day
 *     truthfully reads "Waiting on the office"; there is no separate "not
 *     sent yet" state to invent. 2026-07-26 owner-directed: a submitted
 *     (undecided) day now carries the "Change these hours" affordance —
 *     the same tested fix sheet — because the worker can fix a sent day
 *     until the office decides. The old honest absence is now an honest
 *     affordance.
 *   - "Send this week to the office" appears ONLY when a week really holds
 *     DRAFT entries (legacy / office-created — Phil itself never writes
 *     drafts). It flushes them through the existing draft→submitted PATCH,
 *     one write per entry (the time-entries store, not jobs.json),
 *     non-optimistic, with honest per-entry failure via PhilSyncBanner.
 *   - No reviewer name on the sent state (no reviewer identity exists in the
 *     domain) and no "with lunch out" claim (not a domain fact) — omitted.
 */

interface Props {
  /** The worker's full entry history (GET /api/time-entries, newest first). */
  entries: ReadonlyArray<TimeEntry>;
  /** Sydney-local today, YYYY-MM-DD (the server resolves it). */
  todayISO: string;
  /** ACTIVE assigned jobs (id + name + real ref) — attribution + chips. */
  assignedJobs: ReadonlyArray<HoursJobRef>;
  /** True when the assigned-jobs fetch failed (blocks writes, shown honestly). */
  jobsError: boolean;
  /** The signed-in worker's id (session.userId) — scopes the persistent
   *  saved-entries journal so a shared phone never merges another worker's
   *  day. Null/absent → the journal is not read (in-memory overlay only). */
  viewerId?: string | null;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending"; total: number }
  | { kind: "sent"; count: number }
  | { kind: "failed"; okCount: number; failCount: number };

const DOT_CLASS: Record<HoursWeekDot, string> = {
  danger: "bg-state-danger-dot",
  warning: "bg-state-warning-dot",
  info: "bg-state-info-dot",
  success: "bg-state-success-dot",
  neutral: "bg-state-neutral-dot",
};

/** Real status → the ONE worker status vocabulary (status-words.ts —
 *  2026-07-26 owner-directed). Non-canonical badge labels carry an explicit
 *  tone, as the badge's type contract requires. */
function entryStatusBadge(status: TimeEntry["status"]) {
  switch (status) {
    case "approved":
      return <PhilStatusBadge label={STATUS_WORDS.approved} tone="success" />;
    case "submitted":
      return <PhilStatusBadge label={STATUS_WORDS.submitted} tone="info" />;
    case "rejected":
      return <PhilStatusBadge label={STATUS_WORDS.rejected} tone="danger" />;
    case "draft":
      return <PhilStatusBadge label={STATUS_WORDS.draft} tone="warning" />;
  }
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
      {children}
    </h3>
  );
}

/** The mono-ish code chip (same treatment as the sharpened Jobs rows). */
function JobRefChip({ refCode }: { refCode: string }) {
  return (
    <span className="font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
      {refCode}
    </span>
  );
}

export function PhilHoursSharpened({ entries, todayISO, assignedJobs, jobsError, viewerId }: Props) {
  const router = useRouter();

  // Optimistic overlay (2026-07-28): the store's listing can lag a fresh
  // write, so the refresh after a save can re-render WITHOUT the day the
  // worker just logged. Every confirmed save (log / change / fix / send-week)
  // reports its server-returned entry here and is merged over the server list
  // until it catches up — the day flips instantly and never vanishes.
  // 2026-08-06: each confirmed save is ALSO journalled to localStorage
  // (saved-entries-journal), because since the pages read entries in-process
  // (2026-08-03) the lag outlives this component — a reload or a hop to
  // My Day re-renders from the still-stale store. The journal re-seeds this
  // overlay after mount so the day survives navigation too.
  const [savedEntries, setSavedEntries] = useState<ReadonlyArray<TimeEntry>>([]);
  useEffect(() => {
    const journalled = readSavedEntries(viewerId);
    if (journalled.length === 0) return;
    setSavedEntries((prev) => {
      const have = new Set(prev.map((e) => e.date));
      const add = journalled.filter((e) => !have.has(e.date));
      return add.length > 0 ? [...prev, ...add] : prev;
    });
  }, [viewerId]);
  function recordSaved(entry: TimeEntry) {
    recordSavedEntry(entry);
    setSavedEntries((prev) => [...prev.filter((e) => e.date !== entry.date), entry]);
  }
  const mergedEntries = useMemo(
    () => mergeSavedEntries(entries, savedEntries),
    [entries, savedEntries],
  );

  const { weeks, hiddenWeekCount } = useMemo(
    () => buildHoursWeeks(mergedEntries, { todayISO, assignedJobs, jobsError }),
    [mergedEntries, todayISO, assignedJobs, jobsError],
  );

  // Fold state: this week open, prior weeks folded (design §2.6). Weeks that
  // appear later (a new week ticking over after a refresh) default per the
  // same rule via the ?? fallback in isOpen below.
  const [openWeeks, setOpenWeeks] = useState<Record<string, boolean>>(() =>
    defaultOpenWeeks(weeks),
  );
  const isOpen = (w: HoursWeek) => openWeeks[w.weekStart] ?? w.isCurrent;

  // "Log" on an unlogged past day seeds the ONE mounted LogHoursSheet (the
  // existing flow — never a second logging implementation) and brings it
  // into view. Keyed remount so the sheet's useState initialisers re-seed.
  const [logDate, setLogDate] = useState<string | null>(null);
  const logSheetRef = useRef<HTMLDivElement | null>(null);
  function logDay(date: string) {
    setLogDate(date);
    const current = weeks.find((w) => w.isCurrent);
    if (current && !isOpen(current)) {
      setOpenWeeks((open) => ({ ...open, [current.weekStart]: true }));
    }
    // Client-only nicety; state above is the real mechanism.
    logSheetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Draft-flush ("send week") state, per week card.
  const [sendStates, setSendStates] = useState<Record<string, SendState>>({});
  const sendStateFor = (w: HoursWeek): SendState => sendStates[w.weekStart] ?? { kind: "idle" };

  async function sendWeek(week: HoursWeek) {
    const drafts = week.sendableDrafts;
    if (drafts.length === 0) return;
    setSendStates((s) => ({
      ...s,
      [week.weekStart]: { kind: "sending", total: drafts.length },
    }));
    let ok = 0;
    let failed = 0;
    // Sequential, non-optimistic: each PATCH is confirmed (or not) before the
    // next; a failure never blocks the rest, and nothing renders as sent
    // until the server said so.
    for (const draft of drafts) {
      const result = await timesheetsClient.editOwnEntry(
        draft.date,
        buildDraftSendPayload(draft),
      );
      if (result.ok) {
        ok += 1;
        recordSaved(result.data.entry);
      } else failed += 1;
    }
    setSendStates((s) => ({
      ...s,
      [week.weekStart]:
        failed === 0 ? { kind: "sent", count: ok } : { kind: "failed", okCount: ok, failCount: failed },
    }));
    // Reload the server data either way so the rows show their true new
    // statuses (and a partial failure's remaining drafts recompute).
    router.refresh();
  }

  const lastLogged = useMemo(
    () => lastLoggedJobFor(mergedEntries, assignedJobs.map((j) => j.id)),
    [mergedEntries, assignedJobs],
  );
  const soleJobId = assignedJobs.length === 1 ? assignedJobs[0]!.id : null;
  const initialTodayEntry = mergedEntries.find((e) => e.date === todayISO) ?? null;

  return (
    <div className="space-y-4" data-testid="phil-hours-sharpened">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-text">
          Hours
        </h1>
        {weeks.length > 1 ? (
          <span className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            {weeks.length} weeks
          </span>
        ) : null}
      </header>

      {weeks.map((week) => (
        <WeekCard
          key={week.weekStart}
          week={week}
          open={isOpen(week)}
          onToggle={() =>
            setOpenWeeks((open) =>
              toggleWeek(
                { ...open, [week.weekStart]: open[week.weekStart] ?? week.isCurrent },
                week.weekStart,
              ),
            )
          }
          todayISO={todayISO}
          assignedJobs={assignedJobs}
          jobsError={jobsError}
          onLogDay={logDay}
          onSaved={recordSaved}
          sendState={sendStateFor(week)}
          onSendWeek={() => void sendWeek(week)}
          logSheet={
            week.isCurrent ? (
              <div ref={logSheetRef} className="space-y-2 border-t border-border pt-3">
                <SectionLabel>Log your day</SectionLabel>
                <LogHoursSheet
                  key={logDate ?? "today"}
                  initialTodayEntry={initialTodayEntry}
                  recentEntries={mergedEntries}
                  onSaved={recordSaved}
                  assignedJobs={assignedJobs.map((j) => ({ id: j.id, name: j.name }))}
                  jobsError={jobsError}
                  initialJobId={soleJobId}
                  lastLoggedJobId={lastLogged?.jobId ?? null}
                  lastLoggedDate={lastLogged?.date ?? null}
                  initialDate={logDate}
                />
              </div>
            ) : null
          }
        />
      ))}

      {hiddenWeekCount > 0 ? (
        <p className="px-1 text-[13px] text-text-muted">
          Showing your last {weeks.length} weeks — the office keeps the rest.
        </p>
      ) : null}

      <p className="px-1 text-[13px] text-text-muted">
        {/* one string, not adjacent JSX text — SSR comment markers would split
            the copy (same trick as PhilWeekSummary). */}
        {`Standard day is ${formatHoursLabel(STANDARD_DAY_HOURS)} — use “Custom / overtime hours” for a different day.`}
      </p>
    </div>
  );
}

/* ── One collapsible week card ─────────────────────────────────────────── */

function WeekCard({
  week,
  open,
  onToggle,
  todayISO,
  assignedJobs,
  jobsError,
  onLogDay,
  onSaved,
  sendState,
  onSendWeek,
  logSheet,
}: {
  week: HoursWeek;
  open: boolean;
  onToggle: () => void;
  todayISO: string;
  assignedJobs: ReadonlyArray<HoursJobRef>;
  jobsError: boolean;
  onLogDay: (date: string) => void;
  onSaved: (entry: TimeEntry) => void;
  sendState: SendState;
  onSendWeek: () => void;
  logSheet: React.ReactNode;
}) {
  const bodyId = `phil-hours-week-body-${week.weekStart}`;
  return (
    <section
      data-testid={`phil-hours-week-${week.weekStart}`}
      className="overflow-hidden rounded-card border border-border bg-surface-raised shadow-card"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid={`phil-hours-week-toggle-${week.weekStart}`}
        className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-subtle"
      >
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[week.dot])}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[15px] font-bold text-text">
            {hoursWeekLabel(week.weekStart, todayISO)}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-text-muted [font-variant-numeric:tabular-nums]">
            {weekRange(week)} · wk {week.weekNumber}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="font-display text-[15px] font-bold text-text [font-variant-numeric:tabular-nums]">
            {formatHoursLabel(week.totalHours)}
          </span>
          {/* The total stays the headline; when the week holds real (stored)
              overtime, ONE quiet line names it — the worker checks the OT
              they logged made it in without opening a single day (owner-
              directed 2026-08-09). */}
          {week.overtimeHours > 0 ? (
            <span
              data-testid={`phil-hours-week-ot-${week.weekStart}`}
              className="text-[12px] text-text-muted [font-variant-numeric:tabular-nums]"
            >
              {`incl. ${formatHoursLabel(week.overtimeHours)} OT`}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-5 w-5 shrink-0 text-text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div id={bodyId} className="space-y-3 border-t border-border px-4 py-3">
          {week.jobBreakdown.length > 0 ? (
            <ul className="space-y-1">
              {week.jobBreakdown.map((row) => (
                <li
                  key={row.jobId ?? "none"}
                  className="flex min-h-[24px] items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={cn(
                        "truncate text-sm font-medium",
                        row.known ? "text-text" : "text-text-muted",
                      )}
                    >
                      {row.name}
                    </span>
                    {row.ref ? <JobRefChip refCode={row.ref} /> : null}
                  </span>
                  <span className="shrink-0 text-sm text-text-muted [font-variant-numeric:tabular-nums]">
                    {formatHoursLabel(row.hours)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <DayRows
            week={week}
            todayISO={todayISO}
            assignedJobs={assignedJobs}
            jobsError={jobsError}
            onLogDay={onLogDay}
            onSaved={onSaved}
          />

          <SendWeekBlock
            week={week}
            todayISO={todayISO}
            sendState={sendState}
            onSendWeek={onSendWeek}
          />

          {logSheet}
        </div>
      ) : null}
    </section>
  );
}

function weekRange(week: HoursWeek): string {
  const s = new Date(week.weekStart + "T00:00:00Z");
  const e = new Date(week.weekEnd + "T00:00:00Z");
  const day = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", timeZone: "UTC" });
  const mon = (d: Date) => d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  return s.getUTCMonth() === e.getUTCMonth()
    ? `Mon ${day(s)} – Sun ${day(e)} ${mon(e)}`
    : `Mon ${day(s)} ${mon(s)} – Sun ${day(e)} ${mon(e)}`;
}

/* ── Day rows: real entries + honest gaps ──────────────────────────────── */

function DayRows({
  week,
  todayISO,
  assignedJobs,
  jobsError,
  onLogDay,
  onSaved,
}: {
  week: HoursWeek;
  todayISO: string;
  assignedJobs: ReadonlyArray<HoursJobRef>;
  jobsError: boolean;
  onLogDay: (date: string) => void;
  onSaved: (entry: TimeEntry) => void;
}) {
  const byDate = new Map(week.entries.map((e) => [e.date, e]));
  const rows: Array<{ date: string; entry: TimeEntry | null }> = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(week.weekStart, i);
    const entry = byDate.get(date) ?? null;
    if (entry) {
      rows.push({ date, entry });
      continue;
    }
    if (date > todayISO) continue; // future — nothing to show yet
    // An unworked weekend never reads as owed (same rule as philWeek.ts).
    if (i >= 5) continue;
    rows.push({ date, entry: null });
  }
  // Entries outside the Mon–Sun frame can't exist (weekStartOf groups them),
  // so `rows` is the complete honest picture of the week.
  if (rows.length === 0) return null;

  return (
    <ul className="divide-y divide-border border-t border-border">
      {rows.map(({ date, entry }) => (
        <li key={date} className="py-2.5">
          {entry ? (
            <EntryRow entry={entry} date={date} todayISO={todayISO} assignedJobs={assignedJobs} jobsError={jobsError} onSaved={onSaved} />
          ) : (
            <MissedRow date={date} todayISO={todayISO} onLogDay={onLogDay} />
          )}
        </li>
      ))}
    </ul>
  );
}

function allocationLabel(
  a: TimeEntryAllocation,
  assignedJobs: ReadonlyArray<HoursJobRef>,
): { name: string; ref: string | null } {
  const job = a.jobId ? assignedJobs.find((j) => j.id === a.jobId) : undefined;
  if (job) return { name: job.name, ref: job.ref ?? null };
  // Approver-enriched entries carry jobName; worker-scope ones don't — use it
  // when the server really sent it, otherwise the honest fallback.
  if (a.jobId) return { name: a.jobName ?? UNKNOWN_JOB_LABEL, ref: null };
  return { name: NO_JOB_LABEL, ref: null };
}

function EntryRow({
  entry,
  date,
  todayISO,
  assignedJobs,
  jobsError,
  onSaved,
}: {
  entry: TimeEntry;
  date: string;
  todayISO: string;
  assignedJobs: ReadonlyArray<HoursJobRef>;
  jobsError: boolean;
  onSaved: (entry: TimeEntry) => void;
}) {
  const allocations = entry.allocations ?? [];
  const split = allocations.length > 1;
  // 2026-07-26 owner-directed compaction: the "change a sent day" trigger is a
  // compact pill in the row's action slot (same slot the Log pill uses), not a
  // full-width bar under every submitted day. The sheet body only mounts below
  // the row while it's open.
  const changeable = entry.status === "submitted" && canResubmitInPhil(entry);
  const [changeOpen, setChangeOpen] = useState(false);
  // The office fixed this day's hours at approval time. ONE line, in the row
  // that already exists (P10 — no new section), saying the real before → after
  // and why. A pay change the worker can't see would be the dishonest option.
  const adjusted = amendmentLine(entry);
  // The STORED ordinary/overtime split, shown only when the day really holds
  // overtime (owner-directed 2026-08-09): "7h 36m + 1h OT" under the day, so
  // the worker sees the OT they tapped landed exactly — the same stored
  // fields pay reads, never a client-side re-derivation (otSplitLabel's
  // honesty guard drops legacy splits that don't reconcile).
  const otSplit = otSplitLabel(entry);
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">{hoursDayLabel(date, todayISO)}</p>
          <div className="mt-0.5 space-y-0.5">
            {allocations.map((a, i) => {
              const { name, ref } = allocationLabel(a, assignedJobs);
              return (
                <p key={i} className="flex items-baseline gap-2 text-[13px] text-text-muted">
                  {ref ? <JobRefChip refCode={ref} /> : null}
                  <span className="truncate">{name}</span>
                  {split ? (
                    <span className="shrink-0 [font-variant-numeric:tabular-nums]">
                      {formatHoursLabel(a.hours)}
                    </span>
                  ) : null}
                </p>
              );
            })}
            {otSplit ? (
              <p
                data-testid="phil-hours-ot-split"
                className="text-[13px] text-text-muted [font-variant-numeric:tabular-nums]"
              >
                {otSplit}
              </p>
            ) : null}
            {adjusted ? (
              <p
                data-testid="phil-hours-adjusted"
                className="text-[13px] text-text-muted"
              >
                {adjusted}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold text-text [font-variant-numeric:tabular-nums]">
            {formatHoursLabel(entry.totalHours)}
          </span>
          {entryStatusBadge(entry.status)}
          {changeable && !changeOpen ? (
            <button
              type="button"
              onClick={() => setChangeOpen(true)}
              data-testid="phil-edit-submitted"
              className="mt-0.5 rounded-pill border border-border px-4 py-2 text-sm font-medium text-text hover:border-brand-navy"
            >
              Change
            </button>
          ) : null}
        </div>
      </div>

      {entry.status === "rejected" ? (
        <div className="space-y-2">
          {entry.rejectedReason ? (
            <PhilNotice tone="danger" title="Why it bounced back">
              <p className="whitespace-pre-line">{entry.rejectedReason}</p>
            </PhilNotice>
          ) : null}
          {/* The EXISTING fix-and-resubmit flow — same component and endpoint
              as the current screen; nothing reimplemented. */}
          <RejectedHoursResubmitSheet
            entry={entry}
            assignedJobs={assignedJobs.map((j) => ({ id: j.id, name: j.name }))}
            jobsError={jobsError}
            onSaved={onSaved}
          />
        </div>
      ) : null}

      {/* 2026-07-26 owner-directed: a submitted (undecided) day is changeable
          until the office decides — the SAME tested sheet, submitted variant,
          controlled by the compact row pill above (owner: one small button,
          no full-width bar per day). */}
      {changeable && changeOpen ? (
        <RejectedHoursResubmitSheet
          entry={entry}
          assignedJobs={assignedJobs.map((j) => ({ id: j.id, name: j.name }))}
          jobsError={jobsError}
          open
          onOpenChange={setChangeOpen}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function MissedRow({
  date,
  todayISO,
  onLogDay,
}: {
  date: string;
  todayISO: string;
  onLogDay: (date: string) => void;
}) {
  const isToday = date === todayISO;
  // Backdating past the server's window can't succeed — no dead-end button.
  const canLog = isWithinBackdateWindow(date);
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text">{hoursDayLabel(date, todayISO)}</p>
        <p className="mt-0.5 text-[13px] text-text-muted">Not logged</p>
      </div>
      {/* Today carries the SAME Log pill as any other unlogged day (owner-
          directed, 2026-08-07): once the log card below is seeded to a
          DIFFERENT day, today's row was the one place with no way back —
          the worker had to re-pick today in the date input. The pill just
          re-seeds the one mounted sheet to this date, same as every row. */}
      {canLog ? (
        <button
          type="button"
          onClick={() => onLogDay(date)}
          className="shrink-0 rounded-pill border border-border px-4 py-2 text-sm font-medium text-text hover:border-brand-navy"
        >
          Log
        </button>
      ) : null}
    </div>
  );
}

/* ── "Send this week to the office" — the draft flush ──────────────────── */

function SendWeekBlock({
  week,
  todayISO,
  sendState,
  onSendWeek,
}: {
  week: HoursWeek;
  todayISO: string;
  sendState: SendState;
  onSendWeek: () => void;
}) {
  const sendable = week.sendableDrafts;
  const blocked = week.blockedDrafts;
  if (sendable.length === 0 && blocked.length === 0 && sendState.kind === "idle") return null;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      {sendState.kind === "sending" ? (
        <PhilSyncBanner
          state="sending"
          detail={`${sendState.total} ${sendState.total === 1 ? "day" : "days"} on the way up.`}
        />
      ) : null}
      {sendState.kind === "sent" ? (
        <PhilSyncBanner
          state="saved"
          detail={`${sendState.count} ${sendState.count === 1 ? "day" : "days"} sent to the office for review.`}
        />
      ) : null}
      {sendState.kind === "failed" ? (
        <PhilSyncBanner
          state="failed"
          detail={
            sendState.okCount > 0
              ? `${sendState.okCount} sent, ${sendState.failCount} didn't go — they're still saved as drafts.`
              : `Nothing's lost — ${sendState.failCount === 1 ? "the day is" : "the days are"} still saved as drafts.`
          }
          onRetry={sendable.length > 0 ? onSendWeek : undefined}
        />
      ) : null}

      {sendable.length > 0 && sendState.kind !== "sending" ? (
        <button
          type="button"
          onClick={onSendWeek}
          data-testid={`phil-hours-send-week-${week.weekStart}`}
          className="flex min-h-[52px] w-full items-center justify-center rounded-card bg-brand-navy px-4 font-display text-[15px] font-bold text-text-inverse transition active:scale-[0.99]"
        >
          Send this week to the office
        </button>
      ) : null}
      {sendable.length > 0 ? (
        <p className="text-[13px] text-text-muted">
          {sendable.length === 1
            ? "1 logged day hasn't been sent yet."
            : `${sendable.length} logged days haven't been sent yet.`}
        </p>
      ) : null}

      {blocked.map(({ entry, reason }) => (
        <p key={entry.id} className="text-[13px] text-text-muted">
          {hoursDayLabel(entry.date, todayISO)} can’t be sent from here — {reason}.
        </p>
      ))}
    </div>
  );
}
