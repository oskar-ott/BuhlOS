import { evaluateAgainstCriteria } from "@/domains/test-records/criteria";
import { isPointApplicable } from "./applicability";
import type {
  ITPInstance,
  ITPInstanceResult,
  ITPPointType,
  ITPScope,
  ITPStatus,
  ITPTemplatePoint,
} from "./types";

/**
 * Pure display helpers for the ITP domain. Kept separate from schema +
 * service + client layers so server and client components can import
 * them without dragging Zod / fetch runtime cost.
 *
 * Status pill tones map to the same 5-tone palette evidence + snags
 * use (doc 27 §6.2):
 *   pending      → warning   (needs first record)
 *   in-progress  → info      (mid-flight)
 *   witnessed    → info      (all points done; awaiting sign-off)
 *   signed-off   → success   (admin signed off; terminal)
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §6.2
 *   src/domains/snags/format.ts — precedent
 */

/* ---------------------------------------------------------------------
 * Status / scope / point-type labels + tones
 * -------------------------------------------------------------------*/

const STATUS_LABELS: Record<ITPStatus, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  witnessed: "Witnessed",
  "signed-off": "Signed off",
};

export function statusLabel(status: ITPStatus): string {
  return STATUS_LABELS[status];
}

export type ITPStatusTone = "warning" | "info" | "success" | "neutral";

export function statusTone(status: ITPStatus): ITPStatusTone {
  switch (status) {
    case "pending":
      return "warning";
    case "in-progress":
      return "info";
    case "witnessed":
      return "info";
    case "signed-off":
      return "success";
  }
}

const POINT_TYPE_LABELS: Record<ITPPointType, string> = {
  photo: "Photo",
  value: "Value",
  signoff: "Sign-off",
  note: "Note",
};

export function pointTypeLabel(type: ITPPointType): string {
  return POINT_TYPE_LABELS[type];
}

const SCOPE_LABELS: Record<ITPScope, string> = {
  job: "Whole job",
  level: "Level",
  area: "Area",
  // "Switchboard" is the legacy electrical scope label — preserved as
  // UI copy per [32-phase-e-plan.md] §15.1 #4. Sidebar / section
  // headers must not use "Switchboard"; this is a scope value, not a
  // section name.
  switchboard: "Switchboard",
};

export function scopeLabel(scope: ITPScope): string {
  return SCOPE_LABELS[scope];
}

/**
 * Compose a human scope line: "Whole job", "Level: G", "Area: Kitchen",
 * "Switchboard: MSB-1". Consumed by the per-instance recording header
 * (E1b) so the worker sees what part of the job the ITP covers without
 * needing to drill into job structure.
 *
 * `scopeName` is the resolved display name from job.areaGroups /
 * areas / switchboards — the caller resolves it because this module
 * doesn't take a Job dependency.
 */
export function scopeContextLine(
  scope: ITPScope,
  scopeName: string | null | undefined,
): string {
  const label = SCOPE_LABELS[scope];
  if (scope === "job") return label;
  const name = scopeName == null ? "" : String(scopeName).trim();
  return name ? `${label}: ${name}` : label;
}

/* ---------------------------------------------------------------------
 * Value-point pass/fail derivation
 *
 * A `type='value'` point with `min` and/or `max` set passes when the
 * recorded numeric value falls within the range. Used by the per-point
 * card to render a pass/fail pill alongside the recorded number.
 *
 * Returns null when there's nothing to compare against — the point
 * has no pass criterion, the result is missing, or the value isn't
 * numeric.
 * -------------------------------------------------------------------*/

export type ValuePassFail = "pass" | "fail" | null;

export function valuePassFail(
  point: ITPTemplatePoint,
  result: ITPInstanceResult | undefined,
): ValuePassFail {
  if (point.type !== "value") return null;
  if (!result) return null;
  // Delegate to the ONE shared numeric rule (#517) — same bounds/numeric logic
  // ITP has always used, now unified with test records so there is no second
  // pass/fail engine to drift.
  return evaluateAgainstCriteria(result.value, point.min, point.max);
}

export function valuePassFailLabel(
  point: ITPTemplatePoint,
  result: ITPInstanceResult | undefined,
): string | null {
  const r = valuePassFail(point, result);
  if (r === "pass") return "Pass";
  if (r === "fail") return "Fail";
  return null;
}

/* ---------------------------------------------------------------------
 * Instance lifecycle predicates
 *
 * Same trio as snags + evidence so panel + queue code reads identically
 * across surfaces.
 * -------------------------------------------------------------------*/

/** Instance is still moving through the worker → admin loop. Used by
 *  the Phil panel default filter + the admin queue's "Active" tab. */
export function isActive(status: ITPStatus): boolean {
  return (
    status === "pending" ||
    status === "in-progress" ||
    status === "witnessed"
  );
}

/** Instance has reached the terminal state. Used by the admin queue's
 *  "Signed off" tab default filter. */
export function isDone(status: ITPStatus): boolean {
  return status === "signed-off";
}

/** Instance needs the worker's attention in Phil — recording is still
 *  open. Witnessed instances are no longer worker-actionable (it's
 *  admin's turn to sign off) but the worker still wants to see them
 *  on the panel until sign-off, so we include them. Same shape as
 *  snags.needsWorkerAttention. */
export function needsWorkerAttention(status: ITPStatus): boolean {
  return isActive(status);
}

/* ---------------------------------------------------------------------
 * Progress + completion percentage
 * -------------------------------------------------------------------*/

export interface ITPProgress {
  done: number;
  total: number;
  percent: number;
}

/**
 * Count required points done vs. total required. Mirrors the
 * auto-advance criterion in api/job-itps.js:82-86 — a point is "done"
 * when its result row carries an `at` timestamp; the writer always
 * stamps `at` on every record, so presence-with-`at` is the safest
 * signal even if a future writer leaves `value` empty for a note-only
 * point.
 *
 * Optional points are excluded from the denominator so the progress
 * line matches the witnessed-state criterion the server uses. If a
 * snapshot has no required points the percent is 0 (avoids div-by-0).
 *
 * #293: non-applicable conditional points are also excluded from the
 * denominator (snapshot-driven via instance.scope) so Phil's "n / m
 * points", the ITPDrawer, and qa-rollup all match what the worker
 * actually sees — and a non-applicable required point can't keep an ITP
 * below 100% forever.
 */
/**
 * #285: evidence coverage — "n of m evidence-required points photographed".
 * Null when the snapshot has no flagged points, so surfaces never render
 * "0 of 0". Photographed = the result row carries a photoUrl (the server
 * gate guarantees new records do; old pre-flag results may not — that
 * honesty is the point of showing the line).
 */
export function evidenceCoverage(
  instance: ITPInstance
): { required: number; photographed: number } | null {
  const points = instance.templateSnapshot?.points ?? [];
  const flagged = points.filter((p) => p.evidenceRequired === true);
  if (flagged.length === 0) return null;
  let photographed = 0;
  for (const p of flagged) {
    const result = instance.results?.[p.id];
    if (result && typeof result.photoUrl === "string" && result.photoUrl.trim() !== "") {
      photographed += 1;
    }
  }
  return { required: flagged.length, photographed };
}

export function formatProgress(instance: ITPInstance): ITPProgress {
  const points = instance.templateSnapshot.points || [];
  const ctx = { scope: instance.scope };
  const required = points.filter(
    (p) =>
      p.required !== false && !p.archived && isPointApplicable(p, ctx),
  );
  const results = instance.results || {};
  let done = 0;
  for (const p of required) {
    const r = results[p.id];
    if (r && r.at) done += 1;
  }
  const total = required.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done, total, percent };
}
