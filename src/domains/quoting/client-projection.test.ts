import { describe, expect, it } from "vitest";

import { projectQuoteToClientView } from "./client-projection";
import { QUOTE_MARGIN_INTERNAL_ONLY_KEYS } from "./margin";
import { computeQuoteTotals } from "./totals";
import type { Quote } from "./schema";

/**
 * #186 — the client projection separates the internal estimate from the
 * client-facing quote. The headline test is a SECURITY one: no internal-only
 * key (cost/margin/markupPct/…) may appear anywhere in the projected document,
 * even when the source quote carries them via `.passthrough()`.
 */

function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: "qv2_1",
    name: "East Gym fit-out",
    clientName: "Acme Builders",
    status: "draft",
    createdAt: "2026-06-20T00:00:00.000Z",
    createdBy: "u_boss",
    updatedAt: "2026-06-20T00:00:00.000Z",
    sections: [
      {
        id: "s1",
        title: "Power",
        sortOrder: 1,
        lines: [
          { id: "l1", kind: "material", description: "GPO double", qty: 10, unit: "ea", rate: 25 },
          { id: "l2", kind: "labour", description: "Install", qty: 4, unit: "hr", rate: 95 },
        ],
      },
    ],
    totals: { subtotalExGst: 630, gst: 63, totalIncGst: 693, lineCount: 2 },
    ...over,
  } as Quote;
}

/** Every object key appearing anywhere in a value (recursive). */
function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const el of v) keysDeep(el, out);
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      out.add(k);
      keysDeep(val, out);
    }
  }
  return out;
}

describe("projectQuoteToClientView", () => {
  it("projects sell-side sections + computed line/section totals", () => {
    const view = projectQuoteToClientView(quote());
    expect(view.name).toBe("East Gym fit-out");
    expect(view.clientName).toBe("Acme Builders");
    expect(view.sections).toHaveLength(1);
    const lines = view.sections[0]!.lines;
    expect(lines[0]).toEqual({ description: "GPO double", qty: 10, unit: "ea", rate: 25, lineTotalExGst: 250 });
    expect(lines[1]!.lineTotalExGst).toBe(380); // 4 × 95
    // Totals match totals.ts exactly (the printed lines foot to the subtotal).
    expect(view.totals).toEqual(computeQuoteTotals(quote().sections));
    expect(view.totals.subtotalExGst).toBe(630);
    expect(view.gstRate).toBe(0.1);
  });

  it("SECURITY: no internal-only key leaks — even when the source passthrough's them", () => {
    // A malicious/internal quote with cost/margin/markup riding along via .passthrough().
    const dirty = quote({
      sections: [
        {
          id: "s1",
          title: "Power",
          sortOrder: 1,
          // passthrough fields (cost/margin/markup) ride along on the source line
          lines: [
            {
              id: "l1",
              kind: "material",
              description: "GPO",
              qty: 1,
              unit: "ea",
              rate: 25,
              cost: 12,
              totalCost: 12,
              margin: { amount: 13, pct: 52 },
              markupPct: 108,
              effectiveMargin: 52,
              flag: "low",
            },
          ],
        },
      ],
    });
    const view = projectQuoteToClientView(dirty);
    const keys = keysDeep(view);
    const leaked = QUOTE_MARGIN_INTERNAL_ONLY_KEYS.filter((k) => keys.has(k));
    expect(leaked).toEqual([]);
    // and the benign internal `kind`/`id` are dropped from the client line too.
    expect(keys.has("kind")).toBe(false);
    expect(keys.has("id")).toBe(false);
    // the legitimate sell-side number still computes from the source rate/qty.
    expect(view.sections[0]!.lines[0]!.lineTotalExGst).toBe(25);
  });

  it("clientName is null when absent; sections sort by sortOrder", () => {
    const view = projectQuoteToClientView(
      quote({
        clientName: null,
        sections: [
          { id: "b", title: "Second", sortOrder: 2, lines: [] },
          { id: "a", title: "First", sortOrder: 1, lines: [] },
        ],
      }),
    );
    expect(view.clientName).toBeNull();
    expect(view.sections.map((s) => s.title)).toEqual(["First", "Second"]);
  });

  it("empty quote → zero totals, no lines", () => {
    const view = projectQuoteToClientView(quote({ sections: [], totals: { subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 } }));
    expect(view.sections).toEqual([]);
    expect(view.totals).toEqual({ subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 });
  });
});
