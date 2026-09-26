"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hoursWriteFailureCopy } from "@/domains/timesheets/error-copy";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  ChevronsUpDown,
  Clock,
  GraduationCap,
  MapPin,
  Split,
  Sun,
  Thermometer,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import { PhilNotice } from "./ui/PhilNotice";
import { cn } from "@/lib/cn";
import { SplitDaySheet } from "./SplitDaySheet";
import { DialPicker } from "./DialPicker";
import { DayDialPicker } from "./DayDialPicker";
import { useJobHistorySearch } from "./useJobHistorySearch";
import { fieldPhaseChip } from "@/domains/jobs/lifecycle";
import styles from "./myDay.module.css";
import { timesheetsClient } from "@/domains/timesheets/client";
import { useSubmissionKey } from "@/domains/timesheets/useSubmissionKey";
import {
  STANDARD_DAY_HOURS,
  STANDARD_DAY_OT_ADD_ONS,
  buildCustomHoursPayload,
  buildSplitDayPayload,
  buildStandardDayPayload,
  localDateString,
  logDayDialOptions,
  MAX_HOURS_PER_DAY,
  MAX_BACKDATE_DAYS,
  isWeekendDate,
  isWithinBackdateWindow,
  standardDayPlusOt,
} from "@/domains/timesheets/service";
import {
  formatDateLabel,
  formatHoursLabel,
  formatShortDateLabel,
  logActionTitle,
  otChipLabel,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import { canResubmitInPhil } from "@/domains/timesheets/resubmit";
import { RejectedHoursResubmitSheet } from "./RejectedHoursResubmitSheet";
import type { TimeEntry } from "@/domains/timesheets/types";

// The custom sheet's quick picks are OT presets ONLY (owner-directed
// 2026-08-09). The old whole-hour grid (4h…12h) invited the exact error this
// flow exists to kill: a worker who did an extra hour reads "9" as their day
// and taps 9h — but standard + 1h OT is 8h 36m, and the pay is wrong. Every
// preset is now standard-day + OT with the derived total shown; anything else
// is typed exactly as hours + minutes below.

interface LogHoursSheetProps {
  /**
   * The most recent entry for the worker, fetched by the server component.
   * Drives the status line ("Submitted", "Approved", etc.) and the resubmit
   * affordance when an entry was rejected.
   */
  initialTodayEntry: TimeEntry | null;
  /**
   * Entries for the worker's last 7 days. Used to detect duplicate-date
   * submissions before they round-trip to the server (409 handling stays
   * the source of truth — this is just UI hinting).
   */
  recentEntries: ReadonlyArray<TimeEntry>;
  /**
   * The worker's ACTIVE assigned jobs (id + name), loaded server-side from
   * /api/jobs (source of truth: users.json.assignedJobIds). Drives the job
   * attribution block: hours must be tied to one of these so we never submit
   * jobId: null when the worker has active jobs.
   */
  assignedJobs: ReadonlyArray<PickableJob>;
  /**
   * True when the assigned-jobs fetch failed. Submission is blocked (rather
   * than falling back to an unattributed entry) until jobs load.
   */
  jobsError?: boolean;
  /**
   * Optional preselected job — e.g. if a future entry point launches the
   * sheet from a specific job context. Only takes effect when it is one of
   * the worker's active assigned jobs.
   */
  initialJobId?: string | null;
  /**
   * The worker's most-recently-logged job id (derived server-side from their
   * recent entries, and only set when that job is still assignable). When the
   * worker has several jobs and no explicit initialJobId, the picker defaults
   * to this — logging "the same job as last time" is then one tap, with the
   * full list one tap behind "Pick a different job".
   */
  lastLoggedJobId?: string | null;
  /**
   * The date (YYYY-MM-DD) the lastLoggedJobId was last logged — a REAL entry
   * date, used only for the "Your last job · logged …" sub-line so the default
   * explains itself. Null when unknown (then no date is shown — never faked).
   */
  lastLoggedDate?: string | null;
  /**
   * Optional preselected date (validated YYYY-MM-DD — callers go through
   * parseFixDate). Set by the ?fixDate= deep link on /phil/my-day so the
   * "Hours rejected" push notification lands the worker on the exact day
   * that needs fixing. Defaults to today.
   */
  initialDate?: string | null;
  /**
   * When true and the selected date's entry is rejected, the inline
   * fix-and-resubmit sheet renders already expanded (the ?fixDate= deep-link
   * behaviour — one tap from the notification to the fix).
   */
  autoOpenFix?: boolean;
  /**
   * Reports the server-confirmed entry after every successful save (log,
   * change, fix), so the parent can overlay it over a lagging server list —
   * the day flips instantly instead of waiting out the store's listing lag.
   */
  onSaved?: (entry: TimeEntry) => void;
  /**
   * True ONLY for apprentices (employee-record role, resolved server-side by
   * loadIsApprenticeInProcess — fail-closed). Shows the "TAFE day" option:
   * apprentices attend trade school one paid day a week (owner-directed
   * 2026-08-10) and log it here, attributed to TAFE instead of a job.
   */
  canLogTafe?: boolean;
}

type Mode = "standard" | "custom";

/** Job-less day types (owner-directed 2026-08-10) — display metadata for the
 *  attribution slot and the picker-dial rows. Names come from the ONE
 *  vocabulary (DAY_TYPE_LABELS in format.ts) via the label fields here. */
type LogDayType = "tafe" | "sick" | "holiday";
const DAY_TYPE_META: Record<
  LogDayType,
  { label: string; dialLabel: string; caption: string; icon: ReactNode }
> = {
  sick: {
    label: "Sick day",
    dialLabel: "Sick day",
    caption: "Logged as leave — no job",
    icon: <Thermometer className="h-[17px] w-[17px]" />,
  },
  holiday: {
    label: "Holiday",
    dialLabel: "Holiday",
    caption: "Logged as leave — no job",
    icon: <Sun className="h-[17px] w-[17px]" />,
  },
  tafe: {
    label: "TAFE",
    dialLabel: "TAFE day",
    caption: "Paid trade-school day — no job",
    icon: <GraduationCap className="h-[17px] w-[17px]" />,
  },
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; entry: TimeEntry; mode: Mode }
  | { kind: "error"; message: string; status: number; retrySafe?: boolean };

/**
 * The capture surface a tradie sees on /phil/my-day. Field-first per
 * docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today:
 *
 *   - TWO log options, no more (owner-directed 2026-08-09): the standard-day
 *     button, or "Custom / overtime hours". Overtime lives in the custom
 *     sheet as +OT presets that FILL the exact-time inputs with the derived
 *     total (+1h OT → 8h 36m), so nobody does the arithmetic that caused the
 *     "8.36"/"9 hours" pay errors — a worker never enters a total they
 *     computed themselves
 *   - Date defaults to today; can be backed off by up to 14 days
 *   - Notes optional, single-line
 *   - Status line shows what the server last accepted
 */
export function LogHoursSheet({
  initialTodayEntry,
  recentEntries,
  assignedJobs,
  jobsError = false,
  initialJobId = null,
  lastLoggedJobId = null,
  lastLoggedDate = null,
  initialDate = null,
  autoOpenFix = false,
  onSaved,
  canLogTafe = false,
}: LogHoursSheetProps) {
  const router = useRouter();
  // One replay-safe key per logical submission: a retry after a timeout reuses
  // it (the server returns the original entry instead of a duplicate / 409),
  // changing the hours or job mints a fresh one, and a confirmed success clears
  // it. (#497 — the foundation the offline outbox #143 builds on.)
  const submissionKey = useSubmissionKey();
  const [todayEntry, setTodayEntry] = useState<TimeEntry | null>(initialTodayEntry);
  const [date, setDate] = useState<string>(() => initialDate ?? localDateString());
  // This week's days for the dial (today first) — plus the seeded day when an
  // older week's "Log" pill launched the sheet. Recomputed only on re-seed
  // (the sheet is keyed by logDate in the parent, so a new pill remounts us).
  const dayOptions = useMemo(
    () => logDayDialOptions(localDateString(), initialDate),
    [initialDate]
  );
  const [notes, setNotes] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);
  // The custom sheet's single decimal source of truth. The OT preset chips
  // and the hours/minutes inputs both write THIS value (a chip writes the
  // derived standard+OT total, e.g. 8.6 for +1h OT) — the worker always
  // submits a machine-derived number, never one they computed.
  const [customHours, setCustomHours] = useState<number>(STANDARD_DAY_HOURS);
  const [splitOpen, setSplitOpen] = useState(false);
  // "More options" now holds only the optional note (the day picker moved up
  // under the calendar; custom-overtime + split sit directly under the
  // standard-day action — owner reposition). Collapsed by default to keep the
  // log area calm, auto-expands once a job is picked. Controlled + onToggle so
  // manual open/close still works.
  const [moreOpen, setMoreOpen] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  // Job attribution. Preselect, in order of authority: an explicit launch
  // context (initialJobId) → the worker's last-logged job (the usual "same job
  // as yesterday" default) → the sole assigned job. Only a worker with several
  // jobs AND no usable default is left to pick explicitly. Every candidate is
  // validated against the active assigned jobs so a stale id never sticks.
  // Closed jobs the worker found through the picker's history search (a
  // callback weeks after the job finished — docs/job-lifecycle.md). They join
  // the pickable set for this sheet only; the server still gates the write.
  const [historyJobs, setHistoryJobs] = useState<ReadonlyArray<PickableJob>>([]);
  const pickableJobs = useMemo<ReadonlyArray<PickableJob>>(() => {
    const have = new Set(assignedJobs.map((j) => j.id));
    return [...assignedJobs, ...historyJobs.filter((j) => !have.has(j.id))];
  }, [assignedJobs, historyJobs]);
  const discoverJobs = useCallback((found: ReadonlyArray<PickableJob>) => {
    setHistoryJobs((prev) => {
      const have = new Set(prev.map((j) => j.id));
      const add = found.filter((j) => !have.has(j.id));
      return add.length > 0 ? [...prev, ...add] : prev;
    });
  }, []);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    if (initialJobId && assignedJobs.some((j) => j.id === initialJobId)) return initialJobId;
    if (lastLoggedJobId && assignedJobs.some((j) => j.id === lastLoggedJobId)) {
      return lastLoggedJobId;
    }
    return assignedJobs.length === 1 ? assignedJobs[0]!.id : null;
  });

  const hasJobs = assignedJobs.length > 0;
  const selectedJob = pickableJobs.find((j) => j.id === selectedJobId) ?? null;
  // A job-less day type (owner-directed 2026-08-10): sick / holiday for
  // everyone, TAFE for apprentices (canLogTafe). While selected, the day
  // belongs to NO job: attribution names the type, the job guard stands
  // down, and the payloads carry dayType + jobId: null.
  const [dayTypeSel, setDayTypeSel] = useState<"tafe" | "sick" | "holiday" | null>(null);
  const dayTypeActive = dayTypeSel === "tafe" ? (canLogTafe ? dayTypeSel : null) : dayTypeSel;
  // The types this worker may pick — sick/holiday always, TAFE apprentices
  // only. Order = dial order: leave days first (the common case), TAFE last.
  const dayTypeOptions: Array<"sick" | "holiday" | "tafe"> = canLogTafe
    ? ["sick", "holiday", "tafe"]
    : ["sick", "holiday"];
  // Safe to attribute a submission iff jobs loaded, at least one exists, and
  // one is selected — OR the day is a day-type day (deliberately job-less).
  // When false the submit buttons are disabled and the guard below produces
  // an honest message rather than an unattributed entry.
  const jobReady = !!dayTypeActive || (!jobsError && hasJobs && !!selectedJob);

  /**
   * Returns an error to show instead of submitting, or null when job
   * attribution is satisfied. Mirrors the product rule: block when jobs
   * failed to load, when there is no active assigned job, or when a worker
   * with multiple jobs hasn't picked one. Never allows a silent jobId: null.
   */
  function jobAttributionError(): { message: string; status: number } | null {
    // A day-type day is deliberately job-less — the guard stands down entirely.
    if (dayTypeActive) return null;
    if (jobsError) {
      return { message: "Couldn't load your jobs. Pull to refresh and try again.", status: 0 };
    }
    if (!hasJobs) {
      return {
        message: "No active assigned job. Ask the office to assign you to a job.",
        status: 0,
      };
    }
    if (!selectedJob) {
      return { message: "Pick which job these hours are for.", status: 0 };
    }
    return null;
  }

  // When the worker changes the date, surface the existing entry for that
  // day (if any) so they see status / hours without re-fetching.
  const entryForSelectedDate = useMemo<TimeEntry | null>(() => {
    if (date === todayEntry?.date) return todayEntry;
    const match = recentEntries.find((e) => e.date === date);
    return match ?? null;
  }, [date, todayEntry, recentEntries]);

  // Reset the success banner once the worker starts a new submission.
  useEffect(() => {
    if (state.kind === "success") {
      const t = setTimeout(() => setState({ kind: "idle" }), 6000);
      return () => clearTimeout(t);
    }
  }, [state]);

  const dateInWindow = isWithinBackdateWindow(date);
  // A submitted/approved SELECTED day never renders the log actions at all —
  // it gets an explained status instead (2026-07-26 owner-directed: no bare
  // disabled primary with no visible reason, ever).
  const lockedByStatus = entryForSelectedDate
    ? entryForSelectedDate.status === "submitted" || entryForSelectedDate.status === "approved"
    : false;

  async function submitStandardDay() {
    const jobErr = jobAttributionError();
    if (jobErr) {
      setState({ kind: "error", ...jobErr });
      return;
    }
    if (!dateInWindow) {
      setState({
        kind: "error",
        message: `Pick a date in the last ${MAX_BACKDATE_DAYS} days (or today / tomorrow).`,
        status: 0,
      });
      return;
    }
    setState({ kind: "submitting" });
    // The EXACT payload the standard day has always sent (regression-pinned
    // in timesheets.test.ts). Overtime never rides this action — it lives in
    // the custom sheet as presets (owner-directed 2026-08-09).
    const payload = buildStandardDayPayload({
      date,
      jobId: dayTypeActive ? null : selectedJobId,
      notes: notes || null,
      dayType: dayTypeActive,
    });
    const result = await timesheetsClient.submitNewEntry(payload, {
      idempotencyKey: submissionKey.keyFor(JSON.stringify(payload)),
    });
    handleResult(result, "standard");
  }

  async function submitCustom() {
    const jobErr = jobAttributionError();
    if (jobErr) {
      setCustomOpen(false);
      setState({ kind: "error", ...jobErr });
      return;
    }
    if (!dateInWindow) {
      setState({
        kind: "error",
        message: `Pick a date in the last ${MAX_BACKDATE_DAYS} days (or today / tomorrow).`,
        status: 0,
      });
      return;
    }
    if (customHours <= 0 || customHours > MAX_HOURS_PER_DAY) {
      setState({
        kind: "error",
        message: `Custom hours must be between 0 and ${MAX_HOURS_PER_DAY}.`,
        status: 0,
      });
      return;
    }
    setState({ kind: "submitting" });
    setCustomOpen(false);
    const payload = buildCustomHoursPayload({
      date,
      totalHours: customHours,
      jobId: dayTypeActive ? null : selectedJobId,
      notes: notes || null,
      dayType: dayTypeActive,
    });
    const result = await timesheetsClient.submitNewEntry(payload, {
      idempotencyKey: submissionKey.keyFor(JSON.stringify(payload)),
    });
    handleResult(result, "custom");
  }

  async function submitSplit(
    totalHours: number,
    allocations: Array<{ jobId: string; hours: number }>
  ) {
    if (!dateInWindow) {
      setState({
        kind: "error",
        message: `Pick a date in the last ${MAX_BACKDATE_DAYS} days (or today / tomorrow).`,
        status: 0,
      });
      return;
    }
    setState({ kind: "submitting" });
    setSplitOpen(false);
    // Same gate as the single-job paths: the server validates every
    // allocation's jobId against the worker's active assigned jobs. The
    // SplitDaySheet already requires a picked job per row before it calls us.
    const payload = buildSplitDayPayload({
      date,
      totalHours,
      allocations,
      notes: notes || null,
    });
    const result = await timesheetsClient.submitNewEntry(payload, {
      idempotencyKey: submissionKey.keyFor(JSON.stringify(payload)),
    });
    handleResult(result, "custom");
  }

  function handleResult(
    result: Awaited<ReturnType<typeof timesheetsClient.submitNewEntry>>,
    mode: Mode
  ) {
    if (result.ok) {
      // Confirmed write — drop the held key so the NEXT distinct submission
      // starts a fresh one (a later identical-looking submit is genuinely new).
      submissionKey.clear();
      setTodayEntry(result.data.entry);
      onSaved?.(result.data.entry);
      setState({ kind: "success", entry: result.data.entry, mode });
      setNotes("");
      // A per-submission choice — the next day logged starts from the plain
      // standard day again, never inheriting a previous day's overtime.
      setCustomHours(STANDARD_DAY_HOURS);
      // Re-fetch the server data so the "This week" strip + hero reflect the new
      // entry immediately — the logged day turns green without a manual reload.
      // refresh() re-renders the server components but preserves this client
      // component's state (the success banner), so the confirmation stays.
      router.refresh();
      return;
    }
    // Site-language copy for the refusal (P11) and an HONEST "trying again is
    // safe" line only where a retry can succeed (P7 — 2026-09-26 audit: every
    // 400/403/409 read as "request failed … trying again is safe").
    const copy = hoursWriteFailureCopy(
      {
        status: result.error.status || 0,
        message: result.error.message,
        kind: result.error.kind,
      },
      "Couldn’t submit your hours. Try again in a moment."
    );
    setState({
      kind: "error",
      message: copy.message,
      status: result.error.status || 0,
      retrySafe: copy.retrySafe,
    });
  }

  const submitting = state.kind === "submitting";
  // Status reflects the SELECTED date ONLY (2026-07-26 owner-directed bug
  // fix): the old `?? todayEntry` fallback showed TODAY's status / fix card
  // under a past date that simply has no entry — a wrong-day lie. A day with
  // no entry shows no status.
  const statusEntry = entryForSelectedDate;
  // Custom-hours validity, surfaced inline in the sheet (not only on submit).
  const customHoursInvalid = customHours <= 0 || customHours > MAX_HOURS_PER_DAY;
  // The overtime portion the "Exact overtime worked" inputs edit — DERIVED
  // from the one decimal source of truth (customHours), never a second state
  // that could drift. 2dp keeps 7.6 + 1h 30m an exact 9.1.
  const roundHours = (n: number) => Math.round(n * 100) / 100;
  const otPortion = Math.max(0, roundHours(customHours - STANDARD_DAY_HOURS));

  return (
    <div className="space-y-3">
      <StatusLine entry={statusEntry}>
        {statusEntry?.status === "rejected" ? (
          canResubmitInPhil(statusEntry) ? (
            // Fix-and-resubmit right where the rejection is shown — the same
            // tested sheet /phil/hours uses. Keyed by entry id so switching
            // dates resets the form to that entry's values.
            <RejectedHoursResubmitSheet
              key={statusEntry.id}
              entry={statusEntry}
              assignedJobs={pickableJobs}
              jobsError={jobsError}
              defaultOpen={autoOpenFix}
              onSaved={onSaved}
            />
          ) : (
            // Single AND split days are now fixable in Phil (#128). This is the
            // residual honest limit: a rejected entry with no usable allocation
            // (legacy/degenerate) — the office must reopen it.
            <p className="text-xs text-text-muted">
              These hours can&rsquo;t be fixed here — ask the office to reopen them.
            </p>
          )
        ) : null}
      </StatusLine>

      {/* No card wrapper — the design's actions sit as standalone bars on the
          page surface, not inside a bordered form box. */}
      <div className="space-y-3">
        {/* Day picker — THIS week's days by name on the same dial the job
            picker uses (owner-directed 2026-08-09), replacing the free
            calendar input: a worker can't mis-pick a date the dial doesn't
            offer. Today sits on top; an older week's "Log" pill seeds its
            exact day as an extra dated row (logDayDialOptions). */}
        <div>
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">Day</p>
          <DayDialPicker
            options={dayOptions}
            selectedDate={date}
            onSelect={setDate}
            disabled={submitting}
          />
          {!dateInWindow ? (
            <p className={styles.dayPickWarn}>Pick a date in the last {MAX_BACKDATE_DAYS} days.</p>
          ) : null}
        </div>

        {lockedByStatus && statusEntry ? (
          // 2026-07-26 owner-directed: the log actions never render as a bare
          // disabled primary with no explanation. A submitted selected day
          // shows what's true (sent, undecided) + the change affordance; an
          // approved day names its absence (P7) — locked for pay, no button.
          <LockedDayStatus
            entry={statusEntry}
            assignedJobs={pickableJobs}
            jobsError={jobsError}
            onSaved={onSaved}
          />
        ) : (
          <>
            {dayTypeActive ? (
              // A day type selected: the attribution slot shows it (same
              // quiet jobLine treatment as a chosen job) + the way back.
              <div className="space-y-2" data-testid={`phil-daytype-selected-${dayTypeActive}`}>
                <div className={styles.jobLine}>
                  <span className={styles.jobLinePin} aria-hidden="true">
                    {DAY_TYPE_META[dayTypeActive].icon}
                  </span>
                  <span className={styles.jobLineText}>
                    <span className={styles.jobLineName}>{DAY_TYPE_META[dayTypeActive].label}</span>
                    <span className={styles.jobLineCaption}>
                      {DAY_TYPE_META[dayTypeActive].caption}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setDayTypeSel(null)}
                  disabled={submitting}
                  className={styles.subAction}
                >
                  <span className={styles.subActionIcon} aria-hidden="true">
                    <MapPin className="h-[17px] w-[17px]" />
                  </span>
                  <span className={styles.subActionLabel}>Log a job day instead</span>
                  <ChevronRight
                    className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
                    aria-hidden="true"
                  />
                </button>
              </div>
            ) : (
              <JobAttribution
                jobs={pickableJobs}
                onDiscoverJobs={discoverJobs}
                selectedJobId={selectedJobId}
                onSelect={(id) => {
                  setSelectedJobId(id);
                  setMoreOpen(true); // open the note disclosure once a job is chosen
                }}
                lastLoggedJobId={lastLoggedJobId}
                lastLoggedDate={lastLoggedDate}
                jobsError={jobsError}
                disabled={submitting}
                dayTypes={dayTypeOptions}
                onSelectDayType={setDayTypeSel}
              />
            )}

            {/* Weekend rule (owner-directed 2026-08-10): Sat/Sun hours book as
                all overtime — one muted fact line (P10: no new control, no
                alarm tone; the pay split below shows the same truth). */}
            {isWeekendDate(date) && !dayTypeActive ? (
              <p className="text-sm text-text-muted">
                {`Weekend day — all hours count as overtime.`}
              </p>
            ) : null}

            {/* The design's compact yellow "Log today's hours" action (md-act.log)
                in place of a screen-filling navy block. Same submit handler, same
                disabled gating; the aria-label is the exact "Submit Standard day"
                string the smoke clicks. The title flips to "Log hours for this
                day" when the selected date isn't today (week-strip taps /
                ?fixDate= deep links preselect past days), so it never claims
                "today" while writing a backdated entry. This action logs the
                standard day and NOTHING else — any other length of day goes
                through "Custom / overtime hours" (owner-directed 2026-08-09:
                two options, no chip row riding here). */}
            <button
              type="button"
              onClick={submitStandardDay}
              disabled={submitting || !dateInWindow || !jobReady}
              aria-label="Submit Standard day, 7 hours 36 minutes"
              className={styles.logAction}
            >
              <span className={styles.logActionIcon} aria-hidden="true">
                <Clock className="h-[18px] w-[18px]" />
              </span>
              <span className={styles.logActionText}>
                <span className={styles.logActionTitle}>
                  {submitting ? "Logging…" : logActionTitle(date, localDateString())}
                </span>
                {/* Kept short: this sub-label is UPPERCASE + wide letter-spacing, so
                    the old "<date> · standard day 7h 36m" overflowed the fixed-height
                    button. The day is already named in the title above and the exact
                    date sits in the Day picker right below, so the date is dropped. */}
                <span className={styles.logActionSub}>
                  {`Standard day · ${formatHoursLabel(STANDARD_DAY_HOURS)}`}
                </span>
              </span>
              <span className={styles.logActionArrow} aria-hidden="true">
                →
              </span>
            </button>

            {/* The two secondary log actions now sit DIRECTLY under the standard-day
                action (owner reposition): custom/overtime + split are no longer
                behind the "More options" expander. Only the optional note stays
                tucked below, so the lead is still the job + the two yellow actions. */}
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              disabled={submitting || !dateInWindow || !jobReady}
              className={styles.subAction}
            >
              <span className={styles.subActionIcon} aria-hidden="true">
                <Timer className="h-[17px] w-[17px]" />
              </span>
              <span className={styles.subActionLabel}>Custom / overtime hours</span>
              <ChevronRight
                className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
                aria-hidden="true"
              />
            </button>

            {assignedJobs.length > 1 && !dayTypeActive ? (
              <button
                type="button"
                onClick={() => setSplitOpen(true)}
                disabled={submitting || !dateInWindow || !hasJobs}
                className={styles.subAction}
                data-testid="split-across-jobs"
              >
                <span className={styles.subActionIcon} aria-hidden="true">
                  <Split className="h-[17px] w-[17px]" />
                </span>
                <span className={styles.subActionLabel}>Split across jobs</span>
                <ChevronRight
                  className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
                  aria-hidden="true"
                />
              </button>
            ) : null}

            {/* Only the optional note is tucked under "More options" now. */}
            <details
              className={styles.moreOptions}
              open={moreOpen}
              onToggle={(e) => setMoreOpen(e.currentTarget.open)}
            >
              <summary className={styles.moreOptionsSummary}>More options</summary>
              <div className="mt-3 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-text">Notes (optional)</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    disabled={submitting}
                    rows={2}
                    maxLength={500}
                    placeholder="Anything the office should know…"
                    className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                  />
                </label>
              </div>
            </details>
          </>
        )}
      </div>

      <FeedbackBanner state={state} jobs={pickableJobs} />

      <Modal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="Custom or overtime hours"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {/* One string, not adjacent JSX text (SSR comment markers split copy). */}
            {`Did overtime? Tap a preset or set the exact overtime — the day total is worked out for you. Standard day is ${formatHoursLabel(STANDARD_DAY_HOURS)}.`}
          </p>
          {/* OT presets, NOT raw totals (owner-directed 2026-08-09): a worker
              who worked an extra hour thinks "9 hours" — but the day is
              standard 7h 36m + 1h OT = 8h 36m. Each chip names the OT and
              SHOWS the derived total, and tapping it writes that total into
              the exact-time inputs below (customHours — the one source of
              truth), so what gets submitted is derived, checked by eye, and
              never worker arithmetic. Same derivation as the payload
              (standardDayPlusOt). */}
          <div
            role="group"
            aria-label="Overtime on top of the standard day"
            className="grid grid-cols-2 gap-2"
          >
            {STANDARD_DAY_OT_ADD_ONS.map((addOn) => {
              const total = standardDayPlusOt(addOn);
              const active = customHours === total;
              return (
                <button
                  key={addOn}
                  type="button"
                  onClick={() => setCustomHours(total)}
                  aria-pressed={active}
                  aria-label={`Standard day plus ${formatHoursLabel(addOn)} overtime — ${formatHoursLabel(total)} total`}
                  className={cn(
                    "min-h-[52px] rounded-card border px-2 py-2 text-left",
                    active
                      ? "border-brand-navy bg-brand-navy text-text-inverse"
                      : "border-border bg-surface text-text hover:border-border-strong"
                  )}
                >
                  {/* One string per line, not adjacent JSX text — SSR comment
                      markers would split the copy (repo-wide gotcha). */}
                  <span className="block text-sm font-semibold">{`${otChipLabel(addOn)} OT`}</span>
                  <span
                    className={cn(
                      "block text-xs [font-variant-numeric:tabular-nums]",
                      active ? "text-text-inverse" : "text-text-muted"
                    )}
                  >
                    {`= ${formatHoursLabel(total)} total`}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Exact OVERTIME, not exact total (owner-directed 2026-08-09):
              with a total-denominated field a worker logging 1h OT could type
              "1h 0m" and log a one-hour day — the same self-computed-number
              trap as everywhere else. These inputs speak the worker's frame
              ("how much overtime?"); the day total is DERIVED (standard day +
              OT, same as the presets) and echoed below, so what they read is
              what the server receives. Hours + minutes, NEVER a decimal box
              (the "8.36" incident, 2026-08-07). customHours stays the single
              decimal source of truth underneath. */}
          <fieldset className="block text-sm">
            <legend className="mb-1 block font-medium text-text">Exact overtime worked</legend>
            <div className="flex items-center gap-2">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={16}
                  step={1}
                  value={Math.floor(otPortion)}
                  onChange={(e) => {
                    const h = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    const m = Math.round((otPortion % 1) * 60);
                    setCustomHours(roundHours(STANDARD_DAY_HOURS + h + m / 60));
                  }}
                  aria-label="Overtime hours"
                  aria-invalid={customHoursInvalid}
                  aria-describedby={customHoursInvalid ? "custom-hours-error" : undefined}
                  className={cn(
                    "h-12 w-full rounded-card border bg-surface px-3 text-base focus:outline-none",
                    customHoursInvalid
                      ? "border-state-danger focus:border-state-danger"
                      : "border-border focus:border-brand-navy"
                  )}
                />
                <span className="shrink-0 text-text-muted">h</span>
              </label>
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={59}
                  step={1}
                  value={Math.round((otPortion % 1) * 60)}
                  onChange={(e) => {
                    const m = Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                    const h = Math.floor(otPortion);
                    setCustomHours(roundHours(STANDARD_DAY_HOURS + h + m / 60));
                  }}
                  aria-label="Overtime minutes"
                  aria-invalid={customHoursInvalid}
                  className={cn(
                    "h-12 w-full rounded-card border bg-surface px-3 text-base focus:outline-none",
                    customHoursInvalid
                      ? "border-state-danger focus:border-state-danger"
                      : "border-border focus:border-brand-navy"
                  )}
                />
                <span className="shrink-0 text-text-muted">m</span>
              </label>
            </div>
            {/* The derived truth, always visible — the worker checks the day
                total by eye, never computes it. One string (SSR markers). */}
            <p className="mt-1 text-sm text-text [font-variant-numeric:tabular-nums]">
              {`= ${formatHoursLabel(customHours)} total (standard day + overtime)`}
            </p>
            {customHoursInvalid ? (
              <span
                id="custom-hours-error"
                role="alert"
                className="mt-1 block text-xs font-medium text-state-danger"
              >
                The day must be between 0 and {MAX_HOURS_PER_DAY} hours in total.
              </span>
            ) : null}
          </fieldset>

          {/* The short-day escape hatch: a half day is a TOTAL, not overtime,
              so it keeps a clearly-labelled exact-time entry — tucked behind a
              disclosure so the overtime lead stays clean (P10). */}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-text-muted">
              Worked less than a standard day?
            </summary>
            <div className="mt-2 flex items-center gap-2">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_HOURS_PER_DAY}
                  step={1}
                  value={Math.floor(customHours)}
                  onChange={(e) => {
                    const h = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    const m = Math.round((customHours % 1) * 60);
                    setCustomHours(roundHours(h + m / 60));
                  }}
                  aria-label="Hours"
                  aria-invalid={customHoursInvalid}
                  className={cn(
                    "h-12 w-full rounded-card border bg-surface px-3 text-base focus:outline-none",
                    customHoursInvalid
                      ? "border-state-danger focus:border-state-danger"
                      : "border-border focus:border-brand-navy"
                  )}
                />
                <span className="shrink-0 text-text-muted">h</span>
              </label>
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={59}
                  step={1}
                  value={Math.round((customHours % 1) * 60)}
                  onChange={(e) => {
                    const m = Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                    const h = Math.floor(customHours);
                    setCustomHours(roundHours(h + m / 60));
                  }}
                  aria-label="Minutes"
                  aria-invalid={customHoursInvalid}
                  className={cn(
                    "h-12 w-full rounded-card border bg-surface px-3 text-base focus:outline-none",
                    customHoursInvalid
                      ? "border-state-danger focus:border-state-danger"
                      : "border-border focus:border-brand-navy"
                  )}
                />
                <span className="shrink-0 text-text-muted">m</span>
              </label>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              This sets the exact time worked for the whole day.
            </p>
          </details>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCustom} disabled={submitting || customHoursInvalid}>
              {submitting ? "Submitting…" : `Submit ${formatHoursLabel(customHours)}`}
            </Button>
          </div>
        </div>
      </Modal>

      <SplitDaySheet
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        // The SAME discovered set the dial uses (#1060): a closed job found
        // through the history search can be split against, not just the
        // default live list.
        assignedJobs={pickableJobs}
        submitting={submitting}
        onSubmit={submitSplit}
        // User-toggled split (not the ?fixDate= resubmit path) → opt into
        // sheet back-safety so a swipe-back closes it instead of leaving the
        // hours form (#149). pushState carries no URL, so ?fixDate= is untouched.
        backSafe
      />
    </div>
  );
}

/**
 * Job attribution block. Renders one of four states:
 *   - jobs failed to load   → warning, submit blocked
 *   - zero active jobs       → honest "ask the office" message, submit blocked
 *   - exactly one job        → preselected, shown read-only — plus the
 *                              day-type entry bar when day types exist
 *   - multiple jobs          → ONE job preselected (the last-logged default, or
 *                              an explicit launch context), collapsed to a
 *                              single line; "Pick a different job" reopens a
 *                              searchable spinning dial. With no usable
 *                              default the dial stays open ("Pick one").
 * Day types (sick / holiday, + TAFE for apprentices — owner-directed
 * 2026-08-10) ride the TOP of the same dial so they're easy to find; picking
 * one hands off to onSelectDayType and the parent swaps the attribution.
 * It never lets the worker proceed with no job when active jobs exist.
 */
/** A job the log sheet can attribute hours to. `ref` (the IV#### code) and
 *  `address` only feed the picker's search — workers find jobs by number and
 *  street as often as by name. */
export interface PickableJob {
  id: string;
  name: string;
  ref?: string | null;
  address?: string | null;
  /** Lifecycle stamp — set on jobs found through the history search so the
   *  dial row and the picked line can say "Closed 14 Aug" (a callback). */
  completedAt?: string | null;
  status?: string | null;
}

/**
 * The picker's rows for a search (pure — exported for tests). With no query:
 * the day types ride the TOP of the drum (owner-directed 2026-08-10: easy to
 * find) above every job. With a query: ONLY what matches, jobs FIRST — a job
 * search used to leave the pinned "Sick day" row in the band, and a tap there
 * logged sick leave instead of the job (2026-09-23 audit). A day type still
 * shows when the worker searches for it ("sick", "holiday", "tafe").
 */
export function jobDialRows(
  jobs: ReadonlyArray<PickableJob>,
  dayTypes: ReadonlyArray<{ id: string; label: string }>,
  query: string
): { rows: Array<{ id: string; label: string }>; jobMatches: number } {
  const q = query.trim().toLowerCase();
  const jobRows = (q ? jobs.filter((j) => jobMatchesQuery(j, q)) : jobs).map((j) => {
    // A finished/closed job reads as such on the drum — the row itself
    // says this is a callback, so it can't be mistaken for a live namesake.
    const chip = fieldPhaseChip(j);
    return { id: j.id, label: chip ? `${j.name} · ${chip}` : j.name };
  });
  if (!q) return { rows: [...dayTypes, ...jobRows], jobMatches: jobRows.length };
  const dayRows = dayTypes.filter((t) => t.label.toLowerCase().includes(q));
  return { rows: [...jobRows, ...dayRows], jobMatches: jobRows.length };
}

function jobMatchesQuery(job: PickableJob, q: string): boolean {
  return [job.name, job.ref, job.address].some(
    (field) => typeof field === "string" && field.toLowerCase().includes(q)
  );
}

function JobAttribution({
  jobs,
  onDiscoverJobs,
  selectedJobId,
  onSelect,
  lastLoggedJobId,
  lastLoggedDate,
  jobsError,
  disabled,
  dayTypes,
  onSelectDayType,
}: {
  jobs: ReadonlyArray<PickableJob>;
  /** Closed jobs the history search turned up — the parent adds them to the
   *  pickable set so a pick resolves to a real job (name on the receipt). */
  onDiscoverJobs: (jobs: ReadonlyArray<PickableJob>) => void;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  lastLoggedJobId: string | null;
  lastLoggedDate: string | null;
  jobsError: boolean;
  disabled: boolean;
  dayTypes: ReadonlyArray<LogDayType>;
  onSelectDayType: (t: LogDayType) => void;
}): ReactNode {
  // Multi-job: collapse to the chosen job once one is picked ("Pick a different
  // job" reopens the list); stay expanded while nothing is picked so the
  // required choice is never hidden. `query` filters the reopened list. Both
  // declared before the single-job / empty / error early returns to satisfy the
  // rules of hooks.
  const [pickerOpen, setPickerOpen] = useState<boolean>(!selectedJobId);
  const [query, setQuery] = useState<string>("");
  // History search (docs/job-lifecycle.md): a closed job isn't in `jobs`, so
  // two typed characters also ask the server. Results are labelled as closed
  // in the dial and on the picked line — a callback is never a quiet pick.
  const history = useJobHistorySearch(query, pickerOpen && jobs.length > 0);
  useEffect(() => {
    if (history.kind !== "ready" || history.jobs.length === 0) return;
    onDiscoverJobs(
      history.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        ref: j.code ?? j.ref ?? null,
        address: j.siteAddress ?? null,
        completedAt: j.completedAt ?? null,
        status: j.status ?? null,
      }))
    );
  }, [history, onDiscoverJobs]);
  const label = (
    <p className="font-display text-xs uppercase tracking-widest text-text-muted">Job</p>
  );
  // Compact "or a sick day / holiday / TAFE" tail for the picker-open bars.
  const dayTypeTail = dayTypes
    .map((t) => (t === "tafe" ? "TAFE" : t === "sick" ? "sick day" : "holiday"))
    .join(" / ");

  if (jobsError) {
    return (
      <div
        role="status"
        className="rounded-card border border-border border-l-4 border-l-state-warning bg-surface-subtle p-3"
      >
        {label}
        <p className="mt-1 text-sm font-medium text-text">Couldn&rsquo;t load your jobs</p>
        <p className="mt-0.5 text-xs text-text-muted">
          Hours can&rsquo;t be logged until your jobs load.
        </p>
        <div className="mt-2">
          <RefreshButton label="Try again" />
        </div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div
        role="status"
        className="rounded-card border border-border border-l-4 border-l-state-warning bg-surface-subtle p-3"
      >
        {label}
        <p className="mt-1 text-sm font-medium text-text">No active assigned job</p>
        <p className="mt-0.5 text-xs text-text-muted">
          Ask the office to assign you to a job before logging hours.
        </p>
      </div>
    );
  }

  if (jobs.length === 1 && !pickerOpen) {
    // Quiet inline context, not a boxed form field — the job already headlines
    // the greeting ("on {job}"). The "Assigned job" pill is kept verbatim (the
    // field-readiness smoke asserts it for the single-job attribution path).
    // Day types still need a way in (a one-job worker gets sick too): one bar
    // opens the dial, which then shows the day types above their job.
    return (
      <div className="space-y-2">
        <div className={styles.jobLine}>
          <span className={styles.jobLinePin} aria-hidden="true">
            <MapPin className="h-[17px] w-[17px]" />
          </span>
          <span className={styles.jobLineText}>
            <span className={styles.jobLineName}>{jobs[0]!.name}</span>
            <span className={styles.jobLineCaption}>Assigned job</span>
          </span>
        </div>
        {dayTypes.length > 0 ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={disabled}
            aria-expanded={false}
            data-testid="phil-daytype-open"
            className={styles.subAction}
          >
            <span className={styles.subActionIcon} aria-hidden="true">
              <ChevronsUpDown className="h-[17px] w-[17px]" />
            </span>
            <span className={styles.subActionLabel}>{`Log a ${dayTypeTail}`}</span>
            <ChevronRight
              className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
    );
  }

  // Once a job is chosen, collapse to a one-line summary so the picker stops
  // taking up the screen — tap "Pick a different job" to reopen the list. When
  // the chosen job IS the last-logged default, a quiet sub-line says so (with
  // the real entry date) so the pre-selection explains itself.
  const selected = jobs.find((j) => j.id === selectedJobId) ?? null;
  if (selected && !pickerOpen) {
    // The chosen job sits as a quiet info line, with a full-width "Select a
    // different job" banner UNDER it (not an inline link) — so the job display
    // and the change action are distinct: tapping the job does nothing, tapping
    // the banner opens the picker. Reuses the same bar style as the other
    // secondary log actions for one consistent affordance (owner request).
    return (
      <div className="space-y-2">
        <div className={styles.jobLine}>
          <span className={styles.jobLinePin} aria-hidden="true">
            <MapPin className="h-[17px] w-[17px]" />
          </span>
          <span className={styles.jobLineText}>
            <span className={styles.jobLineName}>{selected.name}</span>
            {/* The caption explains the pre-selection: when this IS the
                last-logged default, name it (with the real date); otherwise the
                plain "Job" label. */}
            <span className={styles.jobLineCaption}>
              {fieldPhaseChip(selected)
                ? `${fieldPhaseChip(selected)} — these hours are a callback`
                : selected.id === lastLoggedJobId && lastLoggedDate
                  ? `Your last job · logged ${formatShortDateLabel(lastLoggedDate)}`
                  : "Job"}
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={disabled}
          aria-expanded={false}
          className={styles.subAction}
        >
          <span className={styles.subActionIcon} aria-hidden="true">
            <ChevronsUpDown className="h-[17px] w-[17px]" />
          </span>
          <span className={styles.subActionLabel}>
            {dayTypes.length > 0
              ? `Select a different job — or a ${dayTypeTail}`
              : "Select a different job"}
          </span>
          <ChevronRight
            className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
            aria-hidden="true"
          />
        </button>
      </div>
    );
  }

  // Reopened (or never-picked) picker. The search field narrows the dial to
  // what matches — jobs first (jobDialRows); unsearched, the day-type rows sit
  // on top (owner-directed 2026-08-10: easy to find) but the drum OPENS on the
  // first job, so the band never starts on "Sick day". Taps stay the way
  // anything is chosen. A one-job worker gets no search (nothing to narrow).
  const q = query.trim().toLowerCase();
  const { rows: dialItems, jobMatches } = jobDialRows(
    jobs,
    dayTypes.map((t) => ({ id: `daytype:${t}`, label: DAY_TYPE_META[t].dialLabel })),
    q
  );
  const firstJobRow = dialItems.find((it) => !it.id.startsWith("daytype:"));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        {label}
        {!selectedJobId ? (
          <span className="text-xs font-medium text-state-warning">Pick one</span>
        ) : (
          // Reopened with a job already chosen — let the worker collapse back
          // without having to re-pick.
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            disabled={disabled}
            aria-expanded
            className="-my-2 min-h-[44px] px-3 text-sm font-semibold text-brand-navy underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Done
          </button>
        )}
      </div>
      {jobs.length > 1 ? (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
          placeholder="Find a job — name, IV number or street"
          aria-label="Search your jobs"
          className="mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
      ) : null}
      {/* The spinning dial (owner-directed 2026-08-02): a fixed-height wheel
          replaces the vertical radio list, so a growing job list no longer
          grows the page (P10 — the picker's slot has constant height). Same
          semantics: radiogroup, tap a row to pick it. Day types ride the top
          of the SAME drum. */}
      {dialItems.length > 0 ? (
        <DialPicker
          items={dialItems}
          selectedId={selectedJobId}
          onSelect={(id) => {
            if (id.startsWith("daytype:")) {
              onSelectDayType(id.slice("daytype:".length) as LogDayType);
            } else {
              onSelect(id);
            }
            setQuery("");
            setPickerOpen(false);
          }}
          disabled={disabled}
          ariaLabel={
            dayTypes.length > 0
              ? "Choose the job or day type for these hours"
              : "Choose the job for these hours"
          }
          countNoun="options"
          testId="job-dial"
          initialId={firstJobRow?.id ?? null}
        />
      ) : null}
      {q && jobMatches === 0 ? (
        <p className="px-1 py-2 text-sm text-text-muted" role="status">
          {history.kind === "searching"
            ? "Checking finished jobs…"
            : history.kind === "failed"
              ? `No job here matches “${query.trim()}” and finished jobs couldn’t be checked — try again.`
              : `No job matches “${query.trim()}”. Check the name, IV number or street — or add the job from the Jobs tab.`}
        </p>
      ) : null}
      {/* #424: this picker logs a single job. With >1 assigned job the worker
          also has the "Split across jobs" action below, so point them at it
          rather than telling them to log the bigger block (which contradicted
          the split feature). */}
      {jobs.length > 1 ? (
        <p className="mt-2 text-xs text-text-muted">
          This logs one job. On more than one today? Use “Split across jobs” below.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What renders IN PLACE OF the log actions when the selected day is already
 * submitted or approved (2026-07-26 owner-directed — kills the silent
 * disabled-primary state; P10: it fills the existing day-status slot, nothing
 * new at level one).
 *
 *   - submitted: the day is sent but undecided — a calm status line plus the
 *     "Change these hours" affordance (the same tested fix sheet, submitted
 *     variant). The worker can fix a sent day until the office decides.
 *   - approved: a named absence (P7) — locked for pay, no button, and the
 *     copy says who to ask.
 */
function LockedDayStatus({
  entry,
  assignedJobs,
  jobsError,
  onSaved,
}: {
  entry: TimeEntry;
  assignedJobs: ReadonlyArray<{ id: string; name: string }>;
  jobsError: boolean;
  onSaved?: (entry: TimeEntry) => void;
}): ReactNode {
  if (entry.status === "submitted") {
    return (
      <div className="space-y-2" data-testid="phil-day-sent-status">
        <p role="status" className="text-sm font-medium text-text">
          Sent to the office — waiting for approval
        </p>
        {canResubmitInPhil(entry) ? (
          // The same tested sheet, submitted variant — keyed by entry id so
          // switching dates resets the form to that entry's values.
          <RejectedHoursResubmitSheet
            key={entry.id}
            entry={entry}
            assignedJobs={assignedJobs}
            jobsError={jobsError}
            onSaved={onSaved}
          />
        ) : (
          // Residual honest limit: a submitted entry with no usable
          // allocation (legacy/degenerate) — the office must sort it.
          <p className="text-xs text-text-muted">
            These hours can&rsquo;t be changed here — ask the office.
          </p>
        )}
      </div>
    );
  }
  // approved — locked for pay, honestly no button (P7 named absence).
  return (
    <p role="status" className="text-sm text-text-muted" data-testid="phil-day-approved-status">
      Approved and locked for pay. If something&rsquo;s wrong, ask the office.
    </p>
  );
}

function StatusLine({
  entry,
  children,
}: {
  entry: TimeEntry | null;
  /** Extra content under the status (the inline fix-and-resubmit sheet). */
  children?: ReactNode;
}): ReactNode {
  // The empty "No entry yet" state is intentionally NOT rendered here — the
  // PhilWeekStrip above already shows today as "log now / Today not logged",
  // so a second empty card would be redundant clutter against the design. Real
  // submitted/approved/rejected states still surface below.
  if (!entry) return null;
  // Only the actionable (rejected) state earns a card on My Day — it carries the
  // rejection reason and hosts the inline fix-and-resubmit. Submitted / approved
  // / draft days are already shown by the week strip above and the post-submit
  // confirmation banner below, so the informational "X logged · <status>" card
  // was just clutter (owner request — removed).
  if (entry.status !== "rejected") return null;
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle>{formatHoursLabel(entry.totalHours)} logged</CardTitle>
          <CardDescription>{formatDateLabel(entry.date)}</CardDescription>
        </div>
        <Pill tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Pill>
      </div>
      {entry.status === "rejected" && entry.rejectedReason ? (
        <PhilNotice tone="danger" title="Rejected">
          <p>{entry.rejectedReason}</p>
        </PhilNotice>
      ) : null}
      {children}
    </Card>
  );
}

/**
 * What a saved entry was booked to, in the words the worker picked it by:
 * the day type ("Sick day"), else the job name(s). Null when the entry names
 * no job the sheet knows (never a guessed name — P7).
 */
export function savedEntryTarget(
  entry: Pick<TimeEntry, "dayType" | "allocations">,
  jobs: ReadonlyArray<PickableJob>
): string | null {
  const dayType = entry.dayType as LogDayType | null | undefined;
  if (dayType && DAY_TYPE_META[dayType]) return DAY_TYPE_META[dayType].label;
  const names = (entry.allocations ?? [])
    .map((a) => jobs.find((j) => j.id === a.jobId)?.name)
    .filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join(" + ") : null;
}

function FeedbackBanner({
  state,
  jobs,
}: {
  state: SubmitState;
  jobs: ReadonlyArray<PickableJob>;
}): ReactNode {
  if (state.kind === "success") {
    // The receipt names the DAY and the JOB the hours landed on, so a wrong
    // pick is caught here — not by the office a week later (2026-09-23 audit).
    // No promise of a push: notifications aren't configured in production.
    const target = savedEntryTarget(state.entry, jobs);
    return (
      <PhilNotice
        tone="success"
        role="status"
        title={`${formatHoursLabel(state.entry.totalHours)} sent for approval`}
      >
        {formatShortDateLabel(state.entry.date)}
        {target ? ` · ${target}` : ""}. Waiting on the office.
        {state.entry.dayType
          ? " Logged the wrong day? Ask the office to change it."
          : " Wrong day or job? Use “Change these hours” above."}
      </PhilNotice>
    );
  }
  if (state.kind === "error") {
    return (
      <PhilNotice tone="danger" role="alert" title="Couldn’t submit">
        {state.message}
        {state.retrySafe
          ? " Your choices are still here — trying again is safe, it won’t log the day twice."
          : " Your choices are still here."}
      </PhilNotice>
    );
  }
  return null;
}
