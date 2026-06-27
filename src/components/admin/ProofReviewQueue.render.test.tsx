import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ProofReviewQueue } from "./ProofReviewQueue";
import type { ProofQueueItem } from "@/server/job-control/proof-queue";

function item(over: Partial<ProofQueueItem> = {}): ProofQueueItem {
  return {
    reviewId: "pr_1",
    jobId: "job-1",
    jobName: "Glebe Town Hall",
    taskRef: { areaId: "a1", stage: "roughIn", taskId: "t1" },
    workPackageId: "wp_1",
    workPackageTitle: "Switchboard terminations",
    requirements: [{ id: "re_1", label: "Photo before close-up", kind: "photo", met: true }],
    photos: [
      { evidenceId: "ev_1", photoUrl: "https://blob/ev_1.jpg", capturedByName: "Josh", capturedAt: "2026-06-25T00:00:00Z" },
    ],
    submittedBy: "u-josh",
    submittedAt: "2026-06-25T00:00:00Z",
    jobControlRevision: "rev1",
    ...over,
  };
}

const render = (items: ProofQueueItem[]) =>
  renderToString(createElement(ProofReviewQueue, { initialItems: items })).replace(/<!-- -->/g, "");

describe("ProofReviewQueue (#503)", () => {
  it("renders a submitted item with what-it-proves, photo, and both actions", () => {
    const html = render([item()]);
    expect(html).toContain("Photo before close-up"); // what it proves
    expect(html).toContain("Glebe Town Hall");
    expect(html).toContain('src="https://blob/ev_1.jpg"');
    expect(html).toContain("Approve proof");
    expect(html).toContain("Send back");
    // The independence rule is stated to the approver.
    expect(html).toContain("can’t sign off proof you captured");
  });

  it("shows an honest empty state when nothing is waiting", () => {
    expect(render([])).toContain("Queue clear");
  });

  it("renders a photo placeholder (not a broken image) when a proof has no photo URL", () => {
    const html = render([item({ photos: [{ evidenceId: "ev_x", photoUrl: null, capturedByName: null, capturedAt: null }] })]);
    expect(html).not.toContain('src="null"');
  });
});
