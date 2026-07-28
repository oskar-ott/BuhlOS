import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilNeedsYouFeed } from "./PhilNeedsYouFeed";
import type { PhilNeedsYouItem } from "@/domains/phil/needs-you";

function render(items: PhilNeedsYouItem[]) {
  return renderToString(createElement(PhilNeedsYouFeed, { items }));
}

describe("PhilNeedsYouFeed (render)", () => {
  it("shows an honest empty state — no fabricated rows — when there's nothing", () => {
    const html = render([]);
    expect(html).toContain("Nothing needs you right now");
    expect(html).toContain("clear for today");
    // no item rows / action buttons leak into the empty state
    expect(html).not.toContain("Fix hours");
    expect(html).not.toContain("<ul");
  });

  it("renders real rows that link to real routes, with a count", () => {
    const items: PhilNeedsYouItem[] = [
      {
        id: "rejected-hours:e1",
        kind: "rejected-hours",
        title: "Wed 22 May hours need a fix",
        detail: "Stage mismatch",
        href: "/phil/hours",
        actionLabel: "Fix hours",
        severity: "urgent",
      },
      {
        id: "calibration:a1",
        kind: "calibration",
        title: "Fluke 1587 calibration expired",
        detail: "Don't test with it",
        href: "/phil/gear",
        actionLabel: "View gear",
        severity: "urgent",
      },
    ];
    const html = render(items);
    expect(html).toContain("Needs you");
    expect(html).toContain(">2<"); // count badge
    expect(html).toContain("Wed 22 May hours need a fix");
    expect(html).toContain("Fix hours");
    expect(html).toContain('href="/phil/hours"');
    expect(html).toContain("Fluke 1587 calibration expired");
    expect(html).toContain('href="/phil/gear"');
    expect(html).toContain("View gear");
  });
});
