import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobMaterialsCard } from "./JobMaterialsCard";

/**
 * The hub's Materials spend ledger card (owner pull 2026-08-23). renderToString
 * skips the mount fetch, so this pins the initial contract: the card is the
 * `#materials` anchor the builder links to, titled, with a skeleton — no
 * fabricated lines, no "$0", no add form before the ledger has loaded.
 */
describe("JobMaterialsCard — initial render", () => {
  it("renders the Materials title, the #materials anchor, and a skeleton", () => {
    const html = renderToString(createElement(JobMaterialsCard, { jobId: "job-a" }));
    expect(html).toContain("Materials");
    expect(html).toContain('id="materials"');
    expect(html).toContain("materials-skeleton");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Add spend");
  });
});
