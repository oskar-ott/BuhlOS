import { describe, expect, it, vi } from "vitest";
import { decodeSessionCookie } from "@/lib/auth/session";
import { ScopeReconciliationSchema } from "@/domains/job-control/reconciliation";
import type { JobStructure } from "@/domains/job-control/compile";
import { taskRefKey } from "@/domains/job-control/spine";
import {
  PersistedScopeReconciliationSchema,
  type PersistedScopeReconciliation,
  type VerifiedSession,
} from "./reconciliation-producer";
import {
  JOB_CONTROL_COMPILER_VERSION,
  blobCompileDeps,
  buildCompilePreview,
  computeCompileSourceHash,
  computeStructureHash,
  confirmCompileAuthorized,
  jobControlKey,
  prepareCompileConfirm,
  runCompileConfirm,
  runCompilePreview,
  type CompileProducerDeps,
  type PersistedJobControl,
} from "./compile-producer";

// ── Fixtures ───────────────────────────────────────────────────────────────--

const REF_ZIP = { areaId: "area_east_gym", stage: "fitOff" as const, taskId: "task_zip" };
const REF_CABLING = { areaId: "area_reception", stage: "fitOff" as const, taskId: "task_cabling" };
const AT = "2026-06-15T12:00:00.000Z";

function structure(): JobStructure {
  const job: JobStructure = {
    id: "job_100arthur",
    roughInTasks: [],
    fitOffTasks: [],
    areaGroups: [
      {
        id: "ag_ground",
        name: "Ground floor",
        areas: [
          { id: "area_east_gym", name: "East Gym", roughInTasks: [], fitOffTasks: [{ id: "task_zip", name: "ZIP circuit" }] },
          { id: "area_reception", name: "Reception", roughInTasks: [], fitOffTasks: [{ id: "task_cabling", name: "A/V cabling" }] },
        ],
      },
    ],
  };
  return job;
}

/** A reconciliation: a priced ZIP clause (East Gym), a by-others warning
 *  (Reception), and an unclassified clause (a gap — must NOT become a task). */
function recBody(includeAv = true) {
  const clauseClassifications: Array<Record<string, unknown>> = [
    {
      clauseId: "sw_zip",
      classification: "priced",
      deliveredBy: [REF_ZIP],
      boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip" }],
      requiredEvidence: [{ id: "re_zip", label: "Circuit test", kind: "test_result" }],
    },
    { clauseId: "sw_unclear", classification: "unclear" },
  ];
  if (includeAv) {
    clauseClassifications.push({
      clauseId: "sw_av",
      classification: "by_others",
      warningText: "A/V hardware by others — cabling only",
      deliveredBy: [REF_CABLING],
    });
  }
  return ScopeReconciliationSchema.parse({ jobId: "job_100arthur", clauseClassifications });
}

function reconciliationEnvelope(
  over: Partial<{ includeAv: boolean; sourceHash: string }> = {},
): PersistedScopeReconciliation {
  return PersistedScopeReconciliationSchema.parse({
    jobId: "job_100arthur",
    reconciliation: recBody(over.includeAv ?? true),
    status: "amber",
    sourceHash: over.sourceHash ?? "rec-source-hash-v1",
    generatedAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  });
}

function fakeDeps(
  over: Partial<{
    found: boolean;
    structure: JobStructure;
    reconciliation: PersistedScopeReconciliation | null;
    previous: PersistedJobControl | null;
    previousUnreadable: boolean;
  }> = {},
): CompileProducerDeps & { saved: PersistedJobControl[]; save: ReturnType<typeof vi.fn> } {
  const found = over.found ?? true;
  const struct = over.structure ?? structure();
  const reconciliation = over.reconciliation !== undefined ? over.reconciliation : reconciliationEnvelope();
  const previous = over.previous ?? null;
  const previousUnreadable = over.previousUnreadable ?? false;
  const saved: PersistedJobControl[] = [];
  const save = vi.fn(async (_jobId: string, p: PersistedJobControl) => {
    saved.push(p);
  });
  return {
    saved,
    save,
    loadStructure: async () => ({ found, structure: found ? struct : null }),
    loadReconciliation: async () => reconciliation,
    loadPrevious: async () =>
      previousUnreadable
        ? { status: "unreadable" }
        : previous == null
          ? { status: "absent" }
          : { status: "ok", value: previous },
    savePersisted: save,
  };
}

const verifyAdmin = async (): Promise<VerifiedSession> => ({ role: "admin", username: "Boss" });
const verifyField = async (): Promise<VerifiedSession> => ({ role: "electrician" });
const verifyNull = async (): Promise<VerifiedSession | null> => null;

// ── Source hashing ───────────────────────────────────────────────────────────

describe("compile source hashing", () => {
  it("structure hash is deterministic and changes when the structure changes", () => {
    const a = computeStructureHash(structure());
    expect(a).toBe(computeStructureHash(structure()));
    const edited = structure();
    edited.areaGroups![0]!.areas![0]!.name = "East Gym (renamed)";
    expect(computeStructureHash(edited)).not.toBe(a);
  });

  it("compile source hash changes when reconciliation or structure changes", () => {
    const base = computeCompileSourceHash(reconciliationEnvelope(), structure());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // change reconciliation (drop the AV clause) → different hash
    expect(computeCompileSourceHash(reconciliationEnvelope({ includeAv: false }), structure())).not.toBe(base);
    // change structure → different hash
    const edited = structure();
    edited.areaGroups![0]!.areas!.pop();
    expect(computeCompileSourceHash(reconciliationEnvelope(), edited)).not.toBe(base);
  });
});

// ── Preview ───────────────────────────────────────────────────────────────--

describe("buildCompilePreview", () => {
  it("compiles work packages and names gaps without minting tasks", () => {
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
    });
    expect(r.workPackages.map((p) => p.title).sort()).toEqual(["East Gym", "Reception"]);
    // the unclassified clause is a NAMED gap, never a fabricated task
    expect(r.gaps.some((g) => g.kind === "unclassified_clause" && g.clauseId === "sw_unclear")).toBe(true);
    const allTaskIds = r.workPackages.flatMap((p) => p.taskRefs.map((t) => t.taskId));
    expect(allTaskIds).not.toContain("sw_unclear");
    expect(r.draft).toBe(true);
    expect(r.hasPrevious).toBe(false);
  });
});

describe("runCompilePreview", () => {
  it("fails clearly (409 no_reconciliation) when scope-reconciliation.json is missing", async () => {
    const deps = fakeDeps({ reconciliation: null });
    const r = await runCompilePreview(deps, { jobId: "job_100arthur" });
    expect(r).toMatchObject({ ok: false, status: 409, code: "no_reconciliation" });
  });

  it("404s when the job structure is missing", async () => {
    const deps = fakeDeps({ found: false });
    const r = await runCompilePreview(deps, { jobId: "missing" });
    expect(r).toMatchObject({ ok: false, status: 404, code: "job_not_found" });
  });

  it("reads reconciliation + structure, returns the compile result, and persists NOTHING", async () => {
    const deps = fakeDeps();
    const r = await runCompilePreview(deps, { jobId: "job_100arthur" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workPackages.length).toBe(2);
    expect(r.gaps.length).toBeGreaterThan(0); // includes the unclassified gap
    expect(deps.save).not.toHaveBeenCalled();
  });
});

// ── Diff ──────────────────────────────────────────────────────────────────--

describe("diff behaviour", () => {
  it("first compile (no previous) is all-added", () => {
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
    });
    expect(r.diff.added).toBe(r.workPackages.length);
    expect(r.diff.removed).toBe(0);
    expect(r.diff.updated).toBe(0);
  });

  it("re-compiling identical input against the prior artifact is a no-op delta", () => {
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
      at: AT,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: prep.persisted,
    });
    expect(r.diff).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(r.hasPrevious).toBe(true);
  });

  it("a package whose content changes shows as updated (not added/removed)", () => {
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
      at: "2026-06-14T00:00:00.000Z",
    });
    if (!prep.ok) return;
    // Same areas survive, but the East Gym (sw_zip) clause drops its required
    // evidence → that area's package content changes.
    const base = reconciliationEnvelope().reconciliation;
    const editedRec = ScopeReconciliationSchema.parse({
      ...base,
      clauseClassifications: base.clauseClassifications.map((c) =>
        c.clauseId === "sw_zip" ? { ...c, requiredEvidence: [] } : c,
      ),
    });
    const editedEnvelope = PersistedScopeReconciliationSchema.parse({
      ...reconciliationEnvelope(),
      reconciliation: editedRec,
      sourceHash: "rec-source-hash-v2",
    });
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: editedEnvelope,
      structure: structure(),
      previous: prep.persisted,
    });
    expect(r.diff).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(r.diff.updatedPackages).toHaveLength(1);
    expect(r.diff.updatedPackages[0]?.after.title).toBe("East Gym");
    expect(r.diff.updatedPackages[0]?.before).not.toEqual(r.diff.updatedPackages[0]?.after);
  });

  it("a package that disappears shows as removed", () => {
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(), // East Gym + Reception
      structure: structure(),
      previous: null,
      at: AT,
    });
    if (!prep.ok) return;
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope({ includeAv: false }), // Reception gone
      structure: structure(),
      previous: prep.persisted,
    });
    expect(r.diff.removed).toBe(1);
  });
});

// ── Confirm (pure) ────────────────────────────────────────────────────────--

describe("prepareCompileConfirm", () => {
  it("builds a job-control artifact with compiled packages + provenance, preserving gaps", () => {
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
      confirmedBy: "u_admin",
      at: AT,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.persisted.workPackages.length).toBe(2);
    expect(prep.persisted.compileMeta?.compilerVersion).toBe(JOB_CONTROL_COMPILER_VERSION);
    expect(prep.persisted.compileMeta?.confirmedBy).toBe("u_admin");
    expect(prep.persisted.compileMeta?.confirmedAt).toBe(AT);
    // gaps are PRESERVED in provenance, never turned into tasks
    expect(prep.persisted.compileMeta?.gaps.some((g) => g.kind === "unclassified_clause")).toBe(true);
  });

  it("rejects a stale source hash and writes nothing of substance", () => {
    const prep = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
      expectedSourceHash: "stale",
      at: AT,
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("stale_source");
    expect(prep.currentSourceHash).toBe(computeCompileSourceHash(reconciliationEnvelope(), structure()));
  });

  it("preserves claim/closeout/evidence arrays from an existing artifact (L1 owns only work packages)", () => {
    const first = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
      at: "2026-06-14T00:00:00.000Z",
    });
    if (!first.ok) return;
    // simulate a later producer having added a claim line + evidence link
    const withDownstream: PersistedJobControl = {
      ...first.persisted,
      claimLines: [
        {
          id: "cl_1",
          jobId: "job_100arthur",
          description: "Claim 1",
          claimedAmount: 100,
          status: "draft",
          order: 0,
          boqLineRefs: [],
        },
      ],
      evidenceLinks: [
        { id: "el_1", jobId: "job_100arthur", evidenceId: "ev_1", workPackageId: "wp_x", role: "progress" },
      ],
    };
    const next = prepareCompileConfirm({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: withDownstream,
      at: AT,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.persisted.claimLines).toHaveLength(1);
    expect(next.persisted.evidenceLinks).toHaveLength(1);
    // generatedAt is carried from the first artifact; updatedAt is now
    expect(next.persisted.compileMeta?.generatedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(next.persisted.updatedAt).toBe(AT);
  });
});

// ── Confirm orchestration ─────────────────────────────────────────────────--

describe("runCompileConfirm", () => {
  it("writes ONLY jobs/<jobId>/job-control.json on a fresh confirm", async () => {
    const deps = fakeDeps();
    const r = await runCompileConfirm(deps, { jobId: "job_100arthur", confirmedBy: "u_admin", at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saved.key).toBe("jobs/job_100arthur/job-control.json");
    expect(jobControlKey("job_100arthur")).toBe("jobs/job_100arthur/job-control.json");
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.saved[0]!.workPackages.length).toBe(2);
  });

  it("rejects a stale source hash with 409 and writes NOTHING", async () => {
    const deps = fakeDeps();
    const r = await runCompileConfirm(deps, { jobId: "job_100arthur", expectedSourceHash: "stale", at: AT });
    expect(r).toMatchObject({ ok: false, status: 409, code: "stale_source" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("409s (no_reconciliation) and writes nothing when reconciliation is missing", async () => {
    const deps = fakeDeps({ reconciliation: null });
    const r = await runCompileConfirm(deps, { jobId: "job_100arthur", at: AT });
    expect(r).toMatchObject({ ok: false, status: 409, code: "no_reconciliation" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an UNREADABLE existing artifact (409, no clobber of preserved arrays)", async () => {
    const deps = fakeDeps({ previousUnreadable: true });
    const r = await runCompileConfirm(deps, { jobId: "job_100arthur", confirmedBy: "u_admin", at: AT });
    expect(r).toMatchObject({ ok: false, status: 409, code: "unreadable_previous" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("preview tolerates an unreadable existing artifact as 'no previous' (read-only, no write)", async () => {
    const deps = fakeDeps({ previousUnreadable: true });
    const r = await runCompilePreview(deps, { jobId: "job_100arthur" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hasPrevious).toBe(false);
    expect(deps.save).not.toHaveBeenCalled();
  });
});

// ── Authoritative write auth (reused L0 gate) ─────────────────────────────────

describe("confirmCompileAuthorized — only writes after authoritative admin verification", () => {
  it("does NOT write when the authoritative check fails (unauthenticated → 401)", async () => {
    const deps = fakeDeps();
    const r = await confirmCompileAuthorized(
      deps,
      { cookieHeader: "buhl_session=x.badsig", baseUrl: "https://x", verify: verifyNull },
      { jobId: "job_100arthur", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("does NOT write for a verified non-admin (403)", async () => {
    const deps = fakeDeps();
    const r = await confirmCompileAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyField },
      { jobId: "job_100arthur", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("rejects a FORGED cookie that the unverified decode would have accepted", async () => {
    const forgedBody = Buffer.from(JSON.stringify({ role: "admin", exp: 4102444800000 })).toString("base64url");
    const forgedCookie = `${forgedBody}.not-a-real-hmac`;
    expect(decodeSessionCookie(forgedCookie)?.role).toBe("admin"); // unverified decode is fooled

    const deps = fakeDeps();
    const r = await confirmCompileAuthorized(
      deps,
      { cookieHeader: `buhl_session=${forgedCookie}`, baseUrl: "https://x", verify: verifyNull },
      { jobId: "job_100arthur", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("writes only after authoritative admin verification, stamping the verified confirmedBy", async () => {
    const deps = fakeDeps();
    const r = await confirmCompileAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin },
      { jobId: "job_100arthur", at: AT },
    );
    expect(r.ok).toBe(true);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.saved[0]!.compileMeta?.confirmedBy).toBe("Boss");
  });

  it("still enforces stale-source protection under an authorised admin (no write)", async () => {
    const deps = fakeDeps();
    const r = await confirmCompileAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin },
      { jobId: "job_100arthur", expectedSourceHash: "stale", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(deps.save).not.toHaveBeenCalled();
  });
});

// ── blobCompileDeps wiring ────────────────────────────────────────────────--

describe("blobCompileDeps", () => {
  it("exposes the producer deps surface", () => {
    const deps = blobCompileDeps();
    expect(typeof deps.loadStructure).toBe("function");
    expect(typeof deps.loadReconciliation).toBe("function");
    expect(typeof deps.loadPrevious).toBe("function");
    expect(typeof deps.savePersisted).toBe("function");
  });
});

// keep taskRefKey import meaningful (guards against accidental task fabrication shape)
describe("gap clauses never appear as task coordinates", () => {
  it("no compiled taskRef references the unclassified clause id", () => {
    const r = buildCompilePreview({
      jobId: "job_100arthur",
      persistedReconciliation: reconciliationEnvelope(),
      structure: structure(),
      previous: null,
    });
    const keys = r.workPackages.flatMap((p) => p.taskRefs.map(taskRefKey));
    expect(keys.every((k) => !k.includes("sw_unclear"))).toBe(true);
  });
});
