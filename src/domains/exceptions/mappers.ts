import type { TimeEntry } from "@/domains/timesheets/types";
import { weekStartOf } from "@/domains/timesheets/service";
import type { Job } from "@/domains/jobs/types";
import { resolveAction, type ResolvedAction } from "./routes";
import type { ExceptionItem } from "./types";

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

/** "Tom", "Tom and Sam", "Tom, Sam and 3 others" — the people behind a group. */
function namesLabel(entries: ReadonlyArray<TimeEntry>): string {
  const names = [...new Set(entries.map((e) => e.userName?.trim() || "a worker"))];
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"}`;
}

/** The earliest of a set of ISO stamps (the group's age is its oldest item). */
function oldest(stamps: ReadonlyArray<string | null | undefined>): string | undefined {
  const real = stamps.filter((s): s is string => !!s).sort();
  return real[0];
}

/**
 * Hours: submitted = awaiting approval; rejected = needs worker correction.
 *
 * ONE item per kind, not one per day (owner pull 2026-10-06 — "stop
 * unnecessary Needs you items building up"): a crew of eight logging a week
 * used to put ~40 rows on the phone home. The group says how many days and
 * whose, ages from its OLDEST day, and lands where they're decided — the
 * approvals queue, or the weekly board on the oldest rejected day's week
 * (rejected days show there as "Sent back"). Every day is still on those
 * screens; nothing is dropped, only counted together. Same shape as the
 * desktop queue rows (src/domains/command-centre/needs-you.ts).
 */
export function hoursExceptions(
  pending: ReadonlyArray<TimeEntry>,
  rejected: ReadonlyArray<TimeEntry>,
): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  const waiting = pending.filter((e) => e.status === "submitted"); // trust the field, not the caller
  if (waiting.length > 0) {
    const n = waiting.length;
    out.push({
      id: "hours-pending",
      source: "hours",
      sourceId: "pending",
      title: `${n} ${n === 1 ? "day" : "days"} waiting on your approval`,
      summary: `From ${namesLabel(waiting)} — approve or send back so they land in this pay period.`,
      severity: "warning",
      status: "waiting",
      ownerRole: "office",
      createdAt: oldest(waiting.map((e) => e.submittedAt ?? e.createdAt)),
      ...withAction(resolveAction("hoursApprovals", {}, { label: "Review approvals" })),
      tags: ["hours", "approval"],
    });
  }
  const sentBack = rejected.filter((e) => e.status === "rejected");
  if (sentBack.length > 0) {
    const n = sentBack.length;
    const oldestDay = [...sentBack].sort((a, b) => a.date.localeCompare(b.date))[0]!;
    out.push({
      id: "hours-rejected",
      source: "hours",
      sourceId: "rejected",
      title: `${n} rejected ${n === 1 ? "day" : "days"} to re-submit`,
      summary: `Sent back to ${namesLabel(sentBack)} — these hours can’t be paid until they fix and resubmit.`,
      severity: "warning",
      status: "blocked",
      ownerRole: "office",
      createdAt: oldest(sentBack.map((e) => e.rejectedAt ?? e.submittedAt ?? e.createdAt)),
      ...withAction(
        resolveAction("hoursWeekly", {}, { label: "Review rejections", query: { week: weekStartOf(oldestDay.date) } }),
      ),
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

    // Photos / tags to review are NOT a Needs-you item (owner pull 2026-10-06):
    // they block no one and grew with every capture. They stay on the job —
    // the card's "Review N" link and the job's Evidence page.

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
