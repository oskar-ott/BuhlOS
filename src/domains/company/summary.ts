import type { QuoteStatus, QuoteSummary } from "@/domains/quoting/schema";
import { formatMoney } from "@/domains/quoting/totals";
import type { QaDashboard } from "@/domains/itp/qa-rollup";
import type { ITPTemplateSummary } from "@/domains/itp/types";

/**
 * Company surface stat-tile view-models (brief §8). Pure projections over the
 * data the Quotes (/v2/quotes), QA status (/qa) and ITP templates
 * (/itp-templates) pages ALREADY load, into a glanceable four-tile header row —
 * the §7 Resources redesign pattern (src/domains/resources/summary.ts), so all
 * the Company surfaces lead with the same chrome.
 *
 * Pure + deterministic so each builder is unit-tested in isolation; the pages do
 * the (admin-gated) loading and render these tiles via <CompanyStatStrip />. No
 * new source of truth, no new fetch — every number is derived from rows the page
 * already has in hand (the quote register summaries, the server-derived QA
 * dashboard totals, the template library summaries).
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers):
 *   - QUOTES: the "Live pipeline" value sums `totalIncGst` over ACTIVE quotes
 *     only (draft + submitted) — won/lost/archived are terminal, not pipeline.
 *     `totalIncGst` is the SELL total and only ever shown here, on an admin-gated
 *     page; per-line cost/margin is never in `QuoteSummary` so it cannot leak.
 *     We do NOT fabricate a margin or win-rate tile — `QuoteSummary` carries no
 *     cost, and a win rate needs decided-quote history this list doesn't hold.
 *   - QA: a `witnessed` ITP is recorded but NOT independently signed off, so it
 *     is NEVER counted as "done". "Signed off" is the only completion tile;
 *     "Awaiting sign-off" is its own (warning) tile so the gap is visible.
 *   - ITP TEMPLATES: only library-derivable aggregates (live count, checks across
 *     live templates, archived count). Usage-per-template / jobs-using-a-template
 *     is NOT in `ITPTemplateSummary`, so no "most used" tile is invented.
 *   - When a derivation has no real input the tile reads "—", never a fake 0.
 */

export type StatTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatTile {
  key: string;
  label: string;
  /** Pre-formatted display value, or "—" when the signal isn't available. */
  value: string;
  /** Sub-label under the value (context), e.g. "draft + submitted". */
  hint: string;
  /** Colour accent for the value; "neutral" is the calm default. */
  tone: StatTone;
}

export interface CompanySummaryVM {
  /** Page sub-line, e.g. "14 quotes · 5 live". */
  subline: string;
  tiles: ReadonlyArray<StatTile>;
}

// ── Quotes ────────────────────────────────────────────────────────────────

/** Quotes that are still in play (not won/lost/archived). */
const ACTIVE_QUOTE_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  "draft",
  "submitted",
]);

/**
 * Quotes header (brief §8 — /v2/quotes). Counts come straight off the register
 * summaries the list already renders; the pipeline value sums the SELL total of
 * the live quotes only. A won quote is what feeds the Job Builder's scope intake
 * (`fromQuoteId`), so "Won" is its own tile.
 */
export function buildQuotesSummary(
  quotes: ReadonlyArray<QuoteSummary>,
): CompanySummaryVM {
  const live = quotes.filter((q) => ACTIVE_QUOTE_STATUSES.has(q.status));
  const submitted = quotes.filter((q) => q.status === "submitted").length;
  const won = quotes.filter((q) => q.status === "won").length;

  // Sell-side total of the live pipeline only. Admin-gated page; cost/margin is
  // never present in the summary, so nothing private leaks.
  const pipelineValue = live.reduce(
    (sum, q) => sum + (Number.isFinite(q.totalIncGst) ? q.totalIncGst : 0),
    0,
  );

  const tiles: StatTile[] = [
    {
      key: "live",
      label: "Live quotes",
      value: String(live.length),
      hint: "draft + submitted",
      tone: "neutral",
    },
    {
      key: "pipeline",
      label: "Live pipeline",
      // No live quotes → no pipeline to total; "—" beats a misleading $0.00.
      value: live.length > 0 ? formatMoney(pipelineValue) : "—",
      hint: "sell inc GST",
      tone: "neutral",
    },
    {
      key: "submitted",
      label: "With the client",
      value: String(submitted),
      hint: submitted > 0 ? "awaiting a reply" : "none out",
      tone: submitted > 0 ? "info" : "neutral",
    },
    {
      key: "won",
      label: "Won",
      value: String(won),
      hint: won > 0 ? "ready to build" : "none yet",
      tone: won > 0 ? "success" : "neutral",
    },
  ];

  const subline = `${quotes.length} ${
    quotes.length === 1 ? "quote" : "quotes"
  } · ${live.length} live`;

  return { subline, tiles };
}

// ── QA status ──────────────────────────────────────────────────────────────

/**
 * QA header (brief §8 — /qa). Every number is read straight off the
 * server-derived `QaDashboard` (its `totals` + `oldestActiveAgeDays`); nothing is
 * recomputed here, so the strip and the board's table can never disagree.
 *
 * "ITP completion without independent review is not done": `signed-off` is the
 * only completion tile; `awaitingSignOff` (witnessed-but-unreviewed) is surfaced
 * as a warning so it reads as an open obligation, not progress.
 */
export function buildQaSummary(dashboard: QaDashboard): CompanySummaryVM {
  const { totals, oldestActiveAgeDays } = dashboard;

  // Jobs with no ITPs attached at all — a real coverage gap, not all-clear.
  const noItps = totals.jobs - totals.jobsWithItps;

  const tiles: StatTile[] = [
    {
      key: "active",
      label: "Active checks",
      value: String(totals.activeInstances),
      hint: "in progress across jobs",
      tone: "neutral",
    },
    {
      key: "awaiting",
      label: "Awaiting sign-off",
      value: String(totals.awaitingSignOff),
      hint: totals.awaitingSignOff > 0 ? "recorded, not reviewed" : "none pending",
      tone: totals.awaitingSignOff > 0 ? "warning" : "neutral",
    },
    {
      key: "openpoints",
      label: "Open points",
      value: String(totals.openPoints),
      hint: totals.openPoints > 0 ? "not yet recorded" : "all recorded",
      tone: totals.openPoints > 0 ? "warning" : "neutral",
    },
    {
      key: "oldest",
      label: "Oldest active",
      // Oldest unwitnessed check, in whole days; null = nothing active.
      value: oldestActiveAgeDays === null ? "—" : `${oldestActiveAgeDays}d`,
      hint:
        noItps > 0
          ? `${noItps} job${noItps === 1 ? "" : "s"} with no ITPs`
          : oldestActiveAgeDays === null
            ? "nothing in flight"
            : "chase the oldest first",
      tone:
        oldestActiveAgeDays !== null && oldestActiveAgeDays >= 14
          ? "danger"
          : oldestActiveAgeDays !== null && oldestActiveAgeDays >= 7
            ? "warning"
            : "neutral",
    },
  ];

  const subline = `${totals.jobs} active ${
    totals.jobs === 1 ? "job" : "jobs"
  } · ${totals.jobsWithItps} with ITPs`;

  return { subline, tiles };
}

// ── ITP templates ──────────────────────────────────────────────────────────

/**
 * ITP template library header (brief §8 — /itp-templates). The page loads the
 * library with `includeArchived=1`, so the live/archived split and the total
 * check count are all derivable from the summaries in hand. Usage-per-template
 * is NOT in `ITPTemplateSummary`, so no "most used" tile is invented.
 */
export function buildItpTemplatesSummary(
  templates: ReadonlyArray<ITPTemplateSummary>,
): CompanySummaryVM {
  const live = templates.filter((t) => t.archived !== true);
  const archived = templates.filter((t) => t.archived === true);

  const liveChecks = live.reduce((sum, t) => sum + (t.points?.length ?? 0), 0);
  // Live templates carrying no checks are a real authoring gap worth surfacing.
  const emptyLive = live.filter((t) => (t.points?.length ?? 0) === 0).length;

  const tiles: StatTile[] = [
    {
      key: "live",
      label: "Live templates",
      value: String(live.length),
      hint: "the builder can draw from",
      tone: "neutral",
    },
    {
      key: "checks",
      label: "Checks in library",
      value: live.length > 0 ? String(liveChecks) : "—",
      hint: "across live templates",
      tone: "neutral",
    },
    {
      key: "empty",
      label: "Templates with no checks",
      value: String(emptyLive),
      hint: emptyLive > 0 ? "nothing to verify yet" : "all have checks",
      tone: emptyLive > 0 ? "warning" : "neutral",
    },
    {
      key: "archived",
      label: "Archived",
      value: String(archived.length),
      hint: archived.length > 0 ? "kept out of the builder" : "none archived",
      tone: "neutral",
    },
  ];

  const subline = `${live.length} live · ${archived.length} archived`;

  return { subline, tiles };
}
