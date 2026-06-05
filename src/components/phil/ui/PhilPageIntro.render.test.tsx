import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilPageIntro } from "./PhilPageIntro";

/**
 * SSR smoke for the page intro — the single <h1> + supporting line + meta slot
 * that gives every Phil list surface a consistent titled header.
 */
describe("PhilPageIntro", () => {
  it("renders an h1 title with description and meta slot", () => {
    const html = renderToString(
      createElement(PhilPageIntro, {
        title: "Jobs",
        description: "Sites you’re currently assigned to.",
        meta: createElement("span", null, "3 jobs"),
      }),
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Jobs");
    expect(html).toContain("Sites you’re currently assigned to.");
    expect(html).toContain("3 jobs");
  });

  it("renders the title alone when description and meta are omitted", () => {
    const html = renderToString(createElement(PhilPageIntro, { title: "My gear" }));
    expect(html).toContain("My gear");
  });
});
