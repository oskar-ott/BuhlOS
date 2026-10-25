"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Send } from "lucide-react";
import { amendmentLine, formatHoursLabel } from "@/domains/timesheets/format";
import {
  dayDate,
  draftSendBlockReason,
  entryTarget,
  splitLabel,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";
import type { HoursProblem } from "@/domains/timesheets/problem";
import type { TimeEntry } from "@/domains/timesheets/types";
import { HoursSheet } from "./HoursSheet";
import { StatusPill } from "./StatusPill";

export const NO_DELETE_LINE =
  "Logged days can't be deleted. Change the hours instead, or ask the office.";

/**
 * Day detail (docs/phil-hours.md): tap a logged row. The status pill, the
 * receipt in large type, the note, and — while the office hasn't decided —
 * "Change these hours" with its consequence. An office draft ("Not sent") can
 * be sent from here. At the bottom, where a worker would look for delete, the
 * no-delete line.
 */
export function DayDetailSheet({
  open,
  onClose,
  entry,
  jobs,
  jobsError,
  busy = false,
  problem,
  onChangeHours,
  onSaveNote,
  onSendDraft,
}: {
  open: boolean;
  onClose: () => void;
  entry: TimeEntry;
  jobs: ReadonlyArray<HoursJob>;
  jobsError: boolean;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  onChangeHours: () => void;
  onSaveNote: (note: string) => void;
  onSendDraft: () => void;
}): ReactNode {
  const [note, setNote] = useState("");
  const waiting = entry.status === "submitted";
  const draft = entry.status === "draft";
  const target = entryTarget(entry, jobs);
  const split = (entry.allocations ?? []).length > 1;
  const adjusted = amendmentLine(entry);
  const draftBlock = draft ? draftSendBlockReason(entry, jobs, jobsError) : null;
  const day = weekdayName(entry.date);

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title={dayDate(entry.date)}
      subtitle={target}
      testId="hours-sheet-detail"
      footer={{
        problem: problem ?? null,
        send:
          draft && !draftBlock
            ? {
                label: `Send ${day} to the office`,
                sub: "The office saved it but it hasn't been sent",
                onClick: onSendDraft,
                busy,
                testId: "hours-draft-send",
              }
            : null,
        reason: draft && draftBlock ? `This day can't be sent from here — ${draftBlock}.` : null,
        note: <p data-testid="hours-no-delete">{NO_DELETE_LINE}</p>,
      }}
    >
      <div className="space-y-4">
        <StatusPill state={entry.status} size="md" />

        <div className="rounded-[16px] bg-surface-subtle p-4" data-testid="hours-detail-receipt">
          <p className="font-display text-[28px] font-extrabold leading-none tabular-nums tracking-tight">
            {formatHoursLabel(entry.totalHours)}
          </p>
          <p className="mt-1 text-[15px] text-text">
            {split
              ? (entry.allocations ?? [])
                  .map(
                    (a) =>
                      `${jobs.find((j) => j.id === a.jobId)?.name ?? a.jobName ?? "A job you're no longer on"} ${formatHoursLabel(a.hours)}`
                  )
                  .join(" + ")
              : `${target} · ${splitLabel(entry)}`}
          </p>
          {adjusted ? <p className="mt-2 text-[13px] text-text-muted">{adjusted}</p> : null}
          {entry.notes ? (
            <p className="mt-2 text-[13px] text-text-muted">
              <span className="font-semibold text-text">Note:</span> {entry.notes}
            </p>
          ) : null}
        </div>

        {waiting ? (
          <>
            <p className="text-[14px] text-text">
              The office hasn&rsquo;t decided on this day yet, so you can still change the hours.
            </p>
            <button
              type="button"
              onClick={onChangeHours}
              data-testid="hours-change-hours"
              className="flex min-h-[64px] w-full items-center justify-between gap-3 rounded-card border border-border-strong bg-surface px-4 text-left active:bg-surface-subtle"
            >
              <span>
                <span className="block font-display text-[16px] font-bold">Change these hours</span>
                <span className="block text-[13px] text-text-muted">
                  The office will see the new hours instead
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) onSaveNote(note.trim());
              }}
            >
              <label className="block">
                <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                  Add a note for the office
                </span>
                <span className="flex gap-2">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    placeholder="One line"
                    className="h-12 min-w-0 flex-1 rounded-card border border-border-strong bg-surface px-3 text-[15px] text-text focus:border-brand-navy focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busy || !note.trim()}
                    className="inline-flex h-12 shrink-0 items-center gap-1 rounded-card border border-border-strong px-3 font-display text-[14px] font-semibold text-text disabled:opacity-40"
                  >
                    <Send aria-hidden="true" className="h-4 w-4" />
                    Save note
                  </button>
                </span>
              </label>
            </form>
          </>
        ) : entry.status === "approved" ? (
          <p className="text-[14px] text-text-muted">
            Approved and locked for pay. If something&rsquo;s wrong, ask the office.
          </p>
        ) : draft ? (
          <p className="text-[14px] text-text">
            The office saved this day for you. It isn&rsquo;t sent until you send it.
          </p>
        ) : null}
      </div>
    </HoursSheet>
  );
}
