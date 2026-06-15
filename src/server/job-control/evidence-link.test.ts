import { describe, expect, it, vi } from "vitest";
import { buildAreaTaskContext } from "@/components/phil/philTaskContext";
import { buildJobControlReadResult } from "./read";
import {
  EvidenceLinkRequestSchema,
  applyEvidenceLink,
  blobEvidenceLinkDeps,
  evidenceLinkRequestHasProof,
  writeEvidenceLink,
  type EvidenceLinkDeps,
  type EvidenceLinkRequest,
} from "./evidence-link";
import {
  PersistedJobControlSchema,
  jobControlRevisionOf,
  type PersistedJobControl,
} from "./compile-producer";

// ── Fixture: a compiled artifact with one package + two required-evidence items ─

function artifactRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
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
        requiredEvidence: [
          { id: "re1", label: "Circuit test", kind: "test_result" },
          { id: "re2", label: "Board photo", kind: "photo" },
        ],
      },
    ],
    claimLines: [
      { id: "cl_1", jobId: "job_1", description: "Claim 1", claimedAmount: 100, status: "draft", order: 0, boqLineRefs: [] },
    ],
    closeoutRequirements: [],
    evidenceLinks: [],
    updatedAt: "2026-06-15T00:00:00.000Z",
    compileMeta: {
      generatedAt: "2026-06-14T00:00:00.000Z",
      confirmedAt: "2026-06-15T00:00:00.000Z",
      confirmedBy: "u_admin",
      compilerVersion: "1",
      sourceHash: "compile-hash",
      sourceReconciliationHash: "recon-hash",
      sourceStructureHash: "structure-hash",
      gaps: [{ kind: "unclassified_clause", clauseId: "sw_ghost", message: "x" }],
      diff: { added: 1, updated: 0, removed: 0 },
    },
    ...over,
  };
}

function artifact(over: Record<string, unknown> = {}): PersistedJobControl {
  return PersistedJobControlSchema.parse(artifactRaw(over));
}

const AT = "2026-06-15T12:00:00.000Z";
const REQ: EvidenceLinkRequest = { workPackageId: "wp_1", requiredEvidenceId: "re1", evidenceId: "ev_123" };

/** The revision a caller would have read for a given raw artifact (matches the
 *  writer's stale-write precondition). */
function revOf(raw: unknown): string {
  return jobControlRevisionOf(PersistedJobControlSchema.parse(raw));
}

function fakeDeps(
  over: Partial<{ raw: unknown; idPrefix: string }> = {},
): EvidenceLinkDeps & {
  saved: PersistedJobControl[];
  save: ReturnType<typeof vi.fn>;
  loadRaw: ReturnType<typeof vi.fn>;
  /** The matching expected revision for the served artifact (undefined if missing/unreadable). */
  currentRevision: string | undefined;
} {
  const raw = "raw" in over ? over.raw : artifactRaw();
  const saved: PersistedJobControl[] = [];
  const save = vi.fn(async (_jobId: string, a: PersistedJobControl) => {
    saved.push(a);
  });
  const loadRaw = vi.fn(async () => raw);
  let n = 0;
  let currentRevision: string | undefined;
  try {
    currentRevision = raw == null ? undefined : revOf(raw);
  } catch {
    currentRevision = undefined; // unreadable raw
  }
  return { saved, save, loadRaw, mintId: () => `${over.idPrefix ?? "el_test_"}${++n}`, currentRevision };
}

/** A correct expected revision for the default fixture. */
const FIXTURE_REV = revOf(artifactRaw());

// ── Request guards ───────────────────────────────────────────────────────────

describe("evidence-link request", () => {
  it("requires a proof id (evidence or observation)", () => {
    expect(evidenceLinkRequestHasProof({ workPackageId: "wp_1", requiredEvidenceId: "re1" })).toBe(false);
    expect(evidenceLinkRequestHasProof({ workPackageId: "wp_1", requiredEvidenceId: "re1", evidenceId: "ev_1" })).toBe(true);
    expect(evidenceLinkRequestHasProof({ workPackageId: "wp_1", requiredEvidenceId: "re1", observationId: "ob_1" })).toBe(true);
  });
  it("schema rejects an unknown role", () => {
    expect(EvidenceLinkRequestSchema.safeParse({ workPackageId: "wp_1", requiredEvidenceId: "re1", evidenceId: "ev_1", role: "nope" }).success).toBe(false);
  });
});

// ── applyEvidenceLink (pure) ─────────────────────────────────────────────────

describe("applyEvidenceLink", () => {
  it("writes one link referencing the REAL saved evidence id, preserving everything else", () => {
    const before = artifact();
    const r = applyEvidenceLink(before, REQ, { id: "el_x", at: AT, createdBy: "u_worker" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.link.evidenceId).toBe("ev_123"); // real proof id, not fabricated
    expect(r.link.id).toBe("el_x");
    expect(r.link.workPackageId).toBe("wp_1");
    expect(r.link.requiredEvidenceId).toBe("re1");
    expect(r.link.role).toBe("progress"); // default
    expect(r.artifact.evidenceLinks).toHaveLength(1);
    // preservation
    expect(r.artifact.workPackages).toEqual(before.workPackages);
    expect(r.artifact.compileMeta).toEqual(before.compileMeta);
    expect(r.artifact.claimLines).toEqual(before.claimLines);
    expect(r.artifact.closeoutRequirements).toEqual(before.closeoutRequirements);
    // purity: the input is not mutated
    expect(before.evidenceLinks).toHaveLength(0);
  });

  it("invalid work package → no link", () => {
    const r = applyEvidenceLink(artifact(), { ...REQ, workPackageId: "wp_nope" }, { id: "el_x", at: AT });
    expect(r).toEqual({ ok: false, reason: "invalid_work_package" });
  });

  it("invalid required-evidence id → no link", () => {
    const r = applyEvidenceLink(artifact(), { ...REQ, requiredEvidenceId: "re_nope" }, { id: "el_x", at: AT });
    expect(r).toEqual({ ok: false, reason: "invalid_requirement" });
  });

  it("missing proof → no link", () => {
    const r = applyEvidenceLink(artifact(), { workPackageId: "wp_1", requiredEvidenceId: "re1" }, { id: "el_x", at: AT });
    expect(r).toEqual({ ok: false, reason: "missing_proof" });
  });

  it("is idempotent — re-linking the same proof creates no duplicate", () => {
    const linked = artifact({
      evidenceLinks: [
        { id: "el_existing", jobId: "job_1", evidenceId: "ev_123", workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" },
      ],
    });
    const r = applyEvidenceLink(linked, REQ, { id: "el_new", at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(false);
    expect(r.artifact.evidenceLinks).toHaveLength(1);
    expect(r.link.id).toBe("el_existing");
  });

  it("preserves an unrelated existing link and appends the new one", () => {
    const linked = artifact({
      evidenceLinks: [
        { id: "el_other", jobId: "job_1", evidenceId: "ev_999", workPackageId: "wp_1", requiredEvidenceId: "re2", role: "progress" },
      ],
    });
    const r = applyEvidenceLink(linked, REQ, { id: "el_new", at: AT });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.evidenceLinks.map((e) => e.id).sort()).toEqual(["el_new", "el_other"]);
  });
});

// ── writeEvidenceLink (orchestration) ─────────────────────────────────────────

describe("writeEvidenceLink", () => {
  it("valid target + matching revision → writes once and advances the revision", async () => {
    const deps = fakeDeps();
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: REQ,
      expectedRevision: deps.currentRevision!,
      at: AT,
      createdBy: "u_worker",
    });
    expect(r).toMatchObject({ ok: true, status: 200, created: true });
    if (!r.ok) return;
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.saved[0]!.evidenceLinks).toHaveLength(1);
    expect(deps.saved[0]!.evidenceLinks[0]!.evidenceId).toBe("ev_123");
    // revision advanced (content changed) and is stamped on the saved artifact
    expect(r.revision).toBe(deps.saved[0]!.revision);
    expect(r.revision).not.toBe(deps.currentRevision);
  });

  it("STALE revision → 409, no write (does not erase the current artifact)", async () => {
    const deps = fakeDeps();
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: REQ,
      expectedRevision: "stale-revision",
      at: AT,
    });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "stale_revision" });
    if (!r.ok) expect(r.currentRevision).toBe(deps.currentRevision);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("stale write does NOT erase a newer link that landed first", async () => {
    // The artifact already carries a link X (e.g. another capture landed first),
    // so its revision moved. A worker holding the OLD revision is rejected — X survives.
    const deps = fakeDeps({
      raw: artifactRaw({
        evidenceLinks: [
          { id: "el_X", jobId: "job_1", evidenceId: "ev_X", workPackageId: "wp_1", requiredEvidenceId: "re2", role: "progress" },
        ],
      }),
    });
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: REQ,
      expectedRevision: FIXTURE_REV, // the pre-link revision the worker read
      at: AT,
    });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "stale_revision" });
    expect(deps.save).not.toHaveBeenCalled(); // link X is never clobbered
  });

  it("missing artifact → 404, no write (revision check not reached)", async () => {
    const deps = fakeDeps({ raw: null });
    const r = await writeEvidenceLink(deps, { jobId: "job_1", request: REQ, expectedRevision: "anything", at: AT });
    expect(r).toMatchObject({ ok: false, status: 404, reason: "missing" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("unreadable artifact → 409, NOT overwritten", async () => {
    const deps = fakeDeps({ raw: { jobId: "job_1", workPackages: "not-an-array" } });
    const r = await writeEvidenceLink(deps, { jobId: "job_1", request: REQ, expectedRevision: "anything", at: AT });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "unreadable" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("invalid work package → 409, no write", async () => {
    const deps = fakeDeps();
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: { ...REQ, workPackageId: "wp_nope" },
      expectedRevision: deps.currentRevision!,
      at: AT,
    });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "invalid_work_package" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("invalid requirement → 409, no write", async () => {
    const deps = fakeDeps();
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: { ...REQ, requiredEvidenceId: "re_nope" },
      expectedRevision: deps.currentRevision!,
      at: AT,
    });
    expect(r).toMatchObject({ ok: false, status: 409, reason: "invalid_requirement" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("duplicate request → idempotent, no second write, revision unchanged", async () => {
    const depsWithLink = fakeDeps({
      raw: artifactRaw({
        evidenceLinks: [
          { id: "el_existing", jobId: "job_1", evidenceId: "ev_123", workPackageId: "wp_1", requiredEvidenceId: "re1", role: "progress" },
        ],
      }),
    });
    const r = await writeEvidenceLink(depsWithLink, {
      jobId: "job_1",
      request: REQ,
      expectedRevision: depsWithLink.currentRevision!,
      at: AT,
    });
    expect(r).toMatchObject({ ok: true, created: false });
    if (r.ok) expect(r.revision).toBe(depsWithLink.currentRevision);
    expect(depsWithLink.save).not.toHaveBeenCalled();
  });

  it("links via an observation id too", async () => {
    const deps = fakeDeps();
    const r = await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: { workPackageId: "wp_1", requiredEvidenceId: "re1", observationId: "ob_1" },
      expectedRevision: deps.currentRevision!,
      at: AT,
    });
    expect(r.ok).toBe(true);
    expect(deps.saved[0]!.evidenceLinks[0]!.observationId).toBe("ob_1");
  });

  it("blobEvidenceLinkDeps exposes load/save/mintId; mints an el_ id", () => {
    const deps = blobEvidenceLinkDeps();
    expect(typeof deps.loadRaw).toBe("function");
    expect(typeof deps.save).toBe("function");
    expect(deps.mintId()).toMatch(/^el_/);
  });
});

// ── End-to-end: after a link is written, Phil marks the requirement met ───────

describe("loop closes: written link → read → buildAreaTaskContext met", () => {
  it("the linked requirement flips to met; an unrelated one stays needed", async () => {
    const deps = fakeDeps();
    await writeEvidenceLink(deps, {
      jobId: "job_1",
      request: REQ,
      expectedRevision: deps.currentRevision!,
      at: AT,
    }); // links re1
    const persisted = deps.saved[0]!;

    // Read it back through the field-safe boundary, then build task context.
    const read = buildJobControlReadResult("job_1", persisted);
    expect(read.ok && read.ready).toBe(true);
    if (!read.ok || !read.ready) return;
    const ctx = buildAreaTaskContext({
      areaId: "a1",
      stage: "roughIn",
      taskIds: ["t1"],
      workPackages: read.workPackages,
      evidenceLinks: read.evidenceLinks,
    }).get("t1")!;

    const byId = Object.fromEntries(ctx.requiredEvidence.map((e) => [e.id, e.met]));
    expect(byId.re1).toBe(true); // linked → met
    expect(byId.re2).toBe(false); // unrelated → still needed
  });
});
