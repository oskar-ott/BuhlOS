import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { JOBS, INVOICE_MULTI_REFERENCE, TAX_INVOICE_IV0041 } from "./test-helpers/fixtures";

const requireFromHere = createRequire(import.meta.url);
const iv = requireFromHere("../../../api/_lib/invoices/iv-match.js");

/**
 * Exact IV matching — the central business rule. The IV number is jobs.json
 * `code` (IV####); normalisation is conservative; matching is never fuzzy.
 */
describe("normaliseIvReference", () => {
  it("accepts case, whitespace and a single separator between IV and the digits", () => {
    expect(iv.normaliseIvReference("iv0041")).toBe("IV0041");
    expect(iv.normaliseIvReference("  IV 0041 ")).toBe("IV0041");
    expect(iv.normaliseIvReference("IV-0041")).toBe("IV0041");
    expect(iv.normaliseIvReference("IV#0041")).toBe("IV0041");
  });
  it("refuses malformed references — never pads, never guesses", () => {
    expect(iv.normaliseIvReference("IV41")).toBeNull();
    expect(iv.normaliseIvReference("IV00411")).toBeNull();
    expect(iv.normaliseIvReference("INV0041")).toBeNull();
    expect(iv.normaliseIvReference("0041")).toBeNull();
    expect(iv.normaliseIvReference("IV--0041")).toBeNull();
    expect(iv.normaliseIvReference("")).toBeNull();
    expect(iv.normaliseIvReference(null)).toBeNull();
  });
});

describe("extractIvCandidates + selectIvReference", () => {
  it("reads a labelled reference and prefers it over stray tokens", () => {
    const c = iv.extractIvCandidates(TAX_INVOICE_IV0041);
    const labelled = c.filter((x: { source: string }) => x.source === "labelled");
    expect(labelled).toEqual([expect.objectContaining({ normalised: "IV0041", label: "Job Number", raw: "IV 0041" })]);
    const sel = iv.selectIvReference(c);
    expect(sel).toMatchObject({ outcome: "selected", normalised: "IV0041", source: "labelled", label: "Job Number" });
  });
  it("never treats the supplier's own invoice number line as a job reference", () => {
    const c = iv.extractIvCandidates("Tax Invoice No: IV0041\nSub Total 1.00");
    expect(c.filter((x: { source: string }) => x.source === "labelled")).toEqual([]);
    // it is still visible as an unlabelled token, so the reviewer can see it
    expect(c.find((x: { source: string }) => x.source === "text")?.normalised).toBe("IV0041");
  });
  it("handles every wholesaler label variant", () => {
    for (const label of ["Job Number", "Job Reference", "Customer Reference", "Order Number", "Purchase Reference", "Your Reference", "Order No", "PO Number", "Cust Ref", "Job"]) {
      const sel = iv.selectIvReference(iv.extractIvCandidates(`${label}: IV0041\nTotal 1.00`));
      expect(sel.outcome, label).toBe("selected");
      expect(sel.normalised, label).toBe("IV0041");
      expect(sel.label, label).toBe(label);
    }
  });
  it("reads a label whose value sits on the next line", () => {
    const sel = iv.selectIvReference(iv.extractIvCandidates("Your Reference\nIV0042\nTotal 1.00"));
    expect(sel).toMatchObject({ outcome: "selected", normalised: "IV0042", label: "Your Reference" });
  });
  it("refuses when several different references are printed", () => {
    const sel = iv.selectIvReference(iv.extractIvCandidates(INVOICE_MULTI_REFERENCE));
    expect(sel.outcome).toBe("multi_reference");
    expect(sel.distinct.sort()).toEqual(["IV0041", "IV0042"]);
  });
  it("falls back to a single unlabelled token, flagged as text evidence", () => {
    const sel = iv.selectIvReference(iv.extractIvCandidates("Delivery note\nIV0041 site\nTotal 1.00"));
    expect(sel).toMatchObject({ outcome: "selected", normalised: "IV0041", source: "text" });
  });
  it("returns none when nothing looks like an IV reference", () => {
    expect(iv.selectIvReference(iv.extractIvCandidates("Invoice 1\nTotal 1.00")).outcome).toBe("none");
  });
});

describe("buildJobCodeIndex + matchJobByIv", () => {
  it("indexes live coded jobs only and reports collisions", () => {
    const idx = iv.buildJobCodeIndex(JOBS);
    expect(idx.size).toBe(3);
    expect(idx.collisions).toEqual([]);
    expect(idx.byCode.has("IV0043")).toBe(false); // deleted job
    const dup = iv.buildJobCodeIndex([...JOBS, { id: "clash", name: "Clash", code: "iv0041" }]);
    expect(dup.collisions).toEqual(["IV0041"]);
  });
  it("matches exactly one job, warns on complete/archived jobs, never fuzzes", () => {
    const idx = iv.buildJobCodeIndex(JOBS);
    expect(iv.matchJobByIv("IV0041", idx)).toMatchObject({ status: "exact", matchCount: 1, warnings: [] });
    expect(iv.matchJobByIv("IV0042", idx)).toMatchObject({ status: "exact", warnings: ["job is complete — late invoice?"] });
    expect(iv.matchJobByIv("IV0050", idx)).toMatchObject({ status: "exact", warnings: ["job is archived — late invoice?"] });
    expect(iv.matchJobByIv("IV0999", idx)).toMatchObject({ status: "not_found", matchCount: 0 });
    expect(iv.matchJobByIv("IV004", idx)).toMatchObject({ status: "malformed" });
    // a one-digit-off reference is NOT a match
    expect(iv.matchJobByIv("IV0040", idx).status).toBe("not_found");
  });
  it("blocks automatic matching when two live jobs share a code", () => {
    const idx = iv.buildJobCodeIndex([...JOBS, { id: "clash", name: "Clash", code: "IV0041" }]);
    const m = iv.matchJobByIv("IV0041", idx);
    expect(m.status).toBe("ambiguous");
    expect(m.matchCount).toBe(2);
  });
});
