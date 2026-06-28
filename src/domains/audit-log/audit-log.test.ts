import { describe, expect, it } from "vitest";
import {
  AppendAuditLogPayloadSchema,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  AuditActionSchema,
  AuditLogEntrySchema,
  AuditLogFileSchema,
  AuditTargetTypeSchema,
} from "./schema";
import { entriesForTarget, monthBucket, sortNewestFirst } from "./client";
import type { AuditLogEntry } from "./types";

/* ----------------------------------------------------------------------
 * Schema
 * -------------------------------------------------------------------- */

const validEntry: AuditLogEntry = {
  id: "al_abc12345",
  ts: "2026-05-25T14:30:00.000Z",
  action: "evidence.captured",
  actorId: "user-tradie-1",
  actorName: "Sam",
  actorRole: "tradie",
  jobId: "birdwood-iv3232",
  targetType: "evidence",
  targetId: "ev_xyz12345",
  summary: "photo evidence captured — \"Cabling looks good\"",
  metadata: {
    kind: "photo",
    areaId: "ar_abc",
    stage: "roughIn",
  },
};

describe("AuditLogEntrySchema", () => {
  it("accepts a fully populated entry", () => {
    expect(AuditLogEntrySchema.safeParse(validEntry).success).toBe(true);
  });

  it("accepts an entry with nullable jobId / actorRole", () => {
    const r = AuditLogEntrySchema.safeParse({
      ...validEntry,
      jobId: null,
      actorRole: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown action values", () => {
    expect(
      AuditLogEntrySchema.safeParse({ ...validEntry, action: "evidence.deleted" }).success
    ).toBe(false);
  });

  it("rejects unknown targetType values", () => {
    expect(
      AuditLogEntrySchema.safeParse({ ...validEntry, targetType: "not_a_real_target" }).success
    ).toBe(false);
  });

  it("accepts the D.5 snag targetType + verbs", () => {
    const snagCreate = {
      ...validEntry,
      action: "snag.created" as const,
      targetType: "snag" as const,
      targetId: "sn_abc12345",
      summary: 'snag created — "Plug missing earth"',
      metadata: { priority: "high", status: "open" },
    };
    expect(AuditLogEntrySchema.safeParse(snagCreate).success).toBe(true);

    const snagTransition = {
      ...snagCreate,
      action: "snag.transitioned" as const,
      summary: "snag in_progress → resolved",
      metadata: { from: "in_progress", to: "resolved" },
    };
    expect(AuditLogEntrySchema.safeParse(snagTransition).success).toBe(true);
  });

  it("rejects when required fields are missing", () => {
    const cases = [
      "id",
      "ts",
      "action",
      "actorId",
      "actorName",
      "targetType",
      "targetId",
      "summary",
    ];
    for (const f of cases) {
      const broken = { ...validEntry } as Record<string, unknown>;
      delete broken[f];
      expect(AuditLogEntrySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("passes through unknown forward-compat fields (.passthrough)", () => {
    const future = { ...validEntry, requestId: "req_abc" };
    const parsed = AuditLogEntrySchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { requestId?: string }).requestId).toBe("req_abc");
    }
  });

  it("enum exports stay in sync", () => {
    // D5 added evidence.unreviewed for the reviewed → submitted
    // transition so the History panel can distinguish it from the
    // original review. D.5 added snag.created + snag.transitioned and
    // the 'snag' targetType. E1a adds the itp.* verbs covering the
    // api/job-itps.js mutating actions (incl. itp.submitted, the
    // explicit submit-for-review handoff) + the itp_template /
    // itp_instance target types.
    expect([...AUDIT_ACTIONS].sort()).toEqual([
      "backup.completed",
      // #231: certificates register.
      "certificate.uploaded",
      "contact.removed",
      "contact.saved",
      // #331: worker licence register lifecycle.
      "credential.added",
      "credential.removed",
      "credential.updated",
      // #370: daywork register lifecycle.
      "daywork.amended",
      "daywork.created",
      "daywork.signed",
      "daywork.transitioned",
      // #210: site diary lifecycle (created + append-only amend).
      "diary.amended",
      "diary.created",
      "document.acknowledged",
      "document.made_current",
      "document.superseded",
      "document.uploaded",
      "employee.activated",
      "employee.created",
      "employee.disabled",
      "employee.role_changed",
      "employee.updated",
      "evidence.captured",
      // #233: as-built designation verbs. flagged sorts between captured and
      // linked ('f' < 'l'); unflagged sorts before unlinked ('unf' < 'unl').
      "evidence.flagged_asbuilt",
      // #263: before/after pairing verbs (sort between captured and rejected;
      // unlinked sorts before unreviewed).
      "evidence.linked",
      "evidence.rejected",
      "evidence.reviewed",
      "evidence.unflagged_asbuilt",
      "evidence.unlinked",
      "evidence.unreviewed",
      // #390: hours / time-entry events (approvals pass + worker submits).
      "hours.approved",
      "hours.bulk_approved",
      "hours.bulk_rejected",
      "hours.reject_undone",
      "hours.rejected",
      "hours.reopened",
      "hours.resubmitted",
      "hours.submitted",
      // #332: induction register (backfilled sorts before confirmed).
      "induction.backfilled",
      "induction.confirmed",
      "invite.accepted",
      "invite.issued",
      "invite.opened",
      "invite.revoked",
      "invite.send_failed",
      "itp.archived",
      "itp.attached",
      "itp.point.recorded",
      "itp.reopened",
      "itp.signed_off",
      "itp.submitted",
      // #349 closeout lifecycle + #581 Job Builder/won-quote creation.
      "job.closed",
      "job.created",
      // #235 defect liability period (handover date set / cleared).
      "job.handover_cleared",
      "job.handover_set",
      "job.reopened",
      "job.tasks_generated",
      // #127/#333 leave lifecycle.
      "leave.cancelled",
      "leave.decided",
      "leave.recorded",
      // PR 11: Material Request lifecycle.
      "material_request.created",
      "material_request.transitioned",
      // #217: meeting-minutes register lifecycle (record + append-only amend).
      "minutes.amended",
      "minutes.recorded",
      // PR 11: observation -> real material request conversion verb.
      // Sorts before observation.converted_to_snag because '_material' < '_snag'.
      "observation.converted_to_material_request",
      // #276: observation -> real RFI conversion verb.
      // Sorts between '_material_request' and '_snag' ('r' is between 'm' and 's').
      "observation.converted_to_rfi",
      // PR 6: observation -> real snag conversion verb.
      // (sorts before observation.created because 'co' < 'cr')
      "observation.converted_to_snag",
      // #280: observation -> real variation claim conversion verb
      // ('_variation' sorts after '_snag').
      "observation.converted_to_variation",
      // PR 10: observation lifecycle (create on POST, transitioned on PATCH
      // when status/priority/assignment change).
      "observation.created",
      "observation.transitioned",
      // #503: office proof sign-off (admin approve/send-back surface).
      "proof.approved",
      "proof.sent_back",
      // #581: quote→job conversion lifecycle.
      "quote.converted",
      // #371: pre-start readiness gate lifecycle (item tick / override / clear).
      "readiness.item_ticked",
      "readiness.overridden",
      "readiness.override_cleared",
      // #276: RFI register lifecycle.
      "rfi.created",
      "rfi.transitioned",
      // #219: safety document lifecycle (upload + acknowledge).
      "safety_doc.acknowledged",
      "safety_doc.uploaded",
      // #230: services-locations register lifecycle (added/updated/removed).
      // Sorts between safety_doc and snag ('se' < 'sn'); added < removed < updated.
      "service_location.added",
      "service_location.removed",
      "service_location.updated",
      "snag.created",
      "snag.transitioned",
      "storage.write_rejected",
      // #280: variation claim lifecycle.
      "variation.created",
      "variation.transitioned",
    ]);
    expect([...AUDIT_TARGET_TYPES].sort()).toEqual([
      // #231: per-job certificates.
      "certificate",
      "contact",
      "credential",
      // #370: daywork docket records.
      "daywork",
      // #210: per-job site diary entries.
      "diary",
      "document",
      "employee",
      "evidence",
      "induction",
      "invite",
      "itp_instance",
      "itp_template",
      // #581: a created job.
      "job",
      "leave",
      // PR 11: material requests as audit targets.
      "material_request",
      // #217: per-job meeting-minutes records.
      "minutes",
      // PR 6: observation as audit target (for observation.converted_to_snag).
      "observation",
      // #371: per-job pre-start readiness records.
      "prestart",
      // #503: per-task proof review records.
      "proof_review",
      // #581: a converted quote.
      "quote",
      // #276: per-job RFI records.
      "rfi",
      // #219: per-job safety docs.
      "safety_doc",
      // #230: per-job services-locations records (sorts between safety_doc and snag).
      "service_location",
      "snag",
      // #151: platform-level events (backup runs).
      "system",
      // #390: timesheet day records.
      "time_entry",
      // #280: variation claim records.
      "variation",
    ]);
  });

  it("AuditActionSchema and AuditTargetTypeSchema enforce the same set", () => {
    expect(AuditActionSchema.safeParse("evidence.captured").success).toBe(true);
    expect(AuditActionSchema.safeParse("evidence.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("evidence").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("snag").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.created").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.transitioned").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("rfi").success).toBe(true); // #276 added the rfi target
    expect(AuditTargetTypeSchema.safeParse("not_a_real_target").success).toBe(false);
    // ITP verbs + target types accepted; nonsense rejected.
    expect(AuditActionSchema.safeParse("itp.attached").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.point.recorded").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.signed_off").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.reopened").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.archived").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("itp_instance").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("itp_template").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("itp").success).toBe(false);
  });
});

describe("AuditLogFileSchema", () => {
  it("parses an empty monthly blob", () => {
    expect(AuditLogFileSchema.safeParse({ entries: [] }).success).toBe(true);
  });

  it("parses a monthly blob with multiple entries", () => {
    const r = AuditLogFileSchema.safeParse({
      entries: [
        validEntry,
        {
          ...validEntry,
          id: "al_2",
          action: "evidence.reviewed",
          ts: "2026-05-26T09:00:00.000Z",
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("AppendAuditLogPayloadSchema", () => {
  it("accepts a minimal evidence.captured payload", () => {
    const r = AppendAuditLogPayloadSchema.safeParse({
      action: "evidence.captured",
      actorId: "user-1",
      actorName: "Sam",
      targetType: "evidence",
      targetId: "ev_1",
      summary: "captured",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when actorName is missing", () => {
    const r = AppendAuditLogPayloadSchema.safeParse({
      action: "evidence.captured",
      actorId: "user-1",
      targetType: "evidence",
      targetId: "ev_1",
      summary: "captured",
    });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Client helpers
 * -------------------------------------------------------------------- */

describe("sortNewestFirst", () => {
  it("sorts by ts descending", () => {
    const a: AuditLogEntry = { ...validEntry, id: "a", ts: "2026-05-25T10:00:00Z" };
    const b: AuditLogEntry = { ...validEntry, id: "b", ts: "2026-05-25T11:00:00Z" };
    const c: AuditLogEntry = { ...validEntry, id: "c", ts: "2026-05-25T09:00:00Z" };
    expect(sortNewestFirst([a, b, c]).map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("returns a new array (does not mutate input)", () => {
    const input: AuditLogEntry[] = [
      { ...validEntry, id: "a", ts: "2026-05-25T10:00:00Z" },
      { ...validEntry, id: "b", ts: "2026-05-25T11:00:00Z" },
    ];
    const out = sortNewestFirst(input);
    expect(out).not.toBe(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]); // unchanged
  });
});

describe("entriesForTarget", () => {
  it("returns only entries matching targetType + targetId", () => {
    const a: AuditLogEntry = { ...validEntry, id: "a", targetId: "ev_1" };
    const b: AuditLogEntry = { ...validEntry, id: "b", targetId: "ev_2" };
    const c: AuditLogEntry = { ...validEntry, id: "c", targetId: "ev_1" };
    expect(entriesForTarget([a, b, c], "evidence", "ev_1").map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns empty when target type doesn't match", () => {
    expect(entriesForTarget([validEntry], "snag", "ev_xyz12345")).toEqual([]);
  });
});

describe("monthBucket", () => {
  it("extracts yyyy-mm from a full ISO timestamp", () => {
    expect(monthBucket("2026-05-25T14:30:00.000Z")).toBe("2026-05");
    expect(monthBucket("2026-12-31T23:59:59.999Z")).toBe("2026-12");
  });

  it("returns empty string for bad input", () => {
    expect(monthBucket("")).toBe("");
    expect(monthBucket("2026")).toBe("");
    expect(monthBucket("nonsense" as unknown as string)).toBe("");
  });
});
