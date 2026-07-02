import { lineTotal } from "../quoting/totals";
import { computeLineValues, previousPositionFor } from "./math";
import type { ProgressClaim, ProgressClaimLine } from "./types";

/**
 * Claim-line seeding (#372 AC1): lines come from the job's PRICED SOURCE —
 * the linked quote's sections/lines (which is where imported BOQ workbook
 * lines land after #365/#828 materialises them) — or, where no priced quote
 * is linked, from the compiled work packages (#367). A job with neither
 * starts blank and the office adds manual lines.
 *
 * Money grounding: a quote-seeded line's contract value is the quoting
 * domain's OWN footing rule (`lineTotal` = qty × rate rounded to cents),
 * converted once to integer cents — the claim always foots against the
 * printed quote. Package-seeded lines are UNPRICED (null, flagged) until the
 * office enters a contract value; nothing is ever invented (P7).
 *
 * `previously claimed` is derived per sourceKey from the prior non-draft
 * claims (math.previousPositionFor). Manual lines from the latest prior claim
 * are carried forward so scope the office added by hand keeps its cumulative
 * chain.
 */

// Minimal structural shapes — the store validates the real docs; the seeder
// only needs these fields (keeps this module pure + fixture-friendly).

export interface SeedQuoteLine {
  id: string;
  description: string;
  qty: number;
  rate: number;
}

export interface SeedQuoteSection {
  id: string;
  title?: string | null;
  lines: ReadonlyArray<SeedQuoteLine>;
}

export interface SeedQuote {
  id: string;
  sections: ReadonlyArray<SeedQuoteSection>;
}

export interface SeedWorkPackage {
  id: string;
  title: string;
  boqLineRefs?: ReadonlyArray<{ quoteId: string; sectionId: string; lineId: string }>;
}

export const boqSourceKey = (quoteId: string, sectionId: string, lineId: string): string =>
  `boq:${quoteId}/${sectionId}/${lineId}`;
export const packageSourceKey = (workPackageId: string): string => `wp:${workPackageId}`;
export const manualSourceKey = (lineId: string): string => `manual:${lineId}`;

/** Quote-line dollars → integer cents via the quoting footing rule. */
export function quoteLineValueCents(line: { qty: number; rate: number }): number {
  return Math.round(lineTotal(line) * 100);
}

interface SeedDeps {
  mintLineId: () => string;
  priorClaims: ReadonlyArray<ProgressClaim>;
}

interface SeedLineBase {
  sourceKey: string;
  lineRef: string;
  sectionLabel: string | null;
  description: string;
  boqLineRef: { quoteId: string; sectionId: string; lineId: string } | null;
  workPackageId: string | null;
  contractValueCents: number | null;
  contractValueSource: "quote_line" | "manual";
  order: number;
}

function buildLine(deps: SeedDeps, base: SeedLineBase): ProgressClaimLine {
  const prev = previousPositionFor(base.sourceKey, deps.priorClaims);
  const line: ProgressClaimLine = {
    ...base,
    id: deps.mintLineId(),
    previousPctBp: prev.pctBp,
    previousValueCents: prev.valueCents,
    thisPctBp: 0,
    overClaimOverride: false,
    evidenceRefs: [],
    toDatePctBp: 0,
    toDateValueCents: null,
    thisValueCents: null,
  };
  return { ...line, ...computeLineValues(line) };
}

/**
 * Seed from the linked quote: one claim line per priced quote line, grouped by
 * section, `lineRef` = "section.line" position for Payapps keying. Work-package
 * links resolve via the packages' boqLineRefs.
 */
export function seedLinesFromQuote(
  quote: SeedQuote,
  workPackages: ReadonlyArray<SeedWorkPackage>,
  deps: SeedDeps,
): ProgressClaimLine[] {
  const packageByBoqKey = new Map<string, string>();
  for (const wp of workPackages) {
    for (const ref of wp.boqLineRefs ?? []) {
      packageByBoqKey.set(boqSourceKey(ref.quoteId, ref.sectionId, ref.lineId), wp.id);
    }
  }
  const lines: ProgressClaimLine[] = [];
  quote.sections.forEach((section, si) => {
    section.lines.forEach((ql, li) => {
      const sourceKey = boqSourceKey(quote.id, section.id, ql.id);
      lines.push(
        buildLine(deps, {
          sourceKey,
          lineRef: `${si + 1}.${li + 1}`,
          sectionLabel: section.title ?? null,
          description: ql.description,
          boqLineRef: { quoteId: quote.id, sectionId: section.id, lineId: ql.id },
          workPackageId: packageByBoqKey.get(sourceKey) ?? null,
          contractValueCents: quoteLineValueCents(ql),
          contractValueSource: "quote_line",
          order: lines.length,
        }),
      );
    });
  });
  return lines;
}

/** Seed from work packages (no priced quote): one UNPRICED line per package. */
export function seedLinesFromPackages(
  workPackages: ReadonlyArray<SeedWorkPackage>,
  deps: SeedDeps,
): ProgressClaimLine[] {
  return workPackages.map((wp, i) =>
    buildLine(deps, {
      sourceKey: packageSourceKey(wp.id),
      lineRef: `${i + 1}`,
      sectionLabel: null,
      description: wp.title,
      boqLineRef: null,
      workPackageId: wp.id,
      contractValueCents: null,
      contractValueSource: "manual",
      order: i,
    }),
  );
}

/**
 * Carry forward MANUAL lines from the latest prior non-draft claim — hand-added
 * scope keeps its cumulative chain and its office-entered contract value.
 */
export function carryForwardManualLines(
  seeded: ReadonlyArray<ProgressClaimLine>,
  deps: SeedDeps,
): ProgressClaimLine[] {
  const counted = deps.priorClaims
    .filter((c) => c.status !== "draft")
    .sort((a, b) => a.number - b.number);
  const latest = counted[counted.length - 1];
  if (!latest) return [...seeded];
  const have = new Set(seeded.map((l) => l.sourceKey));
  const carried = latest.lines
    .filter((l) => l.sourceKey.startsWith("manual:") && !have.has(l.sourceKey))
    .map((l, i) =>
      buildLine(deps, {
        sourceKey: l.sourceKey,
        lineRef: l.lineRef,
        sectionLabel: l.sectionLabel ?? null,
        description: l.description,
        boqLineRef: null,
        workPackageId: l.workPackageId ?? null,
        contractValueCents: l.contractValueCents,
        contractValueSource: "manual",
        order: seeded.length + i,
      }),
    );
  return [...seeded, ...carried];
}
