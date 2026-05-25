import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveITPPayloadSchema,
  AttachITPPayloadSchema,
  ITP_OVERRIDE_JUSTIFICATION_MAX,
  ITP_POINT_TYPES,
  ITP_RESULT_NOTE_MAX,
  ITP_RESULT_PHOTO_URL_MAX,
  ITP_SCOPES,
  ITP_SIGNOFF_INDEPENDENCE_THRESHOLD,
  ITP_STATUSES,
  ITP_WITNESS_ROLES,
  ITPInstanceResultSchema,
  ITPInstanceSchema,
  ITPListResponseSchema,
  ITPPointTypeSchema,
  ITPScopeSchema,
  ITPStatusSchema,
  ITPTemplatePointSchema,
  ITPTemplateSnapshotSchema,
  ITPTransitionResponseSchema,
  ITPWitnessRoleSchema,
  RecordITPPointPayloadSchema,
  ReopenITPPayloadSchema,
  SignOffITPPayloadSchema,
} from "./schema";
import {
  formatProgress,
  isActive,
  isDone,
  needsWorkerAttention,
  pointTypeLabel,
  scopeContextLine,
  scopeLabel,
  statusLabel,
  statusTone,
  valuePassFail,
  valuePassFailLabel,
} from "./format";
import {
  allowedTransitionsList,
  canRecord,
  canRoleTransition,
  canSignOff,
  canTransition,
  compareForQueue,
  isAdminRole,
  isFieldRole,
  isLeadingHandRole,
  pointsRecordedByUserRatio,
} from "./service";
import {
  archiveItp,
  attachItp,
  listItps,
  recordItpPoint,
  reopenItp,
  signOffItp,
} from "./client";
import type {
  ITPInstance,
  ITPInstanceResult,
  ITPTemplatePoint,
} from "./types";

/* ----------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------- */

const photoPoint: ITPTemplatePoint = {
  id: "ip_photo",
  label: "Photo of MSB door label",
  type: "photo",
  required: true,
};

const valuePoint: ITPTemplatePoint = {
  id: "ip_value",
  label: "Insulation resistance",
  type: "value",
  unit: "MΩ",
  min: 1,
  max: 1000,
  required: true,
};

const signoffPoint: ITPTemplatePoint = {
  id: "ip_signoff",
  label: "Energised and tagged",
  type: "signoff",
  witnessRole: "admin",
  required: true,
};

const notePoint: ITPTemplatePoint = {
  id: "ip_note",
  label: "Site notes",
  type: "note",
  required: false,
};

const baseInstance: ITPInstance = {
  id: "itp_12345678",
  templateId: "tpl_msb_energise",
  templateSnapshot: {
    name: "MSB energisation",
    category: "Compliance",
    points: [photoPoint, valuePoint, signoffPoint, notePoint],
  },
  scope: "switchboard",
  scopeId: "sb_msb_1",
  status: "pending",
  results: {},
  createdAt: "2026-05-26T08:00:00.000Z",
  createdBy: "anna",
  updatedAt: "2026-05-26T08:00:00.000Z",
};

const photoResult: ITPInstanceResult = {
  value: null,
  note: "Door label visible.",
  photoUrl: "https://example.com/photo.jpg",
  byUserId: "user-tradie-1",
  byUsername: "sam",
  at: "2026-05-26T09:00:00.000Z",
};

const valueResult: ITPInstanceResult = {
  value: 250,
  note: "",
  byUserId: "user-tradie-1",
  byUsername: "sam",
  at: "2026-05-26T09:05:00.000Z",
};

const signoffResult: ITPInstanceResult = {
  value: true,
  note: "",
  byUserId: "user-admin-1",
  byUsername: "anna",
  at: "2026-05-26T10:00:00.000Z",
};

/* ----------------------------------------------------------------------
 * Schema — point types, scopes, statuses, witness roles
 * -------------------------------------------------------------------- */

describe("ITP enum schemas", () => {
  it("ITP_STATUSES preserves the kebab-case legacy values", () => {
    expect([...ITP_STATUSES]).toEqual([
      "pending",
      "in-progress",
      "witnessed",
      "signed-off",
    ]);
  });

  it("ITP_POINT_TYPES matches api/itp-templates.js VALID_POINT_TYPES", () => {
    expect([...ITP_POINT_TYPES].sort()).toEqual([
      "note",
      "photo",
      "signoff",
      "value",
    ]);
  });

  it("ITP_SCOPES matches api/job-itps.js VALID_SCOPE", () => {
    expect([...ITP_SCOPES].sort()).toEqual([
      "area",
      "job",
      "level",
      "switchboard",
    ]);
  });

  it("ITP_WITNESS_ROLES matches api/itp-templates.js VALID_WITNESS", () => {
    expect([...ITP_WITNESS_ROLES].sort()).toEqual(["admin", "builder", "lh"]);
  });

  it("status / point-type schemas reject unknown values", () => {
    expect(ITPStatusSchema.safeParse("signedoff").success).toBe(false);
    expect(ITPStatusSchema.safeParse("in_progress").success).toBe(false);
    expect(ITPPointTypeSchema.safeParse("checkbox").success).toBe(false);
    expect(ITPScopeSchema.safeParse("room").success).toBe(false);
    expect(ITPWitnessRoleSchema.safeParse("client").success).toBe(false);
  });

  it("config constants are at the documented values", () => {
    expect(ITP_RESULT_NOTE_MAX).toBe(500);
    expect(ITP_RESULT_PHOTO_URL_MAX).toBe(400);
    expect(ITP_OVERRIDE_JUSTIFICATION_MAX).toBe(500);
    expect(ITP_SIGNOFF_INDEPENDENCE_THRESHOLD).toBe(0.5);
  });
});

/* ----------------------------------------------------------------------
 * Schema — ITPTemplatePoint + ITPTemplateSnapshot
 * -------------------------------------------------------------------- */

describe("ITPTemplatePointSchema", () => {
  it("accepts photo / value / signoff / note points", () => {
    for (const p of [photoPoint, valuePoint, signoffPoint, notePoint]) {
      expect(ITPTemplatePointSchema.safeParse(p).success).toBe(true);
    }
  });

  it("rejects when id / label / type missing", () => {
    for (const f of ["id", "label", "type"] as const) {
      const broken = { ...photoPoint } as Record<string, unknown>;
      delete broken[f];
      expect(ITPTemplatePointSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("passes through forward-compat fields (.passthrough)", () => {
    const future = { ...photoPoint, weighting: 2 };
    const parsed = ITPTemplatePointSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { weighting?: number }).weighting).toBe(2);
    }
  });
});

describe("ITPTemplateSnapshotSchema", () => {
  it("accepts a snapshot with multiple point types", () => {
    expect(
      ITPTemplateSnapshotSchema.safeParse(baseInstance.templateSnapshot)
        .success,
    ).toBe(true);
  });

  it("requires name + points array", () => {
    const broken = { ...baseInstance.templateSnapshot } as Record<
      string,
      unknown
    >;
    delete broken.name;
    expect(ITPTemplateSnapshotSchema.safeParse(broken).success).toBe(false);
    const noPoints = { ...baseInstance.templateSnapshot } as Record<
      string,
      unknown
    >;
    delete noPoints.points;
    expect(ITPTemplateSnapshotSchema.safeParse(noPoints).success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema — ITPInstanceResult + ITPInstance
 * -------------------------------------------------------------------- */

describe("ITPInstanceResultSchema", () => {
  it("accepts photo / value / signoff result rows", () => {
    expect(ITPInstanceResultSchema.safeParse(photoResult).success).toBe(true);
    expect(ITPInstanceResultSchema.safeParse(valueResult).success).toBe(true);
    expect(ITPInstanceResultSchema.safeParse(signoffResult).success).toBe(true);
  });

  it("requires byUserId / byUsername / at", () => {
    for (const f of ["byUserId", "byUsername", "at"] as const) {
      const broken = { ...photoResult } as Record<string, unknown>;
      delete broken[f];
      expect(ITPInstanceResultSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("tolerates value of any shape (number / bool / string)", () => {
    expect(
      ITPInstanceResultSchema.safeParse({ ...valueResult, value: 250 }).success,
    ).toBe(true);
    expect(
      ITPInstanceResultSchema.safeParse({ ...valueResult, value: true })
        .success,
    ).toBe(true);
    expect(
      ITPInstanceResultSchema.safeParse({ ...valueResult, value: "passed" })
        .success,
    ).toBe(true);
    expect(
      ITPInstanceResultSchema.safeParse({ ...valueResult, value: null }).success,
    ).toBe(true);
  });
});

describe("ITPInstanceSchema", () => {
  it("accepts a minimal pending instance with empty results", () => {
    expect(ITPInstanceSchema.safeParse(baseInstance).success).toBe(true);
  });

  it("accepts a fully populated witnessed instance", () => {
    const witnessed = {
      ...baseInstance,
      status: "witnessed" as const,
      results: {
        [photoPoint.id]: photoResult,
        [valuePoint.id]: valueResult,
        [signoffPoint.id]: signoffResult,
      },
    };
    expect(ITPInstanceSchema.safeParse(witnessed).success).toBe(true);
  });

  it("accepts a signed-off instance with stamps", () => {
    const signed = {
      ...baseInstance,
      status: "signed-off" as const,
      signedOffBy: "anna",
      signedOffAt: "2026-05-26T11:00:00.000Z",
    };
    expect(ITPInstanceSchema.safeParse(signed).success).toBe(true);
  });

  it("rejects a signed-off instance missing signedOffBy", () => {
    const broken = {
      ...baseInstance,
      status: "signed-off" as const,
      signedOffAt: "2026-05-26T11:00:00.000Z",
    };
    expect(ITPInstanceSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a signed-off instance missing signedOffAt", () => {
    const broken = {
      ...baseInstance,
      status: "signed-off" as const,
      signedOffBy: "anna",
    };
    expect(ITPInstanceSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    const cases = [
      "id",
      "templateId",
      "templateSnapshot",
      "scope",
      "status",
      "results",
      "createdAt",
      "createdBy",
      "updatedAt",
    ];
    for (const f of cases) {
      const broken = { ...baseInstance } as Record<string, unknown>;
      delete broken[f];
      expect(ITPInstanceSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("passes through forward-compat fields (.passthrough)", () => {
    const future = { ...baseInstance, reviewerNotes: "looks good" };
    const parsed = ITPInstanceSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { reviewerNotes?: string }).reviewerNotes).toBe(
        "looks good",
      );
    }
  });

  it("status enum stays in sync with the runtime export", () => {
    expect(ITPStatusSchema.options).toEqual([...ITP_STATUSES]);
  });
});

/* ----------------------------------------------------------------------
 * Schema — request payloads
 * -------------------------------------------------------------------- */

describe("AttachITPPayloadSchema", () => {
  it("accepts a minimal job-scoped attach", () => {
    expect(
      AttachITPPayloadSchema.safeParse({
        templateId: "tpl_1",
        scope: "job",
      }).success,
    ).toBe(true);
  });

  it("accepts an area-scoped attach with scopeId", () => {
    expect(
      AttachITPPayloadSchema.safeParse({
        templateId: "tpl_1",
        scope: "area",
        scopeId: "ar_1",
      }).success,
    ).toBe(true);
  });

  it("rejects when templateId is empty / missing", () => {
    expect(
      AttachITPPayloadSchema.safeParse({ templateId: "", scope: "job" })
        .success,
    ).toBe(false);
    expect(
      AttachITPPayloadSchema.safeParse({ scope: "job" }).success,
    ).toBe(false);
  });

  it("rejects unknown scope", () => {
    expect(
      AttachITPPayloadSchema.safeParse({
        templateId: "tpl_1",
        scope: "room",
      }).success,
    ).toBe(false);
  });
});

describe("RecordITPPointPayloadSchema", () => {
  it("accepts a minimal record body", () => {
    expect(
      RecordITPPointPayloadSchema.safeParse({
        instanceId: "itp_1",
        pointId: "ip_1",
      }).success,
    ).toBe(true);
  });

  it("accepts every value shape (number / bool / string)", () => {
    for (const v of [42, 0, true, false, "ok", null]) {
      expect(
        RecordITPPointPayloadSchema.safeParse({
          instanceId: "itp_1",
          pointId: "ip_1",
          value: v,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects when instanceId / pointId missing", () => {
    expect(
      RecordITPPointPayloadSchema.safeParse({ pointId: "ip_1" }).success,
    ).toBe(false);
    expect(
      RecordITPPointPayloadSchema.safeParse({ instanceId: "itp_1" }).success,
    ).toBe(false);
  });

  it("rejects note longer than ITP_RESULT_NOTE_MAX", () => {
    const tooLong = "x".repeat(ITP_RESULT_NOTE_MAX + 1);
    expect(
      RecordITPPointPayloadSchema.safeParse({
        instanceId: "itp_1",
        pointId: "ip_1",
        note: tooLong,
      }).success,
    ).toBe(false);
  });

  it("rejects photoUrl longer than ITP_RESULT_PHOTO_URL_MAX", () => {
    const tooLong = "x".repeat(ITP_RESULT_PHOTO_URL_MAX + 1);
    expect(
      RecordITPPointPayloadSchema.safeParse({
        instanceId: "itp_1",
        pointId: "ip_1",
        photoUrl: tooLong,
      }).success,
    ).toBe(false);
  });
});

describe("SignOffITPPayloadSchema", () => {
  it("accepts a minimal signoff", () => {
    expect(
      SignOffITPPayloadSchema.safeParse({ instanceId: "itp_1" }).success,
    ).toBe(true);
  });

  it("accepts a signoff with overrideJustification", () => {
    expect(
      SignOffITPPayloadSchema.safeParse({
        instanceId: "itp_1",
        overrideJustification: "All values double-checked by Anna at 3pm.",
      }).success,
    ).toBe(true);
  });

  it("rejects overrideJustification longer than the cap", () => {
    const tooLong = "x".repeat(ITP_OVERRIDE_JUSTIFICATION_MAX + 1);
    expect(
      SignOffITPPayloadSchema.safeParse({
        instanceId: "itp_1",
        overrideJustification: tooLong,
      }).success,
    ).toBe(false);
  });
});

describe("ReopenITPPayloadSchema + ArchiveITPPayloadSchema", () => {
  it("accept a minimal instanceId", () => {
    expect(ReopenITPPayloadSchema.safeParse({ instanceId: "itp_1" }).success).toBe(
      true,
    );
    expect(
      ArchiveITPPayloadSchema.safeParse({ instanceId: "itp_1" }).success,
    ).toBe(true);
  });

  it("reject empty instanceId", () => {
    expect(ReopenITPPayloadSchema.safeParse({ instanceId: "" }).success).toBe(
      false,
    );
    expect(ArchiveITPPayloadSchema.safeParse({ instanceId: "" }).success).toBe(
      false,
    );
  });
});

/* ----------------------------------------------------------------------
 * Schema — response shapes
 * -------------------------------------------------------------------- */

describe("ITPListResponseSchema + ITPTransitionResponseSchema", () => {
  it("ITPListResponseSchema accepts an empty list", () => {
    expect(
      ITPListResponseSchema.safeParse({ jobId: "j1", instances: [] }).success,
    ).toBe(true);
  });

  it("ITPListResponseSchema accepts a populated list", () => {
    expect(
      ITPListResponseSchema.safeParse({
        jobId: "j1",
        instances: [baseInstance],
      }).success,
    ).toBe(true);
  });

  it("ITPTransitionResponseSchema returns the canonical updated instance", () => {
    expect(
      ITPTransitionResponseSchema.safeParse({ instance: baseInstance }).success,
    ).toBe(true);
  });
});

/* ----------------------------------------------------------------------
 * Service — state machine
 * -------------------------------------------------------------------- */

describe("canTransition", () => {
  it("allows the documented create + happy-path transitions", () => {
    expect(canTransition(null, "pending")).toBe(true);
    expect(canTransition("pending", "in-progress")).toBe(true);
    expect(canTransition("in-progress", "witnessed")).toBe(true);
    expect(canTransition("witnessed", "signed-off")).toBe(true);
  });

  it("allows the documented reverse (reopen) transition", () => {
    expect(canTransition("signed-off", "witnessed")).toBe(true);
  });

  it("rejects skip-ahead transitions", () => {
    expect(canTransition("pending", "witnessed")).toBe(false);
    expect(canTransition("pending", "signed-off")).toBe(false);
    expect(canTransition("in-progress", "signed-off")).toBe(false);
    expect(canTransition(null, "signed-off")).toBe(false);
  });

  it("rejects undocumented reverse transitions", () => {
    expect(canTransition("witnessed", "pending")).toBe(false);
    expect(canTransition("witnessed", "in-progress")).toBe(false);
    expect(canTransition("in-progress", "pending")).toBe(false);
    expect(canTransition("signed-off", "pending")).toBe(false);
    expect(canTransition("signed-off", "in-progress")).toBe(false);
  });

  it("rejects same-status transitions (no-op records aren't transitions)", () => {
    for (const s of ITP_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("allowedTransitionsList stays in sync with the documented set", () => {
    expect([...allowedTransitionsList()].sort()).toEqual(
      [
        "null→pending",
        "pending→in-progress",
        "in-progress→witnessed",
        "witnessed→signed-off",
        "signed-off→witnessed",
      ].sort(),
    );
  });
});

/* ----------------------------------------------------------------------
 * Service — role tier helpers
 * -------------------------------------------------------------------- */

describe("role tier helpers", () => {
  it("isAdminRole accepts the PR #23 expanded admin set", () => {
    for (const r of ["admin", "boss", "owner", "manager", "office", "pm", "estimator"]) {
      expect(isAdminRole(r)).toBe(true);
    }
  });

  it("isLeadingHandRole accepts every documented LH variant", () => {
    for (const r of ["leadinghand", "leading_hand", "leading-hand", "lh"]) {
      expect(isLeadingHandRole(r)).toBe(true);
    }
  });

  it("isFieldRole accepts tradie / apprentice / labourer / electrician", () => {
    for (const r of ["tradie", "apprentice", "labourer", "electrician"]) {
      expect(isFieldRole(r)).toBe(true);
    }
  });

  it("normalises case before matching", () => {
    expect(isAdminRole("Admin")).toBe(true);
    expect(isAdminRole("BOSS")).toBe(true);
    expect(isLeadingHandRole("LeadingHand")).toBe(true);
    expect(isFieldRole("Tradie")).toBe(true);
  });

  it("rejects unknown / null roles", () => {
    expect(isAdminRole("client")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isFieldRole("admin")).toBe(false);
    expect(isLeadingHandRole("tradie")).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Service — role-based transition gate
 * -------------------------------------------------------------------- */

describe("canRoleTransition", () => {
  const admin = { userId: "u-admin", role: "admin" };
  const lh = { userId: "u-lh", role: "leadingHand" };
  const tradie = { userId: "u-tradie", role: "tradie" };
  const client = { userId: "u-client", role: "client" };

  it("admin can do every documented transition", () => {
    expect(canRoleTransition("pending", "in-progress", admin)).toBe(true);
    expect(canRoleTransition("in-progress", "witnessed", admin)).toBe(true);
    expect(canRoleTransition("witnessed", "signed-off", admin)).toBe(true);
    expect(canRoleTransition("signed-off", "witnessed", admin)).toBe(true);
    expect(canRoleTransition(null, "pending", admin)).toBe(true);
  });

  it("tradie + LH can drive the worker auto-advance transitions", () => {
    expect(canRoleTransition("pending", "in-progress", tradie)).toBe(true);
    expect(canRoleTransition("in-progress", "witnessed", tradie)).toBe(true);
    expect(canRoleTransition("pending", "in-progress", lh)).toBe(true);
    expect(canRoleTransition("in-progress", "witnessed", lh)).toBe(true);
  });

  it("workers cannot sign off or reopen", () => {
    expect(canRoleTransition("witnessed", "signed-off", tradie)).toBe(false);
    expect(canRoleTransition("witnessed", "signed-off", lh)).toBe(false);
    expect(canRoleTransition("signed-off", "witnessed", tradie)).toBe(false);
    expect(canRoleTransition("signed-off", "witnessed", lh)).toBe(false);
  });

  it("clients + unknown roles are blocked from every transition", () => {
    expect(canRoleTransition("pending", "in-progress", client)).toBe(false);
    expect(canRoleTransition("witnessed", "signed-off", client)).toBe(false);
    expect(
      canRoleTransition("pending", "in-progress", {
        userId: "x",
        role: null,
      }),
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Service — canRecord (input visibility helper)
 * -------------------------------------------------------------------- */

describe("canRecord", () => {
  const tradie = { userId: "u-tradie", role: "tradie" };
  const admin = { userId: "u-admin", role: "admin" };
  const client = { userId: "u-client", role: "client" };

  it("allows admin + field roles on active instances", () => {
    expect(canRecord({ status: "pending" }, tradie)).toBe(true);
    expect(canRecord({ status: "in-progress" }, tradie)).toBe(true);
    expect(canRecord({ status: "witnessed" }, tradie)).toBe(true);
    expect(canRecord({ status: "pending" }, admin)).toBe(true);
  });

  it("blocks every role when the instance is signed-off", () => {
    expect(canRecord({ status: "signed-off" }, tradie)).toBe(false);
    expect(canRecord({ status: "signed-off" }, admin)).toBe(false);
  });

  it("blocks every role when the instance is archived", () => {
    expect(canRecord({ status: "pending", archived: true }, tradie)).toBe(
      false,
    );
    expect(canRecord({ status: "pending", archived: true }, admin)).toBe(
      false,
    );
  });

  it("blocks clients + unknown roles", () => {
    expect(canRecord({ status: "pending" }, client)).toBe(false);
    expect(
      canRecord({ status: "pending" }, { userId: "x", role: null }),
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Service — independence rule
 * -------------------------------------------------------------------- */

describe("pointsRecordedByUserRatio", () => {
  it("returns 0 when no points have results", () => {
    expect(pointsRecordedByUserRatio(baseInstance, "u-admin")).toBe(0);
  });

  it("counts only recorded points (results with `at` timestamp)", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      results: {
        [photoPoint.id]: photoResult, // tradie-1
        [valuePoint.id]: valueResult, // tradie-1
      },
    };
    expect(pointsRecordedByUserRatio(inst, "user-tradie-1")).toBeCloseTo(1.0);
    expect(pointsRecordedByUserRatio(inst, "user-admin-1")).toBeCloseTo(0);
  });

  it("ignores archived points in the denominator", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      templateSnapshot: {
        ...baseInstance.templateSnapshot,
        points: [
          photoPoint,
          { ...valuePoint, archived: true },
          signoffPoint,
        ],
      },
      results: {
        [photoPoint.id]: photoResult, // tradie-1
        [signoffPoint.id]: signoffResult, // admin-1
      },
    };
    // 2 non-archived recorded points, admin owns 1 → 0.5
    expect(pointsRecordedByUserRatio(inst, "user-admin-1")).toBeCloseTo(0.5);
  });
});

describe("canSignOff (independence rule)", () => {
  const admin = { userId: "user-admin-1", role: "admin" };
  const otherAdmin = { userId: "user-admin-2", role: "admin" };
  const tradie = { userId: "user-tradie-1", role: "tradie" };

  function instanceWithRatio(
    adminCount: number,
    otherCount: number,
  ): ITPInstance {
    // Build a 10-point snapshot so the threshold math is exact.
    const points: ITPTemplatePoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ip_${i}`,
      label: `Point ${i}`,
      type: "photo",
      required: true,
    }));
    const results: Record<string, ITPInstanceResult> = {};
    for (let i = 0; i < adminCount; i += 1) {
      results[`ip_${i}`] = { ...photoResult, byUserId: "user-admin-1" };
    }
    for (let i = adminCount; i < adminCount + otherCount; i += 1) {
      results[`ip_${i}`] = { ...photoResult, byUserId: "user-other-1" };
    }
    return {
      ...baseInstance,
      status: "witnessed",
      templateSnapshot: { ...baseInstance.templateSnapshot, points },
      results,
    };
  }

  it("returns ok when admin recorded 0% of points", () => {
    const r = canSignOff(instanceWithRatio(0, 5), admin);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ratio).toBe(0);
  });

  it("returns ok when admin recorded exactly 50% (not strictly more)", () => {
    const r = canSignOff(instanceWithRatio(5, 5), admin);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ratio).toBeCloseTo(0.5);
  });

  it("requires justification when admin recorded 60%", () => {
    const r = canSignOff(instanceWithRatio(6, 4), admin);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "needs-justification") {
      expect(r.ratio).toBeCloseTo(0.6);
    } else {
      throw new Error("expected needs-justification");
    }
  });

  it("requires justification when admin recorded 100%", () => {
    const r = canSignOff(instanceWithRatio(10, 0), admin);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "needs-justification") {
      expect(r.ratio).toBeCloseTo(1);
    } else {
      throw new Error("expected needs-justification");
    }
  });

  it("returns ok when a different admin signs off (ratio 0)", () => {
    const r = canSignOff(instanceWithRatio(10, 0), otherAdmin);
    expect(r.ok).toBe(true);
  });

  it("returns wrong-role for non-admin", () => {
    const r = canSignOff(instanceWithRatio(0, 5), tradie);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-role");
  });

  it("returns wrong-status when status isn't witnessed", () => {
    const inst: ITPInstance = {
      ...instanceWithRatio(0, 5),
      status: "in-progress",
    };
    const r = canSignOff(inst, admin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-status");
  });
});

/* ----------------------------------------------------------------------
 * Service — compareForQueue
 * -------------------------------------------------------------------- */

describe("compareForQueue", () => {
  it("sorts active rows ahead of signed-off rows", () => {
    const rows = [
      { status: "signed-off" as const, updatedAt: "2026-05-26T08:00:00Z" },
      { status: "pending" as const, updatedAt: "2026-05-26T08:00:00Z" },
      { status: "witnessed" as const, updatedAt: "2026-05-26T08:00:00Z" },
      { status: "in-progress" as const, updatedAt: "2026-05-26T08:00:00Z" },
    ];
    const sorted = rows.slice().sort(compareForQueue);
    expect(sorted.map((r) => r.status)).toEqual([
      "pending",
      "in-progress",
      "witnessed",
      "signed-off",
    ]);
  });

  it("within same status, newest updatedAt first", () => {
    const rows = [
      { status: "in-progress" as const, updatedAt: "2026-05-26T08:00:00Z" },
      { status: "in-progress" as const, updatedAt: "2026-05-26T10:00:00Z" },
      { status: "in-progress" as const, updatedAt: "2026-05-26T09:00:00Z" },
    ];
    const sorted = rows.slice().sort(compareForQueue);
    expect(sorted.map((r) => r.updatedAt)).toEqual([
      "2026-05-26T10:00:00Z",
      "2026-05-26T09:00:00Z",
      "2026-05-26T08:00:00Z",
    ]);
  });
});

/* ----------------------------------------------------------------------
 * Format — labels, tones, scope context
 * -------------------------------------------------------------------- */

describe("statusLabel + statusTone", () => {
  it("labels every status with a human string", () => {
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("in-progress")).toBe("In progress");
    expect(statusLabel("witnessed")).toBe("Witnessed");
    expect(statusLabel("signed-off")).toBe("Signed off");
  });

  it("maps statuses to the 5-tone palette per doc 27 §6.2", () => {
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("in-progress")).toBe("info");
    expect(statusTone("witnessed")).toBe("info");
    expect(statusTone("signed-off")).toBe("success");
  });
});

describe("scope + point-type labels", () => {
  it("labels scopes including the preserved 'Switchboard' value", () => {
    expect(scopeLabel("job")).toBe("Whole job");
    expect(scopeLabel("level")).toBe("Level");
    expect(scopeLabel("area")).toBe("Area");
    expect(scopeLabel("switchboard")).toBe("Switchboard");
  });

  it("renders scopeContextLine with + without a resolved name", () => {
    expect(scopeContextLine("job", null)).toBe("Whole job");
    expect(scopeContextLine("level", "G")).toBe("Level: G");
    expect(scopeContextLine("area", "Kitchen")).toBe("Area: Kitchen");
    expect(scopeContextLine("switchboard", "MSB-1")).toBe("Switchboard: MSB-1");
    // Missing name falls back to the bare label so the surface is never
    // "Level: " (empty value).
    expect(scopeContextLine("area", null)).toBe("Area");
    expect(scopeContextLine("area", "   ")).toBe("Area");
  });

  it("labels every point type", () => {
    expect(pointTypeLabel("photo")).toBe("Photo");
    expect(pointTypeLabel("value")).toBe("Value");
    expect(pointTypeLabel("signoff")).toBe("Sign-off");
    expect(pointTypeLabel("note")).toBe("Note");
  });
});

/* ----------------------------------------------------------------------
 * Format — lifecycle predicates
 * -------------------------------------------------------------------- */

describe("isActive / isDone / needsWorkerAttention", () => {
  it("isActive is true for pending / in-progress / witnessed", () => {
    expect(isActive("pending")).toBe(true);
    expect(isActive("in-progress")).toBe(true);
    expect(isActive("witnessed")).toBe(true);
    expect(isActive("signed-off")).toBe(false);
  });

  it("isDone is true only for signed-off", () => {
    expect(isDone("signed-off")).toBe(true);
    expect(isDone("pending")).toBe(false);
    expect(isDone("in-progress")).toBe(false);
    expect(isDone("witnessed")).toBe(false);
  });

  it("needsWorkerAttention mirrors isActive (Phil panel filter)", () => {
    for (const s of ITP_STATUSES) {
      expect(needsWorkerAttention(s)).toBe(isActive(s));
    }
  });
});

/* ----------------------------------------------------------------------
 * Format — valuePassFail
 * -------------------------------------------------------------------- */

describe("valuePassFail", () => {
  it("returns null for non-value point types", () => {
    expect(valuePassFail(photoPoint, photoResult)).toBeNull();
    expect(valuePassFail(signoffPoint, signoffResult)).toBeNull();
    expect(valuePassFail(notePoint, undefined)).toBeNull();
  });

  it("returns null when there's no min or max criterion", () => {
    const bare: ITPTemplatePoint = { ...valuePoint, min: null, max: null };
    expect(valuePassFail(bare, valueResult)).toBeNull();
  });

  it("returns pass when value is in range", () => {
    expect(valuePassFail(valuePoint, valueResult)).toBe("pass");
  });

  it("returns fail when value is below min", () => {
    const low: ITPInstanceResult = { ...valueResult, value: 0.5 };
    expect(valuePassFail(valuePoint, low)).toBe("fail");
  });

  it("returns fail when value is above max", () => {
    const high: ITPInstanceResult = { ...valueResult, value: 9999 };
    expect(valuePassFail(valuePoint, high)).toBe("fail");
  });

  it("coerces string values to number before comparing", () => {
    const stringy: ITPInstanceResult = { ...valueResult, value: "250" };
    expect(valuePassFail(valuePoint, stringy)).toBe("pass");
  });

  it("returns null when the value isn't numeric", () => {
    const bad: ITPInstanceResult = { ...valueResult, value: "n/a" };
    expect(valuePassFail(valuePoint, bad)).toBeNull();
  });

  it("renders pass / fail labels via valuePassFailLabel", () => {
    expect(valuePassFailLabel(valuePoint, valueResult)).toBe("Pass");
    expect(
      valuePassFailLabel(valuePoint, { ...valueResult, value: 0.5 }),
    ).toBe("Fail");
    expect(valuePassFailLabel(photoPoint, photoResult)).toBeNull();
  });
});

/* ----------------------------------------------------------------------
 * Format — formatProgress
 * -------------------------------------------------------------------- */

describe("formatProgress", () => {
  it("returns { 0, 3, 0 } for a pending instance with 3 required points + 1 optional", () => {
    const p = formatProgress(baseInstance);
    // photo, value, signoff are required; note is optional.
    expect(p.total).toBe(3);
    expect(p.done).toBe(0);
    expect(p.percent).toBe(0);
  });

  it("counts only required-points-with-`at` toward done", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      results: {
        [photoPoint.id]: photoResult,
        [valuePoint.id]: valueResult,
        // signoffPoint not yet recorded
        // notePoint is optional — even if recorded it shouldn't bump
        // the percent, mirroring the witnessed criterion.
        [notePoint.id]: photoResult,
      },
    };
    const p = formatProgress(inst);
    expect(p.total).toBe(3);
    expect(p.done).toBe(2);
    expect(p.percent).toBe(67);
  });

  it("returns 100% when every required point has a result with `at`", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      results: {
        [photoPoint.id]: photoResult,
        [valuePoint.id]: valueResult,
        [signoffPoint.id]: signoffResult,
      },
    };
    const p = formatProgress(inst);
    expect(p).toEqual({ done: 3, total: 3, percent: 100 });
  });

  it("returns 0% when there are no required points (no div-by-0)", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      templateSnapshot: {
        ...baseInstance.templateSnapshot,
        points: [{ ...notePoint, required: false }],
      },
    };
    const p = formatProgress(inst);
    expect(p).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it("ignores archived points in the denominator", () => {
    const inst: ITPInstance = {
      ...baseInstance,
      templateSnapshot: {
        ...baseInstance.templateSnapshot,
        points: [
          photoPoint,
          { ...valuePoint, archived: true },
          signoffPoint,
        ],
      },
      results: {
        [photoPoint.id]: photoResult,
        [signoffPoint.id]: signoffResult,
      },
    };
    const p = formatProgress(inst);
    expect(p.total).toBe(2);
    expect(p.done).toBe(2);
    expect(p.percent).toBe(100);
  });
});

/* ----------------------------------------------------------------------
 * Client — schema validation + network behaviour
 *
 * We mock `fetch` at the global level since this is what httpGet / httpPost
 * call into. Same pattern as snags.test.ts.
 * -------------------------------------------------------------------- */

const realFetch = globalThis.fetch;

function mockFetchOnce(response: {
  status: number;
  body: unknown;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: "",
    text: async () => JSON.stringify(response.body),
  } as unknown as Response));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("itpClient — listItps", () => {
  it("issues GET against /api/job-itps?jobId=X and returns typed data", async () => {
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { jobId: "j1", instances: [baseInstance] },
    });
    const r = await listItps("j1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/job-itps?jobId=j1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.jobId).toBe("j1");
      expect(r.data.instances).toHaveLength(1);
    }
  });

  it("returns an error result when server returns 403", async () => {
    mockFetchOnce({ status: 403, body: { error: "forbidden" } });
    const r = await listItps("j1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(403);
  });
});

describe("itpClient — attachItp", () => {
  it("validates payload before calling fetch", async () => {
    const fetchMock = mockFetchOnce({
      status: 201,
      body: { instance: baseInstance },
    });
    const r = await attachItp("j1", {
      templateId: "",
      scope: "job",
    } as unknown as Parameters<typeof attachItp>[1]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });

  it("sends an encoded URL with action=attach", async () => {
    const fetchMock = mockFetchOnce({
      status: 201,
      body: { instance: baseInstance },
    });
    const r = await attachItp("birdwood-iv3232", {
      templateId: "tpl_1",
      scope: "switchboard",
      scopeId: "sb_msb_1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe(
      "/api/job-itps?jobId=birdwood-iv3232&action=attach",
    );
    expect(r.ok).toBe(true);
  });
});

describe("itpClient — recordItpPoint", () => {
  it("returns canonical updated instance from the server response", async () => {
    const next = {
      ...baseInstance,
      status: "in-progress" as const,
      results: { [photoPoint.id]: photoResult },
      updatedAt: "2026-05-26T09:00:00.000Z",
    };
    mockFetchOnce({ status: 200, body: { instance: next } });
    const r = await recordItpPoint("j1", {
      instanceId: baseInstance.id,
      pointId: photoPoint.id,
      photoUrl: "https://example.com/photo.jpg",
      note: "Door label visible.",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.instance.status).toBe("in-progress");
      expect(r.data.instance.results[photoPoint.id]).toBeDefined();
    }
  });

  it("rejects payload locally when instanceId missing", async () => {
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { instance: baseInstance },
    });
    const r = await recordItpPoint("j1", {
      pointId: "ip_1",
    } as unknown as Parameters<typeof recordItpPoint>[1]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });

  it("maps a server 400 invalid-body response to an ok=false result", async () => {
    mockFetchOnce({
      status: 400,
      body: { error: "instanceId + pointId required" },
    });
    const r = await recordItpPoint("j1", {
      instanceId: "itp_1",
      pointId: "ip_1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(400);
  });

  it("maps a server 409 invalid-transition response (the canTransition gate)", async () => {
    mockFetchOnce({
      status: 409,
      body: { error: "signed-off — reopen to edit" },
    });
    const r = await recordItpPoint("j1", {
      instanceId: "itp_1",
      pointId: "ip_1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(409);
  });
});

describe("itpClient — signOffItp", () => {
  it("sends overrideJustification when the independence rule trips", async () => {
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { instance: { ...baseInstance, status: "signed-off", signedOffBy: "anna", signedOffAt: "2026-05-26T11:00:00.000Z" } },
    });
    const r = await signOffItp("j1", {
      instanceId: "itp_1",
      overrideJustification: "Anna recorded values then signed off",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.instanceId).toBe("itp_1");
    expect(body.overrideJustification).toBe(
      "Anna recorded values then signed off",
    );
    expect(r.ok).toBe(true);
  });

  it("maps 409 independence-rule violation to an ok=false result", async () => {
    mockFetchOnce({
      status: 409,
      body: {
        error:
          "sign-off requires an override justification — too many points were recorded by the signing user",
      },
    });
    const r = await signOffItp("j1", { instanceId: "itp_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(409);
  });
});

describe("itpClient — reopenItp + archiveItp", () => {
  it("reopenItp sends a POST with the instanceId", async () => {
    const reopened = { ...baseInstance, status: "witnessed" as const };
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { instance: reopened },
    });
    const r = await reopenItp("j1", { instanceId: "itp_1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/job-itps?jobId=j1&action=reopen");
    expect(r.ok).toBe(true);
  });

  it("archiveItp sends a DELETE with id in the querystring", async () => {
    const fetchMock = mockFetchOnce({ status: 200, body: { ok: true } });
    const r = await archiveItp("j1", { instanceId: "itp_1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/job-itps?jobId=j1&id=itp_1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(r.ok).toBe(true);
  });

  it("archiveItp returns ok=false when the instanceId is empty", async () => {
    const fetchMock = mockFetchOnce({ status: 200, body: { ok: true } });
    const r = await archiveItp("j1", {
      instanceId: "",
    } as unknown as Parameters<typeof archiveItp>[1]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });
});
