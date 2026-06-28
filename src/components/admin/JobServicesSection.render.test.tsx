import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobServicesSection } from "./JobServicesSection";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";

/**
 * SSR render tests for the admin hub services section (#230): hidden when empty
 * + read-only, the populated list with denormalised photos + edit/remove for a
 * manager, the read-only list (no edit affordance) for a non-manager, and a
 * quiet error notice.
 */

function record(over: Partial<ServiceLocationRecord> = {}): ServiceLocationRecord {
  return {
    id: "sl_1",
    type: "switchboard",
    label: "Main board",
    description: "In the garage, behind the roller door.",
    photos: [],
    createdBy: "Sam",
    createdById: "u_1",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedBy: "Sam",
    updatedById: "u_1",
    updatedAt: "2026-06-28T00:00:00.000Z",
    ...over,
  };
}

describe("JobServicesSection", () => {
  it("renders nothing when empty, no error, and the viewer can't manage", () => {
    const html = renderToString(
      createElement(JobServicesSection, { jobId: "j", initialRecords: [], canManage: false }),
    );
    expect(html).toBe("");
  });

  it("renders the populated list with the denormalised photo URL", () => {
    const html = renderToString(
      createElement(JobServicesSection, {
        jobId: "j",
        canManage: true,
        initialRecords: [
          record({
            photos: [
              {
                evidenceId: "ev_1",
                photoUrl: "https://blob/board.jpg",
                thumbnailUrl: "https://blob/board-thumb.jpg",
                photoId: "p_1",
                capturedByName: "Sam",
              },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain("Services on site");
    expect(html).toContain("Main board");
    expect(html).toContain("In the garage, behind the roller door.");
    expect(html).toContain("https://blob/board-thumb.jpg");
    // A manager sees edit + remove affordances.
    expect(html).toContain("Edit");
    expect(html).toContain("Remove");
  });

  it("hides edit/remove for a non-manager (read-only list)", () => {
    const html = renderToString(
      createElement(JobServicesSection, {
        jobId: "j",
        canManage: false,
        initialRecords: [record()],
      }),
    );
    expect(html).toContain("Main board");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Remove<");
  });

  it("shows the empty-but-manageable state (the crew add these from the field)", () => {
    const html = renderToString(
      createElement(JobServicesSection, { jobId: "j", initialRecords: [], canManage: true }),
    );
    expect(html).toContain("No services marked on this job yet");
  });

  it("surfaces a quiet notice on a load error", () => {
    const html = renderToString(
      createElement(JobServicesSection, {
        jobId: "j",
        initialRecords: [],
        canManage: true,
        loadError: "Services API returned 500",
      }),
    );
    expect(html).toContain("Couldn’t load the services list");
  });
});
