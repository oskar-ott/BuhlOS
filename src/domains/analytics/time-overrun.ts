/**
 * Pure rules core for the TIME-overrun early-warning flag (#343, Epic 14).
 *
 * The signal: an active job whose hours are burning faster than the work is
 * completing — ">70% of estimated hours consumed, <50% complete" — announces a
 * labour overrun weeks before the estimate is actually breached. `cash-watch`
 * (api/cash-watch.js) only fires once the forecast $ crosses the contract $,
 * which is late, dollar-framed, and silent about the burn-vs-progress ratio.
 * This flag is DISTINCT from that: time-framed, computed from hours-consumed %
 * (vs an estimate) against the canonical completion % (src/domains/jobs/progress.ts).
 *
 * This module is the DECISION-FREE slice: a pure, framework-neutral function
 * that takes INJECTED inputs and returns a structured flag. It mirrors the
 * pure-module + injected-deps + fixture style of
 * src/domains/qa/time-entry-attribution.ts and src/domains/jobs/job-hours.ts —
 * no fetching, no Date.now(), no I/O, no React. The caller supplies the numbers;
 * this module only does the maths and the honest classification.
 *
 * NEVER fabricates numbers (Phil P7). Three honest "can't watch" states are
 * first-class, never silently skipped:
 *   - `no-estimate`  — estimatedHours is null/absent. NO job carries a labour
 *                      HOURS estimate today: the quote→job converter
 *                      (quoteToJobShape in api/quotes.js) drops the per-line
 *                      estimatedHours, and `labourEstimate` is DOLLARS, not
 *                      hours. So the flag renders "No time estimate set" until a
 *                      real hours estimate exists. It does NOT guess one.
 *   - `no-progress`  — progressPct is null (the job has no task lists, so there
 *                      is no completion signal to compare the burn against —
 *                      progress.ts returns null when total tasks === 0).
 *   - `zero-burn`    — an estimate exists but no hours are consumed yet, so
 *                      there is nothing to flag (cash-watch's "zero hours so
 *                      far → no alert" edge, mirrored here).
 *
 * Hours are JOB-LEVEL. Per-area hour estimates do not exist, so this module
 * never fabricates area hours — the caller decides how to caption that (the
 * issue AC: "hours remain job-level"). Thresholds live in ONE place
 * (OVERRUN_THRESHOLDS) and are tunable.
 *
 * Cross-ref:
 *   src/domains/jobs/progress.ts  — canonical progressPct (the completion signal)
 *   src/domains/jobs/job-hours.ts — summariseJobHours (the hoursConsumed source)
 *   api/cash-watch.js             — the sibling $-framed overrun watcher (distinct)
 */

/**
 * The one place the burn/completion thresholds live (issue AC: "tunable in one
 * module"). A flag fires when hours-consumed % is at/above `burnPctFloor` AND
 * completion % is at/below `completePctCeiling` — i.e. the job has eaten most of
 * its estimate while a lot of work remains. `criticalGapPct` escalates the
 * severity once the gap between burn and completion is wide.
 */
export const OVERRUN_THRESHOLDS = {
  /** Fire once ≥70% of the estimated hours are consumed. */
  burnPctFloor: 70,
  /** …and completion is still ≤50%. */
  completePctCeiling: 50,
  /**
   * burn − completion gap (in points) at/above which the flag is `critical`
   * rather than a `warning`. 40 = e.g. 90% burnt / 40% done.
   */
  criticalGapPct: 40,
} as const;

/**
 * Why the flag can't be computed as a live over/under-burn comparison. Each is
 * an HONEST surfaced state, never a silent skip.
 */
export type TimeOverrunState =
  /** No labour HOURS estimate on the job — "No time estimate set". */
  | "no-estimate"
  /** No task lists → no completion % to compare against. */
  | "no-progress"
  /** An estimate exists but zero hours consumed yet — nothing to flag. */
  | "zero-burn"
  /** Both inputs present and non-trivial — the comparison ran. */
  | "watched";

export type TimeOverrunSeverity = "ok" | "warning" | "critical";

export interface TimeOverrunInput {
  /**
   * The job's estimated labour HOURS. `null`/`undefined`/non-positive ⇒
   * `no-estimate` (the honest absence). Never a dollar figure — the caller
   * must convert `labourEstimate` ($) elsewhere; this module trusts hours in.
   */
  estimatedHours: number | null | undefined;
  /**
   * Hours consumed so far — the caller's status-filtered total (approved +
   * submitted; NEVER drafts/rejected — see #329 and job-hours.ts). Non-positive
   * ⇒ `zero-burn` when an estimate exists.
   */
  hoursConsumed: number | null | undefined;
  /**
   * Canonical completion %, 0–100, from src/domains/jobs/progress.ts. `null` ⇒
   * `no-progress` (no task lists). This module never recomputes it — it is
   * injected so the office and the field can never disagree.
   */
  progressPct: number | null | undefined;
}

export interface TimeOverrunFlag {
  state: TimeOverrunState;
  severity: TimeOverrunSeverity;
  /** True only when severity is `warning`/`critical` — the surfaceable signal. */
  flagged: boolean;
  /**
   * hours-consumed as a % of the estimate (rounded), or `null` when there is no
   * estimate to divide by. Can exceed 100 (already over the estimate).
   */
  burnPct: number | null;
  /** Injected completion % echoed back (0–100), or `null` (no task lists). */
  completePct: number | null;
  /**
   * burnPct − completePct, the "how far ahead is spend of progress" gap, or
   * `null` when either side is missing. Positive = burning ahead of progress.
   */
  gapPct: number | null;
  /** Echoed inputs (rounded), so the caller can render the exact math. */
  estimatedHours: number | null;
  hoursConsumed: number;
  /** A plain, honest caption — the "why" the caller can show verbatim. */
  reason: string;
}

/** A finite, non-negative number, or null (absent/NaN/negative → null). */
function nonNegOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A finite 0–100 %, or null. Clamps nothing above 100 away — burn can exceed. */
function pctOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Classify a job's time-overrun risk from injected inputs. Pure: same inputs →
 * same flag, always. The three honest no-data states come FIRST — an absent
 * estimate is `no-estimate`, never a guessed number; an absent progress signal
 * is `no-progress`; a present estimate with zero burn is `zero-burn`.
 *
 * Only when BOTH an estimate (>0) and some burn (>0) and a completion % exist
 * does the module compare burn% against completion% and (maybe) fire.
 */
export function classifyTimeOverrun(input: TimeOverrunInput): TimeOverrunFlag {
  const estimate = nonNegOrNull(input.estimatedHours);
  const consumedRaw = nonNegOrNull(input.hoursConsumed);
  const consumed = consumedRaw != null && consumedRaw > 0 ? round1(consumedRaw) : 0;
  const completePct = pctOrNull(input.progressPct);

  // 1) No labour-hours estimate → we literally cannot watch time. Surface it.
  if (estimate == null || estimate <= 0) {
    return {
      state: "no-estimate",
      severity: "ok",
      flagged: false,
      burnPct: null,
      completePct,
      gapPct: null,
      estimatedHours: null,
      hoursConsumed: consumed,
      reason: "No time estimate set — can't watch labour burn until an estimate exists.",
    };
  }

  const burnPct = round1((consumed / estimate) * 100);

  // 2) Estimate exists but nothing burnt yet → nothing to flag (zero-burn edge).
  if (consumed <= 0) {
    return {
      state: "zero-burn",
      severity: "ok",
      flagged: false,
      burnPct: 0,
      completePct,
      gapPct: null,
      estimatedHours: round1(estimate),
      hoursConsumed: 0,
      reason: `0 of ${round1(estimate)} estimated hours used — nothing to flag yet.`,
    };
  }

  // 3) No task lists → no completion signal to compare the burn against.
  if (completePct == null) {
    return {
      state: "no-progress",
      severity: "ok",
      flagged: false,
      burnPct,
      completePct: null,
      gapPct: null,
      estimatedHours: round1(estimate),
      hoursConsumed: consumed,
      reason: `${consumed} of ${round1(estimate)} estimated hours used (${burnPct}%) — can't compare to progress, no tasks set up.`,
    };
  }

  // 4) Both sides present → run the comparison.
  const gapPct = round1(burnPct - completePct);
  const fires =
    burnPct >= OVERRUN_THRESHOLDS.burnPctFloor &&
    completePct <= OVERRUN_THRESHOLDS.completePctCeiling;
  const severity: TimeOverrunSeverity = !fires
    ? "ok"
    : gapPct >= OVERRUN_THRESHOLDS.criticalGapPct
      ? "critical"
      : "warning";

  const math = `${consumed} of ${round1(estimate)} estimated hours used (${burnPct}%), ${completePct}% complete`;
  const reason = fires ? `Hours outpacing progress — ${math}.` : `On track — ${math}.`;

  return {
    state: "watched",
    severity,
    flagged: fires,
    burnPct,
    completePct,
    gapPct,
    estimatedHours: round1(estimate),
    hoursConsumed: consumed,
    reason,
  };
}

/**
 * A tiny, presentation-neutral view model for a read surface — the label to
 * show, the tone bucket, and whether to render at all. Kept in the pure module
 * so the component carries no rules. The `no-estimate` state is ALWAYS worth
 * showing (the issue AC: "the absence is itself surfaced, never skipped");
 * `zero-burn` is not (nothing to say yet).
 */
export interface TimeOverrunView {
  /** Whether the surface should render anything at all. */
  show: boolean;
  tone: TimeOverrunSeverity | "muted";
  /** Short heading, e.g. "Hours outpacing progress" / "No time estimate set". */
  headline: string;
  /** The math / "why", verbatim from the flag. */
  detail: string;
}

const HEADLINE: Record<TimeOverrunState, string> = {
  "no-estimate": "No time estimate set",
  "no-progress": "No progress to compare",
  "zero-burn": "No hours logged yet",
  watched: "On track",
};

/**
 * The card renders `headline — detail`; a reason that opens with the headline
 * ("No time estimate set — can't watch…") would read twice (2026-08-23 audit).
 * Strip the repeated opener and re-capitalise; an unrelated reason passes through.
 */
function withoutHeadline(headline: string, reason: string): string {
  if (!reason.toLowerCase().startsWith(headline.toLowerCase())) return reason;
  const rest = reason.slice(headline.length).replace(/^\s*[—–-]\s*/, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : reason;
}

export function timeOverrunView(flag: TimeOverrunFlag): TimeOverrunView {
  if (flag.flagged) {
    return {
      show: true,
      tone: flag.severity,
      headline: "Hours outpacing progress",
      detail: flag.reason,
    };
  }
  if (flag.state === "no-estimate") {
    return {
      show: true,
      tone: "muted",
      headline: HEADLINE["no-estimate"],
      detail: withoutHeadline(HEADLINE["no-estimate"], flag.reason),
    };
  }
  if (flag.state === "no-progress") {
    return {
      show: true,
      tone: "muted",
      headline: HEADLINE["no-progress"],
      detail: withoutHeadline(HEADLINE["no-progress"], flag.reason),
    };
  }
  // zero-burn and on-track "watched" are quiet — nothing actionable to surface.
  return { show: false, tone: "muted", headline: HEADLINE[flag.state], detail: flag.reason };
}
