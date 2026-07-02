import { describe, expect, it, vi } from "vitest";
import type { ScopeOfWorkItem } from "@/domains/jobs/types";
import { decodeSessionCookie } from "@/lib/auth/session";
import {
  authorizeAdmin,
  authorizeAdminViaVerify,
  blobReconciliationDeps,
  buildReconciliationPreview,
  computeScopeSourceHash,
  ClassificationsInputSchema,
  confirmReconciliationAuthorized,
  deriveRequiredEvidenceId,
  PersistedScopeReconciliationSchema,
  prepareReconciliationConfirm,
  REASON_REQUIRED_MESSAGE,
  ResolutionsInputSchema,
  runReconciliationConfirm,
  runReconciliationPreview,
  scopeReconciliationKey,
  type ClassificationsInput,
  type PersistedScopeReconciliation,
  type ReconciliationProducerDeps,
  type VerifiedSession,
} from "./reconciliation-producer";

// ── Fixtures ───────────────────────────────────────────────────────────────--

function clauses(): ScopeOfWorkItem[] {
  return [
    { id: "sw_zip", title: "Dedicated 20A ZIP circuit, East Gym", detail: "priced work", order: 0 },
    { id: "sw_av", title: "A/V hardware, Reception", detail: "by others", order: 1 },
    { id: "sw_disposal", title: "Strip-out & disposal, East Gym", detail: "make safe", order: 2 },
    { id: "sw_asbuilt", title: "CAD as-built drawings", detail: "paperwork", order: 3 },
    { id: "sw_extra", title: "Extra GPOs not on drawings", detail: "likely extra", order: 4 },
  ];
}

const AT = "2026-06-15T12:00:00.000Z";

/** A deps double with spies, backed by an in-memory store. */
function fakeDeps(
  over: Partial<{
    found: boolean;
    clauseList: ScopeOfWorkItem[];
    prior: PersistedScopeReconciliation | null;
  }> = {},
): ReconciliationProducerDeps & { saved: PersistedScopeReconciliation[]; save: ReturnType<typeof vi.fn> } {
  const found = over.found ?? true;
  const clauseList = over.clauseList ?? clauses();
  const prior = over.prior ?? null;
  const saved: PersistedScopeReconciliation[] = [];
  const save = vi.fn(async (_jobId: string, p: PersistedScopeReconciliation) => {
    saved.push(p);
  });
  return {
    saved,
    save,
    loadScope: async () => ({ found, clauses: clauseList, quote: null }),
    loadPrior: async () => prior,
    savePersisted: save,
  };
}

// ── computeScopeSourceHash ─────────────────────────────────────────────────--

describe("computeScopeSourceHash", () => {
  it("is deterministic and order-independent", () => {
    const a = computeScopeSourceHash(clauses(), null);
    const b = computeScopeSourceHash([...clauses()].reverse(), null);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the clause set changes", () => {
    const a = computeScopeSourceHash(clauses(), null);
    const b = computeScopeSourceHash(clauses().slice(0, 4), null);
    expect(a).not.toBe(b);
  });

  it("changes when a clause's content changes", () => {
    const a = computeScopeSourceHash(clauses(), null);
    const edited = clauses().map((c) => (c.id === "sw_zip" ? { ...c, detail: "CHANGED" } : c));
    expect(computeScopeSourceHash(edited, null)).not.toBe(a);
  });
});

// ── authorizeAdmin (confirm/preview admin gate) ───────────────────────────────

describe("authorizeAdmin — both producer routes are admin-only", () => {
  it("401s when there is no role", () => {
    expect(authorizeAdmin(null)).toEqual({ ok: false, status: 401, error: "Not signed in" });
  });
  it("403s for a field role — workers cannot produce reconciliations", () => {
    expect(authorizeAdmin("electrician")).toEqual({ ok: false, status: 403, error: "Admin only" });
  });
  it("allows an admin-tier role", () => {
    expect(authorizeAdmin("admin")).toEqual({ ok: true });
    expect(authorizeAdmin("pm")).toEqual({ ok: true });
  });
});

// ── Preview ───────────────────────────────────────────────────────────────--

describe("buildReconciliationPreview", () => {
  it("reads real clauses and emits one classification per clause, all unclear by default", () => {
    const r = buildReconciliationPreview({ jobId: "j", clauses: clauses(), quote: null, prior: null });
    expect(r.reconciliation.clauseClassifications).toHaveLength(5);
    expect(r.reconciliation.clauseClassifications.every((c) => c.classification === "unclear")).toBe(true);
    expect(r.draft).toBe(true);
  });

  it("leaves unclassified clauses as warnings and never silently makes them field work", () => {
    const r = buildReconciliationPreview({ jobId: "j", clauses: clauses(), quote: null, prior: null });
    expect(r.status).toBe("amber");
    expect(r.unclassifiedClauseIds.sort()).toEqual(
      ["sw_asbuilt", "sw_av", "sw_disposal", "sw_extra", "sw_zip"],
    );
    // every warning for an unclassified clause is the explicit not-classified finding
    expect(r.warnings.filter((w) => w.kind === "clause_unpriced_unclassified")).toHaveLength(5);
    // nothing was promoted to a priced/field classification on its own
    expect(r.reconciliation.clauseClassifications.some((c) => c.classification === "priced")).toBe(false);
  });

  it("preserves explicit admin classifications across the closed domain set", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: {
        sw_zip: "priced", // field/priced work the crew performs
        sw_av: "by_others",
        sw_disposal: "excluded",
        sw_asbuilt: "admin_only",
        sw_extra: "variation_trigger",
      },
    });
    const byId = Object.fromEntries(r.reconciliation.clauseClassifications.map((c) => [c.clauseId, c.classification]));
    expect(byId).toMatchObject({
      sw_zip: "priced",
      sw_av: "by_others",
      sw_disposal: "excluded",
      sw_asbuilt: "admin_only",
      sw_extra: "variation_trigger",
    });
    // fully classified, no red conflicts → green; nothing unclear remains
    expect(r.unclassifiedClauseIds).toEqual([]);
    expect(r.status).toBe("green");
  });

  it("preserves needs-confirmation-style classifications (pc_provisional / unclear)", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_extra: "pc_provisional" },
    });
    expect(
      r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_extra")?.classification,
    ).toBe("pc_provisional");
    // the others are still unclear (not silently classified)
    expect(r.unclassifiedClauseIds).toContain("sw_zip");
  });

  it("carries a warning text through for a by_others classification", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_av: { classification: "by_others", warningText: "A/V by others — cabling only" } },
    });
    expect(
      r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_av")?.warningText,
    ).toMatch(/cabling only/);
  });

  it("ignores (but reports) a classification for a clause not in the job scope", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_ghost: "priced" },
    });
    expect(r.unknownClauseIds).toEqual(["sw_ghost"]);
    expect(r.reconciliation.clauseClassifications.some((c) => c.clauseId === "sw_ghost")).toBe(false);
  });

  it("tolerates a job with no scope clauses (empty → green)", () => {
    const r = buildReconciliationPreview({ jobId: "j", clauses: [], quote: null, prior: null });
    expect(r.reconciliation.clauseClassifications).toEqual([]);
    expect(r.status).toBe("green");
  });

  it("does not mutate the prior reconciliation", () => {
    const seed = buildReconciliationPreview({ jobId: "j", clauses: clauses(), quote: null, prior: null });
    const snapshot = JSON.stringify(seed.reconciliation);
    buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: seed.reconciliation,
      classifications: { sw_zip: "priced" },
    });
    expect(JSON.stringify(seed.reconciliation)).toBe(snapshot);
  });
});

// ── ClassificationsInputSchema — no fake classifications ───────────────────────

describe("ClassificationsInputSchema", () => {
  it("rejects an unknown classification (e.g. the non-domain 'field')", () => {
    // "field" is NOT one of the domain's classifications — the producer follows
    // the domain's closed set, not the brief's suggested names.
    expect(ClassificationsInputSchema.safeParse({ sw_zip: "field" }).success).toBe(false);
  });
  it("accepts the bare string and the object form for a known classification", () => {
    expect(ClassificationsInputSchema.safeParse({ a: "priced" }).success).toBe(true);
    expect(
      ClassificationsInputSchema.safeParse({ a: { classification: "by_others", warningText: "x" } }).success,
    ).toBe(true);
  });

  it("accepts a field-delivered clause carrying deliveredBy + requiredEvidence (the authoring path)", () => {
    expect(
      ClassificationsInputSchema.safeParse({
        sw_zip: {
          classification: "priced",
          deliveredBy: [{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip" }],
          requiredEvidence: [{ label: "Circuit test before energising", kind: "test_result" }],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed task coordinate / proof kind (no fake shapes)", () => {
    // empty taskId
    expect(
      ClassificationsInputSchema.safeParse({
        sw_zip: { classification: "priced", deliveredBy: [{ areaId: "a", stage: "fitOff", taskId: "" }] },
      }).success,
    ).toBe(false);
    // a stage outside the closed job-control set
    expect(
      ClassificationsInputSchema.safeParse({
        sw_zip: { classification: "priced", deliveredBy: [{ areaId: "a", stage: "commissioning", taskId: "t" }] },
      }).success,
    ).toBe(false);
    // a proof kind outside the closed REQUIRED_EVIDENCE_KINDS set
    expect(
      ClassificationsInputSchema.safeParse({
        sw_zip: { classification: "priced", requiredEvidence: [{ label: "x", kind: "selfie" }] },
      }).success,
    ).toBe(false);
    // a blank proof label
    expect(
      ClassificationsInputSchema.safeParse({
        sw_zip: { classification: "priced", requiredEvidence: [{ label: "   ", kind: "photo" }] },
      }).success,
    ).toBe(false);
  });
});

// ── deriveRequiredEvidenceId (stable id when the author omits one) ─────────────

describe("deriveRequiredEvidenceId", () => {
  it("is deterministic, label-stable, and re-trims (same label → same re_… id)", () => {
    const a = deriveRequiredEvidenceId("Circuit test");
    expect(a).toMatch(/^re_[0-9a-f]{8}$/);
    expect(deriveRequiredEvidenceId("Circuit test")).toBe(a);
    // surrounding whitespace must not change the id (label is trimmed)
    expect(deriveRequiredEvidenceId("  Circuit test  ")).toBe(a);
  });

  it("gives distinct labels distinct ids", () => {
    expect(deriveRequiredEvidenceId("Photo of the board")).not.toBe(
      deriveRequiredEvidenceId("Test results"),
    );
  });

  it("folds a taskRef into the id (#502) — same label, different task → distinct ids; label-only unchanged", () => {
    const t1 = { areaId: "a1", stage: "roughIn", taskId: "t1" } as const;
    const t2 = { areaId: "a1", stage: "roughIn", taskId: "t2" } as const;
    const labelOnly = deriveRequiredEvidenceId("Circuit test");
    // back-compat: omitting / null taskRef keeps the label-only id
    expect(deriveRequiredEvidenceId("Circuit test", null)).toBe(labelOnly);
    // task scope changes the id, and differs between tasks (no collapse in compile's id-keyed map)
    expect(deriveRequiredEvidenceId("Circuit test", t1)).not.toBe(labelOnly);
    expect(deriveRequiredEvidenceId("Circuit test", t1)).not.toBe(deriveRequiredEvidenceId("Circuit test", t2));
    // still deterministic + well-formed
    expect(deriveRequiredEvidenceId("Circuit test", t1)).toBe(deriveRequiredEvidenceId("Circuit test", t1));
    expect(deriveRequiredEvidenceId("Circuit test", t1)).toMatch(/^re_[0-9a-f]{8}$/);
  });
});

// ── Authoring deliveredBy + requiredEvidence through preview/confirm ───────────
// The product-unblock: an admin patch carrying a task coordinate + required proof
// must survive normalisePatch onto the clause classification, so the L1 compiler
// can emit work packages with required proof (no more no_delivering_task).

describe("authoring deliveredBy + requiredEvidence onto a clause", () => {
  const authored = {
    sw_zip: {
      classification: "priced" as const,
      deliveredBy: [{ areaId: "area_east_gym", stage: "fitOff" as const, taskId: "task_zip" }],
      requiredEvidence: [
        { label: "Circuit test before energising", kind: "test_result" as const, note: "RCD trip time" },
        { id: "re_custom", label: "Board photo", kind: "photo" as const },
      ],
    },
  };

  it("preserves the task coordinate and the proof items on the clause classification", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: authored,
    });
    const cc = r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")!;
    expect(cc.classification).toBe("priced");
    expect(cc.deliveredBy).toEqual([{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip" }]);
    expect(cc.requiredEvidence).toHaveLength(2);
    // the proof's label/kind/note are carried verbatim
    expect(cc.requiredEvidence[0]).toMatchObject({
      label: "Circuit test before energising",
      kind: "test_result",
      note: "RCD trip time",
    });
  });

  it("derives a stable id for proof with no id, and honours an explicit id", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: authored,
    });
    const cc = r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")!;
    // omitted id → the deterministic derivation; explicit id wins unchanged
    expect(cc.requiredEvidence[0]!.id).toBe(deriveRequiredEvidenceId("Circuit test before energising"));
    expect(cc.requiredEvidence[1]!.id).toBe("re_custom");
  });

  it("carries a per-task taskRef through to the requirement with a task-distinct id (#502)", () => {
    const taskRef = { areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip" } as const;
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: {
        sw_zip: {
          classification: "priced",
          deliveredBy: [taskRef],
          requiredEvidence: [{ label: "Board photo", kind: "photo", taskRef }],
        },
      },
    });
    const cc = r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")!;
    expect(cc.requiredEvidence[0]!.taskRef).toEqual(taskRef);
    // the id folds in the taskRef → distinct from the package-level (label-only) id
    expect(cc.requiredEvidence[0]!.id).toBe(deriveRequiredEvidenceId("Board photo", taskRef));
    expect(cc.requiredEvidence[0]!.id).not.toBe(deriveRequiredEvidenceId("Board photo"));
  });

  it("never fabricates proof: a field clause with no requiredEvidence stays empty", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: {
        sw_zip: { classification: "priced", deliveredBy: [{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip" }] },
      },
    });
    const cc = r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")!;
    expect(cc.requiredEvidence).toEqual([]);
    expect(cc.deliveredBy).toHaveLength(1);
  });

  it("leaves the old minimal patch (classification/note/warning only) unchanged — zero regression", () => {
    const r = buildReconciliationPreview({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_av: { classification: "by_others", warningText: "cabling only", note: "n" } },
    });
    const cc = r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_av")!;
    expect(cc).toMatchObject({ classification: "by_others", warningText: "cabling only", note: "n" });
    // the schema defaults keep the new arrays empty, never undefined
    expect(cc.deliveredBy).toEqual([]);
    expect(cc.requiredEvidence).toEqual([]);
  });

  it("persists deliveredBy + requiredEvidence into the confirmed envelope", () => {
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: authored,
      confirmedBy: "u_admin",
      at: AT,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const cc = prep.persisted.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")!;
    expect(cc.deliveredBy).toHaveLength(1);
    expect(cc.requiredEvidence.map((e) => e.id)).toEqual([
      deriveRequiredEvidenceId("Circuit test before energising"),
      "re_custom",
    ]);
    // the envelope round-trips through the persisted schema unchanged
    expect(PersistedScopeReconciliationSchema.safeParse(prep.persisted).success).toBe(true);
  });
});

// ── prepareReconciliationConfirm (pure) ───────────────────────────────────────

describe("prepareReconciliationConfirm", () => {
  it("builds a persisted envelope with provenance", () => {
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_zip: "priced" },
      confirmedBy: "u_admin",
      at: AT,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.persisted.jobId).toBe("j");
    expect(prep.persisted.confirmedBy).toBe("u_admin");
    expect(prep.persisted.confirmedAt).toBe(AT);
    expect(prep.persisted.generatedAt).toBe(AT);
    expect(prep.persisted.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(PersistedScopeReconciliationSchema.safeParse(prep.persisted).success).toBe(true);
  });

  it("rejects a stale source hash and returns the current one", () => {
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      expectedSourceHash: "stale-hash",
      at: AT,
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.code).toBe("stale_source");
    expect(prep.currentSourceHash).toBe(computeScopeSourceHash(clauses(), null));
  });

  it("accepts a matching source hash", () => {
    const hash = computeScopeSourceHash(clauses(), null);
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      expectedSourceHash: hash,
      at: AT,
    });
    expect(prep.ok).toBe(true);
  });

  it("preserves generatedAt from a prior envelope", () => {
    const prior = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      at: "2026-06-14T00:00:00.000Z",
    });
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    const next = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: prior.persisted,
      at: AT,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.persisted.generatedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(next.persisted.updatedAt).toBe(AT);
  });
});

// ── runReconciliationPreview / Confirm (orchestration via deps) ───────────────

describe("runReconciliationPreview", () => {
  it("returns a preview and persists NOTHING", async () => {
    const deps = fakeDeps();
    const r = await runReconciliationPreview(deps, { jobId: "j", classifications: { sw_zip: "priced" } });
    expect(r.ok).toBe(true);
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.saved).toHaveLength(0);
  });

  it("404s for a missing job", async () => {
    const deps = fakeDeps({ found: false });
    const r = await runReconciliationPreview(deps, { jobId: "missing" });
    expect(r).toEqual({ ok: false, status: 404, error: "Job not found" });
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("runReconciliationConfirm", () => {
  it("persists the confirmed reconciliation to jobs/<jobId>/scope-reconciliation.json", async () => {
    const deps = fakeDeps();
    const r = await runReconciliationConfirm(deps, {
      jobId: "job_100arthur",
      classifications: { sw_zip: "priced" },
      confirmedBy: "u_admin",
      at: AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saved.key).toBe("jobs/job_100arthur/scope-reconciliation.json");
    expect(scopeReconciliationKey("job_100arthur")).toBe("jobs/job_100arthur/scope-reconciliation.json");
    expect(deps.save).toHaveBeenCalledTimes(1);
    const persisted = deps.saved[0]!;
    expect(persisted.jobId).toBe("job_100arthur");
    expect(persisted.confirmedBy).toBe("u_admin");
    expect(persisted.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")?.classification).toBe(
      "priced",
    );
  });

  it("rejects a stale source hash with 409 and writes NOTHING", async () => {
    const deps = fakeDeps();
    const r = await runReconciliationConfirm(deps, {
      jobId: "j",
      expectedSourceHash: "stale",
      at: AT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe("stale_source");
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("404s for a missing job and writes NOTHING", async () => {
    const deps = fakeDeps({ found: false });
    const r = await runReconciliationConfirm(deps, { jobId: "missing", at: AT });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("preserves by_others / excluded / admin_only / variation_trigger through confirm", async () => {
    const deps = fakeDeps();
    await runReconciliationConfirm(deps, {
      jobId: "j",
      classifications: {
        sw_av: "by_others",
        sw_disposal: "excluded",
        sw_asbuilt: "admin_only",
        sw_extra: "variation_trigger",
      },
      at: AT,
    });
    const persisted = deps.saved[0]!;
    const byId = Object.fromEntries(
      persisted.reconciliation.clauseClassifications.map((c) => [c.clauseId, c.classification]),
    );
    expect(byId).toMatchObject({
      sw_av: "by_others",
      sw_disposal: "excluded",
      sw_asbuilt: "admin_only",
      sw_extra: "variation_trigger",
    });
  });
});

// ── Prior-loading branch end-to-end (loadPrior → reconcile) ───────────────────

describe("orchestration carries a prior reconciliation forward", () => {
  /** A previously-confirmed envelope: sw_av classified by_others, fixed generatedAt. */
  function priorEnvelope() {
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: { sw_av: "by_others" },
      confirmedBy: "u_old",
      at: "2026-06-14T00:00:00.000Z",
    });
    if (!prep.ok) throw new Error("fixture prior failed to build");
    return prep.persisted;
  }

  it("confirm reconciles over the loaded prior: prior classification survives, scope edits apply, generatedAt carries", async () => {
    // current scope drops sw_asbuilt and adds sw_new
    const currentClauses = clauses()
      .filter((c) => c.id !== "sw_asbuilt")
      .concat({ id: "sw_new", title: "New riser penetration", detail: "x", order: 9 });
    const deps = fakeDeps({ clauseList: currentClauses, prior: priorEnvelope() });

    const r = await runReconciliationConfirm(deps, { jobId: "j", confirmedBy: "u_new", at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const persisted = deps.saved[0]!;
    const byId = Object.fromEntries(
      persisted.reconciliation.clauseClassifications.map((c) => [c.clauseId, c.classification]),
    );
    // prior classification survived → proves loadPrior → reconcile() (not a fresh seed)
    expect(byId.sw_av).toBe("by_others");
    // a dropped clause falls out; a new clause arrives unclear (never silently classified)
    expect("sw_asbuilt" in byId).toBe(false);
    expect(byId.sw_new).toBe("unclear");
    // generatedAt is carried from the prior; updatedAt is this confirm
    expect(persisted.generatedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(persisted.updatedAt).toBe(AT);
  });

  it("preview reflects the loaded prior's classifications and still persists nothing", async () => {
    const deps = fakeDeps({ prior: priorEnvelope() });
    const r = await runReconciliationPreview(deps, { jobId: "j" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_av")?.classification).toBe(
      "by_others",
    );
    expect(deps.save).not.toHaveBeenCalled();
  });
});

// ── Authoritative write auth (confirm uses verifyViaApi, not cookie decode) ───

const verifyAdmin = async (): Promise<VerifiedSession> => ({ role: "admin", username: "Boss" });
const verifyField = async (): Promise<VerifiedSession> => ({ role: "electrician", username: "Sparky" });
const verifyNull = async (): Promise<VerifiedSession | null> => null; // forged/unsigned/expired → /api/auth rejects

describe("authorizeAdminViaVerify — authoritative gate for the write", () => {
  it("401s when the authoritative check returns null (forged / unsigned / unauthenticated)", async () => {
    const r = await authorizeAdminViaVerify({ cookieHeader: "buhl_session=x.badsig", baseUrl: "https://x", verify: verifyNull });
    expect(r).toEqual({ ok: false, status: 401, error: "Not signed in" });
  });
  it("403s when the verified user is not an admin", async () => {
    const r = await authorizeAdminViaVerify({ cookieHeader: "c", baseUrl: "https://x", verify: verifyField });
    expect(r).toEqual({ ok: false, status: 403, error: "Admin only" });
  });
  it("allows a verified admin and derives confirmedBy from the verified identity", async () => {
    const r = await authorizeAdminViaVerify({ cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin });
    expect(r).toEqual({ ok: true, confirmedBy: "Boss" });
  });
});

describe("confirmReconciliationAuthorized — only writes after authoritative admin verification", () => {
  it("does NOT write when the authoritative check fails (unauthenticated → 401)", async () => {
    const deps = fakeDeps();
    const r = await confirmReconciliationAuthorized(
      deps,
      { cookieHeader: "buhl_session=x.badsig", baseUrl: "https://x", verify: verifyNull },
      { jobId: "j", classifications: { sw_zip: "priced" }, at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("does NOT write for a verified non-admin (403)", async () => {
    const deps = fakeDeps();
    const r = await confirmReconciliationAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyField },
      { jobId: "j", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("rejects a FORGED cookie that the unverified decode would have accepted", async () => {
    // A shape-valid, unexpired, but unsigned cookie: decodeSessionCookie is fooled
    // into seeing an admin — the exact attack the authoritative path must defeat.
    const forgedBody = Buffer.from(JSON.stringify({ role: "admin", exp: 4102444800000 })).toString("base64url");
    const forgedCookie = `${forgedBody}.not-a-real-hmac`;
    expect(decodeSessionCookie(forgedCookie)?.role).toBe("admin"); // unverified decode is fooled

    const deps = fakeDeps();
    const r = await confirmReconciliationAuthorized(
      deps,
      // the authoritative /api/auth?action=me rejects the bad HMAC → modelled as null
      { cookieHeader: `buhl_session=${forgedCookie}`, baseUrl: "https://x", verify: verifyNull },
      { jobId: "j", classifications: { sw_zip: "priced" }, at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("writes only after authoritative admin verification, stamping the verified confirmedBy", async () => {
    const deps = fakeDeps();
    const r = await confirmReconciliationAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin },
      { jobId: "j", classifications: { sw_zip: "priced" }, at: AT },
    );
    expect(r.ok).toBe(true);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.saved[0]!.confirmedBy).toBe("Boss");
    expect(deps.saved[0]!.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip")?.classification).toBe(
      "priced",
    );
  });

  it("still enforces stale-source protection under an authorised admin (no write)", async () => {
    const deps = fakeDeps();
    const r = await confirmReconciliationAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin },
      { jobId: "j", expectedSourceHash: "stale", at: AT },
    );
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(deps.save).not.toHaveBeenCalled();
  });
});

// ── Resolutions: resolve-or-accept-with-reason on named findings (#366 AC2/5) ─

describe("resolutions — resolve-or-accept-with-reason", () => {
  /** Every clause classified; the excluded disposal clause carries a note →
   *  exactly one finding, the red disposal trap. */
  const FULL: ClassificationsInput = {
    sw_zip: "priced",
    sw_av: "by_others",
    sw_disposal: { classification: "excluded", note: "disposal owed on site" },
    sw_asbuilt: "admin_only",
    sw_extra: "variation_trigger",
  };
  const KEY = "excluded_with_obligation:sw_disposal";
  const LATER = "2026-06-16T00:00:00.000Z";

  /** A confirmed prior with the one red finding open. */
  function redPrior(): PersistedScopeReconciliation {
    const prep = prepareReconciliationConfirm({
      jobId: "j",
      clauses: clauses(),
      quote: null,
      prior: null,
      classifications: FULL,
      confirmedBy: "Boss",
      at: AT,
    });
    if (!prep.ok) throw new Error("fixture prior failed to build");
    return prep.persisted;
  }

  it("schema: an accept with no reason (or a blank one) is rejected; resolved needs none", () => {
    const missing = ResolutionsInputSchema.safeParse([{ findingKey: KEY, action: "accepted" }]);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.some((i) => i.message === REASON_REQUIRED_MESSAGE)).toBe(true);
    }
    expect(
      ResolutionsInputSchema.safeParse([{ findingKey: KEY, action: "accepted", reason: "   " }])
        .success,
    ).toBe(false);
    expect(
      ResolutionsInputSchema.safeParse([{ findingKey: KEY, action: "resolved" }]).success,
    ).toBe(true);
    expect(
      ResolutionsInputSchema.safeParse([
        { findingKey: KEY, action: "accepted", reason: "builder carries disposal" },
      ]).success,
    ).toBe(true);
  });

  it("accepting a red finding removes it from the open list, recomputes the RAG, and stamps who/when", async () => {
    const prior = redPrior();
    expect(prior.status).toBe("red");
    expect(prior.warnings.map((w) => w.key)).toContain(KEY);

    const deps = fakeDeps({ prior });
    const r = await runReconciliationConfirm(deps, {
      jobId: "j",
      resolutions: [
        { findingKey: KEY, action: "accepted", reason: "Builder confirmed they carry disposal" },
      ],
      confirmedBy: "Boss",
      at: LATER,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknownFindingKeys).toEqual([]);
    expect(r.saved.status).toBe("green");

    const persisted = deps.saved[0]!;
    expect(persisted.warnings.map((w) => w.key)).not.toContain(KEY); // left the open list
    expect(persisted.status).toBe("green"); // RAG recomputed by the engine
    // who/when/why stamped server-side, never client-supplied
    expect(persisted.reconciliation.resolutions).toEqual([
      expect.objectContaining({
        findingKey: KEY,
        action: "accepted",
        reason: "Builder confirmed they carry disposal",
        by: "Boss",
        at: LATER,
      }),
    ]);
  });

  it("marking resolved (no reason) also clears the finding", async () => {
    const deps = fakeDeps({ prior: redPrior() });
    const r = await runReconciliationConfirm(deps, {
      jobId: "j",
      resolutions: [{ findingKey: KEY, action: "resolved" }],
      confirmedBy: "Boss",
      at: LATER,
    });
    expect(r.ok).toBe(true);
    expect(deps.saved[0]!.warnings.map((w) => w.key)).not.toContain(KEY);
    expect(deps.saved[0]!.reconciliation.resolutions[0]).toMatchObject({
      findingKey: KEY,
      action: "resolved",
      by: "Boss",
    });
  });

  it("a resolution naming no real finding is ignored and surfaced, never recorded", async () => {
    const deps = fakeDeps({ prior: redPrior() });
    const r = await runReconciliationConfirm(deps, {
      jobId: "j",
      resolutions: [{ findingKey: "excluded_with_obligation:nope", action: "resolved" }],
      confirmedBy: "Boss",
      at: LATER,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknownFindingKeys).toEqual(["excluded_with_obligation:nope"]);
    expect(deps.saved[0]!.reconciliation.resolutions).toEqual([]);
    expect(deps.saved[0]!.status).toBe("red"); // the real finding is still open
  });

  it("resolutions survive a later re-confirm and re-reconciliation (never wiped, AC5)", async () => {
    // 1) accept the disposal finding
    const deps1 = fakeDeps({ prior: redPrior() });
    const first = await runReconciliationConfirm(deps1, {
      jobId: "j",
      resolutions: [{ findingKey: KEY, action: "accepted", reason: "agreed by email" }],
      confirmedBy: "Boss",
      at: LATER,
    });
    expect(first.ok).toBe(true);

    // 2) later confirm: a scope edit (new clause) + a classification change —
    //    no resolutions in the body at all
    const grownScope = clauses().concat({
      id: "sw_new",
      title: "New riser penetration",
      detail: "x",
      order: 9,
    });
    const deps2 = fakeDeps({ clauseList: grownScope, prior: deps1.saved[0]! });
    const second = await runReconciliationConfirm(deps2, {
      jobId: "j",
      classifications: { sw_new: "priced" },
      confirmedBy: "Boss",
      at: "2026-06-17T00:00:00.000Z",
    });
    expect(second.ok).toBe(true);

    const persisted = deps2.saved[0]!;
    // the acceptance is still recorded and the disposal finding is still closed
    expect(persisted.reconciliation.resolutions).toEqual([
      expect.objectContaining({ findingKey: KEY, action: "accepted", reason: "agreed by email" }),
    ]);
    expect(persisted.warnings.map((w) => w.key)).not.toContain(KEY);
  });

  it("a stale sourceHash rejects the confirm before any resolution is written (409)", async () => {
    const deps = fakeDeps({ prior: redPrior() });
    const r = await runReconciliationConfirm(deps, {
      jobId: "j",
      resolutions: [{ findingKey: KEY, action: "resolved" }],
      expectedSourceHash: "stale",
      confirmedBy: "Boss",
      at: LATER,
    });
    expect(r).toMatchObject({ ok: false, status: 409, code: "stale_source" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("401/403 from the authoritative gate never reach a resolution write", async () => {
    const depsA = fakeDeps({ prior: redPrior() });
    const unauth = await confirmReconciliationAuthorized(
      depsA,
      { cookieHeader: "buhl_session=x.badsig", baseUrl: "https://x", verify: verifyNull },
      { jobId: "j", resolutions: [{ findingKey: KEY, action: "resolved" }], at: LATER },
    );
    expect(unauth).toMatchObject({ ok: false, status: 401 });
    expect(depsA.save).not.toHaveBeenCalled();

    const depsB = fakeDeps({ prior: redPrior() });
    const nonAdmin = await confirmReconciliationAuthorized(
      depsB,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyField },
      { jobId: "j", resolutions: [{ findingKey: KEY, action: "resolved" }], at: LATER },
    );
    expect(nonAdmin).toMatchObject({ ok: false, status: 403 });
    expect(depsB.save).not.toHaveBeenCalled();
  });

  it("a verified admin's resolution write stamps the VERIFIED identity as `by`", async () => {
    const deps = fakeDeps({ prior: redPrior() });
    const r = await confirmReconciliationAuthorized(
      deps,
      { cookieHeader: "c", baseUrl: "https://x", verify: verifyAdmin },
      {
        jobId: "j",
        resolutions: [{ findingKey: KEY, action: "accepted", reason: "priced elsewhere" }],
        at: LATER,
      },
    );
    expect(r.ok).toBe(true);
    expect(deps.saved[0]!.reconciliation.resolutions[0]).toMatchObject({ by: "Boss" });
  });
});

// ── blobReconciliationDeps wiring ─────────────────────────────────────────────

describe("blobReconciliationDeps", () => {
  it("exposes the producer deps surface", () => {
    const deps = blobReconciliationDeps();
    expect(typeof deps.loadScope).toBe("function");
    expect(typeof deps.loadPrior).toBe("function");
    expect(typeof deps.savePersisted).toBe("function");
  });
});
