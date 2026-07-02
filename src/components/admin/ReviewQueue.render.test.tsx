import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ReviewQueue, type ReviewClause } from "./ReviewQueue";

const session: ReviewClause[] = [
  { id: "sw_1", title: "Supply and install DB-1", detail: "Mains tails" },
  { id: "sw_2", title: "Make-safe existing", detail: null },
  { id: "sw_3", title: "Relocate GPOs", detail: null },
];

function render(over: Partial<Parameters<typeof ReviewQueue>[0]> = {}): string {
  return renderToString(
    createElement(ReviewQueue, {
      session,
      index: 0,
      cleared: 0,
      error: null,
      onClassify: () => {},
      onSkip: () => {},
      onClose: () => {},
      ...over,
    })
  ).replace(/<!-- -->/g, ""); // collapse React's text-node comment markers
}

describe("ReviewQueue", () => {
  it("shows the current clause and real classification actions", () => {
    const html = render();
    expect(html).toContain("Supply and install DB-1");
    expect(html).toContain("Mains tails");
    expect(html).toContain("Priced field work");
    expect(html).toContain("Excluded");
    expect(html).toContain("By others");
    // real domain classifications wired as testids
    expect(html).toContain('data-testid="review-classify-priced"');
    expect(html).toContain('data-testid="review-classify-excluded"');
    expect(html).toContain('data-testid="review-skip"');
  });

  it("offers the optional worker heads-up field on the card (AC4)", () => {
    const html = render();
    expect(html).toContain('data-testid="review-warning-text"');
    expect(html).toContain("Heads-up for the crew (optional)");
    // Site language naming where the text lands, not an enum dump.
    expect(html).toContain("By others / Reuse existing / Variation trigger");
  });

  it("shows progress + an up-next peek", () => {
    const html = render({ index: 0, cleared: 1 });
    expect(html).toContain("1 of 3 classified");
    expect(html).toContain("Up next");
    expect(html).toContain("Make-safe existing");
  });

  it("surfaces a persistence error honestly", () => {
    const html = render({ error: "Network error. Try again." });
    expect(html).toContain("Network error. Try again.");
  });

  it("renders the cleared state when the session is done", () => {
    const html = render({ index: 3, cleared: 3 });
    expect(html).toContain("Queue cleared");
    expect(html).toContain("3 of 3 classified");
    expect(html).toContain("Back to the builder");
  });

  it("renders the empty state when there is nothing to review", () => {
    const html = render({ session: [], index: 0, cleared: 0 });
    expect(html).toContain("Nothing to review");
  });
});
