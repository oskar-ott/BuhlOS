import type { SnagItem } from "@/domains/snags/types";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Pure selector for the Phil My Day "Needs you" feed — the logged-in field
 * worker's real, actionable attention items, aggregated across their assigned
 * jobs.
 *
 * HONEST BY CONSTRUCTION. Every item is backed by a real data source and a
 * real route; nothing is fabricated. Only two item kinds are wired today
 * because only two have a real, worker-attributable source:
 *
 *   - rejected-hours: a time entry the office rejected (status "rejected").
 *       Source: GET /api/time-entries (self-scoped to the worker).
 *       Action: /phil/hours (RejectedHoursResubmitSheet).
 *   - snag: a snagsV2 issue ASSIGNED TO THIS WORKER (assignedToId) that is
 *       still open / in progress. Source: GET /api/snags?jobId= per assigned
 *       job. Action: the job's Snags section.
 *
 * Deliberately NOT included (no real, worker-attributable source — see
 * docs/phil-my-day-needs-you.md): assigned tasks (job-level, no assignee/due),
 * required evidence (no required-vs-supplied model), ITP/sign-off (job/role
 * scoped), RFIs (do not exist), and weekly "Submit timesheet" (no weekly
 * batch-submit workflow). When nothing is real, the feed is empty — never a
 * placeholder row.
 */
export type PhilNeedsYouKind = "rejected-hours" | "snag";
export type PhilNeedsYouSeverity = "urgent" | "warning" | "normal";

export interface PhilNeedsYouItem {
  id: string;
  kind: PhilNeedsYouKind;
  title: string;
  detail?: string;
  meta?: string;
  /** A real in-app route — never empty, never a dead link. */
  href: string;
  actionLabel: string;
  severity: PhilNeedsYouSeverity;
}

/** Raw snags for one of the worker's assigned jobs (already job-scoped). */
export interface JobSnags {
  jobId: string;
  jobName: string;
  snags: ReadonlyArray<SnagItem>;
}

export interface PhilNeedsYouInput {
  /** The logged-in worker. Snags are only attributed when this is set. */
  viewerId: string | null;
  /** The worker's recent time entries (the page already loads these). */
  entries: ReadonlyArray<TimeEntry>;
  /** snagsV2 per assigned job. */
  jobSnags: ReadonlyArray<JobSnags>;
}

const SEVERITY_RANK: Record<PhilNeedsYouSeverity, number> = {
  urgent: 0,
  warning: 1,
  normal: 2,
};

function shortDay(dateISO: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return dateISO;
  return new Date(dateISO + "T00:00:00").toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function hoursLabel(totalHours: number): string {
  if (!(totalHours > 0)) return "";
  const mins = Math.round(totalHours * 60);
  const h = Math.floor(mins / 60);
  const m = mins - h * 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function buildPhilNeedsYou(input: PhilNeedsYouInput): PhilNeedsYouItem[] {
  const items: PhilNeedsYouItem[] = [];

  // A. Rejected hours — real and blocks pay; the most urgent thing a worker
  //    can clear. A rejection always carries a date; the reason is shown when
  //    the office left one.
  for (const e of input.entries) {
    if (e.status !== "rejected") continue;
    items.push({
      id: `rejected-hours:${e.id}`,
      kind: "rejected-hours",
      title: `${shortDay(e.date)} hours need a fix`,
      detail: e.rejectedReason ?? undefined,
      meta: hoursLabel(e.totalHours) || undefined,
      href: "/phil/hours",
      actionLabel: "Fix hours",
      severity: "urgent",
    });
  }

  // E. Snags assigned to ME, still open / in progress — own work hanging.
  //    Mirrors PhilJobAttention's per-job filter, generalised across jobs. A
  //    snag assigned to someone else, or already resolved/closed, is never
  //    surfaced as "yours".
  if (input.viewerId) {
    for (const js of input.jobSnags) {
      for (const s of js.snags) {
        if (
          s.assignedToId === input.viewerId &&
          (s.status === "open" || s.status === "in_progress")
        ) {
          items.push({
            id: `snag:${s.id}`,
            kind: "snag",
            title: s.title,
            detail: js.jobName,
            meta: s.areaName ?? undefined,
            href: `/phil/jobs/${encodeURIComponent(js.jobId)}#phil-job-snags`,
            actionLabel: "Open snag",
            severity: s.priority === "urgent" || s.priority === "high" ? "warning" : "normal",
          });
        }
      }
    }
  }

  // urgent → warning → normal; stable within a rank (Array.sort is stable).
  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
