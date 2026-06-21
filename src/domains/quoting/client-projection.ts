import { GST_RATE, computeQuoteTotals, lineTotal } from "./totals";
import type { Quote } from "./schema";

/**
 * Client-facing quote projection (#186) — separate the INTERNAL estimate from
 * the CLIENT-facing quote.
 *
 * A v2 Quote (schema.ts) is sell-side at the line level already ({kind,
 * description, qty, unit, rate}); the cost/margin/markup analysis lives in the
 * #214 margin calculator's OUTPUT (margin.ts), never on the raw quote. But the
 * Quote line/section schemas are `.passthrough()`, so a stored quote CAN carry
 * extra fields, and the office estimate view derives internal numbers
 * (QUOTE_MARGIN_INTERNAL_ONLY_KEYS) the client must never see. This module is the
 * one-way door: it builds the client document by an EXPLICIT sell-side allowlist
 * — never a spread — so nothing internal can leak even if it rides along on the
 * input.
 *
 * Pure, foundation-scope: it reuses totals.ts (the proven #183 line→subtotal→GST
 * math, round-at-line-then-sum) and computes nothing new. The issued-snapshot
 * endpoint, the PDF (#243) and the quote.html consumption are deferred
 * follow-ups; this is the data contract they render.
 */

/** One client-visible line — sell-side only, with its computed ex-GST total. */
export interface ClientQuoteLine {
  description: string;
  qty: number;
  unit: string;
  /** Sell rate per unit, ex GST. */
  rate: number;
  /** qty × rate, rounded at the line (totals.ts rule). */
  lineTotalExGst: number;
}

export interface ClientQuoteSection {
  title: string;
  lines: ClientQuoteLine[];
}

export interface ClientQuoteTotals {
  subtotalExGst: number;
  gst: number;
  totalIncGst: number;
  lineCount: number;
}

/** The client-facing quote document — what a customer may see. Contains NO cost,
 *  margin, markup or any internal-only key (QUOTE_MARGIN_INTERNAL_ONLY_KEYS). */
export interface ClientQuoteView {
  name: string;
  clientName: string | null;
  sections: ClientQuoteSection[];
  totals: ClientQuoteTotals;
  /** Flat GST rate the totals used (e.g. 0.1). */
  gstRate: number;
  gstNote: string;
}

/**
 * Project a full Quote to its client-facing view. EXPLICIT allowlist — every
 * field is named, never spread — so passthrough'd internal fields on the source
 * (cost/margin/markupPct/…) cannot reach the client document. Totals are
 * recomputed from the sections via totals.ts (so the printed lines always foot
 * to the printed subtotal), not trusted from any stored snapshot.
 */
export function projectQuoteToClientView(quote: Quote): ClientQuoteView {
  const sections: ClientQuoteSection[] = [...quote.sections]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({
      title: s.title,
      lines: s.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        rate: l.rate,
        lineTotalExGst: lineTotal({ qty: l.qty, rate: l.rate }),
      })),
    }));

  const totals = computeQuoteTotals(quote.sections);

  return {
    name: quote.name,
    clientName: quote.clientName ?? null,
    sections,
    totals,
    gstRate: GST_RATE,
    gstNote: `Prices exclude GST; GST charged at ${Math.round(GST_RATE * 100)}%.`,
  };
}
