import { describe, expect, it, vi } from "vitest";
import { TestRecordInputSchema } from "@/domains/test-records/schema";
import { buildTestRecord } from "@/domains/test-records/derive";
import {
  applyEvidenceLink,
  type EvidenceLinkRequest,
} from "@/server/job-control/evidence-link";
import { isRequiredEvidenceMet } from "@/domains/job-control/task-context";
import type { PersistedJobControl } from "@/server/job-control/compile-producer";
import { mintTestResultEvidence } from "./evidence-bridge";

function record(over: Record<string, unknown> = {}) {
  return buildTestRecord(
    TestRecordInputSchema.parse({
      jobId: "job_1",
      reportType: "eicr",
      tester: "Sparky",
      testedAt: "2026-06-18T02:00:00.000Z",
      rows: [
        { circuit: "Ring final — kitchen", testType: "insulation_resistance", value: 200, min: 1 },
        { circuit: "Zs kitchen", testType: "earth_fault_loop_zs", value: 1.0, max: 1.37 },
      ],
      ...over,
    }),
    { id: "tr_1", at: "2026-06-18T03:00:00.000Z", createdBy: "u_field" },
  );
}

describe("mintTestResultEvidence — the proof-loop bridge (extend, never fork)", () => {
  it("POSTs a test_result evidence carrying testRecordId + an honest summary note", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ evidenceItem: { id: "ev_minted" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const res = await mintTestResultEvidence(
      { base: "http://localhost:3000", cookieValue: "tok", record: record() },
      fetchImpl,
    );

    expect(res.evidenceId).toBe("ev_minted");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:3000/api/evidence?jobId=job_1");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.kind).toBe("test_result");
    expect(body.testRecordId).toBe("tr_1");
    // Honest summary — real circuit count, derived overall, no invented numbers.
    expect(body.note).toBe("2 circuits, overall pass");
    // The session cookie is forwarded so the mint authorises as the same worker.
    expect((calls[0]!.init.headers as Record<string, string>).cookie).toContain("tok");
    // Idempotency keyed on the record id — a retry returns the same evidence row.
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "test-record:tr_1",
    );
  });

  it("a failing record summarises 'overall fail' (the numbers, never a fake pass)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ evidenceItem: { id: "ev_x" } }), { status: 201 }),
    ) as unknown as typeof fetch;
    let captured = "";
    const spy = vi.fn(async (url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string).note;
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    await mintTestResultEvidence(
      {
        base: "http://x",
        cookieValue: "t",
        record: record({ rows: [{ circuit: "Zs", testType: "earth_fault_loop_zs", value: 5, max: 1.37 }] }),
      },
      spy,
    );
    expect(captured).toBe("1 circuit, overall fail");
  });

  it("a non-OK mint returns evidenceId:null with a worker-facing warning (record already saved)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await mintTestResultEvidence(
      { base: "http://x", cookieValue: "t", record: record() },
      fetchImpl,
    );
    expect(res.evidenceId).toBeNull();
    if (res.evidenceId === null) expect(res.warning).toMatch(/try linking again/i);
  });
});

describe("the minted evidence flips a test_result requirement to met via the UNCHANGED validator", () => {
  // A compiled artifact with a work package carrying a `test_result` requirement.
  const artifact: PersistedJobControl = {
    jobId: "job_1",
    workPackages: [
      {
        id: "wp_1",
        jobId: "job_1",
        title: "East gym",
        scopeClauseIds: [],
        boqLineRefs: [],
        taskRefs: [],
        order: 0,
        requiredEvidence: [{ id: "re_test", label: "Circuit test result", kind: "test_result" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [],
    proofReviews: [],
  } as unknown as PersistedJobControl;

  it("before: the requirement is NOT met; after linking the minted ev_ id: met — no validator change", () => {
    expect(isRequiredEvidenceMet(artifact.evidenceLinks, "wp_1", "re_test")).toBe(false);

    // The Phil flow links the REAL minted evidence id, exactly as a photo proof
    // does — through the UNCHANGED applyEvidenceLink + isRequiredEvidenceMet.
    const request: EvidenceLinkRequest = {
      workPackageId: "wp_1",
      requiredEvidenceId: "re_test",
      evidenceId: "ev_minted", // the companion test_result evidence — a real proof id
    };
    const applied = applyEvidenceLink(artifact, request, {
      id: "el_1",
      at: "2026-06-18T03:00:00.000Z",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("expected ok");

    // The met rule — touched in ZERO places — now reads the requirement as met.
    expect(isRequiredEvidenceMet(applied.artifact.evidenceLinks, "wp_1", "re_test")).toBe(true);
    // And the proof side of the link is a plain evidenceId — no testRecordId arm.
    expect(applied.link.evidenceId).toBe("ev_minted");
    expect("testRecordId" in applied.link).toBe(false);
  });
});
