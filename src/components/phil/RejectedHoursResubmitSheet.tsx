"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { PhilNotice } from "./ui/PhilNotice";
import { cn } from "@/lib/cn";
import { timesheetsClient } from "@/domains/timesheets/client";
import { useSubmissionKey } from "@/domains/timesheets/useSubmissionKey";
import { MAX_HOURS_PER_DAY } from "@/domains/timesheets/service";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  buildResubmitPayload,
  buildSplitResubmitPayload,
  isSplitResubmit,
  resolveResubmitJob,
  resubmitFeedback,
  resubmitInitialJobId,
  splitChangeInitialRows,
  splitResubmitInitialRows,
  type AssignableJob,
  type ResubmitJobResolution,
} from "@/domains/timesheets/resubmit";
import { SplitDaySheet } from "./SplitDaySheet";
import type { TimeEntry } from "@/domains/timesheets/types";

const HOURS_OPTIONS = [4, 5, 6, 7, 7.6, 8, 9, 10] as const;

interface RejectedHoursResubmitSheetProps {
  /** The rejected OR submitted entry to fix (canResubmitInPhil).
   *  Single-allocation entries use the inline form; split days
   *  (2+ allocations) open the split editor. */
  entry: TimeEntry;
  /** The worker's ACTIVE assigned jobs (server-loaded). Drives attribution. */
  assignedJobs: ReadonlyArray<AssignableJob>;
  /** True when the assigned-jobs fetch failed — resubmit is blocked, not nulled. */
  jobsError?: boolean;
  /** Test seam: render with the editor already expanded. Default collapsed. */
  defaultOpen?: boolean;
  /** Controlled-open mode (2026-07-26 owner-directed compaction): the parent
   *  owns the trigger — a compact pill in the day row's action slot — so this
   *  component renders NOTHING while closed instead of its own full-width
   *  button. Pass with `onOpenChange` so Cancel can hand control back. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Reports the server-confirmed entry after a successful save, so the parent
   *  can overlay it over a lagging server list (the day updates instantly). */
  onSaved?: (entry: TimeEntry) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; entry: TimeEntry }
  | { kind: "error"; message: string; status: number };

function reasonMessage(reason: Exclude<ResubmitJobResolution, { ok: true }>["reason"]): string {
  switch (reason) {
    case "jobs_error":
      return "Couldn't load your jobs. Pull to refresh and try again.";
    case "no_jobs":
      return "No active assigned job. Ask the office to assign you to a job.";
    case "no_selection":
      return "Pick which job these hours are for.";
  }
}

/**
 * In-Phil "fix a rejected entry and resubmit" form — and, 2026-07-26
 * owner-directed, the "change a sent day" form too. Lives on /phil/hours (and
 * anywhere the rejected fix mounts) under a rejected OR submitted entry. Edits
 * the hours / job / note and PATCHes the existing entry with
 * `status: "submitted"` via `timesheetsClient.editOwnEntry` — for a rejected
 * entry that is the rejected→submitted transition `main` already supports; for
 * a submitted entry the status doesn't move (a content edit of an undecided
 * day, which the server has always allowed). No admin/approval or payroll
 * controls.
 *
 * The two variants differ ONLY in words (P12 — the submitted variant names
 * its consequence: the office gets the new version). Every rejected-variant
 * label and behaviour is byte-identical to before.
 *
 * A single-allocation day can also be SPLIT across jobs from inside this flow
 * (2026-07-26 owner-directed): the "Split across jobs" affordance — shown only
 * to multi-job workers, mirroring LogHoursSheet's condition — swaps the form
 * for the same split editor the split-resubmit path uses, seeded via
 * `splitChangeInitialRows`. Submitting rides the identical split PATCH path;
 * cancelling returns to the single-job form.
 *
 * Attribution invariant (the #77/#80/#81 guarantee): a worker with active jobs
 * can never resubmit with `jobId: null`. The submit button is disabled and the
 * guard short-circuits unless `resolveResubmitJob` yields a real assigned job —
 * so there is no silent null-job fallback. Mirrors LogHoursSheet's create-path
 * guard without modifying it.
 */
export function RejectedHoursResubmitSheet({
  entry,
  assignedJobs,
  jobsError = false,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  onSaved,
}: RejectedHoursResubmitSheetProps) {
  // The submitted (undecided) variant — same editors, "change & resend" words.
  const editingSubmitted = entry.status === "submitted";
  const [openState, setOpenState] = useState(defaultOpen);
  // Controlled when the parent owns the trigger (compact day-row pill);
  // uncontrolled with the built-in trigger button otherwise.
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = (next: boolean) => {
    if (!controlled) setOpenState(next);
    onOpenChange?.(next);
  };
  const [totalHours, setTotalHours] = useState<number>(entry.totalHours);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() =>
    resubmitInitialJobId(entry, assignedJobs),
  );
  const [notes, setNotes] = useState<string>(entry.notes ?? "");
  // 2026-07-26 owner-directed: a SINGLE-allocation day can be split across
  // jobs from inside this flow. When on, the single-job form yields to the
  // split editor (seeded from the entry); Cancel there returns here.
  const [splitMode, setSplitMode] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  // Replay-safe key per fix attempt — a retry after a timeout reuses it; a
  // changed correction mints a fresh one; success clears it. (#497)
  const resubmitKey = useSubmissionKey();

  // A rejected SPLIT day (2+ allocations) is fixed through the split editor so
  // every allocation survives; a single-allocation entry uses the form below.
  const split = isSplitResubmit(entry);
  const resolution = resolveResubmitJob({ assignedJobs, selectedJobId, jobsError });
  const hoursValid = totalHours > 0 && totalHours <= MAX_HOURS_PER_DAY;
  const submitting = state.kind === "submitting";
  const canSubmit = resolution.ok && hoursValid && !submitting;

  async function submitSplit(
    nextTotal: number,
    allocations: Array<{ jobId: string; hours: number }>,
  ) {
    setState({ kind: "submitting" });
    // Preserve the entry's existing note (the split editor has no note field).
    const payload = buildSplitResubmitPayload(entry, {
      totalHours: nextTotal,
      allocations,
      notes: entry.notes ?? null,
    });
    const result = await timesheetsClient.editOwnEntry(entry.date, payload, {
      idempotencyKey: resubmitKey.keyFor(JSON.stringify(payload)),
    });
    const fb = resubmitFeedback(result);
    if (fb.kind === "success") {
      resubmitKey.clear();
      onSaved?.(fb.entry);
    }
    setState(
      fb.kind === "success"
        ? { kind: "success", entry: fb.entry }
        : { kind: "error", message: fb.message, status: fb.status },
    );
  }

  // Enter/leave the split editor for a single-allocation day. A stale error
  // from the other view is cleared so it can't mislead after the switch.
  function openSplit() {
    if (state.kind === "error") setState({ kind: "idle" });
    setSplitMode(true);
  }
  function closeSplit() {
    if (state.kind === "error") setState({ kind: "idle" });
    setSplitMode(false);
  }

  async function submit() {
    if (!resolution.ok) {
      setState({ kind: "error", status: 0, message: reasonMessage(resolution.reason) });
      return;
    }
    if (!hoursValid) {
      setState({
        kind: "error",
        status: 0,
        message: `Hours must be between 0 and ${MAX_HOURS_PER_DAY}.`,
      });
      return;
    }
    setState({ kind: "submitting" });
    const payload = buildResubmitPayload(entry, {
      totalHours,
      jobId: resolution.jobId,
      notes: notes.trim() || null,
    });
    const result = await timesheetsClient.editOwnEntry(entry.date, payload, {
      idempotencyKey: resubmitKey.keyFor(JSON.stringify(payload)),
    });
    const fb = resubmitFeedback(result);
    if (fb.kind === "success") {
      resubmitKey.clear();
      onSaved?.(fb.entry);
    }
    setState(
      fb.kind === "success"
        ? { kind: "success", entry: fb.entry }
        : { kind: "error", message: fb.message, status: fb.status },
    );
  }

  // After a successful resubmit the form is done — the entry is back in the
  // approval queue. The list around us is server-rendered, so offer a refresh.
  if (state.kind === "success") {
    if (editingSubmitted) {
      return (
        <div data-testid="phil-edit-submitted-success">
          <PhilNotice tone="success" role="status" title="Fix sent">
            <p>
              {formatHoursLabel(state.entry.totalHours)} sent to the office — the old version is
              replaced.
            </p>
            <div className="mt-3">
              <RefreshButton label="Refresh status" />
            </div>
          </PhilNotice>
        </div>
      );
    }
    return (
      <PhilNotice tone="success" role="status" title="Resubmitted">
        <p>
          {formatHoursLabel(state.entry.totalHours)} sent back to the office for approval.
        </p>
        <div className="mt-3">
          <RefreshButton label="Refresh status" />
        </div>
      </PhilNotice>
    );
  }

  if (!open) {
    // Controlled mode: the parent renders the trigger (a compact pill in the
    // day row's action slot) — nothing to show while closed.
    if (controlled) return null;
    if (editingSubmitted) {
      // Quiet secondary affordance — never the yellow primary (P10: this sits
      // inside the day's existing status slot, not a new level-one action).
      return (
        <Button
          variant="secondary"
          size="lg"
          onClick={() => setOpen(true)}
          data-testid="phil-edit-submitted"
        >
          Change these hours
        </Button>
      );
    }
    return (
      <Button variant="secondary" size="lg" onClick={() => setOpen(true)}>
        Fix rejected hours
      </Button>
    );
  }

  const headerLabel = editingSubmitted ? "Change & resend" : "Fix & resubmit";

  // Split day → the split editor, pre-filled from the rejected allocations, so
  // the correction keeps every job (never collapses to one). Jobs must be loaded
  // first (same honest block as the single path; no null-job fallback).
  if (split) {
    if (jobsError || assignedJobs.length === 0) {
      return (
        <div className="space-y-3 rounded-card border border-border bg-surface-subtle p-3">
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">
            {headerLabel}
          </p>
          <PhilNotice
            tone="warning"
            role="status"
            title={jobsError ? "Couldn’t load your jobs" : "No active assigned job"}
          >
            {jobsError
              ? "Pull to refresh — a split day can’t be resubmitted until your jobs load."
              : "Ask the office to assign you to a job before resubmitting."}
          </PhilNotice>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    const init = splitResubmitInitialRows(entry, assignedJobs);
    return (
      <SplitDaySheet
        open
        onClose={() => setOpen(false)}
        assignedJobs={assignedJobs}
        submitting={submitting}
        title={editingSubmitted ? "Change & resend the split day" : "Fix & resubmit the split day"}
        initialTotal={init.total}
        initialRows={init.rows}
        errorMessage={state.kind === "error" ? state.message : null}
        onSubmit={submitSplit}
      />
    );
  }

  // 2026-07-26 owner-directed: the worker chose "Split across jobs" on a
  // single-allocation day — same split editor, seeded with the day's current
  // job carrying the day's hours plus an empty remainder row. Submit PATCHes
  // through the exact split path above (same payload builder, same status
  // semantics per variant); Cancel returns to the single-job form.
  if (splitMode) {
    const init = splitChangeInitialRows(entry, assignedJobs);
    return (
      <SplitDaySheet
        open
        onClose={closeSplit}
        assignedJobs={assignedJobs}
        submitting={submitting}
        title={editingSubmitted ? "Change & resend the split day" : "Fix & resubmit the split day"}
        initialTotal={init.total}
        initialRows={init.rows}
        errorMessage={state.kind === "error" ? state.message : null}
        onSubmit={submitSplit}
      />
    );
  }

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-subtle p-3">
      <p className="font-display text-xs uppercase tracking-widest text-text-muted">
        {headerLabel}
      </p>

      {entry.rejectedReason ? (
        <p className="text-sm text-text-muted">
          <span className="font-semibold text-state-danger">Reason:</span>{" "}
          <span className="whitespace-pre-line">{entry.rejectedReason}</span>
        </p>
      ) : null}

      <ResubmitJobPicker
        jobs={assignedJobs}
        selectedJobId={selectedJobId}
        onSelect={setSelectedJobId}
        jobsError={jobsError}
        disabled={submitting}
      />

      <fieldset className="space-y-2" disabled={submitting}>
        <legend className="font-display text-xs uppercase tracking-widest text-text-muted">
          Hours for this job
        </legend>
        <div className="grid grid-cols-4 gap-2">
          {HOURS_OPTIONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setTotalHours(h)}
              aria-pressed={totalHours === h}
              className={cn(
                "min-h-[44px] rounded-card border px-2 py-2 text-sm font-medium",
                totalHours === h
                  ? "border-brand-navy bg-brand-navy text-text-inverse"
                  : "border-border bg-surface text-text hover:border-border-strong",
              )}
            >
              {formatHoursLabel(h)}
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
            value={totalHours}
            onChange={(e) => setTotalHours(Number(e.target.value))}
            className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
          />
        </label>
      </fieldset>

      {assignedJobs.length > 1 ? (
        // 2026-07-26 owner-directed: the day can be split across jobs from
        // here. Same words as the log sheet's split affordance; only shown to
        // multi-job workers (a one-job worker has nothing to split into).
        <Button
          variant="secondary"
          size="sm"
          onClick={openSplit}
          disabled={submitting}
          data-testid="phil-change-split"
        >
          Split across jobs
        </Button>
      ) : null}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">Note (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={submitting}
          rows={2}
          maxLength={500}
          placeholder="Anything the office should know about the fix…"
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
        />
      </label>

      {state.kind === "error" ? (
        <PhilNotice
          tone="danger"
          role="alert"
          title={editingSubmitted ? "Couldn’t send the fix" : "Couldn’t resubmit"}
        >
          {state.message}
          {state.status ? <span className="ml-1 text-xs">(HTTP {state.status})</span> : null}
        </PhilNotice>
      ) : null}

      {editingSubmitted ? (
        // P12 — name the consequence before the irreversible-looking action.
        <p className="text-xs text-text-muted" data-testid="phil-edit-submitted-consequence">
          The office gets the new version — the old one is replaced.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
        {editingSubmitted ? (
          <Button onClick={submit} disabled={!canSubmit} data-testid="phil-edit-submitted-send">
            {submitting ? "Sending…" : "Send the fix"}
          </Button>
        ) : (
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? "Resubmitting…" : "Submit correction"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Compact job picker for the resubmit form. Same four honest states as the
 * create-path JobAttribution, purpose-built small for an inline card:
 *   - jobs failed to load → warning, submit blocked
 *   - no active jobs       → honest "ask the office", submit blocked
 *   - one job              → preselected, read-only
 *   - multiple jobs        → required radio list
 */
function ResubmitJobPicker({
  jobs,
  selectedJobId,
  onSelect,
  jobsError,
  disabled,
}: {
  jobs: ReadonlyArray<AssignableJob>;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  jobsError: boolean;
  disabled: boolean;
}): ReactNode {
  const label = (
    <p className="font-display text-xs uppercase tracking-widest text-text-muted">Job</p>
  );

  if (jobsError) {
    return (
      <div
        role="status"
        className="rounded-card border border-border border-l-4 border-l-state-warning bg-surface p-3"
      >
        {label}
        <p className="mt-1 text-sm font-medium text-text">Couldn&rsquo;t load your jobs</p>
        <p className="mt-0.5 text-xs text-text-muted">
          Pull to refresh — hours can&rsquo;t be resubmitted until your jobs load.
        </p>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div
        role="status"
        className="rounded-card border border-border border-l-4 border-l-state-warning bg-surface p-3"
      >
        {label}
        <p className="mt-1 text-sm font-medium text-text">No active assigned job</p>
        <p className="mt-0.5 text-xs text-text-muted">
          Ask the office to assign you to a job before resubmitting.
        </p>
      </div>
    );
  }

  if (jobs.length === 1) {
    return (
      <div>
        {label}
        <div className="mt-1 flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
          <span className="min-w-0 truncate text-sm font-medium text-text">{jobs[0]!.name}</span>
          <Pill tone="neutral">Assigned job</Pill>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        {label}
        {!selectedJobId ? (
          <span className="text-xs font-medium text-state-warning">Pick one</span>
        ) : null}
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
                onClick={() => onSelect(j.id)}
                className={cn(
                  "flex min-h-[48px] w-full items-center gap-2 rounded-card border px-3 py-2 text-left text-sm font-medium",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                    : "border-border bg-surface text-text hover:border-border-strong",
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
    </div>
  );
}
