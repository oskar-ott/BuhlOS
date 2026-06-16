import { describe, expect, it, vi } from "vitest";
import {
  FIELD_CLASSIFICATION_OPTIONS,
  EMPTY_SELECTION,
  buildClassificationPatch,
  buildReconciliationConfirmBody,
  canSave,
  compileConfirm,
  compilePreview,
  saveReconciliation,
  summarisePreview,
  type AuthoringSelection,
} from "./jobControlAuthoringClient";

const FULL: AuthoringSelection = {
  clauseId: "sw_zip",
  classification: "priced",
  areaId: "ar_east_gym",
  stage: "fitOff",
  taskId: "ft_zip",
  proofLabel: "Photo of completed ZIP tap",
  proofKind: "photo",
  proofNote: "Capture after testing",
};

/** Response-like fake with a JSON body. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  const ok = status >= 200 && status < 300;
  return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("classification options — only the domain's field-delivering set", () => {
  it("offers exactly priced / general_allowance / pc_provisional with plain labels", () => {
    expect(FIELD_CLASSIFICATION_OPTIONS.map((o) => o.value)).toEqual([
      "priced",
      "general_allowance",
      "pc_provisional",
    ]);
    // never the non-domain `field_delivered` the brief warned about
    expect(FIELD_CLASSIFICATION_OPTIONS.map((o) => o.value)).not.toContain("field_delivered");
    expect(FIELD_CLASSIFICATION_OPTIONS.map((o) => o.label)).toEqual([
      "Priced field work",
      "General allowance",
      "PC / provisional",
    ]);
  });
});

describe("canSave — guards a complete authoring intent", () => {
  it("is false for the empty selection and when any required field is missing", () => {
    expect(canSave(EMPTY_SELECTION)).toBe(false);
    const missing: Array<Partial<AuthoringSelection>> = [
      { clauseId: "" },
      { classification: "" },
      { areaId: "" },
      { stage: "" },
      { taskId: "" },
      { proofLabel: "   " }, // whitespace-only proof is not a proof
    ];
    for (const patch of missing) expect(canSave({ ...FULL, ...patch })).toBe(false);
  });

  it("is true for a complete selection", () => {
    expect(canSave(FULL)).toBe(true);
  });
});

describe("buildClassificationPatch / buildReconciliationConfirmBody", () => {
  it("carries classification + deliveredBy coordinate + requiredEvidence (no fabricated id)", () => {
    const patch = buildClassificationPatch(FULL);
    expect(patch.classification).toBe("priced");
    expect(patch.deliveredBy).toEqual([
      { areaId: "ar_east_gym", stage: "fitOff", taskId: "ft_zip" },
    ]);
    expect(patch.requiredEvidence).toEqual([
      { label: "Photo of completed ZIP tap", kind: "photo", note: "Capture after testing" },
    ]);
    // no client-side id — the L0 producer derives a stable re_… id from the label
    expect("id" in patch.requiredEvidence[0]!).toBe(false);
  });

  it("omits an empty note rather than sending note:''", () => {
    const patch = buildClassificationPatch({ ...FULL, proofNote: "   " });
    expect(patch.requiredEvidence[0]).toEqual({
      label: "Photo of completed ZIP tap",
      kind: "photo",
    });
    expect("note" in patch.requiredEvidence[0]!).toBe(false);
  });

  it("nests the patch under the clause id in the confirm body", () => {
    const body = buildReconciliationConfirmBody("job_1", FULL);
    expect(body.jobId).toBe("job_1");
    expect(Object.keys(body.classifications)).toEqual(["sw_zip"]);
    expect(body.classifications.sw_zip).toEqual(buildClassificationPatch(FULL));
  });
});

describe("saveReconciliation", () => {
  it("POSTs the confirm body and maps a 200 to ok + saved provenance", async () => {
    const fetchImpl = fakeFetch(200, {
      ok: true,
      jobId: "job_1",
      saved: { status: "amber", sourceHash: "abc" },
    });
    const r = await saveReconciliation("job_1", FULL, fetchImpl);
    expect(r).toEqual({ ok: true, data: { status: "amber", sourceHash: "abc" } });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("/api/job-control/reconciliation/confirm");
    const sent = JSON.parse((call[1] as RequestInit).body as string);
    expect(sent).toEqual(buildReconciliationConfirmBody("job_1", FULL));
  });

  it("maps 401/403 to a plain admin-login message", async () => {
    expect((await saveReconciliation("j", FULL, fakeFetch(401, { ok: false }))).ok).toBe(false);
    const r = await saveReconciliation("j", FULL, fakeFetch(403, { ok: false, error: "Admin only" }));
    expect(r).toEqual({ ok: false, message: "Authoring required proof needs an admin login." });
  });

  it("maps 409 stale_source to a reload message", async () => {
    const r = await saveReconciliation("j", FULL, fakeFetch(409, { ok: false, code: "stale_source" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/changed since you loaded it/i);
  });

  it("maps a thrown fetch to a network message", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await saveReconciliation("j", FULL, throwing)).toEqual({
      ok: false,
      message: "Network error. Try again.",
    });
  });
});

describe("compilePreview", () => {
  it("POSTs { jobId } and summarises work packages / proof / gaps / diff", async () => {
    const fetchImpl = fakeFetch(200, {
      ok: true,
      workPackages: [
        { id: "wp_1", requiredEvidence: [{ id: "re_1" }, { id: "re_2" }] },
        { id: "wp_2", requiredEvidence: [{ id: "re_3" }] },
      ],
      gaps: [{ kind: "no_delivering_task", message: "Clause X has no delivering task" }],
      diff: { added: 2, updated: 0, removed: 0 },
      sourceHash: "src_1",
    });
    const r = await compilePreview("job_1", fetchImpl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      workPackageCount: 2,
      requiredProofCount: 3,
      gaps: ["Clause X has no delivering task"],
      added: 2,
      updated: 0,
      removed: 0,
      sourceHash: "src_1",
    });

    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toEqual({ jobId: "job_1" });
  });

  it("maps a no_reconciliation 409 to 'save the proof first'", async () => {
    const r = await compilePreview("job_1", fakeFetch(409, { ok: false, code: "no_reconciliation" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/save the required proof first/i);
  });
});

describe("summarisePreview (pure)", () => {
  it("counts proof across packages and tolerates missing fields", () => {
    expect(summarisePreview({})).toEqual({
      workPackageCount: 0,
      requiredProofCount: 0,
      gaps: [],
      added: 0,
      updated: 0,
      removed: 0,
      sourceHash: "",
    });
  });
});

describe("compileConfirm", () => {
  it("POSTs { jobId, sourceHash } and maps a 200 to the saved revision + counts", async () => {
    const fetchImpl = fakeFetch(200, {
      ok: true,
      jobId: "job_1",
      saved: { key: "jobs/job_1/job-control.json", workPackageCount: 1, gapCount: 0, revision: "rev_1" },
    });
    const r = await compileConfirm("job_1", "src_1", fetchImpl);
    expect(r).toEqual({
      ok: true,
      data: { revision: "rev_1", workPackageCount: 1, gapCount: 0, key: "jobs/job_1/job-control.json" },
    });
    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toEqual({ jobId: "job_1", sourceHash: "src_1" });
  });

  it("omits sourceHash when none is supplied", async () => {
    const fetchImpl = fakeFetch(200, { ok: true, saved: { revision: "rev_x" } });
    await compileConfirm("job_1", null, fetchImpl);
    const sent = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(sent).toEqual({ jobId: "job_1" });
  });

  it("maps a stale_revision 409 to a reload message", async () => {
    const r = await compileConfirm("job_1", "src", fakeFetch(409, { ok: false, code: "stale_revision" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/compiled job changed/i);
  });
});
