import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TakeoffCard } from "./TakeoffCard";
import type { Takeoff, TakeoffLine } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #213 takeoff card. renderToString draws the default
 * state; assemble/adjust/sign-off behaviour is covered by the API + pure
 * assembler tests.
 */

function line(over: Partial<TakeoffLine>): TakeoffLine {
  return {
    id: "tl_1",
    lineIndex: 0,
    sourceType: "device-count",
    description: "Double GPO",
    qty: 12,
    humanQty: null,
    effectiveQty: 12,
    unit: "ea",
    estimate: false,
    flagged: false,
    flagReason: null,
    note: null,
    adjustedAt: null,
    adjustedBy: null,
    provenance: { planId: "pl1", pageIndex: 0, acceptedCountId: "ac_1" },
    ...over,
  };
}

function takeoff(over: Partial<Takeoff>): Takeoff {
  return {
    id: "to_1",
    version: 1,
    status: "draft",
    warnings: [],
    createdAt: "2026-07-03T00:00:00.000Z",
    createdBy: "boss",
    signedOffAt: null,
    signedOffBy: null,
    lines: [
      line({}),
      line({
        id: "tl_2",
        lineIndex: 1,
        sourceType: "schedule-row",
        description: "L2 — OYSTER",
        qty: null,
        effectiveQty: null,
        flagged: true,
        flagReason: "schedule qty cell not a plain number — set the quantity",
        provenance: { planId: "pl1", pageIndex: 1, rowId: "sr_2" },
      }),
      line({
        id: "tl_3",
        lineIndex: 2,
        sourceType: "cable-estimate",
        description: "Cable runs to DB-1 (heuristic estimate)",
        qty: 184.6,
        effectiveQty: 184.6,
        unit: "m",
        estimate: true,
        provenance: { planId: "pl1", pageIndex: 0, cableRunId: "cr_1" },
      }),
      line({
        id: "tl_4",
        lineIndex: 3,
        sourceType: "device-count",
        description: "LED downlight",
        qty: 24,
        humanQty: 20,
        effectiveQty: 20,
        adjustedBy: "boss",
        note: "4 in the linked overlap",
      }),
    ],
    ...over,
  };
}

const lookup = { labelFor: () => "E-SET" };

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("TakeoffCard (#213)", () => {
  it("renders the draft with provenance, estimate/flag honesty, recorded adjustments and the sign-off gate", () => {
    const html = strip(
      renderToString(
        createElement(TakeoffCard, {
          jobId: "j1",
          views: {
            draft: takeoff({
              warnings: [
                { kind: "duplicate-scope", planId: "pl1", pageIndex: 0, detail: "DB-1 also on pl2 p1 (confirmed)" },
              ],
            }),
            signedOff: null,
          },
          lookup,
          onViews: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="takeoff-card"');
    expect(html).toContain('data-testid="takeoff-draft"');
    expect(html).toContain("draft — not signed off");
    expect(html).toContain("Sign off takeoff");
    // provenance + source honesty on lines
    expect(html).toContain("verified count");
    expect(html).toContain("E-SET p1");
    expect(html).toContain("12 ea");
    // flagged qty is a question, never an invented number
    expect(html).toContain("qty?");
    expect(html).toContain("set the quantity");
    // cable line stays an estimate all the way
    expect(html).toContain("estimate");
    expect(html).toContain("184.6 m");
    // adjustment recorded and visible
    expect(html).toContain("20 ea");
    expect(html).toContain("(adj. by boss)");
    // duplicate-scope warning carried into assembly
    expect(html).toContain('data-testid="takeoff-warnings"');
    expect(html).toContain("DB-1 also on pl2 p1");
  });

  it("renders the signed-off version immutable and named as the quoting source", () => {
    const html = strip(
      renderToString(
        createElement(TakeoffCard, {
          jobId: "j1",
          views: {
            draft: null,
            signedOff: takeoff({
              status: "signed_off",
              signedOffAt: "2026-07-03T02:00:00.000Z",
              signedOffBy: "boss",
            }),
          },
          lookup,
          onViews: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="takeoff-signed"');
    expect(html).toContain("signed off · boss — the quoting source");
    expect(html).not.toContain("Sign off takeoff");
    expect(html).not.toContain("Add line:");
    expect(html).toContain("Re-assemble (new version)");
  });

  it("states the empty case honestly", () => {
    const html = strip(
      renderToString(
        createElement(TakeoffCard, {
          jobId: "j1",
          views: { draft: null, signedOff: null },
          lookup,
          onViews: () => undefined,
        }),
      ),
    );
    expect(html).toContain("Unverified AI output never lands here");
  });
});
