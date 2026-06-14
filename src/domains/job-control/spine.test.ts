import { describe, it, expect } from "vitest";
import {
  JobControlSpineSchema,
  WorkPackageSchema,
  ClaimLineSchema,
  EvidenceLinkSchema,
  CloseoutRequirementSchema,
} from "./schema";
import type { JobControlSpine } from "./types";
import {
  taskRefKey,
  boqLineRefKey,
  emptySpine,
  validateEvidenceLink,
  traceClause,
  claimedTotalForPackage,
  jobClaimedTotal,
  reconcileClaimedToDate,
  closeoutProgress,
  findDanglingRefs,
} from "./spine";

/**
 * The worked 100 Arthur St trace from the issue (#364) and the architecture
 * doc: one scope clause — "dedicated 20A ZIP circuit, East Gym" — followed all
 * the way from clause → BOQ line → work package → task → evidence → claim line
 * → closeout. Built entirely from real domain shapes (scope clause = a
 * Job.scopeOfWork[].id; BOQ line = a quotes-v2 QuoteLine coordinate; task = an
 * area/stage/task coordinate; evidence = an EvidenceItem.id).
 */
const CLAUSE_ZIP = "sw_zip_east_gym";
const TASK_KEY = taskRefKey({ areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip_circuit" });
const BOQ_KEY = boqLineRefKey({ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip_20a" });

function zipSpine(): JobControlSpine {
  return JobControlSpineSchema.parse({
    jobId: "job_100arthur",
    workPackages: [
      {
        id: "wp_east_gym_zip",
        jobId: "job_100arthur",
        title: "East Gym — ZIP tap & dedicated 20A circuit",
        scopeClauseIds: [CLAUSE_ZIP],
        boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip_20a" }],
        taskRefs: [{ areaId: "area_east_gym", stage: "fitOff", taskId: "task_zip_circuit" }],
        order: 0,
      },
      {
        id: "wp_unrelated",
        jobId: "job_100arthur",
        title: "Reception — GPOs",
        scopeClauseIds: ["sw_reception_gpos"],
        order: 1,
      },
    ],
    claimLines: [
      {
        id: "cl_zip_claim3",
        jobId: "job_100arthur",
        claimRef: "Claim 3",
        periodLabel: "June 2026",
        description: "East Gym ZIP dedicated circuit — rough-in + fit-off",
        workPackageId: "wp_east_gym_zip",
        boqLineRefs: [{ quoteId: "q_100arthur", sectionId: "sec_power", lineId: "ql_zip_20a" }],
        claimedAmount: 1850,
        status: "approved",
        order: 0,
      },
      {
        id: "cl_unrelated",
        jobId: "job_100arthur",
        description: "Reception GPOs",
        workPackageId: "wp_unrelated",
        claimedAmount: 500,
        status: "draft",
        order: 1,
      },
    ],
    evidenceLinks: [
      {
        id: "el_zip_photo",
        jobId: "job_100arthur",
        evidenceId: "ev_zip_tested",
        workPackageId: "wp_east_gym_zip",
        claimLineId: "cl_zip_claim3",
        role: "progress",
      },
    ],
    closeoutRequirements: [
      {
        id: "cr_zip_itp",
        jobId: "job_100arthur",
        title: "East Gym ZIP circuit tested & ITP signed",
        kind: "itp",
        scopeClauseIds: [CLAUSE_ZIP],
        workPackageId: "wp_east_gym_zip",
        itpInstanceId: "itp_zip_east_gym",
        status: "outstanding",
        order: 0,
      },
      {
        id: "cr_asbuilt",
        jobId: "job_100arthur",
        title: "As-built drawings issued",
        kind: "document",
        scopeClauseIds: [],
        status: "satisfied",
        documentId: "doc_asbuilt_F10",
        order: 1,
      },
    ],
  });
}

describe("schema defaults", () => {
  it("fills array fields so helpers never see undefined", () => {
    const wp = WorkPackageSchema.parse({ id: "wp_x", jobId: "j", title: "X" });
    expect(wp.scopeClauseIds).toEqual([]);
    expect(wp.boqLineRefs).toEqual([]);
    expect(wp.taskRefs).toEqual([]);
    expect(wp.order).toBe(0);
  });

  it("preserves unknown fields (passthrough, for the calculator/claims children)", () => {
    const cl = ClaimLineSchema.parse({
      id: "cl_x",
      jobId: "j",
      description: "d",
      claimedAmount: 10,
      status: "draft",
      futureField: "kept",
    }) as Record<string, unknown>;
    expect(cl.futureField).toBe("kept");
  });
});

describe("keys", () => {
  it("taskRefKey is the area/stage/task coordinate", () => {
    expect(TASK_KEY).toBe("area_east_gym/fitOff/task_zip_circuit");
  });
  it("boqLineRefKey is the quote/section/line coordinate", () => {
    expect(BOQ_KEY).toBe("q_100arthur/sec_power/ql_zip_20a");
  });
});

describe("emptySpine", () => {
  it("is a valid, empty, parseable spine", () => {
    const s = emptySpine("job_x");
    expect(() => JobControlSpineSchema.parse(s)).not.toThrow();
    expect(s.workPackages).toEqual([]);
  });
});

describe("validateEvidenceLink", () => {
  const base = { id: "el", jobId: "j", role: "progress" as const };
  it("accepts a link with proof + node", () => {
    const link = EvidenceLinkSchema.parse({ ...base, evidenceId: "ev1", workPackageId: "wp1" });
    expect(validateEvidenceLink(link)).toEqual([]);
  });
  it("rejects a link with no proof side", () => {
    const link = EvidenceLinkSchema.parse({ ...base, workPackageId: "wp1" });
    expect(validateEvidenceLink(link)).toHaveLength(1);
    expect(validateEvidenceLink(link)[0]).toMatch(/proof side/);
  });
  it("rejects a link with no spine node", () => {
    const link = EvidenceLinkSchema.parse({ ...base, observationId: "obs1" });
    expect(validateEvidenceLink(link)[0]).toMatch(/spine node/);
  });
  it("accepts an observation (variation proof) against a closeout requirement", () => {
    const link = EvidenceLinkSchema.parse({
      ...base,
      role: "closeout",
      observationId: "obs_var",
      closeoutRequirementId: "cr1",
    });
    expect(validateEvidenceLink(link)).toEqual([]);
  });
});

describe("traceClause — the 100 Arthur ZIP circuit", () => {
  const trace = traceClause(zipSpine(), CLAUSE_ZIP);

  it("finds only the package that delivers the clause", () => {
    expect(trace.workPackages.map((wp) => wp.id)).toEqual(["wp_east_gym_zip"]);
  });
  it("reaches the BOQ line that funds it", () => {
    expect(trace.boqLineRefs.map(boqLineRefKey)).toEqual([BOQ_KEY]);
  });
  it("reaches the task that does the work", () => {
    expect(trace.taskRefs.map(taskRefKey)).toEqual([TASK_KEY]);
  });
  it("reaches the claim line that bills it", () => {
    expect(trace.claimLines.map((cl) => cl.id)).toEqual(["cl_zip_claim3"]);
  });
  it("reaches the evidence that proves it", () => {
    expect(trace.evidenceLinks.map((el) => el.evidenceId)).toEqual(["ev_zip_tested"]);
  });
  it("reaches the closeout obligation it carries", () => {
    expect(trace.closeoutRequirements.map((cr) => cr.id)).toEqual(["cr_zip_itp"]);
  });
  it("does not leak the unrelated reception package", () => {
    const recTrace = traceClause(zipSpine(), "sw_reception_gpos");
    expect(recTrace.workPackages.map((wp) => wp.id)).toEqual(["wp_unrelated"]);
    expect(recTrace.evidenceLinks).toEqual([]);
  });
  it("returns an empty trace for an unknown clause", () => {
    const t = traceClause(zipSpine(), "sw_nope");
    expect(t.workPackages).toEqual([]);
    expect(t.claimLines).toEqual([]);
  });
});

describe("claim totals", () => {
  const spine = zipSpine();
  it("totals a package's claim lines", () => {
    expect(claimedTotalForPackage(spine, "wp_east_gym_zip")).toBe(1850);
  });
  it("filters by status", () => {
    expect(claimedTotalForPackage(spine, "wp_unrelated", { statuses: ["approved", "paid"] })).toBe(0);
    expect(claimedTotalForPackage(spine, "wp_unrelated", { statuses: ["draft"] })).toBe(500);
  });
  it("totals the whole job", () => {
    expect(jobClaimedTotal(spine)).toBe(2350);
    expect(jobClaimedTotal(spine, { statuses: ["approved"] })).toBe(1850);
  });
});

describe("reconcileClaimedToDate", () => {
  const spine = zipSpine(); // approved total = 1850
  it("matches the scalar when it agrees with approved+paid lines", () => {
    const r = reconcileClaimedToDate(spine, 1850);
    expect(r.spineTotal).toBe(1850);
    expect(r.matches).toBe(true);
    expect(r.delta).toBe(0);
  });
  it("flags drift between the headline scalar and the lines (money leak)", () => {
    const r = reconcileClaimedToDate(spine, 2000);
    expect(r.delta).toBe(150);
    expect(r.matches).toBe(false);
  });
  it("ignores draft lines by default", () => {
    // unrelated draft (500) is excluded → scalar 1850 still matches
    expect(reconcileClaimedToDate(spine, 1850).matches).toBe(true);
  });
});

describe("closeoutProgress", () => {
  it("tallies by status with a real fraction", () => {
    const p = closeoutProgress(zipSpine());
    expect(p.total).toBe(2);
    expect(p.outstanding).toBe(1);
    expect(p.satisfied).toBe(1);
    expect(p.fractionDischarged).toBe(0.5);
  });
  it("returns null fraction (never fake 0%) when there's nothing to close out", () => {
    expect(closeoutProgress(emptySpine("j")).fractionDischarged).toBeNull();
  });
});

describe("findDanglingRefs", () => {
  it("a fully-consistent spine with full known-id sets has no dangling refs", () => {
    const refs = findDanglingRefs(zipSpine(), {
      scopeClauseIds: [CLAUSE_ZIP, "sw_reception_gpos"],
      taskRefKeys: [TASK_KEY],
      boqLineRefKeys: [BOQ_KEY],
      evidenceIds: ["ev_zip_tested"],
      documentIds: ["doc_asbuilt_F10"],
      itpInstanceIds: ["itp_zip_east_gym"],
    });
    expect(refs).toEqual([]);
  });

  it("always catches INTERNAL dangling refs even with no known sets", () => {
    const spine = JobControlSpineSchema.parse({
      jobId: "j",
      claimLines: [
        { id: "cl_orphan", jobId: "j", description: "d", workPackageId: "wp_ghost", claimedAmount: 1, status: "draft" },
      ],
    });
    const refs = findDanglingRefs(spine);
    expect(refs).toContainEqual({
      entity: "claimLine",
      id: "cl_orphan",
      field: "workPackageId",
      value: "wp_ghost",
    });
  });

  it("only checks external refs the caller supplies (no false positives)", () => {
    // Provide a scope-clause set missing the ZIP clause → flagged.
    const refs = findDanglingRefs(zipSpine(), { scopeClauseIds: ["sw_reception_gpos"] });
    expect(refs.some((r) => r.field === "scopeClauseIds" && r.value === CLAUSE_ZIP)).toBe(true);
    // taskRefs NOT checked because taskRefKeys was not supplied.
    expect(refs.some((r) => r.field === "taskRefs")).toBe(false);
  });

  it("flags a closeout requirement pointing at a missing document", () => {
    const refs = findDanglingRefs(zipSpine(), { documentIds: ["some_other_doc"] });
    expect(refs).toContainEqual({
      entity: "closeoutRequirement",
      id: "cr_asbuilt",
      field: "documentId",
      value: "doc_asbuilt_F10",
    });
  });
});

describe("schema round-trips", () => {
  it("the worked fixture is a valid spine", () => {
    expect(() => JobControlSpineSchema.parse(zipSpine())).not.toThrow();
  });
  it("closeout requirement enums are enforced", () => {
    expect(() =>
      CloseoutRequirementSchema.parse({ id: "cr", jobId: "j", title: "t", kind: "nope", status: "outstanding" }),
    ).toThrow();
  });
});
