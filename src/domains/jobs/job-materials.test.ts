import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Pure helpers of the per-job materials SPEND ledger store
 * (api/_lib/job-materials.js, owner pull 2026-08-23). Money is integer cents;
 * removal is a soft delete; totals exclude tombstoned lines.
 */
const requireFromHere = createRequire(import.meta.url);
const lib = requireFromHere("../../../api/_lib/job-materials.js") as {
  validateLineInput: (body: unknown) => { ok: true; value: Line } | { ok: false; error: string };
  appendLine: (
    data: unknown,
    value: Line,
    actor: unknown
  ) => { data?: { lines: Stored[] }; line?: Stored; error?: string };
  removeLine: (
    data: unknown,
    id: string,
    actor: unknown
  ) => { data: { lines: Stored[] }; line: Stored } | null;
  summariseLedger: (data: unknown) => { lines: Stored[]; totalCents: number; count: number };
  activeLines: (data: unknown) => Stored[];
  keyFor: (jobId: string) => string;
  MAX_LINES: number;
};

type Line = { date: string; supplier: string; description: string | null; amountCents: number };
type Stored = Line & {
  id: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  deletedAt?: string;
  deletedBy?: string;
  deletedByName?: string;
};

const actor = { id: "u_admin", username: "boss", name: "Karen Boss" };

describe("validateLineInput", () => {
  it("accepts a real date, a supplier, an optional description and positive integer cents", () => {
    const r = lib.validateLineInput({
      date: "2026-08-20",
      supplier: "  L&H  ",
      description: " 2.5mm TPS ",
      amountCents: 18450,
    });
    expect(r).toEqual({
      ok: true,
      value: { date: "2026-08-20", supplier: "L&H", description: "2.5mm TPS", amountCents: 18450 },
    });
  });

  it("normalises a blank description to null", () => {
    const r = lib.validateLineInput({
      date: "2026-08-20",
      supplier: "L&H",
      description: "   ",
      amountCents: 100,
    });
    expect(r.ok && r.value.description).toBeNull();
  });

  it("rejects a bad/impossible date, a missing supplier, and non-positive or fractional cents", () => {
    expect(
      lib.validateLineInput({ date: "20/08/2026", supplier: "x", amountCents: 1 })
    ).toMatchObject({ ok: false });
    expect(
      lib.validateLineInput({ date: "2026-02-31", supplier: "x", amountCents: 1 })
    ).toMatchObject({ ok: false });
    expect(
      lib.validateLineInput({ date: "2026-08-20", supplier: "", amountCents: 1 })
    ).toMatchObject({ ok: false });
    expect(
      lib.validateLineInput({ date: "2026-08-20", supplier: "x", amountCents: 0 })
    ).toMatchObject({ ok: false });
    expect(
      lib.validateLineInput({ date: "2026-08-20", supplier: "x", amountCents: 12.5 })
    ).toMatchObject({ ok: false });
    expect(
      lib.validateLineInput({ date: "2026-08-20", supplier: "x", amountCents: "184.50" })
    ).toMatchObject({ ok: false });
  });

  it("refuses an implausibly large amount (a typo guard, not a policy)", () => {
    expect(
      lib.validateLineInput({ date: "2026-08-20", supplier: "x", amountCents: 100_000_000_01 })
    ).toMatchObject({ ok: false });
  });
});

describe("appendLine / removeLine / summariseLedger", () => {
  const v1: Line = { date: "2026-08-20", supplier: "L&H", description: null, amountCents: 18450 };
  const v2: Line = { date: "2026-08-21", supplier: "MM", description: "GPOs", amountCents: 5000 };

  it("appends attributable lines (who/when) and sums the active ones, newest date first", () => {
    const a = lib.appendLine({ lines: [] }, v1, actor);
    const b = lib.appendLine(a.data, v2, actor);
    expect(b.data!.lines).toHaveLength(2);
    expect(b.line).toMatchObject({
      supplier: "MM",
      amountCents: 5000,
      createdBy: "u_admin",
      createdByName: "Karen Boss",
    });
    expect(b.line!.id).toMatch(/^ml_/);
    const s = lib.summariseLedger(b.data);
    expect(s.totalCents).toBe(23450);
    expect(s.count).toBe(2);
    expect(s.lines.map((l) => l.supplier)).toEqual(["MM", "L&H"]);
  });

  it("never mutates the input ledger", () => {
    const input = { lines: [] as Stored[] };
    lib.appendLine(input, v1, actor);
    expect(input.lines).toHaveLength(0);
  });

  it("removal is a soft delete: the line stays on record, leaves the total, and can't be removed twice", () => {
    const a = lib.appendLine({ lines: [] }, v1, actor);
    const id = a.line!.id;
    const r = lib.removeLine(a.data, id, { id: "u_admin", username: "boss" });
    expect(r).not.toBeNull();
    expect(r!.line).toMatchObject({ id, deletedBy: "u_admin", deletedByName: "boss" });
    expect(r!.line.deletedAt).toBeTruthy();
    expect(r!.data.lines).toHaveLength(1); // still on record
    expect(lib.summariseLedger(r!.data)).toMatchObject({ totalCents: 0, count: 0 });
    expect(lib.removeLine(r!.data, id, actor)).toBeNull();
    expect(lib.removeLine(r!.data, "nope", actor)).toBeNull();
  });

  it("ignores malformed amounts when totalling and tolerates a malformed store", () => {
    expect(lib.summariseLedger(null)).toEqual({ lines: [], totalCents: 0, count: 0 });
    expect(
      lib.summariseLedger({
        lines: [{ id: "x", date: "2026-01-01", supplier: "s", amountCents: "bad" }],
      }).totalCents
    ).toBe(0);
  });

  it("caps the ledger so a runaway writer can't bloat the blob", () => {
    const lines = Array.from({ length: lib.MAX_LINES }, (_, i) => ({
      ...v1,
      id: `ml_${i}`,
      createdBy: "u",
      createdByName: "u",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(lib.appendLine({ lines }, v2, actor).error).toMatch(/ledger full/);
  });

  it("keys the store per job under the backed-up jobs/ prefix", () => {
    expect(lib.keyFor("birdwood")).toBe("jobs/birdwood/materials-ledger.json");
  });
});
