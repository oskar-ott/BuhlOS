import { describe, expect, it, vi } from "vitest";

// DocumentsList renders DocumentUploadButton, which calls useRouter().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/v2/jobs/j1/documents",
}));

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentsList } from "./DocumentsList";
import type { Document } from "@/domains/documents/types";
import type { Job } from "@/domains/jobs/types";

/**
 * #196 — admin Specifications section + spec→area link chips.
 *
 * Server-rendered observation (matches the repo's renderToString pattern):
 *   - specs render in their own Specifications section, not the drawings
 *     register;
 *   - a linked spec shows one chip per linked area (live name from the job
 *     tree) plus a stage chip;
 *   - a dangling link (area removed after linking) renders the honest
 *     "linked area no longer on this job" — never a fabricated name (P7).
 */

const job: Job = {
  id: "j1",
  name: "Riverside",
  areaGroups: [
    {
      id: "g1",
      name: "Ground floor",
      areas: [
        { id: "area-kitchen", name: "Kitchen" },
        { id: "area-pantry", name: "Pantry" },
      ],
    },
  ],
} as unknown as Job;

function spec(over: Partial<Document> = {}): Document {
  return {
    id: "sp_1",
    title: "Joinery spec",
    url: "https://blob.example/joinery.pdf",
    mimeType: "application/pdf",
    category: "spec",
    status: "current",
    level: "Section 7.2",
    ...over,
  } as unknown as Document;
}

function drawing(over: Partial<Document> = {}): Document {
  return {
    id: "dr_1",
    title: "Power layout",
    url: "https://blob.example/power.pdf",
    mimeType: "application/pdf",
    drawingNumber: "E-101",
    discipline: "electrical",
    category: "plan",
    status: "current",
    ...over,
  } as unknown as Document;
}

function render(documents: ReadonlyArray<Document>): string {
  return renderToString(
    createElement(DocumentsList, {
      job,
      initialDocuments: documents,
      fetchError: null,
    }),
  );
}

describe("DocumentsList — #196 Specifications section", () => {
  it("renders a Specifications section for spec rows, separate from drawings", () => {
    const html = render([drawing(), spec()]);
    expect(html).toContain("Specifications");
    expect(html).toContain("Joinery spec");
    // SSR splits the clause line with a comment node; assert on both pieces.
    expect(html).toContain("Section / clause:");
    expect(html).toContain("Section 7.2");
    // drawings keep their discipline section
    expect(html).toContain("Electrical");
    expect(html).toContain("Power layout");
  });

  it("offers the Link areas / stage control on spec rows", () => {
    const html = render([spec()]);
    expect(html).toContain("Link areas / stage");
    expect(html).toContain("Not linked to any area");
  });

  it("renders one chip per linked area (live name) plus a stage chip", () => {
    const html = render([
      spec({
        areaIds: ["area-kitchen", "area-pantry"],
        areaLinks: [
          { areaId: "area-kitchen", areaName: "Kitchen" },
          { areaId: "area-pantry", areaName: "Pantry" },
        ],
        stage: "fitOff",
      }),
    ]);
    expect(html).toContain("Kitchen");
    expect(html).toContain("Pantry");
    expect(html).toContain("Fit-off");
  });

  it("renders a dangling link honestly — never a fabricated name (P7)", () => {
    // area-pantry was removed from the job after linking → not in the job tree.
    const html = render([
      spec({
        areaIds: ["area-kitchen", "area-pantry-gone"],
        areaLinks: [
          { areaId: "area-kitchen", areaName: "Kitchen" },
          { areaId: "area-pantry-gone", areaName: "Old Pantry" },
        ],
      }),
    ]);
    expect(html).toContain("linked area no longer on this job");
    // the stale denormalised name is NOT shown for the dangling link
    expect(html).not.toContain("Old Pantry");
    // the live link still renders
    expect(html).toContain("Kitchen");
  });

  it("does not render a Specifications section when there are no specs", () => {
    const html = render([drawing()]);
    expect(html).not.toContain("Specifications");
  });
});
