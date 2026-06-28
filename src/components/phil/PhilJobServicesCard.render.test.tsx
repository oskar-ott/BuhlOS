import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobServicesCard } from "./PhilJobServicesCard";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";

/**
 * Services-on-site card (#230). Guards: render-null when there are no records
 * AND the viewer can't write (P10); the populated list shows real headings,
 * descriptions and the denormalised photo URL; its own #phil-job-services
 * anchor is present (and it never claims #phil-job-site); the load error
 * surfaces a quiet notice; and the copy stays plain site language.
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

describe("PhilJobServicesCard", () => {
  it("renders nothing when there are no records and the viewer can't write", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, { jobId: "j", initialRecords: [], canWrite: false }),
    );
    expect(html).toBe("");
  });

  it("renders the populated list with real headings, descriptions and the photo URL", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, {
        jobId: "j",
        defaultOpen: true,
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
        canWrite: true,
      }),
    );
    expect(html).toContain("Services on site");
    expect(html).toContain("Main board");
    expect(html).toContain("In the garage, behind the roller door.");
    // The denormalised thumbnail URL is rendered — served from here, not /api/evidence.
    expect(html).toContain("https://blob/board-thumb.jpg");
  });

  it("falls back to the type label when the worker gave no label", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, {
        jobId: "j",
        defaultOpen: true,
        initialRecords: [record({ label: null, type: "meter", description: "Front fence." })],
      }),
    );
    expect(html).toContain("Meter");
    expect(html).toContain("Front fence.");
  });

  it("keeps its OWN anchor (#phil-job-services) and never claims #phil-job-site", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, { jobId: "j", initialRecords: [record()] }),
    );
    expect(html).toContain('id="phil-job-services"');
    expect(html).not.toContain('id="phil-job-site"');
  });

  it("surfaces a quiet notice on a load error (still lets the worker add)", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, {
        jobId: "j",
        initialRecords: [],
        canWrite: true,
        loadError: "network error",
      }),
    );
    expect(html).toContain("Couldn’t load services");
    // Still shows the add affordance so a worker isn't blocked.
    expect(html).toContain("Add a service location");
  });

  it("shows the empty-but-writable prompt (worker can add the first one)", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, { jobId: "j", initialRecords: [], canWrite: true }),
    );
    expect(html).toContain("No services marked yet");
    expect(html).toContain("Add a service location");
  });

  it("uses plain site language — no admin/payroll jargon", () => {
    const html = renderToString(
      createElement(PhilJobServicesCard, {
        jobId: "j",
        initialRecords: [record()],
        canWrite: true,
      }),
    ).toLowerCase();
    for (const banned of ["payroll", "xero", "dashboard", "registry", "denormalise"]) {
      expect(html).not.toContain(banned);
    }
  });
});
