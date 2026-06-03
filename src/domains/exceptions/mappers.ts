import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem, ObservationPriority } from "@/domains/observations/types";
import type { MaterialRequestItem, MaterialRequestUrgency } from "@/domains/material-requests/types";
import { isOpenObservation } from "@/domains/observations/service";
import type { ExceptionItem, ExceptionSeverity } from "./types";

/**
 * Source-specific mappers: each turns real source records into ExceptionItems.
 * Pure + deterministic — no fetching, no Date.now(), no randomness. Each item's
 * `actionHref` is a canonical internal route the office can act on.
 */

function routeSegment(value: string): string {
  return encodeURIComponent(value);
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
      summary: `${e.totalHours}h submitted — review and approve or reject.`,
      severity: "warning",
      status: "waiting",
      ownerRole: "office",
      createdAt: e.submittedAt ?? e.createdAt,
      actionLabel: "Review approvals",
      actionHref: "/hours/approvals",
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
        ? `Reason: ${e.rejectedReason}`
        : "Worker needs to fix and resubmit — nudge them or correct it.",
      severity: "warning",
      status: "blocked",
      ownerRole: "office",
      createdAt: e.rejectedAt ?? e.submittedAt ?? e.createdAt,
      actionLabel: "Review approvals",
      actionHref: "/hours/approvals",
      tags: ["hours", "rejected"],
    });
  }
  return out;
}

const PRIORITY_SEVERITY: Record<ObservationPriority, ExceptionSeverity> = {
  urgent: "critical",
  high: "warning",
  normal: "warning",
  low: "info",
};

/** Observations: open AND requiresAction = the field-to-office "what came in". */
export function observationExceptions(
  observations: ReadonlyArray<ObservationItem>,
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const o of observations) {
    if (!isOpenObservation(o.status) || !o.requiresAction) continue;
    out.push({
      id: `observation:${o.id}`,
      source: "observation",
      sourceId: o.id,
      jobId: o.jobId,
      jobName: o.jobName ?? undefined,
      title: o.title,
      summary: o.description ?? undefined,
      severity: PRIORITY_SEVERITY[o.priority] ?? "warning",
      status: "open",
      ownerRole: "office",
      createdAt: o.createdAt,
      dueAt: o.dueDate ?? undefined,
      actionLabel: "Open observation",
      // Deep-link to the per-job slice when we know the job; else the inbox.
      actionHref: o.jobId ? `/v2/jobs/${routeSegment(o.jobId)}/observations` : "/observations",
      tags: ["observation", o.type],
    });
  }
  return out;
}

const ARCHIVED_LIKE = new Set(["archived"]);

/**
 * Job-derived exceptions from the per-job stats already on the jobs list:
 * pending evidence, active snags, ITPs needing sign-off, an ACTIVE job with no
 * assigned crew (PR #67 source of truth), and DRAFT jobs awaiting publish.
 */
export function jobExceptions(jobs: ReadonlyArray<Job>): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const j of jobs) {
    const status = j.status;
    if (status && ARCHIVED_LIKE.has(status)) continue; // never surface archived work
    const name = j.name;

    // Field-work queues only apply once a job is real (not a draft).
    if (status !== "draft") {
      const evidence = j.statsEvidenceV2Pending ?? 0;
      if (evidence > 0) {
        out.push(jobStatItem(j, "evidence", evidence, `${name}: ${evidence} evidence to review`, `/v2/jobs/${routeSegment(j.id)}/evidence`, "warning", "Open evidence"));
      }
      const snags = j.statsSnagsV2Active ?? 0;
      if (snags > 0) {
        out.push(jobStatItem(j, "snag", snags, `${name}: ${snags} open snag${snags === 1 ? "" : "s"}`, `/v2/jobs/${routeSegment(j.id)}/snags`, "warning", "Open snags"));
      }
      const itps = j.statsItpsNeedsReview ?? 0;
      if (itps > 0) {
        out.push(jobStatItem(j, "itp", itps, `${name}: ${itps} ITP${itps === 1 ? "" : "s"} need sign-off`, `/v2/jobs/${routeSegment(j.id)}/itps`, "warning", "Open ITPs"));
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
        summary: "Assign workers so the crew can see this job in Phil.",
        severity: "critical",
        status: "blocked",
        ownerRole: "office",
        actionLabel: "Assign workers",
        actionHref: `/v2/jobs/${routeSegment(j.id)}/builder`,
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
        actionLabel: "Open builder",
        actionHref: `/v2/jobs/${routeSegment(j.id)}/builder`,
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
  href: string,
  severity: ExceptionSeverity,
  actionLabel: string,
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
    actionLabel,
    actionHref: href,
    tags: ["job", source, `count:${count}`],
  };
}

const URGENCY_SEVERITY: Record<MaterialRequestUrgency, ExceptionSeverity> = {
  urgent: "critical",
  high: "warning",
  normal: "info",
  low: "info",
};

/**
 * Material requests still needing an OFFICE decision: `requested` (approve/
 * reject) or `approved` (place the order). Once `ordered`/`delivered` the office
 * has acted, so it's no longer an exception — mirrors the Command Centre's
 * "office action needed before procurement" queue, narrower than isOpenRequest.
 */
const MATERIAL_NEEDS_OFFICE = new Set(["requested", "approved"]);
export function materialExceptions(
  requests: ReadonlyArray<MaterialRequestItem>,
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const m of requests) {
    if (!MATERIAL_NEEDS_OFFICE.has(m.status)) continue;
    out.push({
      id: `material:${m.id}`,
      source: "material",
      sourceId: m.id,
      jobId: m.jobId,
      jobName: m.jobName ?? undefined,
      title: `${m.jobName ?? "Job"}: ${m.item} (${m.status})`,
      summary: `Requested by ${m.requestedByName} — office action needed before ordering.`,
      severity: URGENCY_SEVERITY[m.urgency] ?? "info",
      status: m.status === "approved" ? "waiting" : "open",
      ownerRole: "office",
      createdAt: m.createdAt,
      actionLabel: "Open material requests",
      actionHref: "/material-requests",
      tags: ["material", m.status],
    });
  }
  return out;
}
