import {
  GRACE_DAYS,
  graceEndsAt,
  jobPhase,
  isFieldListedByDefault,
  isFieldOpenable,
  acceptsHours,
  type JobPhase,
  type LifecycleJob,
} from "../../../api/_lib/job-lifecycle.js";

/**
 * Job lifecycle for the UI — the ONE vocabulary both surfaces speak
 * (docs/job-lifecycle.md). The rules live in api/_lib/job-lifecycle.js so the
 * API gates and the screens can never disagree; this module adds the words.
 *
 *   active · on_hold · draft · archived  — the stored status, as today
 *   finishing  — complete, inside the GRACE_DAYS callback window
 *   closed     — complete, window over: found by search, still openable
 */
export { GRACE_DAYS, graceEndsAt, jobPhase, isFieldListedByDefault, isFieldOpenable, acceptsHours };
export type { JobPhase, LifecycleJob };

/** Every phase the admin list can filter on, in display order. */
export const JOB_PHASE_OPTIONS: ReadonlyArray<JobPhase> = [
  "active",
  "on_hold",
  "finishing",
  "closed",
  "draft",
  "archived",
];

const PHASE_LABELS: Record<JobPhase, string> = {
  active: "Active",
  on_hold: "On hold",
  finishing: "Finished",
  closed: "Closed",
  draft: "Draft",
  archived: "Archived",
};

/** Site words for a phase: "Finished" while the crew can still log, "Closed" after. */
export function phaseLabel(phase: JobPhase): string {
  return PHASE_LABELS[phase];
}

export type PhaseTone = "success" | "warning" | "neutral";

/** Finished/closed read as done-and-quiet (neutral), never as a live green. */
export function phaseTone(phase: JobPhase): PhaseTone {
  switch (phase) {
    case "active":
      return "success";
    case "on_hold":
      return "warning";
    default:
      return "neutral";
  }
}

export function parseJobPhaseParam(raw: string | null | undefined): JobPhase | null {
  if (!raw) return null;
  return (JOB_PHASE_OPTIONS as ReadonlyArray<string>).includes(raw) ? (raw as JobPhase) : null;
}

/** "24 Oct" / "24 Oct 2026" — a date the crew can read on a chip. */
export function shortDay(iso: string | null | undefined, withYear = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/**
 * The one-line lifecycle fact for a job, in site words, or null when there is
 * nothing to say (a plain active job). Examples:
 *   "Finished 3 Sep · crew can log until 3 Oct"
 *   "Closed 3 Sep · found by search, still takes callback hours"
 *   "Reopened 20 Sep (finished 3 Sep)"
 */
export function lifecycleLine(job: LifecycleJob, now?: Date | string): string | null {
  const phase = jobPhase(job, now);
  const finished = shortDay(job.completedAt);
  const reopened = shortDay(job.reopenedAt);
  if (phase === "finishing") {
    const until = shortDay(graceEndsAt(job));
    return `Finished ${finished ?? ""}${until ? ` · crew can log until ${until}` : ""}`.replace(/\s+·/, " ·").trim();
  }
  if (phase === "closed") {
    return `Closed${finished ? ` ${finished}` : ""} · found by search, still takes callback hours`;
  }
  if ((phase === "active" || phase === "on_hold") && reopened) {
    return `Reopened ${reopened}${finished ? ` (finished ${finished})` : ""}`;
  }
  if (phase === "archived") {
    return `Archived${finished ? ` · finished ${finished}` : ""} · office history only`;
  }
  return null;
}

/** The crew's version of the lifecycle line — site words, no office terms. */
export function fieldLifecycleLine(job: LifecycleJob, now?: Date | string): string | null {
  const phase = jobPhase(job, now);
  const finished = shortDay(job.completedAt);
  if (phase === "finishing") {
    const until = shortDay(graceEndsAt(job));
    return `Finished${finished ? ` ${finished}` : ""}${until ? ` · log hours here until ${until}` : ""}`;
  }
  if (phase === "closed") {
    return `Closed${finished ? ` ${finished}` : ""} · hours logged here count as a callback`;
  }
  if ((phase === "active" || phase === "on_hold") && job.reopenedAt) {
    return `Reopened ${shortDay(job.reopenedAt) ?? ""}`.trim();
  }
  return null;
}

/** Short chip text for the crew's job rows: "Finished · log until 24 Oct". */
export function fieldPhaseChip(job: LifecycleJob, now?: Date | string): string | null {
  const phase = jobPhase(job, now);
  if (phase === "finishing") {
    const until = shortDay(graceEndsAt(job));
    return until ? `Finished · log until ${until}` : "Finished";
  }
  if (phase === "closed") {
    const when = shortDay(job.completedAt);
    return when ? `Closed ${when}` : "Closed";
  }
  if (phase === "on_hold") return "On hold";
  return null;
}
