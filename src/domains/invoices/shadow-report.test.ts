import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Task F (2026-09-27): the automatic-booking shadow comparison — what the
 * evaluator WOULD have booked vs what a person did — judged from an
 * invoice's own history. Every bucket is proven here, including the two the
 * report must never fake: "no human outcome yet" is unresolved, and a
 * verdict without a snapshot is legacy/unknown, never agreement.
 */
const requireFromHere = createRequire(import.meta.url);
const lib = requireFromHere("../../../api/_lib/invoices/shadow-report.js") as {
  judgeInvoice: (inv: Row, events: Row[], allocations: Row[]) => Row;
  buildShadowReport: (input: { invoices: Row[]; events: Row[]; allocations: Row[]; from: string; to: string; generatedAt?: string }) => Report;
  releaseGate: (report: Report) => { pass: boolean; checks: Array<{ code: string; ok: boolean; detail: string }>; suppliersReady: string[] };
  RELEASE_GATE: { minSample: number };
};
type Row = Record<string, unknown>;
type Report = {
  sampleSize: number; neverEvaluated: number; setAside: number; legacyVerdicts: number; unresolved: number;
  wouldHaveBooked: { count: number; agreed: number; falsePositives: number; unresolved: number; autoBookedStands: number; autoBookedThenReversed: number; falsePositiveReasons: Record<string, number> };
  wouldHaveWaited: { count: number; correct: number; falseNegatives: number; unresolved: number; falseNegativeReasons: Record<string, number> };
  agreement: { job: Record<string, number>; supplier: Record<string, number>; figures: Record<string, number> };
  humanExclusions: number; humanJobChanges: number;
  disagreements: Array<{ invoiceId: string; kind: string; reasons: string[] }>;
  bySupplier: Array<{ supplierKey: string | null; sample: number; agreed: number; falsePositives: number; falseNegatives: number; unresolved: number }>;
};

let t = 0;
const at = () => new Date(Date.UTC(2026, 8, 20, 0, 0, ++t)).toISOString();
const human = { name: "Karen Boss", role: "admin" };
const system = { name: "BuhlOS (auto)", role: "system" };

function inv(id: string, over: Row = {}): Row {
  return { id, supplierKey: "sparky", supplierName: "Sparky Supplies", supplierInvoiceNumber: `SS-${id}`, status: "confirmed", excludedReason: null, autoConfirmChecks: [], ...over };
}
function ev(invoiceId: string, event: string, detail: Row = {}, actor: Row | null = null): Row {
  return { invoiceId, event, detail, actor: actor?.name ?? null, actorRole: actor?.role ?? null, at: at() };
}
const verdict = (id: string, eligible: boolean, extra: Row = {}) =>
  ev(id, eligible ? "auto_confirm_eligible" : "auto_confirm_ineligible", { at: null, failed: eligible ? [] : ["supplier_trusted"], jobId: "birdwood", amountCents: 10000, supplierKey: "sparky", ...extra });
const alloc = (invoiceId: string, jobId = "birdwood", amountCents = 10000, status = "active"): Row => ({ invoiceId, jobId, amountCents, status });

describe("judgeInvoice — one invoice", () => {
  it("never evaluated: no verdict event → not a shadow decision", () => {
    expect(lib.judgeInvoice(inv("a", { status: "needs_review" }), [ev("a", "review_required")], [])).toMatchObject({ kind: "never_evaluated" });
  });

  it("would have booked, person confirmed the same job and figures → agreed", () => {
    const j = lib.judgeInvoice(inv("b"), [verdict("b", true), ev("b", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human)], [alloc("b")]);
    expect(j).toMatchObject({ kind: "agreed", jobAgreement: "agree", figuresAgreement: "agree", supplierAgreement: "agree", legacy: false });
  });

  it("would have booked, person moved it to another job → false positive (job_changed)", () => {
    const j = lib.judgeInvoice(inv("c"), [verdict("c", true), ev("c", "job_selected", { jobId: "kent-st" }, human), ev("c", "confirmed", { jobId: "kent-st", amountCents: 10000 }, human)], [alloc("c", "kent-st")]);
    expect(j).toMatchObject({ kind: "false_positive", jobAgreement: "differ", reasons: ["job_changed"] });
  });

  it("would have booked, person corrected the figures → false positive (figures_changed)", () => {
    const j = lib.judgeInvoice(inv("d"), [verdict("d", true), ev("d", "corrected", { fields: ["subtotalCents"] }, human), ev("d", "confirmed", { jobId: "birdwood", amountCents: 12000 }, human)], [alloc("d", "birdwood", 12000)]);
    expect(j).toMatchObject({ kind: "false_positive", figuresAgreement: "differ", reasons: ["figures_changed"] });
  });

  it("would have booked, person excluded it → false positive (excluded_by_person); set-aside paperwork is not a person's call", () => {
    expect(lib.judgeInvoice(inv("e", { status: "excluded", excludedReason: "statement" }), [verdict("e", true), ev("e", "excluded", { reason: "statement" }, human)], [])).toMatchObject({ kind: "false_positive", reasons: ["excluded_by_person"] });
    expect(lib.judgeInvoice(inv("e2", { status: "excluded", excludedReason: "not_an_invoice:delivery_docket" }), [verdict("e2", true)], [])).toMatchObject({ kind: "set_aside" });
  });

  it("would have waited, person booked it untouched → false negative carrying the failed check codes", () => {
    const j = lib.judgeInvoice(inv("f"), [verdict("f", false), ev("f", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human)], [alloc("f")]);
    expect(j).toMatchObject({ kind: "false_negative", reasons: ["supplier_trusted"] });
  });

  it("would have waited, person had to change something first → waited correctly", () => {
    const j = lib.judgeInvoice(inv("g"), [verdict("g", false), ev("g", "corrected", { fields: ["gstCents"] }, human), ev("g", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human)], [alloc("g")]);
    expect(j).toMatchObject({ kind: "waited_correctly", reasons: ["corrected"] });
  });

  it("no human outcome yet → unresolved, whatever the verdict", () => {
    expect(lib.judgeInvoice(inv("h", { status: "matched" }), [verdict("h", true)], [])).toMatchObject({ kind: "unresolved", status: "matched" });
    expect(lib.judgeInvoice(inv("h2", { status: "needs_review" }), [verdict("h2", false)], [])).toMatchObject({ kind: "unresolved" });
  });

  it("booked automatically and left alone → stands; reversed by a person afterwards → the realised false positive", () => {
    expect(lib.judgeInvoice(inv("i"), [ev("i", "auto_confirm_scheduled", { jobId: "birdwood", amountCents: 10000, supplierKey: "sparky", failed: [] }), ev("i", "confirmed", { jobId: "birdwood", amountCents: 10000 }, system)], [alloc("i")])).toMatchObject({ kind: "auto_booked_stands" });
    const reversed = lib.judgeInvoice(inv("j", { status: "excluded", excludedReason: "wrong supplier" }), [ev("j", "auto_confirm_scheduled", { jobId: "birdwood", amountCents: 10000, supplierKey: "sparky", failed: [] }), ev("j", "confirmed", { jobId: "birdwood", amountCents: 10000 }, system), ev("j", "excluded", { reason: "wrong supplier" }, human)], [alloc("j", "birdwood", 10000, "reversed")]);
    expect(reversed).toMatchObject({ kind: "auto_booked_then_reversed", reasons: ["reversed_by_person"] });
  });

  it("a legacy verdict (no snapshot) takes the job from the preceding `matched` event and the amount from the under_cap check; missing pieces stay unknown", () => {
    const matched = ev("k", "matched", { jobId: "birdwood" });
    const legacy = ev("k", "auto_confirm_eligible", { at: null, failed: [] });
    const events = [matched, legacy, ev("k", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human)];
    const withChecks = lib.judgeInvoice(inv("k", { autoConfirmChecks: [{ code: "under_cap", ok: true, detail: "10000 < 500000 cents" }] }), events, [alloc("k")]);
    expect(withChecks).toMatchObject({ kind: "agreed", legacy: true, jobAgreement: "agree", figuresAgreement: "agree", supplierAgreement: "unknown" });
    const noChecks = lib.judgeInvoice(inv("k2", { autoConfirmChecks: [] }), events.map((e) => ({ ...e, invoiceId: "k2" })), [alloc("k2")]);
    expect(noChecks).toMatchObject({ kind: "agreed", legacy: true, figuresAgreement: "unknown" });
  });
});

describe("buildShadowReport — the numbers", () => {
  const invoices = [
    inv("agree"), inv("wrongjob"), inv("fn"), inv("open", { status: "matched" }), inv("never", { status: "needs_review", supplierKey: "wires", supplierName: "Wholesale Wires" }),
    inv("excluded", { status: "excluded", excludedReason: "not ours", supplierKey: "wires", supplierName: "Wholesale Wires" }),
  ];
  const events = [
    verdict("agree", true), ev("agree", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human),
    verdict("wrongjob", true), ev("wrongjob", "job_selected", { jobId: "kent-st" }, human), ev("wrongjob", "confirmed", { jobId: "kent-st", amountCents: 10000 }, human),
    verdict("fn", false), ev("fn", "confirmed", { jobId: "birdwood", amountCents: 10000 }, human),
    verdict("open", true),
    ev("never", "review_required"),
    verdict("excluded", true, { supplierKey: "wires" }), ev("excluded", "excluded", { reason: "not ours" }, human),
  ];
  const allocations = [alloc("agree"), alloc("wrongjob", "kent-st"), alloc("fn")];
  const report = lib.buildShadowReport({ invoices, events, allocations, from: "2026-09-01", to: "2026-09-30", generatedAt: "2026-09-30T00:00:00.000Z" });

  it("counts sample, never-evaluated and unresolved apart — unresolved is never correct or wrong", () => {
    expect(report.sampleSize).toBe(5);
    expect(report.neverEvaluated).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(report.wouldHaveBooked).toMatchObject({ count: 4, agreed: 1, falsePositives: 2, unresolved: 1, autoBookedStands: 0, autoBookedThenReversed: 0 });
    expect(report.wouldHaveBooked.falsePositiveReasons).toEqual({ job_changed: 1, excluded_by_person: 1 });
    expect(report.wouldHaveWaited).toMatchObject({ count: 1, correct: 0, falseNegatives: 1, unresolved: 0 });
    expect(report.wouldHaveWaited.falseNegativeReasons).toEqual({ supplier_trusted: 1 });
  });

  it("agreement dimensions exclude unresolved invoices and keep unknowns honest", () => {
    expect(report.agreement.job).toEqual({ agree: 2, differ: 1, unknown: 1 });
    expect(report.agreement.figures).toEqual({ agree: 3, differ: 0, unknown: 1 });
    expect(report.agreement.supplier).toEqual({ agree: 3, differ: 0, unknown: 1 });
    expect(report.humanJobChanges).toBe(1);
    expect(report.humanExclusions).toBe(1);
  });

  it("lists every disagreement with its reasons, and groups by supplier", () => {
    expect(report.disagreements.map((d) => `${d.kind}:${d.invoiceId}`).sort()).toEqual(["false_negative:fn", "false_positive:excluded", "false_positive:wrongjob"]);
    const sparky = report.bySupplier.find((s) => s.supplierKey === "sparky");
    const wires = report.bySupplier.find((s) => s.supplierKey === "wires");
    expect(sparky).toMatchObject({ sample: 4, agreed: 1, falsePositives: 1, falseNegatives: 1, unresolved: 1 });
    expect(wires).toMatchObject({ sample: 1, agreed: 0, falsePositives: 1, unresolved: 0 });
  });

  it("the release gate fails on this evidence, naming each failing check", () => {
    const gate = lib.releaseGate(report);
    expect(gate.pass).toBe(false);
    const failing = gate.checks.filter((c) => !c.ok).map((c) => c.code);
    expect(failing).toEqual(expect.arrayContaining(["sample_size", "zero_wrong_job", "zero_false_positives"]));
    expect(gate.suppliersReady).toEqual([]);
  });

  it("the release gate passes only on a clean, large enough, mostly-resolved sample", () => {
    const n = lib.RELEASE_GATE.minSample;
    const cleanInvoices = Array.from({ length: n }, (_, i) => inv(`c${i}`));
    const cleanEvents = cleanInvoices.flatMap((r) => [verdict(String(r.id), true), ev(String(r.id), "confirmed", { jobId: "birdwood", amountCents: 10000 }, human)]);
    const cleanAllocs = cleanInvoices.map((r) => alloc(String(r.id)));
    const clean = lib.buildShadowReport({ invoices: cleanInvoices, events: cleanEvents, allocations: cleanAllocs, from: "2026-09-01", to: "2026-09-30" });
    const gate = lib.releaseGate(clean);
    expect(gate.pass).toBe(true);
    expect(gate.suppliersReady).toEqual(["sparky"]);
  });

  it("an empty period is an empty report, not an error", () => {
    const empty = lib.buildShadowReport({ invoices: [], events: [], allocations: [], from: "2026-01-01", to: "2026-01-31" });
    expect(empty.sampleSize).toBe(0);
    expect(lib.releaseGate(empty).pass).toBe(false);
  });
});
