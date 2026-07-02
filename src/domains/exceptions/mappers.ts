import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem, ObservationPriority } from "@/domains/observations/types";
import type { MaterialRequestItem, MaterialRequestUrgency } from "@/domains/material-requests/types";
import { isOpenObservation } from "@/domains/observations/service";
import { isOverdue as isRfiOverdue } from "@/domains/rfi/logic";
import { resolveAction, jobHubHref, type ResolvedAction } from "./routes";
import type { ExceptionItem, ExceptionRfi, ExceptionSeverity } from "./types";

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
    // Deep-link to the per-job slice when we know the job; else the cross-job
    // inbox (also a real, safe route used as the fallback).
    const action = o.jobId
      ? resolveAction("jobObservations", { jobId: o.jobId }, { label: "Open observation", fallbackHref: "/observations" })
      : resolveAction("observationsInbox", {}, { label: "Open observations" });
    out.push({
      id: `observation:${o.id}`,
      source: "observation",
      sourceId: o.id,
      jobId: o.jobId ?? undefined,
      jobName: o.jobName ?? undefined,
      title: o.title,
      summary: o.description ?? undefined,
      severity: PRIORITY_SEVERITY[o.priority] ?? "warning",
      status: "open",
      ownerRole: "office",
      createdAt: o.createdAt,
      dueAt: o.dueDate ?? undefined,
      ...withAction(action),
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
      const hub = jobHubHref(j.id); // safe parent surface if a section route ever goes missing
      const evidence = j.statsEvidenceV2Pending ?? 0;
      if (evidence > 0) {
        out.push(jobStatItem(j, "evidence", evidence, `${name}: ${evidence} evidence to review`, resolveAction("jobEvidence", { jobId: j.id }, { label: "Open evidence", fallbackHref: hub }), "warning"));
      }
      const snags = j.statsSnagsV2Active ?? 0;
      if (snags > 0) {
        out.push(jobStatItem(j, "snag", snags, `${name}: ${snags} open snag${snags === 1 ? "" : "s"}`, resolveAction("jobSnags", { jobId: j.id }, { label: "Open snags", fallbackHref: hub }), "warning"));
      }
      const itps = j.statsItpsNeedsReview ?? 0;
      if (itps > 0) {
        out.push(jobStatItem(j, "itp", itps, `${name}: ${itps} ITP${itps === 1 ? "" : "s"} need sign-off`, resolveAction("jobItps", { jobId: j.id }, { label: "Open ITPs", fallbackHref: hub }), "warning"));
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
      // Deep-link straight to this request (the inbox opens its drawer on the
      // ?focus id) — the office can act on it without hunting the list.
      ...withAction(resolveAction("materialRequests", {}, { label: "Open request", query: { focus: m.id } })),
      tags: ["material", m.status],
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

/** Whole days between responseDue and today — both YYYY-MM-DD, so Date.parse
 *  reads each as UTC midnight and the difference is an exact day count. */
function rfiDaysOverdue(responseDue: string, today: string): number {
  const due = Date.parse(String(responseDue).slice(0, 10));
  const now = Date.parse(String(today).slice(0, 10));
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - due) / DAY_MS));
}

/** A chase ignored for over a week escalates to critical (mirrors the
 *  urgent-observation / urgent-material escalation: the loudest tier is for
 *  items that are actively stalling work). */
const RFI_CRITICAL_AFTER_DAYS = 7;

/**
 * RFIs (#276 "chase"): overdue only — still awaiting an answer (open/sent, the
 * shared isOverdue predicate the per-job register uses) with a past
 * response-due date, judged against the INJECTED `today` (business-timezone
 * YYYY-MM-DD; pure — no Date.now()). Days-overdue is computed from the real
 * responseDue, never fabricated. Deep-links to the job's RFI register.
 */
export function rfiExceptions(
  rfis: ReadonlyArray<ExceptionRfi>,
  today: string,
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const r of rfis) {
    if (!isRfiOverdue(r, today)) continue;
    const days = rfiDaysOverdue(r.responseDue, today);
    const daysLabel = `${days} day${days === 1 ? "" : "s"} overdue`;
    out.push({
      id: `rfi-overdue:${r.id}`,
      source: "rfi",
      sourceId: r.id,
      jobId: r.jobId,
      jobName: r.jobName,
      title: `${r.ref} overdue — ${r.subject}`,
      // "sent" = the builder owes an answer → chase; "open" = it was never
      // actually sent, which is the honest office-side failure to surface.
      summary:
        r.status === "sent"
          ? `Response was due ${r.responseDue} (${daysLabel}) — chase ${r.askedOf || "the builder"}.`
          : `Response was due ${r.responseDue} (${daysLabel}) — never sent. Send it or move the due date.`,
      severity: days > RFI_CRITICAL_AFTER_DAYS ? "critical" : "warning",
      status: "open",
      ownerRole: "office",
      createdAt: r.createdAt,
      dueAt: r.responseDue,
      ...withAction(
        resolveAction("jobRfis", { jobId: r.jobId }, { fallbackHref: jobHubHref(r.jobId) }),
      ),
      tags: ["rfi", "overdue", r.status],
    });
  }
  return out;
}
