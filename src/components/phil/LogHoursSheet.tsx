"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronsUpDown, Clock, MapPin, Split, Timer } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import { PhilNotice } from "./ui/PhilNotice";
import { cn } from "@/lib/cn";
import { SplitDaySheet } from "./SplitDaySheet";
import { JobDialPicker } from "./JobDialPicker";
import { DayDialPicker } from "./DayDialPicker";
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
  assignedJobs: ReadonlyArray<{ id: string; name: string }>;
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
}

type Mode = "standard" | "custom";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; entry: TimeEntry; mode: Mode }
  | { kind: "error"; message: string; status: number };

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
    [initialDate],
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
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    if (initialJobId && assignedJobs.some((j) => j.id === initialJobId)) return initialJobId;
    if (lastLoggedJobId && assignedJobs.some((j) => j.id === lastLoggedJobId)) {
      return lastLoggedJobId;
    }
    return assignedJobs.length === 1 ? assignedJobs[0]!.id : null;
  });

  const hasJobs = assignedJobs.length > 0;
  const selectedJob = assignedJobs.find((j) => j.id === selectedJobId) ?? null;
  // Safe to attribute a submission iff jobs loaded, at least one exists, and
  // one is selected. When false the submit buttons are disabled and the guard
  // below produces an honest message rather than an unattributed entry.
  const jobReady = !jobsError && hasJobs && !!selectedJob;

  /**
   * Returns an error to show instead of submitting, or null when job
   * attribution is satisfied. Mirrors the product rule: block when jobs
   * failed to load, when there is no active assigned job, or when a worker
   * with multiple jobs hasn't picked one. Never allows a silent jobId: null.
   */
  function jobAttributionError(): { message: string; status: number } | null {
    if (jobsError) {
      return { message: "Couldn't load your jobs. Pull to refresh and try again.", status: 0 };
    }
    if (!hasJobs) {
      return { message: "No active assigned job. Ask the office to assign you to a job.", status: 0 };
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
      jobId: selectedJobId,
      notes: notes || null,
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
      jobId: selectedJobId,
      notes: notes || null,
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
    if (result.error.status === 409) {
      setState({
        kind: "error",
        message: "You already have an entry for that date — its status is shown above.",
        status: 409,
      });
      return;
    }
    if (result.error.status === 401) {
      setState({
        kind: "error",
        message: "Session expired. Sign in again to log hours.",
        status: 401,
      });
      return;
    }
    setState({
      kind: "error",
      message: result.error.message || "Couldn't submit your hours. Try again in a moment.",
      status: result.error.status || 0,
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
              assignedJobs={assignedJobs}
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
            <p className={styles.dayPickWarn}>
              Pick a date in the last {MAX_BACKDATE_DAYS} days.
            </p>
          ) : null}
        </div>

        {lockedByStatus && statusEntry ? (
          // 2026-07-26 owner-directed: the log actions never render as a bare
          // disabled primary with no explanation. A submitted selected day
          // shows what's true (sent, undecided) + the change affordance; an
          // approved day names its absence (P7) — locked for pay, no button.
          <LockedDayStatus
            entry={statusEntry}
            assignedJobs={assignedJobs}
            jobsError={jobsError}
            onSaved={onSaved}
          />
        ) : (
          <>
            <JobAttribution
              jobs={assignedJobs}
              selectedJobId={selectedJobId}
              onSelect={(id) => {
                setSelectedJobId(id);
                setMoreOpen(true); // open the note disclosure once a job is chosen
              }}
              lastLoggedJobId={lastLoggedJobId}
              lastLoggedDate={lastLoggedDate}
              jobsError={jobsError}
              disabled={submitting}
            />

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
              <ChevronRight className={cn(styles.subActionChev, "h-[17px] w-[17px]")} aria-hidden="true" />
            </button>

            {assignedJobs.length > 1 ? (
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
                <ChevronRight className={cn(styles.subActionChev, "h-[17px] w-[17px]")} aria-hidden="true" />
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

      <FeedbackBanner state={state} />

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Custom or overtime hours">
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
        assignedJobs={assignedJobs}
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
 *   - exactly one job        → preselected, shown read-only (no friction)
 *   - multiple jobs          → ONE job preselected (the last-logged default, or
 *                              an explicit launch context), collapsed to a
 *                              single line; "Pick a different job" reopens a
 *                              searchable spinning dial (JobDialPicker). With no
 *                              usable default the dial stays open as a required
 *                              choice ("Pick one").
 * It never lets the worker proceed with no job when active jobs exist.
 */
function JobAttribution({
  jobs,
  selectedJobId,
  onSelect,
  lastLoggedJobId,
  lastLoggedDate,
  jobsError,
  disabled,
}: {
  jobs: ReadonlyArray<{ id: string; name: string }>;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  lastLoggedJobId: string | null;
  lastLoggedDate: string | null;
  jobsError: boolean;
  disabled: boolean;
}): ReactNode {
  // Multi-job: collapse to the chosen job once one is picked ("Pick a different
  // job" reopens the list); stay expanded while nothing is picked so the
  // required choice is never hidden. `query` filters the reopened list. Both
  // declared before the single-job / empty / error early returns to satisfy the
  // rules of hooks.
  const [pickerOpen, setPickerOpen] = useState<boolean>(!selectedJobId);
  const [query, setQuery] = useState<string>("");
  const label = (
    <p className="font-display text-xs uppercase tracking-widest text-text-muted">Job</p>
  );

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

  if (jobs.length === 1) {
    // Quiet inline context, not a boxed form field — the job already headlines
    // the greeting ("on {job}"). The "Assigned job" pill is kept verbatim (the
    // field-readiness smoke asserts it for the single-job attribution path).
    return (
      <div className={styles.jobLine}>
        <span className={styles.jobLinePin} aria-hidden="true">
          <MapPin className="h-[17px] w-[17px]" />
        </span>
        <span className={styles.jobLineText}>
          <span className={styles.jobLineName}>{jobs[0]!.name}</span>
          <span className={styles.jobLineCaption}>Assigned job</span>
        </span>
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
              {selected.id === lastLoggedJobId && lastLoggedDate
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
          <span className={styles.subActionLabel}>Select a different job</span>
          <ChevronRight
            className={cn(styles.subActionChev, "h-[17px] w-[17px]")}
            aria-hidden="true"
          />
        </button>
      </div>
    );
  }

  // Reopened (or never-picked) picker. The search field narrows the dial —
  // useful as a worker's assigned-job count grows — and taps stay the way a
  // job is actually chosen.
  const q = query.trim().toLowerCase();
  const filtered = q ? jobs.filter((j) => j.name.toLowerCase().includes(q)) : jobs;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        {label}
        {!selectedJobId ? (
          <span className="text-xs font-medium text-state-warning">Pick one</span>
        ) : (
          // Reopened via "Pick a different job" with a job already chosen — let
          // the worker collapse back without having to re-pick.
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            disabled={disabled}
            aria-expanded
            className="text-xs font-semibold text-brand-navy underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Done
          </button>
        )}
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={disabled}
        placeholder="Find a job by name or address…"
        aria-label="Search your jobs"
        className="mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      {/* The spinning dial (owner-directed 2026-08-02): a fixed 5-row wheel
          replaces the vertical radio list, so a growing job list no longer
          grows the page (P10 — the picker's slot has constant height). Same
          semantics: radiogroup, tap a job to pick it. */}
      {filtered.length > 0 ? (
        <JobDialPicker
          jobs={filtered}
          selectedJobId={selectedJobId}
          onSelect={(id) => {
            onSelect(id);
            setQuery("");
            setPickerOpen(false);
          }}
          disabled={disabled}
        />
      ) : (
        <p className="px-1 py-2 text-xs text-text-muted">
          No assigned job matches “{query.trim()}”.
        </p>
      )}
      {/* #424: this picker logs a single job. With >1 assigned job the worker
          also has the "Split across jobs" action above, so point them at it
          rather than telling them to log the bigger block (which contradicted
          the split feature). */}
      <p className="mt-2 text-xs text-text-muted">
        This logs one job. On more than one today? Use “Split across jobs” above.
      </p>
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

function FeedbackBanner({ state }: { state: SubmitState }): ReactNode {
  if (state.kind === "success") {
    return (
      <PhilNotice
        tone="success"
        role="status"
        title={`${formatHoursLabel(state.entry.totalHours)} sent for approval`}
      >
        Submitted at{" "}
        {new Date(state.entry.submittedAt ?? state.entry.updatedAt).toLocaleTimeString("en-AU")}.
        The office will get a push when they review.
      </PhilNotice>
    );
  }
  if (state.kind === "error") {
    return (
      <PhilNotice tone="danger" role="alert" title="Couldn’t submit">
        {state.message}
        {state.status ? <span className="ml-1 text-xs">(HTTP {state.status})</span> : null}
      </PhilNotice>
    );
  }
  return null;
}
