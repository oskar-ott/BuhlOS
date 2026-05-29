import type { ObservationType, ObservationStatus, ObservationPriority } from "./types";

/**
 * Pure helpers for the observations domain — no fetch, no React, no Zod in
 * the hot path. Shared by:
 *   - api/observations.js (mirrors requiresActionForType + create rules in
 *     plain JS to avoid the TS build dependency; observations.test.ts asserts
 *     parity)
 *   - the BuhlOS Observations Inbox (sort + summary cards)
 *   - the Phil capture classifier (WORKER_CAPTURE_OPTIONS)
 *
 * Cross-ref: src/domains/snags/service.ts — precedent.
 */

/**
 * Does an observation of this type need office action by default?
 * A plain note or a photo record is "for the record"; everything else
 * (a blocker, a question, a safety issue, a material need…) is something
 * the office has to actually do something about. The client may override
 * (e.g. the field "Not sure — office review" option forces true on a note).
 */
export function requiresActionForType(type: ObservationType): boolean {
  switch (type) {
    case "note":
    case "evidence":
      return false;
    default:
      return true;
  }
}

/**
 * A field-worker capture option. `label`/`hint` are plain tradie English —
 * the worker never sees the internal `type`. `requiresAction` overrides the
 * type default where the label implies urgency the type alone doesn't
 * ("Not sure — office review" maps to a note but must reach the office).
 *
 * Photo/evidence is deliberately NOT here: it stays the existing, fully
 * persisted CaptureSheet flow (PR 4 keeps that path intact and offers these
 * classifications alongside it).
 */
export interface WorkerCaptureOption {
  key: string;
  label: string;
  hint: string;
  type: ObservationType;
  requiresAction?: boolean;
}

export const WORKER_CAPTURE_OPTIONS: ReadonlyArray<WorkerCaptureOption> = [
  { key: "note", label: "Site note", hint: "Quick note for the record", type: "note" },
  { key: "blocker", label: "Blocker", hint: "Something's stopping work", type: "blocker" },
  { key: "defect", label: "Issue / defect", hint: "Damage or bad work to fix", type: "defect" },
  {
    key: "material_request",
    label: "Need material",
    hint: "Gear or material to order",
    type: "material_request",
  },
  {
    key: "plan_mismatch",
    label: "Doesn't match plan",
    hint: "Site differs from the drawings",
    type: "plan_mismatch",
  },
  {
    key: "client_instruction",
    label: "Builder / client said",
    hint: "Instruction given on site",
    type: "client_instruction",
  },
  { key: "safety", label: "Safety concern", hint: "Unsafe condition on site", type: "safety" },
  { key: "rfi", label: "Question for office", hint: "Need the office to confirm", type: "rfi" },
  {
    key: "variation",
    label: "Variation / change",
    hint: "Extra or changed work",
    type: "variation",
  },
  {
    key: "unsure",
    label: "Not sure — office review",
    hint: "We'll sort it in the office",
    type: "note",
    requiresAction: true,
  },
];

export function workerOptionByKey(key: string): WorkerCaptureOption | undefined {
  return WORKER_CAPTURE_OPTIONS.find((o) => o.key === key);
}

/**
 * requiresAction for a chosen worker option: the explicit override if the
 * option sets one, otherwise the type default. Pure so Phil + tests agree.
 */
export function requiresActionForOption(option: WorkerCaptureOption): boolean {
  return option.requiresAction ?? requiresActionForType(option.type);
}

const CLOSED_STATUSES: ReadonlySet<ObservationStatus> = new Set([
  "resolved",
  "converted",
  "record_only",
]);

/** Is this observation still "live" — i.e. something the office may act on? */
export function isOpenObservation(status: ObservationStatus): boolean {
  return !CLOSED_STATUSES.has(status);
}

const STATUS_ORDER: Record<ObservationStatus, number> = {
  needs_action: 0,
  new: 1,
  in_review: 2,
  converted: 3,
  resolved: 4,
  record_only: 5,
};

const PRIORITY_ORDER: Record<ObservationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Exception-first inbox sort: needs-action/new before in-review before the
 * closed states; within a status, urgent→low; then the ones flagged
 * requiresAction; then newest first. So the office clears the loudest,
 * most-overdue site truth first instead of scrolling a raw table.
 */
export function compareForInbox(
  a: {
    status: ObservationStatus;
    priority: ObservationPriority;
    requiresAction: boolean;
    createdAt: string;
  },
  b: {
    status: ObservationStatus;
    priority: ObservationPriority;
    requiresAction: boolean;
    createdAt: string;
  }
): number {
  const sa = STATUS_ORDER[a.status] ?? 99;
  const sb = STATUS_ORDER[b.status] ?? 99;
  if (sa !== sb) return sa - sb;
  const pa = PRIORITY_ORDER[a.priority] ?? 99;
  const pb = PRIORITY_ORDER[b.priority] ?? 99;
  if (pa !== pb) return pa - pb;
  if (a.requiresAction !== b.requiresAction) return a.requiresAction ? -1 : 1;
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

export interface InboxSummary {
  total: number;
  open: number;
  newOrNeedsAction: number;
  /** Open AND flagged requiresAction — the "office must do something" count. */
  needsAction: number;
  highUrgent: number;
  blockers: number;
  inReview: number;
  resolvedOrRecord: number;
}

/** Summary counts for the inbox cards + the command-centre queue card. */
export function summariseInbox(
  observations: ReadonlyArray<{
    status: ObservationStatus;
    priority: ObservationPriority;
    type: ObservationType;
    requiresAction: boolean;
  }>
): InboxSummary {
  const s: InboxSummary = {
    total: observations.length,
    open: 0,
    newOrNeedsAction: 0,
    needsAction: 0,
    highUrgent: 0,
    blockers: 0,
    inReview: 0,
    resolvedOrRecord: 0,
  };
  for (const o of observations) {
    const open = isOpenObservation(o.status);
    if (open) s.open += 1;
    if (o.status === "new" || o.status === "needs_action") s.newOrNeedsAction += 1;
    if (open && o.requiresAction) s.needsAction += 1;
    if (open && (o.priority === "high" || o.priority === "urgent")) s.highUrgent += 1;
    if (open && o.type === "blocker") s.blockers += 1;
    if (o.status === "in_review") s.inReview += 1;
    if (o.status === "resolved" || o.status === "converted" || o.status === "record_only") {
      s.resolvedOrRecord += 1;
    }
  }
  return s;
}
