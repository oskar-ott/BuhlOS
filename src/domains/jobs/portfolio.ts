import type { Job } from "./types";
import { deriveJobHealth, type JobHealth } from "./job-health";

/**
 * Jobs portfolio view-model (brief §3). Pure projections over the jobs the
 * /v2/jobs page already loads (api/jobs?withStats) into the prototype's card
 * grid: a portfolio header summary + a per-card meta strip + the real risk
 * read. The prototype (docs/prototype/admin/admin-jobs.jsx) is the VISUAL
 * target only; its `risk` 0–100 score, `billed` %, `pm` and `next` are mock
 * data and are NOT reproduced here.
 *
 * Pure + deterministic so it is unit-tested in isolation; the page does the
 * (permission-gated) loading and renders this VM. No new source of truth, no
 * new fetch.
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers):
 *   - "Risk" is the EXISTING deriveJobHealth read (expired gear tags + the
 *     evidence/snags/ITP backlog), surfaced as a level + the top contributing
 *     reason — NEVER the prototype's fabricated 0–100 risk score.
 *   - "Value" is contractValue (admin-tier; redactJobForViewer strips it for an
 *     LH viewer, so an LH card reads "—" rather than a fabricated dollar figure).
 *   - The prototype's "Billed %" tile is OMITTED: there is no billed / invoiced /
 *     claimed signal on the jobs LIST read (jobs-summary.js drops every money
 *     field, and the list never carries claimedToDate), so a billed percentage
 *     cannot be derived without inventing it.
 *   - The prototype's "PM" tile is OMITTED: a job carries no project-manager
 *     field in the model, so there is nothing real to render.
 *   - "Crew" is statsCrewCount (server-computed in both the statsOnly and full
 *     reads); absent ⇒ "—", never a fabricated 0.
 *   - The "Total contract" readout sums only the values actually present and
 *     reports how many jobs are priced, so a partial/LH list never implies a
 *     whole-portfolio total it can't back up.
 */

/** "Needs attention" = the risk read is at-risk or watch (a real backlog/breach).
 *  `unknown` (no stat loaded) and `good` are NOT counted — we never imply a job
 *  needs attention on missing data, nor that an all-clear job does. */
export function jobNeedsAttention(health: JobHealth): boolean {
  return health.level === "at-risk" || health.level === "watch";
}

/** Australian dollar formatting for the contract value (whole dollars — the
 *  field is stored in dollars; no cents on a six-figure contract figure). */
export function formatContractValue(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value);
}

export interface PortfolioSummaryInput {
  jobs: ReadonlyArray<Job>;
  /** Per-job health, paired in list order (the page derives it once and reuses
   *  it for the cards + the filter pills — never recomputed here). */
  healthByIndex: ReadonlyArray<JobHealth>;
}

export interface PortfolioSummaryVM {
  /** Page sub-line, e.g. "12 jobs · 3 need attention" — or just the count when
   *  every loaded job is clear / unknown. */
  subline: string;
  jobCount: number;
  needAttentionCount: number;
  /** Pre-formatted total-contract readout for the priced subset, or null when
   *  no job in the list carries a value (LH viewer, or genuinely unpriced) so
   *  the page omits the readout rather than printing "$0". */
  totalContract: {
    /** "$2.79M" style display of the summed value. */
    value: string;
    /** Context line, e.g. "across 9 priced jobs" / "across 1 priced job". */
    hint: string;
  } | null;
}

/** Compact $-readout for a portfolio total (e.g. "$2.8M", "$940k", "$12,500").
 *  Whole-dollar AUD; abbreviates at ≥$1k so a long header stays glanceable. */
export function formatPortfolioTotal(total: number): string {
  if (total >= 1_000_000) {
    return `$${(total / 1_000_000).toFixed(total >= 10_000_000 ? 0 : 2)}M`;
  }
  if (total >= 1_000) {
    return `$${Math.round(total / 1_000)}k`;
  }
  return formatContractValue(total);
}

export function buildPortfolioSummary(input: PortfolioSummaryInput): PortfolioSummaryVM {
  const { jobs, healthByIndex } = input;

  const needAttentionCount = jobs.reduce((sum, _job, i) => {
    const health = healthByIndex[i];
    return health && jobNeedsAttention(health) ? sum + 1 : sum;
  }, 0);

  // Total contract: sum ONLY the values present (a number ≥ 0). An LH viewer's
  // redacted list has none, and a half-priced portfolio reports its own count,
  // so the readout never overstates the figure it can back up.
  let pricedCount = 0;
  let total = 0;
  for (const job of jobs) {
    if (typeof job.contractValue === "number" && Number.isFinite(job.contractValue)) {
      total += job.contractValue;
      pricedCount += 1;
    }
  }

  const subline =
    needAttentionCount > 0
      ? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} · ${needAttentionCount} ${
          needAttentionCount === 1 ? "needs" : "need"
        } attention`
      : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;

  return {
    subline,
    jobCount: jobs.length,
    needAttentionCount,
    totalContract:
      pricedCount > 0
        ? {
            value: formatPortfolioTotal(total),
            hint: `across ${pricedCount} priced ${pricedCount === 1 ? "job" : "jobs"}`,
          }
        : null,
  };
}

export interface JobCardMeta {
  /** "Value" — formatted contractValue, or "—" when redacted/unpriced. */
  value: string;
  /** True when value is a real figure (drives whether the tile is muted). */
  valueKnown: boolean;
  /** "Crew" — statsCrewCount as a string, or "—" when the stat didn't load. */
  crew: string;
  /** True when crew is a real count. */
  crewKnown: boolean;
}

/**
 * The real, honest meta strip for one portfolio card. Value + Crew only — the
 * prototype's Billed% and PM tiles are deliberately dropped (no data source).
 * A missing signal yields "—" (with the *Known flag false), never a fake 0.
 */
export function jobCardMeta(job: Job): JobCardMeta {
  const hasValue =
    typeof job.contractValue === "number" && Number.isFinite(job.contractValue);
  const hasCrew =
    typeof job.statsCrewCount === "number" && Number.isFinite(job.statsCrewCount);
  return {
    value: hasValue ? formatContractValue(job.contractValue as number) : "—",
    valueKnown: hasValue,
    crew: hasCrew ? String(job.statsCrewCount) : "—",
    crewKnown: hasCrew,
  };
}

export interface JobCardVM {
  job: Job;
  health: JobHealth;
  meta: JobCardMeta;
}

/**
 * Build the per-card VM for a job: its real meta strip + the pre-derived health
 * read. Health is passed in (the list derives it once for the cards + pills +
 * sort) so the card never re-walks the stats. Pure.
 */
export function buildJobCard(job: Job, health: JobHealth): JobCardVM {
  return { job, health, meta: jobCardMeta(job) };
}

/** Convenience for callers that have only the job (derives health here). */
export function buildJobCardFromJob(job: Job): JobCardVM {
  return buildJobCard(job, deriveJobHealth(job));
}
