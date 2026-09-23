import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobStatusControl } from "./JobStatusControl";

/**
 * Status control on the hub's health band: a non-admin viewer gets ONLY the
 * static pill (no menu affordance — the server would 403 the write anyway);
 * an admin gets the change-status button, menu closed by default.
 */
describe("JobStatusControl", () => {
  it("renders a static pill for a non-admin viewer", () => {
    const html = renderToString(
      createElement(JobStatusControl, { job: { id: "j1", status: "on_hold" }, canEdit: false })
    );
    expect(html).toContain("On hold");
    expect(html).not.toContain("Change status");
  });

  it("renders the change-status affordance for an admin, menu closed", () => {
    const html = renderToString(
      createElement(JobStatusControl, { job: { id: "j1", status: "active" }, canEdit: true })
    );
    expect(html).toContain("Change status");
    expect(html).not.toContain("menuitemradio");
  });
});

describe("JobStatusControl — lifecycle words (docs/job-lifecycle.md)", () => {
  it("a complete job with no stamp reads Closed; one finished yesterday reads Finished", () => {
    const closed = renderToString(
      createElement(JobStatusControl, { job: { id: "j1", status: "complete" }, canEdit: false })
    );
    expect(closed).toContain("Closed");
    const finishing = renderToString(
      createElement(JobStatusControl, {
        job: { id: "j1", status: "complete", completedAt: new Date(Date.now() - 86_400_000).toISOString() },
        canEdit: false,
      })
    );
    expect(finishing).toContain("Finished");
    expect(finishing).not.toContain("Closed");
  });

  it("never renders the confirm dialog on first paint", () => {
    const html = renderToString(
      createElement(JobStatusControl, { job: { id: "j1", status: "active" }, canEdit: true })
    );
    expect(html).not.toContain("job-status-confirm");
  });
});
