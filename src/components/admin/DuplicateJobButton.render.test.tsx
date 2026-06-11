import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { DuplicateJobButton } from "./DuplicateJobButton";

/** SSR contract for the #190 hub action — present, named, idle by default. */
describe("DuplicateJobButton", () => {
  it("renders the named action without an error state", () => {
    const html = renderToString(createElement(DuplicateJobButton, { jobId: "job-1" }));
    expect(html).toContain("Duplicate job");
    expect(html).not.toContain("Couldn't duplicate");
  });
});
