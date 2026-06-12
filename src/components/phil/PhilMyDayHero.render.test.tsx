import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilMyDayHero } from "./PhilMyDayHero";
import { buildMyDayHero } from "@/domains/phil/my-day-hero";

/**
 * #422 hero render guard. The state logic is pinned in my-day-hero.test.ts;
 * this pins that each state renders its one answer + the right action shape
 * (inline log vs deep-link chip).
 */

describe("PhilMyDayHero", () => {
  it("log-today: prompt with no link (the sheet is right below)", () => {
    const html = renderToString(
      createElement(PhilMyDayHero, {
        hero: buildMyDayHero({ todayStatus: null, needsYouItems: [], soleJob: null }),
      })
    );
    expect(html).toContain("my-day-hero");
    expect(html).toContain('data-hero-kind="log-today"');
    expect(html).toContain("Log today"); // apostrophe renders as &#x27;
    expect(html).not.toContain("my-day-hero-action"); // no link chip
  });

  it("fix-rejected: danger card with a deep-link chip", () => {
    const html = renderToString(
      createElement(PhilMyDayHero, {
        hero: buildMyDayHero({
          todayStatus: "approved",
          needsYouItems: [
            {
              id: "r1",
              kind: "rejected-hours",
              title: "Tuesday's hours",
              detail: "wrong job",
              href: "/phil/my-day?fixDate=2026-06-02",
              actionLabel: "Fix",
              severity: "urgent",
            },
          ],
          soleJob: null,
        }),
      })
    );
    expect(html).toContain('data-hero-kind="fix-rejected"');
    expect(html).toContain("my-day-hero-action");
    expect(html).toContain("fixDate=2026-06-02");
  });

  it("next-job: links to the active job", () => {
    const html = renderToString(
      createElement(PhilMyDayHero, {
        hero: buildMyDayHero({
          todayStatus: "submitted",
          needsYouItems: [],
          soleJob: { id: "j1", name: "Magill Rd" },
        }),
      })
    );
    expect(html).toContain('data-hero-kind="next-job"');
    expect(html).toContain("/phil/jobs/j1");
    expect(html).toContain("Magill Rd");
  });

  it("all-clear: success card, no action", () => {
    const html = renderToString(
      createElement(PhilMyDayHero, {
        hero: buildMyDayHero({ todayStatus: "approved", needsYouItems: [], soleJob: null }),
      })
    );
    expect(html).toContain('data-hero-kind="all-clear"');
    expect(html).toContain("All clear");
    expect(html).not.toContain("my-day-hero-action");
  });
});
