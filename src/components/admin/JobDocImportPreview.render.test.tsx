import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  CreateJobPanel,
  JobDocImportPreview,
  PreviewBody,
  defaultJobName,
} from "./JobDocImportPreview";
import type { BoqImportPreview } from "@/domains/job-doc-import/schema";
import type { BoqJobCreated } from "@/domains/job-doc-import/client";

/**
 * Server-render tests for the BOQ import preview UI (#365). Renders the empty
 * state and a populated PreviewBody to HTML (no DOM, the JobReadinessPanel
 * pattern) and asserts the honest read-only framing, the commercial
 * reconciliation (green when balanced, a delta when not) and the ambiguity
 * chips a human must resolve before any of it becomes job data.
 */

function fixture(): BoqImportPreview {
  return {
    source: { sheetCount: 1, sheetNames: ["Sheet1"] },
    sections: [
      { key: "lighting", lineCount: 1, computed: 6160, stated: 6160, delta: 0, reconciles: true },
      {
        key: "electrical",
        lineCount: 1,
        computed: 950,
        stated: 1000,
        delta: -50,
        reconciles: false,
      },
    ],
    totals: { computed: 7110, stated: 7160, delta: -50, reconciles: false },
    lines: [
      {
        section: "lighting",
        code: "L1.1",
        description: "Sasso 40 downlight",
        qty: 16,
        supplyRate: 275,
        supplyAmount: 4400,
        installRate: 110,
        installAmount: 1760,
        lineTotal: 6160,
        notes: "",
        flags: [],
      },
      {
        section: "electrical",
        code: null,
        description: "Hot pool PC SUM Power requirements TBC",
        qty: 1,
        supplyRate: 950,
        supplyAmount: 950,
        installRate: null,
        installAmount: null,
        lineTotal: 950,
        notes: "PC SUM TBC",
        flags: ["provisional_sum", "needs_clarification"],
      },
    ],
    ambiguities: [
      { kind: "provisional_sum", ref: "Hot pool PC SUM", message: "Provisional (PC) sum." },
      { kind: "needs_clarification", ref: "Hot pool PC SUM", message: "Raise an RFI." },
    ],
    counts: { lines: 2, byFlag: { provisional_sum: 1, needs_clarification: 1 } },
  };
}

const strip = (html: string) => html.replace(/<!-- -->/g, "");

describe("JobDocImportPreview — empty state", () => {
  it("leads with the review-before-create framing and an .xlsx picker", () => {
    const html = strip(renderToString(createElement(JobDocImportPreview)));
    expect(html).toContain("Review before you create");
    // Honest framing: a BOQ is pricing, so no areas/tasks are invented.
    expect(html).toContain("no areas or tasks");
    expect(html).toContain("Pricing / BOQ workbook");
  });
});

describe("CreateJobPanel — the #365 write-half trigger", () => {
  const file = {} as unknown as File; // SSR never touches the file (only on click)
  const noop = () => {};

  it("offers a named create action with honest cost-basis copy", () => {
    const html = strip(
      renderToString(
        createElement(CreateJobPanel, {
          file,
          preview: fixture(),
          defaultName: "Sansara Gym Double Bay REV5",
          created: null,
          onCreated: noop,
        })
      )
    );
    expect(html).toContain("Create a draft job from this bill");
    expect(html).toContain("Create draft job");
    expect(html).toContain("Sansara Gym Double Bay REV5"); // prefilled name
    expect(html).toContain("Areas + tasks come later"); // honest scoping
  });

  it("shows a success state linking to the new job once created", () => {
    const created: BoqJobCreated = {
      jobId: "sansara-gym-double-bay",
      job: { id: "sansara-gym-double-bay", name: "Sansara Gym Double Bay", status: "draft" },
      costBasis: { lines: 2, total: 7110, reconciles: false },
    };
    const html = strip(
      renderToString(
        createElement(CreateJobPanel, {
          file,
          preview: fixture(),
          defaultName: "x",
          created,
          onCreated: noop,
        })
      )
    );
    expect(html).toContain("Draft job created");
    expect(html).toContain('href="/v2/jobs/sansara-gym-double-bay"');
    expect(html).toContain("Open Sansara Gym Double Bay");
  });
});

describe("defaultJobName", () => {
  it("strips the extension and underscores into a readable job name", () => {
    expect(defaultJobName("Sansara_Gym_Double Bay REV5.xlsx")).toBe("Sansara Gym Double Bay REV5");
    expect(defaultJobName(null)).toBe("");
  });
});

describe("PreviewBody — populated", () => {
  const html = strip(
    renderToString(createElement(PreviewBody, { preview: fixture(), fileName: "REV5.xlsx" }))
  );

  it("shows reconciliation: green when it balances, a delta when it doesn't", () => {
    expect(html).toContain("REV5.xlsx");
    expect(html).toContain("reconciles"); // lighting balances
    expect(html).toContain("off by"); // electrical + grand do not
  });

  it("surfaces the ambiguity chips a human must resolve", () => {
    expect(html).toContain("Provisional (PC) sum");
    expect(html).toContain("Needs clarification");
  });

  it("renders the priced lines with their codes", () => {
    expect(html).toContain("L1.1");
    expect(html).toContain("Sasso 40 downlight");
  });
});
