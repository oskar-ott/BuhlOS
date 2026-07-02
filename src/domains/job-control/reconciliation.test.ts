import { describe, it, expect } from "vitest";
import type { ScopeOfWorkItem } from "../jobs/types";
import type { Quote } from "../quoting/schema";
import { boqLineRefKey } from "./spine";
import {
  seedReconciliation,
  reconcile,
  detectFindings,
  reconciliationStatus,
  warningsForCompile,
  applyResolution,
  classifyClause,
  setBoqLineAlternate,
  ScopeReconciliationSchema,
  SCOPE_CLASSIFICATIONS,
} from "./reconciliation";

// ── Fixtures — 100 Arthur St scope clauses + a v2 quote ──────────────────────

function clauses(): ScopeOfWorkItem[] {
  return [
    { id: "sw_zip", title: "Dedicated 20A ZIP circuit, East Gym", detail: "...", order: 0 },
    { id: "sw_av", title: "A/V hardware, Reception", detail: "...", order: 1 },
    { id: "sw_sensors", title: "Upper Ground sensors", detail: "reuse existing", order: 2 },
    { id: "sw_disposal", title: "Strip-out & disposal, East Gym", detail: "make safe", order: 3 },
    { id: "sw_asbuilt", title: "CAD as-built drawings", detail: "...", order: 4 },
  ];
}

function quote(): Quote {
  return {
    id: "q_100arthur",
    name: "100 Arthur St",
    clientName: null,
    status: "won",
    createdAt: "2026-01-01",
    createdBy: "admin",
    updatedAt: "2026-01-02",
    sections: [
      {
        id: "sec_power",
        title: "Power",
        sortOrder: 0,
        lines: [
          { id: "ql_zip", kind: "material", description: "ZIP 20A circuit", qty: 1, unit: "ea", rate: 1850 },
          { id: "ql_pl3", kind: "material", description: "PL3 pendant (alternative)", qty: 6, unit: "ea", rate: 220 },
        ],
      },
    ],
    totals: { subtotalExGst: 3170, gst: 317, totalIncGst: 3487, lineCount: 2 },
  };
}

const KEY_ZIP = boqLineRefKey({ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" });
const KEY_PL3 = boqLineRefKey({ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_pl3" });

describe("classification set", () => {
  it("is the closed ten-class enum incl. the explicit unclear default", () => {
    expect(SCOPE_CLASSIFICATIONS).toHaveLength(10);
    expect(SCOPE_CLASSIFICATIONS).toContain("unclear");
    expect(SCOPE_CLASSIFICATIONS).toContain("variation_trigger");
  });
});

describe("seedReconciliation — forced classification, no silent gaps", () => {
  const rec = seedReconciliation("job_100arthur", clauses(), quote());
  it("emits exactly one classification per clause, all unclear", () => {
    expect(rec.clauseClassifications).toHaveLength(5);
    expect(rec.clauseClassifications.every((c) => c.classification === "unclear")).toBe(true);
  });
  it("emits exactly one classification per quote line, all unowned", () => {
    expect(rec.boqClassifications).toHaveLength(2);
    expect(rec.boqClassifications.every((b) => b.owningClauseId === null)).toBe(true);
  });
  it("tolerates a job with no linked quote (quoteId null)", () => {
    const noQuote = seedReconciliation("j", clauses(), null);
    expect(noQuote.quoteId).toBeNull();
    expect(noQuote.boqClassifications).toEqual([]);
  });
});

describe("detectFindings — each kind fires", () => {
  it("clause_unpriced_unclassified for every unclear clause (amber)", () => {
    const rec = seedReconciliation("j", clauses(), quote());
    const f = detectFindings(rec);
    expect(f.filter((x) => x.kind === "clause_unpriced_unclassified")).toHaveLength(5);
    expect(f.every((x) => x.severity === "amber" || x.kind !== "clause_unpriced_unclassified")).toBe(true);
  });

  it("excluded_with_obligation (red) when an excluded clause keeps a note/doc", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_disposal", { classification: "excluded", note: "still must make safe" });
    // clear the others so only the disposal finding is interesting
    const f = detectFindings(rec);
    const hit = f.find((x) => x.kind === "excluded_with_obligation");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("red");
    expect(hit?.clauseId).toBe("sw_disposal");
  });

  it("priced_line_no_clause (amber) for an unowned, non-alternate line", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    // mark PL3 as alternate so only ZIP is the bare unowned line
    rec = ScopeReconciliationSchema.parse({
      ...rec,
      boqClassifications: rec.boqClassifications.map((b) =>
        boqLineRefKey(b.ref) === KEY_PL3 ? { ...b, isAlternate: true } : b,
      ),
    });
    const f = detectFindings(rec);
    const zip = f.find((x) => x.kind === "priced_line_no_clause" && boqLineRefKey(x.ref!) === KEY_ZIP);
    expect(zip).toBeDefined();
    // the alternate line is NOT reported as priced_line_no_clause
    expect(f.some((x) => x.kind === "priced_line_no_clause" && boqLineRefKey(x.ref!) === KEY_PL3)).toBe(false);
  });

  it("alternate_in_base_total (red) when an alternate line is tied to a clause", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = ScopeReconciliationSchema.parse({
      ...rec,
      boqClassifications: rec.boqClassifications.map((b) =>
        boqLineRefKey(b.ref) === KEY_PL3 ? { ...b, isAlternate: true, owningClauseId: "sw_zip" } : b,
      ),
    });
    const hit = detectFindings(rec).find((x) => x.kind === "alternate_in_base_total");
    expect(hit?.severity).toBe("red");
    expect(boqLineRefKey(hit!.ref!)).toBe(KEY_PL3);
  });
});

describe("clause↔BOQ-line linking (the quote half of AC1)", () => {
  const ZIP_REF = { quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" };

  it("classifying a clause with boqLineRefs marks the lines owned — priced_line_no_clause clears", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    expect(
      detectFindings(rec).some(
        (f) => f.kind === "priced_line_no_clause" && boqLineRefKey(f.ref!) === KEY_ZIP,
      ),
    ).toBe(true);
    rec = classifyClause(rec, "sw_zip", { classification: "priced", boqLineRefs: [ZIP_REF] });
    const zipRecord = rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === KEY_ZIP);
    expect(zipRecord?.owningClauseId).toBe("sw_zip");
    expect(
      detectFindings(rec).some(
        (f) => f.kind === "priced_line_no_clause" && boqLineRefKey(f.ref!) === KEY_ZIP,
      ),
    ).toBe(false);
  });

  it("unlinking (empty boqLineRefs) releases the line — the finding reopens", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_zip", { classification: "priced", boqLineRefs: [ZIP_REF] });
    rec = classifyClause(rec, "sw_zip", { classification: "priced", boqLineRefs: [] });
    const zipRecord = rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === KEY_ZIP);
    expect(zipRecord?.owningClauseId).toBeNull();
    expect(
      detectFindings(rec).some(
        (f) => f.kind === "priced_line_no_clause" && boqLineRefKey(f.ref!) === KEY_ZIP,
      ),
    ).toBe(true);
  });

  it("a patch WITHOUT boqLineRefs never disturbs an existing link", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_zip", { classification: "priced", boqLineRefs: [ZIP_REF] });
    rec = classifyClause(rec, "sw_zip", { classification: "priced", note: "re-noted" });
    const zipRecord = rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === KEY_ZIP);
    expect(zipRecord?.owningClauseId).toBe("sw_zip");
  });

  it("a ref naming a line the quote doesn't have owns nothing (no invented money)", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_zip", {
      classification: "priced",
      boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_ghost" }],
    });
    expect(rec.boqClassifications.every((b) => b.owningClauseId === null)).toBe(true);
  });

  it("linking a line marked alternate raises the red alternate_in_base_total", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = setBoqLineAlternate(rec, { quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_pl3" }, true);
    rec = classifyClause(rec, "sw_zip", {
      classification: "priced",
      boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_pl3" }],
    });
    const hit = detectFindings(rec).find((f) => f.kind === "alternate_in_base_total");
    expect(hit?.severity).toBe("red");
    expect(boqLineRefKey(hit!.ref!)).toBe(KEY_PL3);
  });

  it("setBoqLineAlternate marks/unmarks a real line and ignores an unknown ref", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    const pl3Ref = { quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_pl3" };
    rec = setBoqLineAlternate(rec, pl3Ref, true);
    expect(rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === KEY_PL3)?.isAlternate).toBe(true);
    // an alternate is not unattributed money
    expect(
      detectFindings(rec).some(
        (f) => f.kind === "priced_line_no_clause" && boqLineRefKey(f.ref!) === KEY_PL3,
      ),
    ).toBe(false);
    rec = setBoqLineAlternate(rec, pl3Ref, false);
    expect(rec.boqClassifications.find((b) => boqLineRefKey(b.ref) === KEY_PL3)?.isAlternate).toBe(false);
    const before = rec;
    const after = setBoqLineAlternate(rec, { ...pl3Ref, lineId: "ql_ghost" }, true);
    expect(after).toEqual(before);
  });

  it("a clause-side ref on a PRIOR overlay still counts as ownership (defensive both-ways match)", () => {
    // A persisted overlay written with only the clause half of the link (e.g. a
    // hand-authored prior) must not report the line unattributed.
    let rec = seedReconciliation("j", clauses(), quote());
    rec = ScopeReconciliationSchema.parse({
      ...rec,
      clauseClassifications: rec.clauseClassifications.map((c) =>
        c.clauseId === "sw_zip" ? { ...c, classification: "priced", boqLineRefs: [ZIP_REF] } : c,
      ),
    });
    expect(
      detectFindings(rec).some(
        (f) => f.kind === "priced_line_no_clause" && boqLineRefKey(f.ref!) === KEY_ZIP,
      ),
    ).toBe(false);
  });
});

describe("reconciliationStatus", () => {
  it("amber while clauses remain unclear", () => {
    expect(reconciliationStatus(seedReconciliation("j", clauses(), quote()))).toBe("amber");
  });
  it("red when a red finding is open", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_disposal", { classification: "excluded", note: "make safe" });
    expect(reconciliationStatus(rec)).toBe("red");
  });
  it("green only when every clause is classified and every conflict resolved", () => {
    let rec = seedReconciliation("j", clauses().slice(0, 1), quote());
    // classify the one clause as priced + own the ZIP line, mark PL3 alternate(unowned)
    rec = classifyClause(rec, "sw_zip", {
      classification: "priced",
      boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" }],
    });
    rec = ScopeReconciliationSchema.parse({
      ...rec,
      boqClassifications: rec.boqClassifications.map((b) => {
        if (boqLineRefKey(b.ref) === KEY_ZIP) return { ...b, owningClauseId: "sw_zip" };
        if (boqLineRefKey(b.ref) === KEY_PL3) return { ...b, isAlternate: true };
        return b;
      }),
    });
    expect(detectFindings(rec)).toEqual([]);
    expect(reconciliationStatus(rec)).toBe("green");
  });
  it("an empty reconciliation is green", () => {
    expect(reconciliationStatus(seedReconciliation("j", [], null))).toBe("green");
  });
});

describe("resolution durability (AC5)", () => {
  it("a resolution suppresses its finding and survives re-reconciliation", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_disposal", { classification: "excluded", note: "make safe" });
    const key = detectFindings(rec).find((f) => f.kind === "excluded_with_obligation")!.key;

    rec = applyResolution(rec, { findingKey: key, action: "accepted", reason: "priced as daywork", by: "admin", at: "t" });
    expect(detectFindings(rec).some((f) => f.key === key)).toBe(false);

    // edit scope (add a clause) → reconcile → resolution still present, finding still suppressed
    const more = [...clauses(), { id: "sw_new", title: "new", detail: "", order: 9 }];
    rec = reconcile(rec, more, quote());
    expect(rec.resolutions.some((r) => r.findingKey === key)).toBe(true);
    expect(detectFindings(rec).some((f) => f.key === key)).toBe(false);
    // the disposal classification (excluded) is preserved across reconcile
    expect(rec.clauseClassifications.find((c) => c.clauseId === "sw_disposal")?.classification).toBe("excluded");
  });

  it("applyResolution replaces a prior resolution for the same key (idempotent)", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = applyResolution(rec, { findingKey: "k", action: "resolved", by: "a", at: "t1" });
    rec = applyResolution(rec, { findingKey: "k", action: "accepted", by: "b", at: "t2" });
    expect(rec.resolutions.filter((r) => r.findingKey === "k")).toHaveLength(1);
    expect(rec.resolutions[0]?.by).toBe("b");
  });

  it("reconcile drops a deleted clause's classification but keeps resolutions", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_av", { classification: "by_others" });
    rec = applyResolution(rec, { findingKey: "ghost", action: "accepted", by: "a", at: "t" });
    rec = reconcile(rec, clauses().filter((c) => c.id !== "sw_av"), quote());
    expect(rec.clauseClassifications.some((c) => c.clauseId === "sw_av")).toBe(false);
    expect(rec.resolutions.some((r) => r.findingKey === "ghost")).toBe(true);
  });
});

describe("warningsForCompile — the #367 hand-off", () => {
  it("emits text only for warning-bearing classifications that carry it", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_av", {
      classification: "by_others",
      warningText: "A/V hardware by others — cabling only",
    });
    rec = classifyClause(rec, "sw_sensors", {
      classification: "reuse_existing",
      warningText: "Reuse existing sensors — verify, don't replace",
    });
    // priced clause with no warning text → not emitted
    rec = classifyClause(rec, "sw_zip", { classification: "priced" });
    const w = warningsForCompile(rec);
    expect(w.map((x) => x.clauseId).sort()).toEqual(["sw_av", "sw_sensors"]);
    expect(w.find((x) => x.clauseId === "sw_av")?.warningText).toMatch(/cabling only/);
  });

  it("does not emit for a warning class with no authored text", () => {
    let rec = seedReconciliation("j", clauses(), quote());
    rec = classifyClause(rec, "sw_av", { classification: "by_others" }); // no warningText
    expect(warningsForCompile(rec)).toEqual([]);
  });
});

describe("schema", () => {
  it("round-trips with passthrough (future #366 fields survive)", () => {
    const rec = ScopeReconciliationSchema.parse({
      jobId: "j",
      clauseClassifications: [{ clauseId: "c", classification: "priced", futureField: 1 }],
    }) as { clauseClassifications: Array<Record<string, unknown>> };
    expect(rec.clauseClassifications[0]?.futureField).toBe(1);
  });
  it("rejects an out-of-enum classification", () => {
    expect(() =>
      ScopeReconciliationSchema.parse({
        jobId: "j",
        clauseClassifications: [{ clauseId: "c", classification: "nope" }],
      }),
    ).toThrow();
  });
});
