"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import { PhilNotice } from "./ui/PhilNotice";
import { cn } from "@/lib/cn";
import { SplitDaySheet } from "./SplitDaySheet";
import styles from "./myDay.module.css";
import { timesheetsClient } from "@/domains/timesheets/client";
import {
  STANDARD_DAY_HOURS,
  buildCustomHoursPayload,
  buildSplitDayPayload,
  buildStandardDayPayload,
  localDateString,
  MAX_HOURS_PER_DAY,
  MAX_BACKDATE_DAYS,
  isWithinBackdateWindow,
} from "@/domains/timesheets/service";
import {
  formatDateLabel,
  formatHoursLabel,
  logActionTitle,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import { canResubmitInPhil } from "@/domains/timesheets/resubmit";
import { RejectedHoursResubmitSheet } from "./RejectedHoursResubmitSheet";
import type { TimeEntry } from "@/domains/timesheets/types";

// Quick-pick amounts in the custom sheet — half-days through overtime. The
// overtime values (11, 12) make logging a long day a single tap; anything up
// to MAX_HOURS_PER_DAY can still be typed exactly.
const CUSTOM_HOURS_OPTIONS = [4, 5, 6, 7, 7.6, 8, 9, 10, 11, 12] as const;

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
 *   - One huge button: Standard day · 7h 36m
 *   - Date defaults to today; can be backed off by up to 14 days
 *   - Custom hours fallback opens a sheet with chips for common values
 *   - Notes optional, single-line
 *   - Status line shows what the server last accepted
 */
export function LogHoursSheet({
  initialTodayEntry,
  recentEntries,
  assignedJobs,
  jobsError = false,
  initialJobId = null,
  initialDate = null,
  autoOpenFix = false,
}: LogHoursSheetProps) {
  const router = useRouter();
  const [todayEntry, setTodayEntry] = useState<TimeEntry | null>(initialTodayEntry);
  const [date, setDate] = useState<string>(() => initialDate ?? localDateString());
  const [notes, setNotes] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customHours, setCustomHours] = useState<number>(STANDARD_DAY_HOURS);
  const [splitOpen, setSplitOpen] = useState(false);
  // "More options" now holds only the optional note (the day picker moved up
  // under the calendar; custom-overtime + split sit directly under the
  // standard-day action — owner reposition). Collapsed by default to keep the
  // log area calm, auto-expands once a job is picked. Controlled + onToggle so
  // manual open/close still works.
  const [moreOpen, setMoreOpen] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  // Job attribution. Preselect when launched with a valid job context, else
  // auto-select the sole assigned job; multiple jobs require an explicit pick.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    if (initialJobId && assignedJobs.some((j) => j.id === initialJobId)) return initialJobId;
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
    const payload = buildStandardDayPayload({
      date,
      jobId: selectedJobId,
      notes: notes || null,
    });
    const result = await timesheetsClient.submitNewEntry(payload);
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
    const result = await timesheetsClient.submitNewEntry(payload);
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
    const result = await timesheetsClient.submitNewEntry(payload);
    handleResult(result, "custom");
  }

  function handleResult(
    result: Awaited<ReturnType<typeof timesheetsClient.submitNewEntry>>,
    mode: Mode
  ) {
    if (result.ok) {
      setTodayEntry(result.data.entry);
      setState({ kind: "success", entry: result.data.entry, mode });
      setNotes("");
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
  const statusEntry = entryForSelectedDate ?? todayEntry;

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
        {/* Day picker — moved directly under the week-strip calendar (owner
            reposition): the day you're logging sits WITH the calendar above it,
            not buried in More options. Always in the DOM so the ?fixDate= deep
            link still seeds it. */}
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <span className={styles.mono}>Day</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={submitting}
            className="rounded-pill border border-border bg-surface px-3 py-1.5 text-xs text-text focus:border-brand-navy focus:outline-none"
          />
          {!dateInWindow ? (
            <span className="text-state-danger">
              Pick a date in the last {MAX_BACKDATE_DAYS} days.
            </span>
          ) : null}
        </label>

        <JobAttribution
          jobs={assignedJobs}
          selectedJobId={selectedJobId}
          onSelect={(id) => {
            setSelectedJobId(id);
            setMoreOpen(true); // open the note disclosure once a job is chosen
          }}
          jobsError={jobsError}
          disabled={submitting}
        />

        {/* The design's compact yellow "Log today's hours" action (md-act.log)
            in place of a screen-filling navy block. Same submit handler, same
            disabled gating, same "Submit Standard day" aria-label the smoke
            clicks — purely visual. The title flips to "Log hours for this day"
            when the selected date isn't today (week-strip taps / ?fixDate=
            deep links preselect past days), so it never claims "today" while
            writing a backdated entry. */}
        <button
          type="button"
          onClick={submitStandardDay}
          disabled={submitting || lockedByStatus || !dateInWindow || !jobReady}
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
              Standard day · {formatHoursLabel(STANDARD_DAY_HOURS)}
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
        <Button
          variant="secondary"
          size="lg"
          onClick={() => setCustomOpen(true)}
          disabled={submitting || lockedByStatus || !dateInWindow || !jobReady}
          className="w-full"
        >
          Custom / overtime hours
        </Button>

        {assignedJobs.length > 1 ? (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => setSplitOpen(true)}
            disabled={submitting || lockedByStatus || !dateInWindow || !hasJobs}
            className="w-full"
            data-testid="split-across-jobs"
          >
            Split across jobs
          </Button>
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
      </div>

      <FeedbackBanner state={state} />

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Custom or overtime hours">
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Pick a quick amount (overtime included) or type the exact decimal.
          </p>
          <div className="grid grid-cols-4 gap-2">
            {CUSTOM_HOURS_OPTIONS.map((hours) => (
              <button
                key={hours}
                type="button"
                onClick={() => setCustomHours(hours)}
                aria-pressed={customHours === hours}
                className={cn(
                  "rounded-card border px-3 py-3 text-sm font-medium",
                  customHours === hours
                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                    : "border-border bg-surface text-text hover:border-border-strong"
                )}
              >
                {formatHoursLabel(hours)}
              </button>
            ))}
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-text">Exact hours</span>
            <input
              type="number"
              min={0}
              max={MAX_HOURS_PER_DAY}
              step="0.25"
              value={customHours}
              onChange={(e) => setCustomHours(Number(e.target.value))}
              className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCustom} disabled={submitting}>
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
      />
    </div>
  );
}

/**
 * Job attribution block. Renders one of four states:
 *   - jobs failed to load   → warning, submit blocked
 *   - zero active jobs       → honest "ask the office" message, submit blocked
 *   - exactly one job        → preselected, shown read-only (no friction)
 *   - multiple jobs          → a required radio list (mobile-friendly taps)
 * It never lets the worker proceed with no job when active jobs exist.
 */
function JobAttribution({
  jobs,
  selectedJobId,
  onSelect,
  jobsError,
  disabled,
}: {
  jobs: ReadonlyArray<{ id: string; name: string }>;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  jobsError: boolean;
  disabled: boolean;
}): ReactNode {
  // Multi-job: collapse to the chosen job once one is picked ("Change" reopens
  // the list); stay expanded while nothing is picked so the required choice is
  // never hidden. Declared at the top (before the single-job / empty / error
  // early returns) to satisfy the rules of hooks.
  const [pickerOpen, setPickerOpen] = useState<boolean>(!selectedJobId);
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
          Pull to refresh and try again — hours can&rsquo;t be logged until your jobs load.
        </p>
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
      <div className="flex items-center gap-2 px-0.5">
        <span className="min-w-0 truncate font-display text-sm font-semibold text-text">
          {jobs[0]!.name}
        </span>
        <Pill tone="neutral">Assigned job</Pill>
      </div>
    );
  }

  // Once a job is chosen, collapse to a one-line summary so the picker stops
  // taking up the screen — tap "Change" to reopen the list.
  const selected = jobs.find((j) => j.id === selectedJobId) ?? null;
  if (selected && !pickerOpen) {
    return (
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-display text-sm font-semibold text-text">
            {selected.name}
          </span>
          <Pill tone="neutral">Job</Pill>
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={disabled}
          aria-expanded={false}
          className="shrink-0 text-xs font-semibold text-brand-navy underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        {label}
        {!selectedJobId ? (
          <span className="text-xs font-medium text-state-warning">Pick one</span>
        ) : (
          // Reopened via "Change" with a job already chosen — let the worker
          // collapse back without having to re-pick.
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
      <ul className="mt-1 space-y-2" role="radiogroup" aria-label="Choose the job for these hours">
        {jobs.map((j) => {
          const active = j.id === selectedJobId;
          return (
            <li key={j.id}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => {
                  onSelect(j.id);
                  setPickerOpen(false);
                }}
                className={cn(
                  "flex min-h-[48px] w-full items-center gap-2 rounded-card border px-3 py-2 text-left text-sm font-medium",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                    : "border-border bg-surface text-text hover:border-border-strong"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{j.name}</span>
                {active ? (
                  <span aria-hidden="true" className="text-accent-yellow">
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {/* #424: the one-allocation rule lives here in the picker (only with
          >1 job), not as a permanent apology on My Day. */}
      <p className="mt-2 text-xs text-text-muted">
        One job per submission. Working two today? Log the bigger block and tell
        the office.
      </p>
    </div>
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
