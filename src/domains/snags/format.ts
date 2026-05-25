import type { SnagPriority, SnagStatus } from "./types";

/**
 * Pure display helpers for the snags domain. Kept separate from the
 * client + schema + service layers so they can be imported by both
 * server and client components without dragging fetch / zod runtime
 * cost.
 *
 * Status pill tones map to the same 5-tone palette evidence uses
 * (doc 27 §6.2):
 *   open         → warning   (needs picking up)
 *   in_progress  → info      (someone owns it)
 *   resolved     → info      (fix submitted; awaiting verify)
 *   verified     → success   (admin signed off)
 *   closed       → success   (loop closed; usually hidden)
 *   rejected     → danger    (admin rejected with reason)
 *
 * Priority pill tones:
 *   urgent  → danger
 *   high    → warning
 *   normal  → neutral
 *   low     → neutral (muted)
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §6.2
 *   src/domains/evidence/format.ts — precedent
 */

const STATUS_LABELS: Record<SnagStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  verified: "Verified",
  closed: "Closed",
  rejected: "Rejected",
};

export function statusLabel(status: SnagStatus): string {
  return STATUS_LABELS[status];
}

export type SnagStatusTone =
  | "warning"
  | "info"
  | "success"
  | "danger"
  | "neutral";

export function statusTone(status: SnagStatus): SnagStatusTone {
  switch (status) {
    case "open":
      return "warning";
    case "in_progress":
      return "info";
    case "resolved":
      return "info";
    case "verified":
      return "success";
    case "closed":
      return "success";
    case "rejected":
      return "danger";
  }
}

const PRIORITY_LABELS: Record<SnagPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function priorityLabel(priority: SnagPriority): string {
  return PRIORITY_LABELS[priority];
}

export type SnagPriorityTone = "neutral" | "warning" | "danger";

export function priorityTone(priority: SnagPriority): SnagPriorityTone {
  switch (priority) {
    case "urgent":
      return "danger";
    case "high":
      return "warning";
    case "normal":
    case "low":
      return "neutral";
  }
}

/** Snag is "active" if it's still going through the worker → admin
 *  loop. Used by the Phil panel to decide whether to show actions and
 *  by the queue's default filter. */
export function isActive(status: SnagStatus): boolean {
  return (
    status === "open" ||
    status === "in_progress" ||
    status === "resolved"
  );
}

/** Snag is "done" — verified or closed. Used by admin queue filters
 *  to hide already-handled rows by default. */
export function isDone(status: SnagStatus): boolean {
  return status === "verified" || status === "closed";
}

/** Snag needs the worker's attention in Phil.
 *
 *  Same as isActive() PLUS rejected — a rejected snag carries an
 *  admin-supplied reason that the worker has to see to act on
 *  (either re-raise or accept). Without surfacing rejected, the
 *  operational loop is broken: admin pushes back → worker never
 *  sees why.
 *
 *  Used by JobSnagsPanel so the worker's view always includes any
 *  snag the admin has flagged for their attention. Verified + closed
 *  rows stay out — those are "resolved good" and don't need a
 *  follow-up. */
export function needsWorkerAttention(status: SnagStatus): boolean {
  return isActive(status) || status === "rejected";
}
