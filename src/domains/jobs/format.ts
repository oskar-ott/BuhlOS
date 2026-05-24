import type { Job, JobArea, JobStage, JobStatus, JobTaskTemplate } from "./types";

/**
 * Pure display helpers for the jobs domain. Kept separate from the client
 * + schema layers so they can be imported by both server and client
 * components without dragging fetch / zod runtime cost.
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §6 Visual marker system
 *   docs/rebuild-audit/27-interface-usability-pass.md §8.4 / §8.5
 */

const STATUS_LABELS: Record<JobStatus, string> = {
  active: "Active",
  on_hold: "On hold",
  complete: "Complete",
  archived: "Archived",
  draft: "Draft",
};

/**
 * Display label for a job status. Falls back to "Active" when missing
 * because the legacy data has rows pre-status-field, and a worker seeing
 * "—" beside their assigned job is more confusing than the live default.
 */
export function statusLabel(status: JobStatus | undefined): string {
  if (!status) return STATUS_LABELS.active;
  return STATUS_LABELS[status];
}

/**
 * Map a job status to one of the five tones in doc 27 §6.1.
 *
 *   active    → success (the steady state for an assigned job)
 *   on_hold   → warning (needs attention from PM, but recoverable)
 *   complete  → success (done, no action)
 *   archived  → neutral (hidden by default, no signal)
 *   draft     → neutral (admin-side concept)
 *
 * Returns the tone string the shared <Pill> component accepts.
 */
export type JobStatusTone = "success" | "warning" | "neutral";

export function statusTone(status: JobStatus | undefined): JobStatusTone {
  switch (status) {
    case "on_hold":
      return "warning";
    case "complete":
    case "active":
      return "success";
    case "archived":
    case "draft":
      return "neutral";
    default:
      return "success";
  }
}

const STAGE_LABELS: Record<JobStage, string> = {
  roughIn: "Rough-in",
  fitOff: "Fit-off",
};

export function stageLabel(stage: JobStage): string {
  return STAGE_LABELS[stage];
}

/**
 * Pick the best "when something last happened" timestamp for a job. Phase D1
 * has no real activity feed — no evidence yet, no hours roll-up here, no
 * audit log surfaced — so we fall back through updatedAt → createdAt → null.
 *
 * The display copy in PhilJobsList uses "Updated" or "Created" depending on
 * which we returned (see relativeWhen + whenLabel below).
 */
export function pickWhen(job: Pick<Job, "updatedAt" | "createdAt">): {
  iso: string;
  label: "Updated" | "Created";
} | null {
  if (job.updatedAt) return { iso: job.updatedAt, label: "Updated" };
  if (job.createdAt) return { iso: job.createdAt, label: "Created" };
  return null;
}

/**
 * Render a relative-time string like "2h ago", "3d ago", "May" — short
 * enough to live in the right gutter of a Phil list row. Anything older
 * than ~30 days falls back to the month + year so the worker still gets a
 * stable scan signal.
 *
 * Pure function of (then, now) so tests can pin the clock.
 */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return "just now";

  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  if (diffMs < MIN) return "just now";
  if (diffMs < HOUR) return `${Math.floor(diffMs / MIN)}m ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h ago`;
  if (diffMs < 30 * DAY) return `${Math.floor(diffMs / DAY)}d ago`;
  return then.toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

/**
 * Compose the row's right-gutter caption. Returns null when the job has
 * no timestamps at all — the row hides the caption rather than rendering
 * an em-dash.
 */
export function whenCaption(
  job: Pick<Job, "updatedAt" | "createdAt">,
  now: Date = new Date()
): string | null {
  const picked = pickWhen(job);
  if (!picked) return null;
  const rel = relativeWhen(picked.iso, now);
  if (!rel) return null;
  return `${picked.label} ${rel}`;
}

/**
 * The job-detail page's site context block falls through several optional
 * fields. Returns true when at least one of them is set, so the block
 * doesn't render with an empty header when the legacy job has no site info.
 */
export function hasSiteContext(
  job: Pick<
    Job,
    | "siteAddress"
    | "accessNotes"
    | "parkingNotes"
    | "safetyNotes"
    | "inductionRequired"
    | "siteContactName"
    | "siteContactPhone"
  >
): boolean {
  return Boolean(
    job.siteAddress ||
      job.accessNotes ||
      job.parkingNotes ||
      job.safetyNotes ||
      job.inductionRequired ||
      job.siteContactName ||
      job.siteContactPhone
  );
}

/**
 * Filter archived area groups + their archived areas out of the structural
 * tree. The legacy projectJobStructure() does this server-side for non-admin
 * GETs, but we re-apply it client-side as a defence-in-depth so a future
 * admin opening /phil/jobs/[jobId] for testing doesn't see archived items.
 */
export function visibleAreaGroups(
  groups: Job["areaGroups"]
): NonNullable<Job["areaGroups"]> {
  if (!groups) return [];
  return groups
    .filter((g) => !g.archived)
    .map((g) => ({
      ...g,
      areas: (g.areas ?? []).filter((a) => !a.archived),
    }));
}

/**
 * Resolve the task template list for a given area + stage. Mirrors the
 * legacy api/_lib/job-tasks.js inheritance rule:
 *
 *   - If the area carries a non-empty per-stage override, use it.
 *   - Otherwise, fall back to the job-level template.
 *
 * Archived templates are filtered out either way so a worker doesn't see a
 * task an admin has retired.
 *
 * Phase D1 renders the result read-only (no state pills, no toggle). Phase
 * D3 will wire `/api/task-toggle` and surface per-task runtime state on top
 * of this list.
 */
export function effectiveTasks(
  job: Pick<Job, "roughInTasks" | "fitOffTasks">,
  area: Pick<JobArea, "roughInTasks" | "fitOffTasks"> | null,
  stage: JobStage
): ReadonlyArray<JobTaskTemplate> {
  const fromArea = area
    ? stage === "roughIn"
      ? area.roughInTasks
      : area.fitOffTasks
    : undefined;
  const fromJob = stage === "roughIn" ? job.roughInTasks : job.fitOffTasks;
  const source = fromArea && fromArea.length > 0 ? fromArea : fromJob ?? [];
  return source.filter((t) => !t.archived);
}
