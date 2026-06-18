import { describe, expect, it } from "vitest";
import {
  quoteToJobInput,
  type ConvertQuote,
  type QuoteStructureSection,
  type QuoteMaterialsSection,
} from "./quote-to-job";

/**
 * Unit coverage for the PURE won-quote → job-input mapping (#244). Fixtures
 * are LEGACY-shaped (the quotes.json record handleConvert reads): areaGroups
 * with per-area workPackages, materials with quote-only source/confidence.
 *
 * The CJS convert handler (api/quotes.js quoteToJobShape) mirrors this spec;
 * its parity is pinned by quotes-convert-api.test.ts. Keep the two in step.
 */

const QUOTE: ConvertQuote = {
  id: "q_won_1",
  name: "Birdwood St Rewire",
  jobType: "residential-rewire",
  siteAddress: "12 Birdwood St, Netherby",
};

const STRUCTURE: QuoteStructureSection = {
  areaGroups: [
    {
      id: "qag_1",
      name: "Ground Floor",
      areas: [
        {
          id: "qar_1",
          name: "Kitchen",
          workPackages: [
            { name: "RI kitchen", stage: "rough-in", tasks: ["Run cable", "Mount boxes"] },
            { name: "FO kitchen", stage: "fit-off", tasks: ["Fit GPOs", "Fit lights"] },
          ],
        },
        {
          id: "qar_2",
          name: "Laundry",
          workPackages: [
            // "Run cable" repeats — must dedupe in the union.
            { name: "RI laundry", stage: "rough-in", tasks: ["Run cable", "Mount boxes laundry"] },
          ],
        },
      ],
    },
    {
      id: "qag_2",
      name: "Upper Floor",
      areas: [
        {
          id: "qar_3",
          name: "Bed 1",
          workPackages: [
            // unknown stage → defaults to rough-in
            { name: "RI bed1", stage: "first-fix", tasks: ["Run cable", "Smoke alarm"] },
            { name: "FO bed1", stage: "fit-off", tasks: ["Fit GPOs"] }, // "Fit GPOs" repeats
          ],
        },
      ],
    },
  ],
};

const MATERIALS: QuoteMaterialsSection = {
  items: [
    {
      id: "qmat_1",
      description: "2.5mm TPS cable",
      category: "Cable",
      quantity: 100,
      unitCost: 2.5,
      totalCost: 250,
      status: "priced",
      source: "ai-takeoff", // quote-only — must be stripped
      confidence: 0.82, // quote-only — must be stripped
    },
    {
      id: "qmat_2",
      description: "DB upgrade",
      category: "Switchgear",
      totalCost: 1000,
      status: "ordered",
      source: "manual",
    },
    {
      id: "qmat_3",
      description: "Misc consumables",
      // no status → normalises to 'draft'
      unitCost: 50,
    },
  ],
};

describe("quoteToJobInput — structure mapping (#244)", () => {
  it("maps area groups → areas with fresh g_/a_ ids and the quote names", () => {
    const { jobInput } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    expect(jobInput.areaGroups).toHaveLength(2);
    expect(jobInput.areaGroups.map((g) => g.name)).toEqual(["Ground Floor", "Upper Floor"]);
    for (const g of jobInput.areaGroups) {
      expect(g.id).toMatch(/^g_/);
      for (const a of g.areas) expect(a.id).toMatch(/^a_/);
    }
    const ground = jobInput.areaGroups[0]!;
    expect(ground.areas.map((a) => a.name)).toEqual(["Kitchen", "Laundry"]);
    // fresh ids — NOT the quote's qar_* ids
    expect(ground.areas[0]!.id).not.toBe("qar_1");
  });

  it("does NOT emit per-area workPackages (sanctioned validator strips them)", () => {
    const { jobInput } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    for (const g of jobInput.areaGroups) {
      for (const a of g.areas) {
        expect(a).not.toHaveProperty("workPackages");
        expect(Object.keys(a).sort()).toEqual(["id", "name"]);
      }
    }
  });

  it("unions + dedupes rough-in and fit-off tasks across every work package", () => {
    const { jobInput } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    const rough = jobInput.roughInTasks.map((t) => t.name);
    const fit = jobInput.fitOffTasks.map((t) => t.name);

    // "Run cable" appears in 3 work packages → exactly once.
    expect(rough.filter((n) => n === "Run cable")).toHaveLength(1);
    expect(rough).toEqual(
      expect.arrayContaining(["Run cable", "Mount boxes", "Mount boxes laundry", "Smoke alarm"])
    );
    // "Fit GPOs" appears in 2 fit-off packages → once.
    expect(fit.filter((n) => n === "Fit GPOs")).toHaveLength(1);
    expect(fit).toEqual(expect.arrayContaining(["Fit GPOs", "Fit lights"]));

    // No fit-off task leaked into rough-in and vice versa.
    expect(rough).not.toContain("Fit lights");
    expect(fit).not.toContain("Run cable");
  });

  it("sets job basics from the quote and lands the job as a DRAFT", () => {
    const { jobInput } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    expect(jobInput.name).toBe("Birdwood St Rewire");
    expect(jobInput.type).toBe("residential-rewire");
    expect(jobInput.siteAddress).toBe("12 Birdwood St, Netherby");
    expect(jobInput.fromQuoteId).toBe("q_won_1");
    expect(jobInput.status).toBe("draft");
  });
});

describe("quoteToJobInput — materials field-stripping (#244)", () => {
  it("strips quote-only source/confidence and keeps pricing", () => {
    const { materialsSeed } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    expect(materialsSeed).toHaveLength(3);
    for (const m of materialsSeed) {
      expect(m).not.toHaveProperty("source");
      expect(m).not.toHaveProperty("confidence");
    }
    const cable = materialsSeed[0]!;
    expect(cable.description).toBe("2.5mm TPS cable");
    expect(cable.quantity).toBe(100);
    expect(cable.unitCost).toBe(2.5);
    expect(cable.totalCost).toBe(250);
  });

  it("normalises status: priced/ordered preserved, anything else → draft", () => {
    const { materialsSeed } = quoteToJobInput(QUOTE, STRUCTURE, MATERIALS);
    expect(materialsSeed[0]!.status).toBe("priced");
    expect(materialsSeed[1]!.status).toBe("ordered");
    expect(materialsSeed[2]!.status).toBe("draft"); // had no status
  });
});

describe("quoteToJobInput — empty / missing sections", () => {
  it("tolerates an empty structure and empty materials", () => {
    const { jobInput, materialsSeed } = quoteToJobInput(
      { id: "q_empty", name: "Bare quote" },
      { areaGroups: [] },
      { items: [] }
    );
    expect(jobInput.areaGroups).toEqual([]);
    expect(jobInput.roughInTasks).toEqual([]);
    expect(jobInput.fitOffTasks).toEqual([]);
    expect(materialsSeed).toEqual([]);
    expect(jobInput.status).toBe("draft");
  });

  it("tolerates null/undefined sections", () => {
    const { jobInput, materialsSeed } = quoteToJobInput(
      { id: "q_null", name: "Null sections" },
      null,
      undefined
    );
    expect(jobInput.areaGroups).toEqual([]);
    expect(materialsSeed).toEqual([]);
  });
});
