"use client";

import { DialPicker } from "./DialPicker";

/**
 * The spinning job dial (owner-directed 2026-08-02): the shared DialPicker
 * drum wearing the job vocabulary. A long job list never grows the page
 * (P10 — constant-height slot); flick to spin, tap a job to choose it.
 * The drum itself lives in DialPicker (extracted 2026-08-09 so the day
 * picker shares it) — this wrapper only names things.
 */
export function JobDialPicker({
  jobs,
  selectedJobId,
  onSelect,
  disabled,
}: {
  jobs: ReadonlyArray<{ id: string; name: string }>;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <DialPicker
      items={jobs.map((j) => ({ id: j.id, label: j.name }))}
      selectedId={selectedJobId}
      onSelect={onSelect}
      disabled={disabled}
      ariaLabel="Choose the job for these hours"
      countNoun="jobs"
      testId="job-dial"
    />
  );
}
