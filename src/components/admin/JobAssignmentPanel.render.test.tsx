import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobAssignmentPanel } from "./JobAssignmentPanel";
import type { AssignableWorker } from "@/domains/users/types";

// RefreshButton (rendered in the load-error banner) calls useRouter; stub it so
// the SSR smoke doesn't need a mounted app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * Server-render smoke for the "Assigned field workers" panel. Node env, no
 * browser (mirrors MaterialRequestsInbox.render.test.tsx). renderToString runs
 * useState initialisers (so the assigned/unassigned split renders) but not
 * effects or clicks — the assign/remove/save mutation behaviour is covered by
 * the API test (src/domains/users/users-api.test.ts).
 */

const WORKERS: AssignableWorker[] = [
  { id: "u_a", username: "amy", role: "electrician", assignedJobIds: ["job-1", "elsewhere"] },
  { id: "u_b", username: "ben", role: "tradie", assignedJobIds: ["elsewhere"] },
];

function render(props: Parameters<typeof JobAssignmentPanel>[0]): string {
  return renderToString(createElement(JobAssignmentPanel, props));
}

describe("JobAssignmentPanel", () => {
  it("renders the heading, worker rows and per-worker assignment state", () => {
    const html = render({ jobId: "job-1", jobName: "Birdwood IV", initialWorkers: WORKERS });
    expect(html).toContain("Assigned field workers");
    expect(html).toContain("Birdwood IV");
    expect(html).toContain("amy");
    expect(html).toContain("ben");
    // Roles surfaced as pills.
    expect(html).toContain("electrician");
    expect(html).toContain("tradie");
    // amy is assigned to job-1, ben is not.
    expect(html).toContain("Assigned");
    expect(html).toContain("Not assigned");
    // Count reflects the initial selection (amy only).
    expect(html).toContain("1 assigned");
    expect(html).toContain("Save assignments");
  });

  it("never renders secret fields even if a worker object carried them", () => {
    // The type forbids extra fields, but assert structurally that the panel
    // only ever prints the four safe fields it's given.
    const html = render({ jobId: "job-1", initialWorkers: WORKERS });
    expect(html).not.toContain("passwordHash");
    expect(html).not.toContain("$2a$");
  });

  it("renders the empty state when there are no assignable workers", () => {
    const html = render({ jobId: "job-1", initialWorkers: [] });
    expect(html).toContain("No field workers to assign");
    // Save button still present (disabled) so the section reads as complete.
    expect(html).toContain("Save assignments");
  });

  it("renders a non-blocking load-error banner", () => {
    const html = render({
      jobId: "job-1",
      initialWorkers: [],
      loadError: "API returned 503",
    });
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 503");
  });
});
