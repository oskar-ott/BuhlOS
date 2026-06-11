import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The control uses useRouter().refresh() after deletes; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { TestJobsCleanup } from "./TestJobsCleanup";

/**
 * SSR smoke for the admin test-job cleanup control. Locks the entry-point
 * contract: visible (with count + arm button) when deletable test jobs
 * exist, and renders NOTHING when the list is empty — the index must stay
 * clean for admins with no QA junk. Delete behaviour itself is covered by
 * the API tests (jobs-api.test.ts DELETE suite); this is display-only.
 */
/** SSR inserts `<!-- -->` between JSX expression children — strip for text asserts. */
function renderText(jobs: ReadonlyArray<{ id: string; name: string }>): string {
  return renderToString(createElement(TestJobsCleanup, { jobs })).replace(/<!-- -->/g, "");
}

describe("TestJobsCleanup — render contract", () => {
  it("renders nothing when there are no deletable test jobs", () => {
    expect(renderText([])).toBe("");
  });

  it("shows the count and an arm button when parked test jobs exist", () => {
    const html = renderText([
      { id: "smoke-test-1-job-b", name: "SMOKE_TEST_1_Job_Builder" },
      { id: "smoke-test-2-job-b", name: "SMOKE_TEST_2_Job_Builder" },
    ]);
    expect(html).toContain("Automated test data");
    expect(html).toContain("2 parked test jobs");
    expect(html).toContain("test-jobs-cleanup-arm");
    // Idle state must not pre-render the destructive confirm.
    expect(html).not.toContain("test-jobs-cleanup-confirm");
  });

  it("uses the singular form for one job", () => {
    const html = renderText([{ id: "smoke-test-1-job-b", name: "SMOKE_TEST_1_Job_Builder" }]);
    expect(html).toContain("1 parked test job from QA smoke runs is");
  });
});
