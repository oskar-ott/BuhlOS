import { z } from "zod";

/**
 * owner-numbers — THE definitions of the six numbers the owner checks
 * daily on /reports (#316).
 *
 * This module is the SEED of #329 (the KPI engine — one definition per
 * number). Until the engine lands, each exported builder below IS the
 * single place a number is defined: endpoint payload(s) in →
 * `OwnerNumberTile` out. The /reports page renders ONLY what this module
 * returns — no metric math in components, no client-side re-derivation.
 * When #329 generalises this into the engine, the tiles re-point at it
 * and the page stays unchanged.
 *
 * Consolidation, not invention (#316 charter): every value here is a
 * field the source endpoint already returns, or a sum/count over the
 * rows it returns. No new business definitions:
 *   - tile 1 adds the two returned weekly totals (submitted + approved)
 *     and subtracts last week's same sum — arithmetic over returned
 *     numbers, rendered with compare-weeks' own "old week = 0 → 'new
 *     this week'" honesty convention (its pct: null contract).
 *   - tile 4's stale thresholds are api/admin-stats.js's existing
 *     STALE_THRESHOLDS (High 3 / Medium 7 / Low 14 days) mapped through
 *     api/snags-all.js's own legacy→v2 priority mapping (High→high,
 *     Medium→normal, Low→low). `urgent` outranks `high` in the register's
 *     PRIORITY_RANK, so it shares the high tier's 3 days rather than
 *     getting a looser (or invented) threshold.
 *   - tile 6 reads the PERSISTED `job.cashWatch` state written by the
 *     daily cash-watch cron — never a per-load dryRun recompute (the
 *     dryRun walks every user blob in the request path). `lastAlertedAt`
 *     is surfaced as the tile's asOf, per the #316 enrichment.
 *
 * Sources (one per number — the #329 law, pre-engine form):
 *   hours_week         GET /api/compare-weeks
 *   approvals_waiting  GET /api/time-entries?scope=approver&status=submitted
 *                      (the SAME source the command-centre queue card and
 *                      Today strip count — the two surfaces cannot disagree)
 *   crew_on_clock      GET /api/today-pulse  (field name is `crewOnSite`;
 *                      the LABEL is "on the clock" — hours are evidence of
 *                      logging, not of being on site)
 *   defects_attention  GET /api/snags-all?status=open
 *   quotes_pipeline    GET /api/quote-stats
 *   over_contract      GET /api/jobs  (persisted job.cashWatch + contractValue)
 *
 * States map to the doc 27 §6.1 tone palette: ok → neutral (no accent),
 * warning → --state-warning, error → --state-danger, missing → neutral
 * with an honest explainer (never a zero presented as fact).
 */

// ── Tile model ─────────────────────────────────────────────────────────

export const OWNER_NUMBER_IDS = [
  "hours_week",
  "approvals_waiting",
  "crew_on_clock",
  "defects_attention",
  "quotes_pipeline",
  "over_contract",
] as const;

export type OwnerNumberId = (typeof OWNER_NUMBER_IDS)[number];

export type OwnerNumberState = "ok" | "warning" | "missing" | "error";

export interface OwnerNumberTrend {
  direction: "up" | "down" | "flat";
  label: string;
}

export interface OwnerNumberTile {
  id: OwnerNumberId;
  label: string;
  /** Formatted headline value. Null when state is missing/error — the
   *  explainer speaks instead (no fake zeros). */
  value: string | null;
  /** Week-over-week (or contextual) direction, only where the source
   *  provides the comparison. */
  trend: OwnerNumberTrend | null;
  state: OwnerNumberState;
  /** Where the underlying records live. Null = no surface exists yet —
   *  render no link rather than a dead end (quotes have no v2 UI). */
  drillHref: string | null;
  drillLabel: string | null;
  /** Secondary line under the value (composition, last week, etc.). */
  detail: string | null;
  /** Honest explainer for missing/partial data — rendered verbatim. */
  honestNote: string | null;
  /** Freshness label when the data is NOT live (e.g. cash-watch cron). */
  asOf: string | null;
}

/** Static identity of each number: label + canonical drill-down.
 *  drillHref null = verified no surface exists (quotes). */
export const OWNER_NUMBER_DEFINITIONS: Record<
  OwnerNumberId,
  { label: string; source: string; drillHref: string | null; drillLabel: string | null }
> = {
  hours_week: {
    label: "Hours this week",
    source: "/api/compare-weeks",
    drillHref: "/hours",
    drillLabel: "Open hours",
  },
  approvals_waiting: {
    label: "Approvals waiting",
    source: "/api/time-entries?scope=approver&status=submitted",
    drillHref: "/hours/approvals",
    drillLabel: "Review approvals",
  },
  crew_on_clock: {
    // Honest label: time entries prove hours were logged, not presence on
    // a site. Never "on site".
    label: "On the clock today",
    source: "/api/today-pulse",
    drillHref: "/hours",
    drillLabel: "Open today's hours",
  },
  defects_attention: {
    label: "Open defects — high-priority or stale",
    source: "/api/snags-all?status=open",
    drillHref: "/defects?status=open",
    drillLabel: "Open defects register",
  },
  quotes_pipeline: {
    label: "Active quotes",
    source: "/api/quote-stats",
    // Verified 2026-06-12: no quoting surface exists in the v2 shell
    // (legacy /admin/quotes 307s to /command-centre). No link beats a
    // dead end; re-point when a quoting surface ships.
    drillHref: null,
    drillLabel: null,
  },
  over_contract: {
    label: "Jobs forecast over contract",
    source: "/api/jobs (persisted job.cashWatch)",
    drillHref: "/v2/jobs",
    drillLabel: "Open jobs",
  },
};

// ── Shared formatting ──────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatHours(n: number): string {
  return `${round1(n)} h`;
}

/** Mirrors api/cash-watch.js fmt$ — en-AU, whole dollars. */
export function formatMoney(n: number): string {
  return "$" + Number(n || 0).toLocaleString("en-AU", { maximumFractionDigits: 0 });
}

// ── Source payload schemas (wire shapes, declared minimally) ───────────
// Only fields this module consumes are typed; everything else passes
// through so the endpoints can grow without breaking the dashboard.

export const CompareWeeksWeekSchema = z
  .object({
    weekStart: z.string(),
    weekEnd: z.string(),
    hours: z
      .object({
        submittedTotal: z.number(),
        approvedTotal: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export const CompareWeeksResponseSchema = z
  .object({
    thisWeek: CompareWeeksWeekSchema,
    lastWeek: CompareWeeksWeekSchema,
  })
  .passthrough();

export type CompareWeeksResponse = z.infer<typeof CompareWeeksResponseSchema>;

export const QuoteStatsResponseSchema = z
  .object({
    asOf: z.string().optional(),
    total: z.number(),
    active: z.number(),
    /** Per-stage stale counts keyed by the endpoint's own stage names. */
    stale: z.record(z.number()),
  })
  .passthrough();

export type QuoteStatsResponse = z.infer<typeof QuoteStatsResponseSchema>;

/** The slice of a /api/jobs row this module reads. cashWatch is the
 *  persisted last-alerted overrun state the daily cron writes. */
export const CashWatchJobSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    contractValue: z.unknown().optional(),
    cashWatch: z
      .object({
        lastAlertedAt: z.string().optional(),
        forecastEnd: z.number().nullable().optional(),
        contractValue: z.number().optional(),
        spent: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const OwnerJobsResponseSchema = z.object({
  jobs: z.array(CashWatchJobSchema),
});

export type CashWatchJob = z.infer<typeof CashWatchJobSchema>;

/** Structural slice of a normalised register snag (api/snags-all row /
 *  src/domains/snags/register.ts RegisterSnag). */
export interface RegisterSnagLike {
  status: string;
  priority: string;
  createdAt: string;
}

/** Structural slice of the today-pulse response this module reads. */
export interface TodayPulseLike {
  date: string;
  hours: {
    submittedTotal: number;
    approvedTotal: number;
    crewOnSite: number;
  };
}

// ── Tile 1 · Hours this week vs last ───────────────────────────────────

/**
 * Value = thisWeek submitted + approved hour totals (both returned by
 * compare-weeks); trend = the same sum for last week, subtracted. The
 * endpoint's deltas object diffs the two series separately — the combined
 * series is a sum of returned numbers, so the delta is recomputed from the
 * same totals rather than inventing a combined pct. Honesty conventions:
 *   - last week 0, this week > 0 → "New this week" (the endpoint's
 *     pct: null contract — never ∞ or a fake %).
 *   - todayISO inside the week → "Week in progress" note so a Monday
 *     morning never reads as a collapse.
 */
export function hoursThisWeekTile(
  payload: CompareWeeksResponse,
  todayISO: string,
): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.hours_week;
  const thisTotal = round1(
    payload.thisWeek.hours.submittedTotal + payload.thisWeek.hours.approvedTotal,
  );
  const lastTotal = round1(
    payload.lastWeek.hours.submittedTotal + payload.lastWeek.hours.approvedTotal,
  );

  let trend: OwnerNumberTrend;
  if (lastTotal === 0 && thisTotal > 0) {
    trend = { direction: "up", label: "New this week — no hours last week" };
  } else {
    const delta = round1(thisTotal - lastTotal);
    if (delta > 0) trend = { direction: "up", label: `+${delta} h vs last week` };
    else if (delta < 0) trend = { direction: "down", label: `${delta} h vs last week` };
    else trend = { direction: "flat", label: "Level with last week" };
  }

  const weekInProgress = todayISO >= payload.thisWeek.weekStart && todayISO <= payload.thisWeek.weekEnd;

  return {
    id: "hours_week",
    label: def.label,
    value: formatHours(thisTotal),
    trend,
    state: "ok",
    drillHref: def.drillHref,
    drillLabel: def.drillLabel,
    detail: `Submitted + approved · last week ${formatHours(lastTotal)}`,
    honestNote: weekInProgress
      ? "Week in progress — compared with last week's full total."
      : null,
    asOf: null,
  };
}

// ── Tile 2 · Approvals waiting ─────────────────────────────────────────

/**
 * Count of submitted timesheets in the approver queue — the SAME endpoint
 * + filter the command-centre Hours card and Today strip count, so the
 * two surfaces can never disagree (#185 boundary law: shared numbers
 * share a source). A non-empty queue is doc 27 "needs action" → warning.
 */
export function approvalsWaitingTile(payload: {
  entries: ReadonlyArray<unknown>;
}): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.approvals_waiting;
  const count = payload.entries.length;
  return {
    id: "approvals_waiting",
    label: def.label,
    value: String(count),
    trend: null,
    state: count > 0 ? "warning" : "ok",
    drillHref: def.drillHref,
    drillLabel: def.drillLabel,
    detail:
      count === 0
        ? "No timesheets waiting for you."
        : count === 1
          ? "1 submitted timesheet to review."
          : `${count} submitted timesheets to review.`,
    honestNote: null,
    asOf: null,
  };
}

// ── Tile 3 · Crew on the clock today ───────────────────────────────────

/**
 * today-pulse's `hours.crewOnSite` = distinct users with >0 logged hours
 * on the day. The label says "on the clock": a time entry proves logging,
 * not site presence. A zero is a fact (nobody has logged yet), so it
 * renders as 0 with a note — not as a missing state.
 */
export function crewOnClockTile(payload: TodayPulseLike): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.crew_on_clock;
  const crew = payload.hours.crewOnSite;
  const logged = round1(payload.hours.submittedTotal + payload.hours.approvedTotal);
  return {
    id: "crew_on_clock",
    label: def.label,
    value: String(crew),
    trend: null,
    state: "ok",
    drillHref: def.drillHref,
    drillLabel: def.drillLabel,
    detail:
      crew === 0
        ? null
        : `${formatHours(logged)} submitted or approved for ${payload.date}.`,
    honestNote: crew === 0 ? "No hours logged for today yet." : null,
    asOf: null,
  };
}

// ── Tile 4 · Open defects: high-priority or stale ──────────────────────

/**
 * Stale thresholds (calendar days since createdAt) — api/admin-stats.js
 * STALE_THRESHOLDS mapped through api/snags-all.js's legacy→v2 priority
 * mapping; urgent shares high's tier (see module docstring).
 */
export const DEFECT_STALE_DAYS: Record<string, number> = {
  urgent: 3,
  high: 3,
  normal: 7,
  low: 14,
};

function isHighPriority(s: RegisterSnagLike): boolean {
  return s.priority === "urgent" || s.priority === "high";
}

function isStale(s: RegisterSnagLike, nowMs: number): boolean {
  const threshold = DEFECT_STALE_DAYS[s.priority] ?? DEFECT_STALE_DAYS.normal!;
  const created = Date.parse(s.createdAt);
  if (!Number.isFinite(created)) return false; // can't prove age → not stale
  return (nowMs - created) / DAY_MS >= threshold;
}

/**
 * Input rows = /api/snags-all?status=open (the register's normalised
 * two-store rows, open status only — matching the ?status=open drill so
 * the listed records are the counted population). Value = the UNION of
 * high-priority (urgent|high) and stale rows; the detail line shows the
 * two components, which may overlap.
 */
export function defectsAttentionTile(
  payload: { snags: ReadonlyArray<RegisterSnagLike> },
  nowMs: number,
): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.defects_attention;
  const open = payload.snags.filter((s) => s.status === "open");
  const high = open.filter(isHighPriority);
  const stale = open.filter((s) => isStale(s, nowMs));
  const union = open.filter((s) => isHighPriority(s) || isStale(s, nowMs));

  const detail =
    open.length === 0
      ? null
      : union.length === 0
        ? `${open.length} open in total — none high-priority or stale.`
        : `${high.length} high-priority · ${stale.length} stale · ${open.length} open in total.`;

  return {
    id: "defects_attention",
    label: def.label,
    value: String(union.length),
    trend: null,
    state: union.length > 0 ? "warning" : "ok",
    drillHref: def.drillHref,
    drillLabel: def.drillLabel,
    detail,
    honestNote: open.length === 0 ? "No open defects." : null,
    asOf: null,
  };
}

// ── Tile 5 · Active quotes + stale ─────────────────────────────────────

/**
 * quote-stats' own vocabulary: `active` = non-terminal statuses, `stale`
 * = per-stage counts over its documented day thresholds. The stale
 * headline is the sum of the returned per-stage counts. An EMPTY register
 * is rendered as missing (quoting hasn't moved into BuhlOS), not as a
 * confident "0 active". No drill link — verified there is no quoting
 * surface in the v2 shell yet; a dead link is worse than none.
 */
export function quotePipelineTile(payload: QuoteStatsResponse): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.quotes_pipeline;

  if (payload.total === 0) {
    return {
      id: "quotes_pipeline",
      label: def.label,
      value: null,
      trend: null,
      state: "missing",
      drillHref: null,
      drillLabel: null,
      detail: null,
      honestNote: "No quotes in the register yet.",
      asOf: null,
    };
  }

  const staleTotal = Object.values(payload.stale).reduce((sum, n) => sum + n, 0);
  return {
    id: "quotes_pipeline",
    label: def.label,
    value: String(payload.active),
    trend: null,
    state: staleTotal > 0 ? "warning" : "ok",
    drillHref: null,
    drillLabel: null,
    detail: `${staleTotal} stale by the register's stage thresholds · ${payload.total} total.`,
    honestNote: "No quoting surface to open yet — numbers from the quotes register.",
    asOf: null,
  };
}

// ── Tile 6 · Jobs forecast over contract ───────────────────────────────

/**
 * Reads the PERSISTED `job.cashWatch` (written by the daily cash-watch
 * cron when a forecast first crosses its contractValue) off the active
 * jobs list — never the per-load dryRun recompute. Honesty rules:
 *   - no contractValue on ANY active job → "missing": there is nothing
 *     to compare, so the tile says so ("No contract values set"), never
 *     "$0 at risk".
 *   - zero alerts with contracts set → 0, with an asOf naming the cron
 *     (the absence of alerts is only as fresh as the last run).
 *   - exactly one alerted job → drill straight to that job's hub.
 */
export function overContractTile(payload: {
  jobs: ReadonlyArray<CashWatchJob>;
}): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS.over_contract;
  // Same active-status convention as api/cash-watch.js: missing status
  // defaults to 'active'.
  const active = payload.jobs.filter((j) => (j.status ?? "active") === "active");
  const withContract = active.filter((j) => (Number(j.contractValue) || 0) > 0);

  if (withContract.length === 0) {
    return {
      id: "over_contract",
      label: def.label,
      value: null,
      trend: null,
      state: "missing",
      drillHref: def.drillHref,
      drillLabel: def.drillLabel,
      detail: null,
      honestNote:
        "No contract values set on active jobs — there is nothing to compare forecasts against.",
      asOf: null,
    };
  }

  const alerted = active.filter((j) => j.cashWatch != null);
  const latestAlertAt = alerted
    .map((j) => j.cashWatch?.lastAlertedAt ?? "")
    .filter(Boolean)
    .sort()
    .pop();
  const asOf = latestAlertAt
    ? `Daily cash-watch · last alert ${latestAlertAt.slice(0, 10)}`
    : "Updated by the daily cash-watch run.";

  if (alerted.length === 0) {
    return {
      id: "over_contract",
      label: def.label,
      value: "0",
      trend: null,
      state: "ok",
      drillHref: def.drillHref,
      drillLabel: def.drillLabel,
      detail: `No overrun alerts on record · contract values on ${withContract.length} of ${active.length} active jobs.`,
      honestNote: null,
      asOf,
    };
  }

  const single = alerted.length === 1 ? alerted[0] : undefined;
  const singleDetail = single
    ? `${single.name || single.id} — forecast ${formatMoney(
        single.cashWatch?.forecastEnd ?? single.cashWatch?.spent ?? 0,
      )} vs ${formatMoney(single.cashWatch?.contractValue ?? 0)} contract.`
    : `${alerted.length} jobs with a persisted overrun alert.`;

  return {
    id: "over_contract",
    label: def.label,
    value: String(alerted.length),
    trend: null,
    state: "warning",
    drillHref: single ? `/v2/jobs/${single.id}` : def.drillHref,
    drillLabel: single ? "Open job" : def.drillLabel,
    detail: singleDetail,
    honestNote: null,
    asOf,
  };
}

// ── Per-source degradation ─────────────────────────────────────────────

/**
 * The explicit error tile for a failed source — the other five tiles
 * still paint (the command-centre loadSnapshot pattern). The drill link
 * is kept where one exists: the records surface usually still works even
 * when this page's fetch of the stats endpoint failed.
 */
export function sourceErrorTile(id: OwnerNumberId, message: string): OwnerNumberTile {
  const def = OWNER_NUMBER_DEFINITIONS[id];
  return {
    id,
    label: def.label,
    value: null,
    trend: null,
    state: "error",
    drillHref: def.drillHref,
    drillLabel: def.drillLabel,
    detail: null,
    honestNote: `Couldn't load this number — ${message}.`,
    asOf: null,
  };
}
