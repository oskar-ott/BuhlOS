import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import { resolveAction, jobHubHref, type ResolvedAction } from "./routes";
import type { ExceptionItem, ExceptionSeverity } from "./types";

/**
 * Source-specific mappers: each turns real source records into ExceptionItems.
 * Pure + deterministic — no fetching, no Date.now(), no randomness.
 *
 * Every item's action goes through the route registry (resolveAction) so the
 * link is canonical, encoded, and either `available` (a real implemented
 * surface) or honestly `unavailable` — never a fabricated or broken route.
 */

/** Merge a resolved action's fields onto an item (href/label/state/reason). */
function withAction(action: ResolvedAction) {
  return {
    actionHref: action.actionHref,
    actionLabel: action.actionLabel,
    actionState: action.actionState,
    actionReason: action.actionReason,
  };
}

/** The single distinct job an hours entry is allocated to, or undefined. */
function singleAllocationJobId(entry: TimeEntry): string | undefined {
  const ids = new Set(
    (entry.allocations ?? []).map((a) => a.jobId).filter((j): j is string => !!j),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Hours: submitted = awaiting approval; rejected = needs worker correction. */
export function hoursExceptions(
  pending: ReadonlyArray<TimeEntry>,
  rejected: ReadonlyArray<TimeEntry>,
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const e of pending) {
    if (e.status !== "submitted") continue; // trust the field, not the caller
    out.push({
      id: `hours-pending:${e.id}`,
      source: "hours",
      sourceId: e.id,
      jobId: singleAllocationJobId(e),
      title: `Hours from ${e.userName ?? "a worker"} (${e.date}) awaiting approval`,
      summary: `${e.totalHours}h submitted — approve or reject in the hours queue.`,
      severity: "warning",
      status: "waiting",
      ownerRole: "office",
      createdAt: e.submittedAt ?? e.createdAt,
      ...withAction(resolveAction("hoursApprovals", {}, { label: "Review approvals" })),
      tags: ["hours", "approval"],
    });
  }
  for (const e of rejected) {
    if (e.status !== "rejected") continue;
    out.push({
      id: `hours-rejected:${e.id}`,
      source: "hours",
      sourceId: e.id,
      jobId: singleAllocationJobId(e),
      title: `Rejected hours from ${e.userName ?? "a worker"} (${e.date}) need correction`,
      summary: e.rejectedReason
        ? `Reason: ${e.rejectedReason} — review and nudge the worker to resubmit.`
        : "Worker needs to fix and resubmit — review the rejection.",
      severity: "warning",
      status: "blocked",
      ownerRole: "office",
      createdAt: e.rejectedAt ?? e.submittedAt ?? e.createdAt,
      ...withAction(resolveAction("hoursApprovals", {}, { label: "Review rejections" })),
      tags: ["hours", "rejected"],
    });
  }
  return out;
}

const ARCHIVED_LIKE = new Set(["archived"]);

/**
 * Job-derived exceptions from the per-job stats already on the jobs list:
 * pending evidence, an ACTIVE job with no assigned crew (PR #67 source of
 * truth), and DRAFT jobs awaiting publish.
 */
export function jobExceptions(jobs: ReadonlyArray<Job>): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const j of jobs) {
    const status = j.status;
    if (status && ARCHIVED_LIKE.has(status)) continue; // never surface archived work
    const name = j.name;

    // Field-work queues only apply once a job is real (not a draft).
    if (status !== "draft") {
      const hub = jobHubHref(j.id); // safe parent surface if a section route ever goes missing
      const evidence = j.statsEvidenceV2Pending ?? 0;
      if (evidence > 0) {
        out.push(jobStatItem(j, "evidence", evidence, `${name}: ${evidence} evidence to review`, resolveAction("jobEvidence", { jobId: j.id }, { label: "Open evidence", fallbackHref: hub }), "warning"));
      }
    }

    // Active but nobody assigned — the field literally can't see this job.
    if (status === "active" && (j.statsCrewCount ?? 0) === 0) {
      out.push({
        id: `job-no-crew:${j.id}`,
        source: "job",
        sourceId: j.id,
        jobId: j.id,
        jobName: name,
        title: `${name}: active but no field workers assigned`,
        summary: "Assign workers so the crew can see this job on their phones.",
        severity: "critical",
        status: "blocked",
        ownerRole: "office",
        // Deep-link straight to the PR #67 assignment section on the builder.
        ...withAction(resolveAction("jobBuilder", { jobId: j.id }, { label: "Assign field workers", fragment: "assigned-field-workers" })),
        tags: ["job", "crew"],
      });
    }

    // Draft jobs are office-only until published — a gentle "to publish".
    if (status === "draft") {
      out.push({
        id: `job-draft:${j.id}`,
        source: "job",
        sourceId: j.id,
        jobId: j.id,
        jobName: name,
        title: `${name}: draft, not published`,
        summary: "Office-only until published. Publish to make it live for the field.",
        severity: "info",
        status: "open",
        ownerRole: "office",
        // Deep-link to the builder's Publish tab (honoured via the URL hash).
        ...withAction(resolveAction("jobBuilder", { jobId: j.id }, { label: "Publish job", fragment: "publish" })),
        tags: ["job", "draft"],
      });
    }
  }
  return out;
}

function jobStatItem(
  j: Job,
  source: ExceptionItem["source"],
  count: number,
  title: string,
  action: ResolvedAction,
  severity: ExceptionSeverity,
): ExceptionItem {
  return {
    id: `${source}-job:${j.id}`,
    source,
    sourceId: j.id,
    jobId: j.id,
    jobName: j.name,
    title,
    severity,
    status: "open",
    ownerRole: "office",
    ...withAction(action),
    tags: ["job", source, `count:${count}`],
  };
}
