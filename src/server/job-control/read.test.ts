import { describe, expect, it, vi } from "vitest";
import { buildAreaTaskContext } from "@/components/phil/philTaskContext";
import {
  blobJobControlReadDeps,
  buildJobControlReadResult,
  readJobControlForField,
  type JobControlReadDeps,
} from "./read";

// ── A valid compiled artifact (L1 PersistedJobControl shape) ──────────────────

function rawArtifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job_1",
    workPackages: [
      {
        id: "wp_1",
        jobId: "job_1",
        title: "East Gym",
        scopeClauseIds: ["sw_zip"],
        boqLineRefs: [],
        taskRefs: [{ areaId: "a1", stage: "roughIn", taskId: "t1" }],
        order: 0,
        scopeNote: "Run a dedicated 20A circuit.",
        requiredEvidence: [{ id: "re1", label: "Photo of the board", kind: "photo" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [
      { id: "el_1", jobId: "job_1", evidenceId: "ev1", workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" },
    ],
    updatedAt: "2026-06-15T00:00:00.000Z",
    compileMeta: {
      generatedAt: "2026-06-14T00:00:00.000Z",
      confirmedAt: "2026-06-15T00:00:00.000Z",
      confirmedBy: "u_admin",
      compilerVersion: "1",
      sourceHash: "compile-source-hash",
      sourceReconciliationHash: "recon-source-hash",
      sourceStructureHash: "structure-hash",
      gaps: [{ kind: "unclassified_clause", clauseId: "sw_ghost", message: "not classified" }],
      diff: { added: 1, updated: 0, removed: 0 },
    },
    ...over,
  };
}

// ── Read boundary ──────────────────────────────────────────────────────────--

describe("buildJobControlReadResult", () => {
  it("missing artifact → ready:false, honest empty", () => {
    const r = buildJobControlReadResult("job_1", null);
    expect(r).toEqual({
      ok: true,
      ready: false,
      jobId: "job_1",
      reason: "missing",
      workPackages: [],
      evidenceLinks: [],
    });
  });

  it("valid artifact → ready:true with workPackages + evidenceLinks + light meta", () => {
    const r = buildJobControlReadResult("job_1", rawArtifact());
    expect(r.ok).toBe(true);
    if (!r.ok || !r.ready) throw new Error("expected ready");
    expect(r.workPackages).toHaveLength(1);
    expect(r.workPackages[0]!.id).toBe("wp_1");
    expect(r.evidenceLinks).toHaveLength(1);
    expect(r.meta).toMatchObject({
      generatedAt: "2026-06-14T00:00:00.000Z",
      confirmedAt: "2026-06-15T00:00:00.000Z",
      sourceHash: "compile-source-hash",
    });
    // a field-safe stale-write precondition token (a one-way digest, not office data)
    expect(r.meta.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("unreadable / invalid artifact → ok:false, no crash", () => {
    const r = buildJobControlReadResult("job_1", { jobId: "job_1", workPackages: "not-an-array" });
    expect(r).toMatchObject({ ok: false, reason: "unreadable", workPackages: [], evidenceLinks: [] });
  });

  it("jobId mismatch is rejected", () => {
    const r = buildJobControlReadResult("job_1", rawArtifact({ jobId: "job_OTHER" }));
    expect(r).toMatchObject({ ok: false, reason: "job_mismatch", workPackages: [], evidenceLinks: [] });
  });

  it("returns ONLY the field-safe subset — no gaps, no compileMeta, no source fingerprints", () => {
    const r = buildJobControlReadResult("job_1", rawArtifact());
    expect(r.ok).toBe(true);
    if (!r.ok || !r.ready) throw new Error("expected ready");
    // office-only internals never leak to the field
    expect("gaps" in r).toBe(false);
    expect("compileMeta" in r).toBe(false);
    expect(Object.keys(r.meta).sort()).toEqual(["confirmedAt", "generatedAt", "revision", "sourceHash"]);
    expect("sourceReconciliationHash" in r.meta).toBe(false);
    expect("sourceStructureHash" in r.meta).toBe(false);
  });

  it("LEAK GUARD: office internals never appear ANYWHERE in the serialized field result", () => {
    // Future-proofs the explicit field-pick (the boundary relies on hand-written
    // selection over .passthrough() schemas — a spread refactor would leak).
    const r = buildJobControlReadResult("job_1", rawArtifact());
    const serialized = JSON.stringify(r);
    for (const forbidden of [
      "compileMeta",
      "gaps",
      "sourceReconciliationHash",
      "sourceStructureHash",
      "unclassified_clause", // a gap kind that exists in the artifact
      "recon-source-hash", // the office reconciliation fingerprint value
      "structure-hash",
      "confirmedBy",
      "diff",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("readJobControlForField", () => {
  it("delegates to loadRaw and never writes", async () => {
    const loadRaw = vi.fn(async () => rawArtifact());
    const deps: JobControlReadDeps = { loadRaw };
    const r = await readJobControlForField(deps, "job_1");
    expect(loadRaw).toHaveBeenCalledWith("job_1");
    expect(r.ok).toBe(true);
    // The deps surface is read-only — there is no write/save capability at all.
    expect(Object.keys(deps)).toEqual(["loadRaw"]);
  });

  it("missing artifact via deps → honest empty", async () => {
    const r = await readJobControlForField({ loadRaw: async () => null }, "job_1");
    expect(r).toMatchObject({ ok: true, ready: false, reason: "missing" });
  });

  it("blobJobControlReadDeps exposes only a read", () => {
    const deps = blobJobControlReadDeps();
    expect(typeof deps.loadRaw).toBe("function");
    expect(Object.keys(deps)).toEqual(["loadRaw"]);
  });
});

// ── L2 → L3 integration: read result feeds the Phil task-context adapter ───────

describe("read result wires into buildAreaTaskContext", () => {
  it("missing artifact → empty context map (Phil unchanged / honest empty)", () => {
    const read = buildJobControlReadResult("job_1", null);
    const map = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1", "t2"],
      workPackages: read.workPackages,
      evidenceLinks: read.evidenceLinks,
    });
    expect(map.size).toBe(0);
  });

  it("ready artifact → context lights up only for delivered tasks; evidence met from the link", () => {
    const read = buildJobControlReadResult("job_1", rawArtifact());
    if (!read.ok || !read.ready) throw new Error("expected ready");
    const map = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1", "t2"],
      workPackages: read.workPackages,
      evidenceLinks: read.evidenceLinks,
    });
    expect(map.has("t1")).toBe(true);
    expect(map.has("t2")).toBe(false); // a task no package delivers renders plainly
    const ctx = map.get("t1")!;
    expect(ctx.scopeNote).toBe("Run a dedicated 20A circuit.");
    expect(ctx.requiredEvidence[0]!.met).toBe(true); // el_1 names re1 on wp_1
  });

  it("a gap/unclassified clause never becomes a task (gaps are not in the field read)", () => {
    const read = buildJobControlReadResult("job_1", rawArtifact());
    if (!read.ok || !read.ready) throw new Error("expected ready");
    // sw_ghost is a compile GAP (office-side) — it is not a work package, not a
    // task ref, and is absent from the field read entirely.
    const taskIdsFromPackages = read.workPackages.flatMap((wp) => wp.taskRefs.map((t) => t.taskId));
    expect(taskIdsFromPackages).not.toContain("sw_ghost");
    const map = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["sw_ghost"],
      workPackages: read.workPackages,
      evidenceLinks: read.evidenceLinks,
    });
    expect(map.has("sw_ghost")).toBe(false);
  });

  it("does not mutate the evidenceLinks passed through", () => {
    const read = buildJobControlReadResult("job_1", rawArtifact());
    if (!read.ok || !read.ready) throw new Error("expected ready");
    const before = JSON.stringify(read.evidenceLinks);
    buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1"],
      workPackages: read.workPackages,
      evidenceLinks: read.evidenceLinks,
    });
    expect(JSON.stringify(read.evidenceLinks)).toBe(before);
  });
});
