"use client";

import { useState, type ReactNode } from "react";
import { dayDate, weekdayName, type HoursJob } from "@/domains/timesheets/hours-view";
import { formatHoursLabel } from "@/domains/timesheets/format";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { HoursProblem } from "@/domains/timesheets/problem";
import { HoursSheet } from "./HoursSheet";
import { JobChips } from "./JobChips";

/**
 * Change the job (owner pull 2026-11-09 — "they should be able to change
 * it"): a one-job day still waiting on the office can be moved to another job
 * by the worker, the same way its hours can. The same job chips as logging
 * (the sent job marked "What you sent"), Find another job, and Send. The hours
 * stay as sent; the office sees the new job instead. Approved days stay locked.
 */
export function ChangeJobSheet({
  open,
  onClose,
  entry,
  sentJobId,
  jobs,
  entries,
  foundJob,
  onFindJob,
  busy = false,
  problem,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  entry: TimeEntry;
  sentJobId: string | null;
  jobs: ReadonlyArray<HoursJob>;
  entries?: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>;
  /** A job found through Find another job for this day. */
  foundJob?: HoursJob | null;
  onFindJob: () => void;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  onSend: (jobId: string) => void;
}): ReactNode {
  const [jobId, setJobId] = useState<string | null>(foundJob?.id ?? null);
  const day = weekdayName(entry.date);
  const all = foundJob ? [...jobs, foundJob] : jobs;
  const picked = jobId ? (all.find((j) => j.id === jobId) ?? null) : null;
  const next = picked && picked.id !== sentJobId ? picked : null;
  const hours = formatHoursLabel(entry.totalHours);

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title="Change the job"
      subtitle={`${dayDate(entry.date)} · ${hours}`}
      testId="hours-sheet-change-job"
      footer={{
        problem: problem ?? null,
        review: next
          ? {
              lead: "You're sending instead",
              line: `${dayDate(entry.date)} · ${next.name} · ${hours}`,
            }
          : null,
        reason: next ? null : "Pick the job these hours were really for.",
        send: next
          ? {
              label: `Send ${day} · ${next.name}`,
              sub: "The office sees the new job instead",
              onClick: () => onSend(next.id),
              busy,
              testId: "hours-change-job-send",
            }
          : null,
      }}
    >
      <JobChips
        jobs={jobs}
        pickedJobId={jobId ?? sentJobId}
        lastJobId={sentJobId}
        sentJobId={sentJobId}
        entries={entries}
        foundJob={foundJob ?? null}
        date={entry.date}
        onPick={setJobId}
        onFind={onFindJob}
      />
    </HoursSheet>
  );
}
