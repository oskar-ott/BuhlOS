import { describe, expect, it, vi } from "vitest";
import { TestRecordInputSchema, type TestRecordInput } from "@/domains/test-records/schema";
import {
  applyTestRecord,
  blobTestRecordDeps,
  readTestRecords,
  testRecordsKey,
  writeTestRecord,
  type TestRecordDeps,
} from "./store";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function input(over: Record<string, unknown> = {}): TestRecordInput {
  return TestRecordInputSchema.parse({
    jobId: "job_1",
    reportType: "eicr",
    tester: "Sparky",
    testedAt: "2026-06-18T02:00:00.000Z",
    rows: [
      { circuit: "Ring final — kitchen", testType: "insulation_resistance", value: 200, unit: "MOhm", min: 1 },
    ],
    ...over,
  });
}

function ctx(id = "tr_1", at = "2026-06-18T03:00:00.000Z") {
  return { id, at, createdBy: "u_field" };
}

// ── Pure apply: append + supersede + immutability ─────────────────────────────

describe("applyTestRecord", () => {
  it("appends a derived record to an empty store (server-derives the status)", () => {
    const r = applyTestRecord({ records: [] }, input(), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.store.records).toHaveLength(1);
    expect(r.record.id).toBe("tr_1");
    // status is DERIVED from the value vs criteria, never client-asserted.
    expect(r.record.rows[0]!.status).toBe("pass");
    expect(r.record.overallStatus).toBe("pass");
    expect(r.record.createdBy).toBe("u_field");
  });

  it("a client-smuggled 'pass' is ignored — a value outside its limit derives fail", () => {
    const r = applyTestRecord(
      { records: [] },
      input({ rows: [{ circuit: "Zs", testType: "earth_fault_loop_zs", value: 5, max: 1.37, status: "pass" }] }),
      ctx(),
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.record.rows[0]!.status).toBe("fail");
    expect(r.record.overallStatus).toBe("fail");
  });

  it("does NOT mutate the input store (immutability)", () => {
    const store = { records: [] };
    const before = JSON.stringify(store);
    applyTestRecord(store, input(), ctx());
    expect(JSON.stringify(store)).toBe(before);
    expect(store.records).toHaveLength(0);
  });

  it("supersede-by-revision: a correction is a NEW record that LEAVES the prior one in place", () => {
    const first = applyTestRecord({ records: [] }, input(), ctx("tr_1"));
    if (!first.ok) throw new Error("expected ok");

    const correction = applyTestRecord(
      first.store,
      input({
        supersedesId: "tr_1",
        rows: [{ circuit: "Ring final — kitchen", testType: "insulation_resistance", value: 250, min: 1 }],
      }),
      ctx("tr_2", "2026-06-18T04:00:00.000Z"),
    );
    if (!correction.ok) throw new Error("expected ok");

    // Both records exist — the original is untouched, the correction names it.
    expect(correction.store.records.map((r) => r.id)).toEqual(["tr_1", "tr_2"]);
    const original = correction.store.records.find((r) => r.id === "tr_1")!;
    expect(original.rows[0]!.value).toBe(200); // byte-identical — never edited
    const next = correction.store.records.find((r) => r.id === "tr_2")!;
    expect(next.supersedesId).toBe("tr_1");
    expect(next.rows[0]!.value).toBe(250);
  });

  it("rejects a correction that supersedes a record that does not exist (no dangling)", () => {
    const r = applyTestRecord({ records: [] }, input({ supersedesId: "tr_ghost" }), ctx());
    expect(r).toEqual({ ok: false, reason: "unknown_supersede" });
  });
});

// ── Orchestration via injected deps ───────────────────────────────────────────

describe("writeTestRecord", () => {
  it("first write on a job starts from an empty store and saves the appended record", async () => {
    const saved: unknown[] = [];
    const deps: TestRecordDeps = {
      loadRaw: vi.fn(async () => null), // missing store = first write
      save: vi.fn(async (_jobId, store) => {
        saved.push(store);
      }),
      mintId: () => "tr_minted",
    };
    const res = await writeTestRecord(deps, {
      jobId: "job_1",
      record: input(),
      at: "2026-06-18T03:00:00.000Z",
      createdBy: "u_field",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.record.id).toBe("tr_minted");
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect((saved[0] as { records: unknown[] }).records).toHaveLength(1);
  });

  it("appends to an existing store (read → append → write the full document)", async () => {
    const first = applyTestRecord({ records: [] }, input(), ctx("tr_existing"));
    if (!first.ok) throw new Error("seed");
    const deps: TestRecordDeps = {
      loadRaw: vi.fn(async () => first.store),
      save: vi.fn(async () => {}),
      mintId: () => "tr_new",
    };
    const res = await writeTestRecord(deps, {
      jobId: "job_1",
      record: input({ rows: [{ circuit: "c2", testType: "polarity" }] }),
      at: "2026-06-18T05:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    const savedStore = (deps.save as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      records: { id: string }[];
    };
    expect(savedStore.records.map((r) => r.id)).toEqual(["tr_existing", "tr_new"]);
  });

  it("an UNREADABLE store is failed-soft with NO write (never clobbers existing records)", async () => {
    const deps: TestRecordDeps = {
      loadRaw: vi.fn(async () => ({ records: "not-an-array" })),
      save: vi.fn(async () => {}),
      mintId: () => "tr_x",
    };
    const res = await writeTestRecord(deps, {
      jobId: "job_1",
      record: input(),
      at: "2026-06-18T03:00:00.000Z",
    });
    expect(res).toMatchObject({ ok: false, status: 409, reason: "unreadable" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("a supersede precondition failure does NOT write", async () => {
    const deps: TestRecordDeps = {
      loadRaw: vi.fn(async () => ({ records: [] })),
      save: vi.fn(async () => {}),
      mintId: () => "tr_x",
    };
    const res = await writeTestRecord(deps, {
      jobId: "job_1",
      record: input({ supersedesId: "tr_ghost" }),
      at: "2026-06-18T03:00:00.000Z",
    });
    expect(res).toMatchObject({ ok: false, status: 409, reason: "unknown_supersede" });
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("readTestRecords", () => {
  it("missing store → empty list (never throws)", async () => {
    const r = await readTestRecords({ loadRaw: async () => null }, "job_1");
    expect(r).toEqual({ records: [] });
  });

  it("unreadable store → empty list (never throws)", async () => {
    const r = await readTestRecords({ loadRaw: async () => ({ records: 5 }) }, "job_1");
    expect(r).toEqual({ records: [] });
  });

  it("returns the stored records", async () => {
    const seed = applyTestRecord({ records: [] }, input(), ctx("tr_seed"));
    if (!seed.ok) throw new Error("seed");
    const r = await readTestRecords({ loadRaw: async () => seed.store }, "job_1");
    expect(r.records.map((x) => x.id)).toEqual(["tr_seed"]);
  });
});

describe("blob wiring", () => {
  it("the store key is the per-job test-records blob", () => {
    expect(testRecordsKey("job_42")).toBe("jobs/job_42/test-records.json");
  });

  it("blobTestRecordDeps mints a tr_ prefixed id and exposes load/save", () => {
    const deps = blobTestRecordDeps();
    expect(deps.mintId()).toMatch(/^tr_/);
    expect(typeof deps.loadRaw).toBe("function");
    expect(typeof deps.save).toBe("function");
  });
});
