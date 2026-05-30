"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import { timesheetsClient } from "@/domains/timesheets/client";
import {
  STANDARD_DAY_HOURS,
  buildCustomHoursPayload,
  buildStandardDayPayload,
  localDateString,
  MAX_HOURS_PER_DAY,
  MAX_BACKDATE_DAYS,
  isWithinBackdateWindow,
  canEdit,
  primaryJobId,
  pickDefaultJobId,
} from "@/domains/timesheets/service";
import {
  formatDateLabel,
  formatHoursLabel,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import type { TimeEntry } from "@/domains/timesheets/types";

const CUSTOM_HOURS_OPTIONS = [4, 5, 6, 7, 7.6, 8, 9, 10] as const;

/**
 * One of the worker's assigned jobs, as surfaced in the job picker. Built by
 * the host server component from /api/jobs (already filtered to the worker's
 * assignedJobIds by the legacy server).
 */
export interface JobOption {
  id: string;
  name: string;
}

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
   * the source of truth — this is just UI hinting) and to pre-fill the
   * sheet when the worker reopens an editable (draft / rejected) day.
   */
  recentEntries: ReadonlyArray<TimeEntry>;
  /**
   * The worker's assigned jobs. When there's exactly one, the sheet
   * auto-selects it; when there are several it defaults to the most recently
   * logged-against job and lets the worker switch. Empty array → hours are
   * logged with no job (`jobId: null`), matching the legacy "general" entry.
   */
  jobs: ReadonlyArray<JobOption>;
  /**
   * Optional date to open on instead of today — used by the "Fix & resubmit"
   * deep link (`/phil/my-day?fix=YYYY-MM-DD`) so a rejected day opens straight
   * into edit mode.
   */
  initialDate?: string;
}

type Mode = "standard" | "custom";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; entry: TimeEntry; mode: Mode; edited: boolean }
  | { kind: "error"; message: string; status: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The capture surface a tradie sees on /phil/my-day. Field-first per
 * docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today:
 *
 *   - One huge button: Standard day · 7h 36m
 *   - Job auto-selected (single assigned job) or picked from chips
 *   - Date defaults to today; can be backed off by up to 14 days
 *   - Custom hours fallback opens a sheet with chips for common values
 *   - Notes optional, single-line
 *   - Status line shows what the server last accepted
 *   - Reopening a draft / rejected day edits in place (PATCH) and resubmits
 */
export function LogHoursSheet({
  initialTodayEntry,
  recentEntries,
  jobs,
  initialDate,
}: LogHoursSheetProps) {
  const [todayEntry, setTodayEntry] = useState<TimeEntry | null>(initialTodayEntry);
  // Entries the worker has just created / resubmitted this session, keyed by
  // date, so the status line reflects the change without a full page refetch.
  const [localEntries, setLocalEntries] = useState<Record<string, TimeEntry>>({});
  const [date, setDate] = useState<string>(() =>
    initialDate && DATE_RE.test(initialDate) ? initialDate : localDateString()
  );
  const [notes, setNotes] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customHours, setCustomHours] = useState<number>(STANDARD_DAY_HOURS);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() =>
    pickDefaultJobId(jobs, recentEntries)
  );
  const [prefilledId, setPrefilledId] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  // When the worker changes the date, surface the existing entry for that
  // day (if any) so they see status / hours without re-fetching. A locally
  // edited entry takes precedence over the server-fetched snapshot.
  const entryForSelectedDate = useMemo<TimeEntry | null>(() => {
    if (localEntries[date]) return localEntries[date];
    if (date === todayEntry?.date) return todayEntry;
    return recentEntries.find((e) => e.date === date) ?? null;
  }, [date, localEntries, todayEntry, recentEntries]);

  const existingEditable = Boolean(
    entryForSelectedDate && canEdit(entryForSelectedDate.status)
  );

  // Reopening a draft / rejected day pre-fills hours, notes and job once per
  // entry so the worker amends what they submitted rather than starting blank.
  useEffect(() => {
    const entry = entryForSelectedDate;
    if (entry && canEdit(entry.status) && entry.id !== prefilledId) {
      setNotes(entry.notes ?? "");
      setCustomHours(
        entry.totalHours > 0 && entry.totalHours <= MAX_HOURS_PER_DAY
          ? entry.totalHours
          : STANDARD_DAY_HOURS
      );
      setSelectedJobId(primaryJobId(entry) ?? pickDefaultJobId(jobs, recentEntries));
      setPrefilledId(entry.id);
    }
  }, [entryForSelectedDate, prefilledId, jobs, recentEntries]);

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

  const selectedJob = selectedJobId
    ? jobs.find((j) => j.id === selectedJobId) ?? null
    : null;

  /**
   * Route a payload to PATCH (edit-in-place) when the selected day already has
   * an editable entry, else POST. A POST that races into a 409 ("entry already
   * exists — edit it instead") falls back to PATCH so a double-tap or a second
   * tab still resubmits cleanly instead of dead-ending on the legacy app.
   */
  async function submit(
    payload: ReturnType<typeof buildStandardDayPayload>,
    mode: Mode
  ) {
    setState({ kind: "submitting" });
    const editing = existingEditable;
    let result = editing
      ? await timesheetsClient.editOwnEntry(date, payload)
      : await timesheetsClient.submitNewEntry(payload);
    if (!editing && !result.ok && result.error.status === 409) {
      result = await timesheetsClient.editOwnEntry(date, payload);
      handleResult(result, mode, true);
      return;
    }
    handleResult(result, mode, editing);
  }

  async function submitStandardDay() {
    if (!dateInWindow) {
      setState({
        kind: "error",
        message: `Pick a date in the last ${MAX_BACKDATE_DAYS} days (or today / tomorrow).`,
        status: 0,
      });
      return;
    }
    const payload = buildStandardDayPayload({
      date,
      jobId: selectedJobId,
      notes: notes || null,
    });
    await submit(payload, "standard");
  }

  async function submitCustom() {
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
    setCustomOpen(false);
    const payload = buildCustomHoursPayload({
      date,
      totalHours: customHours,
      jobId: selectedJobId,
      notes: notes || null,
    });
    await submit(payload, "custom");
  }

  function handleResult(
    result: Awaited<ReturnType<typeof timesheetsClient.submitNewEntry>>,
    mode: Mode,
    edited: boolean
  ) {
    if (result.ok) {
      const entry = result.data.entry;
      setLocalEntries((m) => ({ ...m, [entry.date]: entry }));
      if (entry.date === todayEntry?.date || entry.date === localDateString()) {
        setTodayEntry(entry);
      }
      setPrefilledId(entry.id);
      setState({ kind: "success", entry, mode, edited });
      if (!edited) setNotes("");
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
  const standardSubtext = submitting
    ? "Submitting…"
    : existingEditable
      ? "One tap resubmits these hours."
      : "One tap submits this day's hours.";

  return (
    <div className="space-y-4">
      <StatusLine entry={entryForSelectedDate ?? todayEntry} selectedDate={date} />

      <Card className="space-y-4 p-4">
        <div>
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">Day</p>
          <p className="mt-1 text-base text-text">{formatDateLabel(date)}</p>
        </div>

        {jobs.length > 0 ? (
          <div>
            <p className="font-display text-xs uppercase tracking-widest text-text-muted">Job</p>
            {jobs.length === 1 ? (
              <p className="mt-1 text-base text-text">{jobs[0]?.name}</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {jobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => setSelectedJobId(job.id)}
                    aria-pressed={selectedJobId === job.id}
                    disabled={submitting || lockedByStatus}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm font-medium",
                      selectedJobId === job.id
                        ? "border-brand-navy bg-brand-navy text-text-inverse"
                        : "border-border bg-surface text-text hover:border-border-strong",
                      "disabled:cursor-not-allowed disabled:opacity-60"
                    )}
                  >
                    {job.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <button
          type="button"
          onClick={submitStandardDay}
          disabled={submitting || lockedByStatus || !dateInWindow}
          aria-label="Submit Standard day, 7 hours 36 minutes"
          className={cn(
            "block w-full rounded-card bg-brand-navy px-5 py-6 text-left text-text-inverse",
            "transition-colors hover:bg-accent-ink active:bg-accent-ink",
            "disabled:cursor-not-allowed disabled:bg-border disabled:text-text-muted"
          )}
        >
          <span className="block font-display text-xs uppercase tracking-widest text-accent-yellow">
            {existingEditable ? "Resubmit standard day" : "Standard day"}
          </span>
          <span className="mt-1 block font-display text-3xl">
            {formatHoursLabel(STANDARD_DAY_HOURS)}
          </span>
          <span className="mt-2 block text-xs text-text-inverse/80">
            {selectedJob ? `${selectedJob.name} · ` : ""}
            {standardSubtext}
          </span>
        </button>

        <Button
          variant="secondary"
          size="lg"
          onClick={() => setCustomOpen(true)}
          disabled={submitting || lockedByStatus || !dateInWindow}
          className="w-full"
        >
          Custom hours
        </Button>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={submitting}
            className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
          />
          {!dateInWindow ? (
            <span className="mt-1 block text-xs text-state-danger">
              Pick a date in the last {MAX_BACKDATE_DAYS} days (or today / tomorrow).
            </span>
          ) : null}
        </label>

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
      </Card>

      <FeedbackBanner state={state} />

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Custom hours">
        <div className="space-y-4">
          <p className="text-sm text-text-muted">Pick a quick amount or type the exact decimal.</p>
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
              {submitting
                ? "Submitting…"
                : `${existingEditable ? "Resubmit" : "Submit"} ${formatHoursLabel(customHours)}`}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StatusLine({
  entry,
  selectedDate,
}: {
  entry: TimeEntry | null;
  selectedDate: string;
}): ReactNode {
  if (!entry) {
    return (
      <Card className="flex items-center justify-between bg-surface-subtle">
        <div>
          <CardTitle>No entry yet</CardTitle>
          <CardDescription>
            Nothing submitted for {formatDateLabel(selectedDate)} — tap Standard day to log it.
          </CardDescription>
        </div>
      </Card>
    );
  }
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
        <p className="rounded-card bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <span className="font-medium">Rejected:</span> {entry.rejectedReason}
          <span className="mt-1 block text-xs text-rose-700">
            Fix the hours below and tap Resubmit standard day (or Custom hours) to send it
            back for approval.
          </span>
        </p>
      ) : null}
    </Card>
  );
}

function FeedbackBanner({ state }: { state: SubmitState }): ReactNode {
  if (state.kind === "success") {
    const submittedTime = new Date(
      state.entry.submittedAt ?? state.entry.updatedAt
    ).toLocaleTimeString("en-AU");
    return (
      <Card className="border-emerald-200 bg-emerald-50" role="status" aria-live="polite">
        <CardTitle>
          {formatHoursLabel(state.entry.totalHours)}{" "}
          {state.edited ? "resubmitted" : "sent for approval"}
        </CardTitle>
        <CardDescription>
          {state.edited ? "Resubmitted" : "Submitted"} at {submittedTime}. The office will get a
          push when they review.
        </CardDescription>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="border-rose-200 bg-rose-50" role="alert" aria-live="assertive">
        <CardTitle>Couldn&rsquo;t submit</CardTitle>
        <CardDescription className="text-rose-900">
          {state.message}
          {state.status ? <span className="ml-1 text-xs">(HTTP {state.status})</span> : null}
        </CardDescription>
      </Card>
    );
  }
  return null;
}
