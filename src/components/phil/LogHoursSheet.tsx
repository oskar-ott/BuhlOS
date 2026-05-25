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
} from "@/domains/timesheets/service";
import {
  formatDateLabel,
  formatHoursLabel,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import type { TimeEntry } from "@/domains/timesheets/types";

const CUSTOM_HOURS_OPTIONS = [4, 5, 6, 7, 7.6, 8, 9, 10] as const;

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
export function LogHoursSheet({ initialTodayEntry, recentEntries }: LogHoursSheetProps) {
  const [todayEntry, setTodayEntry] = useState<TimeEntry | null>(initialTodayEntry);
  const [date, setDate] = useState<string>(() => localDateString());
  const [notes, setNotes] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customHours, setCustomHours] = useState<number>(STANDARD_DAY_HOURS);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

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
      jobId: null,
      notes: notes || null,
    });
    const result = await timesheetsClient.submitNewEntry(payload);
    handleResult(result, "standard");
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
    setState({ kind: "submitting" });
    setCustomOpen(false);
    const payload = buildCustomHoursPayload({
      date,
      totalHours: customHours,
      jobId: null,
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
      return;
    }
    if (result.error.status === 409) {
      setState({
        kind: "error",
        message: "You already have an entry for that date. Open the legacy app to edit it for now.",
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

  return (
    <div className="space-y-4">
      <StatusLine entry={entryForSelectedDate ?? todayEntry} selectedDate={date} />

      <Card className="space-y-4 p-4">
        <div>
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">Day</p>
          <p className="mt-1 text-base text-text">{formatDateLabel(date)}</p>
        </div>

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
            Standard day
          </span>
          <span className="mt-1 block font-display text-3xl">
            {formatHoursLabel(STANDARD_DAY_HOURS)}
          </span>
          <span className="mt-2 block text-xs text-text-inverse/80">
            {submitting ? "Submitting…" : "One tap submits today's hours."}
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
              {submitting ? "Submitting…" : `Submit ${formatHoursLabel(customHours)}`}
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
            Open the legacy My day to edit and resubmit — the in-Phil edit
            flow is still being built.
          </span>
        </p>
      ) : null}
    </Card>
  );
}

function FeedbackBanner({ state }: { state: SubmitState }): ReactNode {
  if (state.kind === "success") {
    return (
      <Card className="border-emerald-200 bg-emerald-50" role="status" aria-live="polite">
        <CardTitle>{formatHoursLabel(state.entry.totalHours)} sent for approval</CardTitle>
        <CardDescription>
          Submitted at{" "}
          {new Date(state.entry.submittedAt ?? state.entry.updatedAt).toLocaleTimeString("en-AU")}.
          The office will get a push when they review.
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
