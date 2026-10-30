"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, MessageSquareWarning } from "lucide-react";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { STANDARD_DAY_HOURS } from "@/domains/timesheets/service";
import {
  dayDate,
  entryTarget,
  jobTiles,
  leaveOptions,
  receiptLine,
  splitLabel,
  weekdayName,
  type HoursJob,
  type LeaveType,
} from "@/domains/timesheets/hours-view";
import {
  buildDayTypeResubmitPayload,
  buildResubmitPayload,
  buildSplitResubmitPayload,
} from "@/domains/timesheets/resubmit";
import type { HoursProblem } from "@/domains/timesheets/problem";
import type { PatchTimeEntryPayload, TimeEntry } from "@/domains/timesheets/types";
import { HoursSheet } from "./HoursSheet";
import { JobTiles } from "./JobTiles";
import { LeavePills } from "./LeavePills";
import { OtSheet } from "./OtSheet";
import { SplitSheet } from "./SplitSheet";

/**
 * Fix needed (docs/phil-hours.md): the office's reason in their words, what
 * was sent, then "Change what's wrong" — the same job chips (the sent job
 * marked), the leave group, and the hours row (or Split jobs for a split day),
 * which open the same sheets logging uses. Until something changes the footer
 * says so; once changed, the review reads "You're sending instead" and Send
 * goes back to the office. Payloads are the existing resubmit builders —
 * the rejected → submitted transition the server already supports.
 */
export function FixSheet({
  open,
  onClose,
  entry,
  jobs,
  canLogTafe,
  busy = false,
  problem,
  onFindJob,
  foundJob,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  entry: TimeEntry;
  jobs: ReadonlyArray<HoursJob>;
  canLogTafe: boolean;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  /** Opens Find another job for this day; the pick lands in `foundJob`. */
  onFindJob: () => void;
  foundJob?: HoursJob | null;
  onSend: (payload: PatchTimeEntryPayload) => void;
}): ReactNode {
  const sentJobId = (entry.allocations ?? []).find((a) => a.jobId)?.jobId ?? null;
  const sentType = (entry.dayType as LeaveType | null | undefined) ?? null;
  const split = (entry.allocations ?? []).length > 1;

  const [jobId, setJobId] = useState<string | null>(foundJob?.id ?? sentJobId);
  const [leave, setLeave] = useState<LeaveType | null>(sentType);
  const [hours, setHours] = useState<number>(entry.totalHours);
  const [splitRows, setSplitRows] = useState<Array<{ jobId: string; hours: number }> | null>(null);
  const [nested, setNested] = useState<"none" | "hours" | "split">("none");
  // A job found through search after this sheet opened wins the pick.
  const effectiveJobId =
    foundJob && jobId === sentJobId && foundJob.id !== sentJobId ? foundJob.id : jobId;

  const jobChanged = leave === null && effectiveJobId !== sentJobId;
  const typeChanged = leave !== sentType;
  const hoursChanged = Math.abs(hours - entry.totalHours) > 0.005;
  const changed = jobChanged || typeChanged || hoursChanged || splitRows !== null;

  const day = weekdayName(entry.date);
  const allJobs: HoursJob[] =
    foundJob && !jobs.some((j) => j.id === foundJob.id) ? [...jobs, foundJob] : [...jobs];
  const targetName = leave ? null : (allJobs.find((j) => j.id === effectiveJobId)?.name ?? null);
  // The same capped grid as the dock: the sent job leads, then by recency
  // (`jobs` arrives ranked); a found job takes the oldest unpicked tile.
  const grid = jobTiles({
    ranked: jobs,
    pickedJobId: leave ? null : effectiveJobId,
    lead: sentJobId,
    found: foundJob ? [foundJob] : [],
  });

  function payload(): PatchTimeEntryPayload | null {
    if (leave)
      return buildDayTypeResubmitPayload(entry, {
        totalHours: hours,
        dayType: leave,
        notes: entry.notes ?? null,
      });
    if (splitRows)
      return buildSplitResubmitPayload(entry, {
        totalHours: hours,
        allocations: splitRows,
        notes: entry.notes ?? null,
      });
    if (split && !splitRows) {
      // A split day fixed only in hours keeps its jobs; share the new total pro rata is a
      // guess, so the split sheet is the only way to change a split day's hours.
      return null;
    }
    if (!effectiveJobId) return null;
    return buildResubmitPayload(entry, {
      totalHours: hours,
      jobId: effectiveJobId,
      notes: entry.notes ?? null,
    });
  }

  const draft = payload();
  const preview = draft
    ? receiptLine(
        {
          date: entry.date,
          dayType: draft.dayType ?? null,
          allocations: (draft.allocations ?? []).map((a) => ({ jobId: a.jobId, hours: a.hours })),
          totalHours: draft.totalHours ?? hours,
          ordinaryHours: draft.ordinaryHours ?? 0,
          overtimeHours: draft.overtimeHours ?? 0,
        },
        allJobs
      )
    : null;

  const reason = !changed
    ? "Nothing changed yet. Pick the right job or hours, then you can send it back to the office."
    : !draft
      ? split
        ? "Use Split jobs to change a split day's hours."
        : "Pick a job to send it back."
      : null;

  return (
    <>
      <HoursSheet
        open={open}
        onClose={onClose}
        title={`Fix ${day}`}
        subtitle={dayDate(entry.date)}
        testId="hours-sheet-fix"
        footer={{
          problem: problem ?? null,
          reason,
          review: reason || !preview ? null : { lead: "You're sending instead", line: preview },
          send: {
            label: `Send fixed ${day}`,
            sub: "Goes back to the office",
            onClick: () => {
              if (draft) onSend(draft);
            },
            busy,
            testId: "hours-fix-send",
          },
        }}
      >
        <div className="space-y-4">
          <div
            className="rounded-[16px] border border-[#f4c9c9] bg-[#fee2e2] p-4"
            data-testid="hours-fix-reason"
          >
            <p className="flex items-center gap-2 font-display text-[13px] font-bold uppercase tracking-[0.06em] text-state-danger">
              <MessageSquareWarning aria-hidden="true" className="h-4 w-4" />
              Fix needed · the office says
            </p>
            <p className="mt-1 whitespace-pre-line text-[16px] text-text">
              {entry.rejectedReason?.trim()
                ? `“${entry.rejectedReason.trim()}”`
                : "No reason was written."}
            </p>
          </div>

          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              What you sent
            </p>
            <p className="mt-1 text-[15px] tabular-nums text-text">
              {`${splitLabel(entry)} · ${entryTarget(entry, jobs)}`}
            </p>
          </div>

          <div className="space-y-3">
            <p className="font-display text-[15px] font-bold">Change what&rsquo;s wrong</p>

            {!split ? (
              <JobTiles
                tiles={grid.tiles}
                more={grid.more}
                pickedJobId={leave ? null : effectiveJobId}
                lastJobId={sentJobId}
                sentJobId={sentJobId}
                date={entry.date}
                onPick={(id) => {
                  setJobId(id);
                  setLeave(null);
                }}
                onFind={onFindJob}
              />
            ) : null}

            <LeavePills
              options={leaveOptions(canLogTafe || sentType === "tafe")}
              selected={leave}
              onSelect={(t) => {
                setLeave(t);
                setSplitRows(null);
                if (hours <= 0) setHours(STANDARD_DAY_HOURS);
              }}
              sentType={sentType}
            />

            {split && !leave ? (
              <button
                type="button"
                onClick={() => setNested("split")}
                data-testid="hours-fix-split"
                className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-card border border-border-strong bg-surface px-4 text-left active:bg-surface-subtle"
              >
                <span>
                  <span className="block font-display text-[15px] font-bold">Split jobs</span>
                  <span className="block text-[13px] text-text-muted tabular-nums">{`Now: ${splitLabel(entry)} across ${(entry.allocations ?? []).length} jobs`}</span>
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setNested("hours")}
                data-testid="hours-fix-hours"
                className="flex min-h-[56px] w-full items-center justify-between gap-3 rounded-card border border-border-strong bg-surface px-4 text-left active:bg-surface-subtle"
              >
                <span>
                  <span className="block font-display text-[15px] font-bold">
                    {leave ? "Hours" : "Custom or overtime hours"}
                  </span>
                  <span className="block text-[13px] text-text-muted tabular-nums">
                    {`Now: ${formatHoursLabel(hours)}${Math.abs(hours - STANDARD_DAY_HOURS) < 0.005 ? " · standard day" : ""}`}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            )}
          </div>
        </div>
      </HoursSheet>

      {nested === "hours" ? (
        <OtSheet
          open
          onClose={() => setNested("none")}
          variant={leave ? "leave" : "weekday"}
          date={entry.date}
          target={leave ? (targetName ?? "Leave") : (targetName ?? "this job")}
          sentHours={hours}
          pick
          onSubmit={(total) => {
            setHours(total);
            setSplitRows(null);
            setNested("none");
          }}
        />
      ) : null}

      {nested === "split" ? (
        <SplitSheet
          open
          onClose={() => setNested("none")}
          date={entry.date}
          jobs={jobs}
          defaultJobId={sentJobId}
          initialTotal={hours}
          initialRows={(
            splitRows ?? (entry.allocations ?? []).map((a) => ({ jobId: a.jobId, hours: a.hours }))
          ).map((r) => ({
            jobId: r.jobId && jobs.some((j) => j.id === r.jobId) ? r.jobId : null,
            hours: r.hours,
          }))}
          pick
          onSubmit={(total, rows) => {
            setHours(total);
            setSplitRows(rows);
            setNested("none");
          }}
        />
      ) : null}
    </>
  );
}
