import { beforeEach, describe, expect, it } from "vitest";
import {
  attachRecord,
  claimsRevisionOf,
  computeClaimsRevision,
  createClaim,
  deleteDraftClaim,
  detachRecord,
  linkEvidence,
  readClaimsView,
  removeLine,
  setClaimStatus,
  submitClaim,
  updateLine,
  type ClaimsStoreDeps,
} from "./store";
import type { ProgressClaimsDoc } from "@/domains/progress-claims/types";

/**
 * Deps-injected store tests (the job-control writer-test pattern): a fake
 * blob layer, spy-counted saves (ONE write per mutation), and fixed neighbours
 * — job / quote / spine / evidence / ITPs / variations / dayworks.
 */

interface World {
  doc: unknown | null;
  saves: Array<ProgressClaimsDoc>;
  job: Record<string, unknown> | null;
  quote: unknown | null;
  spine: unknown | null;
  jobData: unknown | null;
  itps: unknown | null;
  variations: unknown | null;
  dayworks: unknown | null;
}

let world: World;
let mint: number;

function deps(): ClaimsStoreDeps {
  return {
    loadDoc: async () => world.doc,
    saveDoc: async (_jobId, doc) => {
      world.saves.push(doc);
      world.doc = doc;
    },
    loadJob: async () => world.job,
    loadQuote: async () => world.quote,
    loadSpine: async () => world.spine,
    loadJobData: async () => world.jobData,
    loadItps: async () => world.itps,
    loadVariations: async () => world.variations,
    loadDayworks: async () => world.dayworks,
    mintClaimId: () => `pc_${++mint}`,
    mintLineId: () => `cl_${++mint}`,
  };
}

const EMPTY_REV = claimsRevisionOf({ jobId: "job-1", claims: [] });

function currentRev(): string {
  return claimsRevisionOf(world.doc as ProgressClaimsDoc);
}

beforeEach(() => {
  mint = 0;
  world = {
    doc: null,
    saves: [],
    job: { id: "job-1", name: "100 Arthur St", fromQuoteId: "q1", claimedToDate: 0 },
    quote: {
      id: "q1",
      title: "Arthur base build",
      sections: [
        {
          id: "s1",
          title: "East Gym",
          lines: [
            { id: "l1", description: "ZIP tap & dedicated 20A circuit", qty: 1, rate: 1850 },
            { id: "l2", description: "GPO double, RCD protected", qty: 14, rate: 68.5 },
          ],
        },
      ],
    },
    spine: {
      workPackages: [
        {
          id: "wp_zip",
          title: "East Gym — ZIP",
          boqLineRefs: [{ quoteId: "q1", sectionId: "s1", lineId: "l1" }],
          taskRefs: [
            { areaId: "a1", stage: "roughIn", taskId: "t1" },
            { areaId: "a1", stage: "fitOff", taskId: "t2" },
          ],
        },
      ],
    },
    jobData: {
      dwellings: { a1: { roughIn: { tasks: { t1: "complete" } }, fitOff: { tasks: {} } } },
      evidence: [{ id: "ev1", kind: "photo", note: "ZIP circuit at board" }],
    },
    itps: { instances: [{ id: "itp1", status: "signed-off", templateSnapshot: { name: "Final fix ITP" } }] },
    variations: {
      claims: [
        { id: "vc_1", ref: "VO-001", scope: "Extra GPO run", status: "approved", valueCents: 25_000 },
        { id: "vc_2", ref: "VO-002", scope: "Unpriced extra", status: "approved", valueCents: null },
        { id: "vc_3", ref: "VO-003", scope: "Still draft", status: "draft", valueCents: 10_000 },
      ],
    },
    dayworks: {
      dockets: [
        { id: "dw_1", ref: "DW-004", description: "Builder direction — move board", status: "signed" },
        { id: "dw_2", ref: "DW-005", description: "Unsigned scribble", status: "unsigned" },
      ],
    },
  };
});

async function createDraft() {
  const res = await createClaim(deps(), {
    jobId: "job-1",
    expectedRevision: EMPTY_REV,
    at: "2026-07-01T00:00:00.000Z",
    by: "karen",
  });
  if (!res.ok) throw new Error(`createDraft failed: ${res.error}`);
  return res;
}

describe("createClaim", () => {
  it("seeds from the linked quote with ONE write", async () => {
    const res = await createDraft();
    expect(res.claim?.seedSource).toBe("quote");
    expect(res.claim?.lines).toHaveLength(2);
    expect(res.claim?.lines[0]!.contractValueCents).toBe(185_000);
    expect(res.claim?.lines[0]!.workPackageId).toBe("wp_zip");
    expect(res.claim?.number).toBe(1);
    expect(world.saves).toHaveLength(1);
  });

  it("falls back to packages (unpriced) when no quote is linked", async () => {
    world.job = { id: "job-1", name: "100 Arthur St" };
    const res = await createDraft();
    expect(res.claim?.seedSource).toBe("packages");
    expect(res.claim?.lines).toHaveLength(1);
    expect(res.claim?.lines[0]!.contractValueCents).toBeNull();
  });

  it("seeds blank when neither exists", async () => {
    world.job = { id: "job-1" };
    world.spine = null;
    const res = await createDraft();
    expect(res.claim?.seedSource).toBe("blank");
    expect(res.claim?.lines).toHaveLength(0);
  });

  it("409s a second open draft", async () => {
    const first = await createDraft();
    const res = await createClaim(deps(), {
      jobId: "job-1",
      expectedRevision: first.revision,
      at: "2026-07-01T00:00:00.000Z",
      by: "karen",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("draft_exists");
  });

  it("409s a stale revision with the current one attached", async () => {
    await createDraft();
    const res = await createClaim(deps(), {
      jobId: "job-1",
      expectedRevision: "stale",
      at: "2026-07-01T00:00:00.000Z",
      by: "karen",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("stale_revision");
      expect(res.currentRevision).toBe(currentRev());
    }
  });

  it("404s an unknown job and refuses an unreadable doc", async () => {
    world.job = null;
    const res = await createClaim(deps(), {
      jobId: "job-1",
      expectedRevision: EMPTY_REV,
      at: "t",
      by: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("job_not_found");

    world.job = { id: "job-1" };
    world.doc = { totally: "corrupt", claims: "nope" };
    const res2 = await createClaim(deps(), {
      jobId: "job-1",
      expectedRevision: EMPTY_REV,
      at: "t",
      by: null,
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe("doc_unreadable");
    expect(world.saves).toHaveLength(0); // never overwrites what it can't read
  });
});

describe("updateLine", () => {
  it("sets the admin-entered percent and computes values server-side", async () => {
    const draft = await createDraft();
    const lineId = draft.claim!.lines[0]!.id;
    const res = await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId,
      thisPctBp: 2500,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const line = res.claim!.lines.find((l) => l.id === lineId)!;
      expect(line.thisValueCents).toBe(46_250);
      expect(line.toDatePctBp).toBe(2500);
      expect(res.claim!.totals.thisClaimValueCents).toBe(46_250);
    }
  });

  it("enforces the over-claim guard unless the override is set", async () => {
    const draft = await createDraft();
    const lineId = draft.claim!.lines[0]!.id;
    const over = await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId,
      thisPctBp: 10_500,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("over_claim");

    const withOverride = await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId,
      thisPctBp: 10_500,
      overClaimOverride: true,
    });
    expect(withOverride.ok).toBe(true);
  });

  it("locks quote-sourced contract values", async () => {
    const draft = await createDraft();
    const res = await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId: draft.claim!.lines[0]!.id,
      contractValueCents: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_input");
  });
});

describe("evidence linking", () => {
  it("links only REAL records and snapshots labels", async () => {
    const draft = await createDraft();
    const lineId = draft.claim!.lines[0]!.id;
    const ok = await linkEvidence(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId,
      add: [
        { kind: "evidence", id: "ev1" },
        { kind: "itp", id: "itp1" },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const refs = ok.claim!.lines.find((l) => l.id === lineId)!.evidenceRefs;
      expect(refs).toHaveLength(2);
      expect(refs[0]!.label).toBe("ZIP circuit at board");
      expect(refs[1]!.label).toBe("Final fix ITP (signed-off)");
    }

    const bad = await linkEvidence(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      lineId,
      add: [{ kind: "evidence", id: "ghost" }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("record_not_found");
  });
});

describe("attachments", () => {
  it("attaches an approved variation with its real value; rejects unpriced/draft ones", async () => {
    const draft = await createDraft();
    const ok = await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      kind: "variation",
      recordId: "vc_1",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.claim!.attachments[0]).toMatchObject({ ref: "VO-001", valueCents: 25_000 });
      expect(ok.claim!.totals.attachmentsValueCents).toBe(25_000);
    }

    for (const [recordId, reason] of [
      ["vc_2", "not_attachable"],
      ["vc_3", "not_attachable"],
      ["ghost", "record_not_found"],
    ] as const) {
      const res = await attachRecord(deps(), {
        jobId: "job-1",
        expectedRevision: currentRev(),
        claimId: draft.claim!.id,
        kind: "variation",
        recordId,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe(reason);
    }
  });

  it("a record attaches to at most one claim, and can be detached", async () => {
    const draft = await createDraft();
    await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      kind: "variation",
      recordId: "vc_1",
    });
    const again = await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      kind: "variation",
      recordId: "vc_1",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("already_attached");

    const detached = await detachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      kind: "variation",
      recordId: "vc_1",
    });
    expect(detached.ok).toBe(true);
    if (detached.ok) expect(detached.claim!.attachments).toHaveLength(0);
  });

  it("signed dayworks attach as support with NO invented value; unsigned rejected", async () => {
    const draft = await createDraft();
    const ok = await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      kind: "daywork",
      recordId: "dw_1",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.claim!.attachments[0]!.valueCents).toBeNull();
      expect(ok.claim!.totals.attachmentsValueCents).toBe(0);
    }
    const unsigned = await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      kind: "daywork",
      recordId: "dw_2",
    });
    expect(unsigned.ok).toBe(false);
  });
});

describe("submit — the immutable freeze", () => {
  async function draftWithMovement() {
    const draft = await createDraft();
    const lineId = draft.claim!.lines[0]!.id;
    const updated = await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId,
      thisPctBp: 2500,
    });
    if (!updated.ok) throw new Error("setup failed");
    return { claimId: draft.claim!.id, lineId, revision: updated.revision };
  }

  it("blocks a claim with nothing claimed", async () => {
    const draft = await createDraft();
    const res = await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      at: "2026-07-02T00:00:00.000Z",
      by: "karen",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("submit_blocked");
      expect(res.blockers).toContainEqual({ code: "nothing_claimed" });
    }
  });

  it("freezes status, stamps who/when, builds the evidence manifest", async () => {
    const { claimId, lineId, revision } = await draftWithMovement();
    await linkEvidence(deps(), {
      jobId: "job-1",
      expectedRevision: revision,
      claimId,
      lineId,
      add: [{ kind: "evidence", id: "ev1" }],
    });
    const res = await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      at: "2026-07-02T00:00:00.000Z",
      by: "karen",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claim!.status).toBe("submitted");
      expect(res.claim!.submittedAt).toBe("2026-07-02T00:00:00.000Z");
      expect(res.claim!.submittedBy).toBe("karen");
      const manifest = res.claim!.evidenceManifest!;
      expect(manifest.entries.find((e) => e.lineId === lineId)!.refs).toHaveLength(1);
    }
  });

  it("a submitted claim is immutable — every draft mutation 409s", async () => {
    const { claimId, lineId } = await draftWithMovement();
    await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      at: "t",
      by: null,
    });
    const savesBefore = world.saves.length;
    for (const attempt of [
      updateLine(deps(), { jobId: "job-1", expectedRevision: currentRev(), claimId, lineId, thisPctBp: 1 }),
      removeLine(deps(), { jobId: "job-1", expectedRevision: currentRev(), claimId, lineId }),
      deleteDraftClaim(deps(), { jobId: "job-1", expectedRevision: currentRev(), claimId }),
      linkEvidence(deps(), { jobId: "job-1", expectedRevision: currentRev(), claimId, lineId, removeIds: ["x"] }),
    ]) {
      const res = await attempt;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("immutable_claim");
    }
    expect(world.saves.length).toBe(savesBefore); // nothing wrote
  });

  it("re-verifies attachments at freeze — a walked-back variation blocks", async () => {
    const draft = await createDraft();
    await attachRecord(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      kind: "variation",
      recordId: "vc_1",
    });
    // The builder rejects the variation between attach and submit.
    world.variations = {
      claims: [{ id: "vc_1", ref: "VO-001", scope: "Extra GPO run", status: "rejected", valueCents: 25_000 }],
    };
    const res = await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      at: "t",
      by: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_attachable");
  });

  it("claim 2 derives previously-claimed from claim 1 (cumulative chain)", async () => {
    const { claimId } = await draftWithMovement();
    await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      at: "2026-07-02T00:00:00.000Z",
      by: null,
    });
    const second = await createClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      at: "2026-08-01T00:00:00.000Z",
      by: null,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.claim!.number).toBe(2);
      expect(second.claim!.previousClaimId).toBe(claimId);
      const zip = second.claim!.lines.find((l) => l.sourceKey === "boq:q1/s1/l1")!;
      expect(zip.previousPctBp).toBe(2500);
      expect(zip.previousValueCents).toBe(46_250);
      expect(zip.thisPctBp).toBe(0);
    }
  });
});

describe("setClaimStatus", () => {
  async function submitted() {
    const draft = await createDraft();
    await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId: draft.claim!.lines[0]!.id,
      thisPctBp: 2500,
    });
    await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      at: "t",
      by: null,
    });
    return draft.claim!.id;
  }

  it("certify requires a value; then paid; invalid moves 409", async () => {
    const claimId = await submitted();
    const noValue = await setClaimStatus(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      to: "certified",
      at: "t",
    });
    expect(noValue.ok).toBe(false);

    const certified = await setClaimStatus(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      to: "certified",
      certifiedValueCents: 40_000,
      certifiedRef: "PC-3-CERT",
      at: "2026-07-10T00:00:00.000Z",
    });
    expect(certified.ok).toBe(true);
    if (certified.ok) expect(certified.claim!.certifiedValueCents).toBe(40_000);

    const paid = await setClaimStatus(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      to: "paid",
      paidRef: "EFT-991",
      at: "2026-07-20T00:00:00.000Z",
    });
    expect(paid.ok).toBe(true);

    const backwards = await setClaimStatus(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId,
      to: "certified",
      certifiedValueCents: 1,
      at: "t",
    });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.reason).toBe("invalid_transition");
  });
});

describe("readClaimsView", () => {
  it("serves derived rollups, references, linkable + attachable records", async () => {
    const draft = await createDraft();
    await updateLine(deps(), {
      jobId: "job-1",
      expectedRevision: draft.revision,
      claimId: draft.claim!.id,
      lineId: draft.claim!.lines[0]!.id,
      thisPctBp: 2500,
    });
    await submitClaim(deps(), {
      jobId: "job-1",
      expectedRevision: currentRev(),
      claimId: draft.claim!.id,
      at: "2026-07-02T00:00:00.000Z",
      by: null,
    });

    const view = await readClaimsView(deps(), "job-1", "2026-07-05T00:00:00.000Z");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.derived.claimedToDateCents).toBe(46_250);
    expect(view.derived.oldestUnpaidDays).toBe(3);
    // Reference completion: 1 of 2 package tasks complete in dwellings.
    expect(view.references).toEqual([
      { workPackageId: "wp_zip", tasksComplete: 1, tasksTotal: 2 },
    ]);
    expect(view.linkable.map((r) => r.id)).toEqual(["ev1", "itp1"]);
    // Only attachable-quality records are offered; vc_1 is still free.
    expect(view.attachable.map((r) => r.id)).toEqual(["vc_1", "dw_1"]);
    expect(view.seed.source).toBe("quote");
    expect(view.revision).toBe(currentRev());
  });

  it("an empty job serves an empty register with the empty revision", async () => {
    const view = await readClaimsView(deps(), "job-1", "2026-07-05T00:00:00.000Z");
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.claims).toEqual([]);
      expect(view.revision).toBe(EMPTY_REV);
      expect(view.derived.claimedToDateCents).toBe(0);
      expect(view.derived.oldestUnpaidDays).toBeNull();
    }
  });
});

describe("revision", () => {
  it("is a content hash that moves with the claims", async () => {
    const before = computeClaimsRevision({ jobId: "job-1", claims: [] });
    await createDraft();
    const after = claimsRevisionOf(world.doc as ProgressClaimsDoc);
    expect(after).not.toBe(before);
    expect((world.doc as ProgressClaimsDoc).revision).toBe(after);
  });
});
