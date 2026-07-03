import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CrossSheetLinksCard } from "./CrossSheetLinksCard";
import type { EntityLink, SheetRef } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #212 references & links card. renderToString draws the
 * default state; scan/review behaviour is covered by the API + pure tests.
 */

function ref(over: Partial<SheetRef>): SheetRef {
  return {
    id: "ref_1",
    planId: "pl1",
    pageIndex: 0,
    pageSha256: "sha0",
    text: "REFER E-501 FOR SWITCHBOARD DETAILS",
    targetSheetNumber: "E-501",
    bbox: null,
    confidence: 0.9,
    createdAt: "2026-07-03T00:00:00.000Z",
    resolved: { planId: "pl1", pageIndex: 4 },
    ...over,
  };
}

function link(over: Partial<EntityLink>): EntityLink {
  return {
    id: "el_1",
    kind: "same-board",
    identifier: "DB-1",
    a: { planId: "pl1", pageIndex: 0 },
    b: { planId: "pl2", pageIndex: 0 },
    confidence: 0.9,
    evidence: '"DB-1" (schedule) and "DB-1" (pin) match exactly',
    origin: "ai",
    status: "proposed",
    createdAt: "2026-07-03T00:00:00.000Z",
    reviewedAt: null,
    reviewedBy: null,
    ...over,
  };
}

const lookup = {
  labelFor: (planId: string) => (planId === "pl1" ? "E-SET" : "E-SET · Rev B"),
  pageOptions: [
    { planId: "pl1", pageIndex: 0, label: "E-SET p1" },
    { planId: "pl2", pageIndex: 0, label: "E-SET · Rev B p1" },
  ],
};

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("CrossSheetLinksCard (#212)", () => {
  it("renders proposals needing a call, confirmed links both ways, and resolved/unresolved refs", () => {
    const html = strip(
      renderToString(
        createElement(CrossSheetLinksCard, {
          jobId: "j1",
          refs: [ref({}), ref({ id: "ref_2", targetSheetNumber: "E-999", resolved: null })],
          links: [
            link({}),
            link({
              id: "el_2",
              identifier: "MSB",
              status: "confirmed",
              reviewedBy: "boss",
            }),
            link({ id: "el_3", identifier: "DB-9", status: "rejected" }),
          ],
          lookup,
          onLinks: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="cross-sheet-links"');
    expect(html).toContain("never\n              auto-merged".replace("\n              ", " "));
    // proposal with evidence + explicit confirm/reject
    expect(html).toContain('data-testid="link-proposed"');
    expect(html).toContain("match exactly");
    expect(html).toContain("Same board");
    expect(html).toContain("Not the same");
    // confirmed link reads in both directions
    expect(html).toContain('data-testid="link-confirmed"');
    expect(html).toContain("E-SET p1 ↔ E-SET · Rev B p1");
    expect(html).toContain("Unlink");
    // rejection stickiness stated
    expect(html).toContain("stay rejected");
    // refs: resolved shows the target, unresolved is honest
    expect(html).toContain('data-testid="sheet-ref"');
    expect(html).toContain("E-SET p5");
    expect(html).toContain('data-testid="ref-unresolved"');
    expect(html).toContain("no analysed sheet numbered E-999");
  });

  it("states the empty case and offers the scan", () => {
    const html = strip(
      renderToString(
        createElement(CrossSheetLinksCard, {
          jobId: "j1",
          refs: [],
          links: [],
          lookup,
          onLinks: () => undefined,
        }),
      ),
    );
    expect(html).toContain("No links yet");
    expect(html).toContain("Scan for board links");
    expect(html).toContain("No reference callouts detected yet");
  });
});
