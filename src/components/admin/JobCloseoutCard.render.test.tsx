import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobCloseoutCard } from "./JobCloseoutCard";

/**
 * #349 — the closeout card's initial render (renderToString skips the mount
 * fetch, so we see the loading state). The snapshot maths + lifecycle are pinned
 * by the API/pure harnesses; this guards the card mounts without throwing.
 */
describe("JobCloseoutCard — initial render", () => {
  it("renders a labelled region and a loading state before data arrives", () => {
    const html = renderToString(createElement(JobCloseoutCard, { jobId: "job-a" }));
    expect(html).toContain("Job closeout");
    expect(html).toContain("Loading");
  });
});
