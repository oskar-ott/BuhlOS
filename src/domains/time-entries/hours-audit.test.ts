import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/domains/audit-log/schema";

/**
 * #390 — the hours audit-log payload builders. Pure: the handlers append the
 * result best-effort after the payroll mutation. Asserts the shape, the privacy
 * line (hours/status only, never a dollar amount), and that every action/target
 * the builders emit is a synced enum value (so the journal write isn't dropped
 * by audit-log.js's VALID_ACTIONS/VALID_TARGET_TYPES gate).
 */
const requireFromHere = createRequire(import.meta.url);
const { buildHoursAuditEntry, buildHoursBulkAuditEntry } = requireFromHere(
  "../../../api/_lib/hours-audit.js",
) as {
  buildHoursAuditEntry: (input: Record<string, unknown>) => Record<string, unknown>;
  buildHoursBulkAuditEntry: (input: Record<string, unknown>) => Record<string, unknown>;
};

const ACTOR = { id: "u_admin", username: "Daniel", role: "admin" };
const ENTRY = {
  id: "te_1",
  userId: "u_field",
  userName: "Sparky",
  date: "2026-06-17",
  status: "approved",
  totalHours: 8.5,
  allocations: [{ jobId: "job-a" }, { jobId: "job-b" }, { jobId: null }, { jobId: "job-a" }],
};

describe("buildHoursAuditEntry (#390)", () => {
  it("shapes a valid audit payload with the touched jobs and the resulting status", () => {
    const p = buildHoursAuditEntry({ action: "hours.approved", actor: ACTOR, entry: ENTRY });
    expect(p).toMatchObject({
      action: "hours.approved",
      actorId: "u_admin",
      actorName: "Daniel",
      actorRole: "admin",
      jobId: "job-a", // first touched job at the top level
      targetType: "time_entry",
      targetId: "te_1",
    });
    expect(p.metadata).toMatchObject({
      userId: "u_field",
      userName: "Sparky",
      date: "2026-06-17",
      status: "approved",
      totalHours: 8.5,
      jobIds: ["job-a", "job-b"], // deduped, falsy dropped
    });
  });

  it("carries a reason when provided", () => {
    const p = buildHoursAuditEntry({ action: "hours.rejected", actor: ACTOR, entry: ENTRY, reason: "missing site" });
    expect((p.metadata as { reason?: string }).reason).toBe("missing site");
  });

  it("records hours + status but NEVER a dollar amount (privacy line)", () => {
    const p = buildHoursAuditEntry({ action: "hours.approved", actor: ACTOR, entry: ENTRY });
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/amount|payRate|rate|dollar|\$/i);
    expect((p.metadata as { totalHours: number }).totalHours).toBe(8.5);
  });

  it("falls back targetId to userId:date when the entry has no id", () => {
    const p = buildHoursAuditEntry({
      action: "hours.reopened",
      actor: ACTOR,
      entry: { ...ENTRY, id: undefined },
    });
    expect(p.targetId).toBe("u_field:2026-06-17");
  });

  it("shapes a worker submission payload (submit/resubmit) attributed to the actor", () => {
    // A self-submit: the worker is both actor and target. On-behalf submits pass
    // the LH/admin as actor while entry.userId stays the worker — same builder.
    const submittedEntry = { ...ENTRY, status: "submitted" };
    const worker = { id: "u_field", username: "Sparky", role: "electrician" };
    const submit = buildHoursAuditEntry({ action: "hours.submitted", actor: worker, entry: submittedEntry });
    expect(submit).toMatchObject({
      action: "hours.submitted",
      actorId: "u_field",
      targetType: "time_entry",
      targetId: "te_1",
    });
    expect((submit.metadata as { status: string; userId: string }).status).toBe("submitted");
    expect((submit.metadata as { userId: string }).userId).toBe("u_field");

    const resubmit = buildHoursAuditEntry({ action: "hours.resubmitted", actor: worker, entry: submittedEntry });
    expect(resubmit.action).toBe("hours.resubmitted");
  });

  it("emits only synced action + target enum values", () => {
    for (const action of [
      "hours.approved",
      "hours.rejected",
      "hours.reject_undone",
      "hours.reopened",
      "hours.submitted",
      "hours.resubmitted",
      "hours.edited_while_submitted", // 2026-07-26 owner-directed
    ]) {
      const p = buildHoursAuditEntry({ action, actor: ACTOR, entry: ENTRY });
      expect(AUDIT_ACTIONS).toContain(p.action);
      expect(AUDIT_TARGET_TYPES).toContain(p.targetType);
    }
  });

  it("renders every underscore in a multi-underscore action's summary as spaces", () => {
    const p = buildHoursAuditEntry({
      action: "hours.edited_while_submitted",
      actor: ACTOR,
      entry: ENTRY,
    });
    expect(p.summary).toContain("edited while submitted");
    expect(p.summary).not.toContain("_");
  });
});

describe("buildHoursBulkAuditEntry (#390)", () => {
  const decided = [
    { userId: "u1", date: "2026-06-16", totalHours: 8 },
    { userId: "u2", date: "2026-06-16", totalHours: 7.5 },
  ];

  it("writes ONE summarising entry with the decided days in metadata (not N rows)", () => {
    const p = buildHoursBulkAuditEntry({ action: "hours.bulk_approved", actor: ACTOR, decided });
    expect(p).toMatchObject({ action: "hours.bulk_approved", targetType: "time_entry", jobId: null });
    expect(p.targetId).toBe("bulk:u_admin:2");
    expect(p.summary).toContain("2 timesheet days");
    expect((p.metadata as { count: number; entries: unknown[] }).count).toBe(2);
    expect((p.metadata as { entries: Array<{ userId: string }> }).entries.map((e) => e.userId)).toEqual(["u1", "u2"]);
  });

  it("bulk actions are synced enum values", () => {
    for (const action of ["hours.bulk_approved", "hours.bulk_rejected"]) {
      const p = buildHoursBulkAuditEntry({ action, actor: ACTOR, decided });
      expect(AUDIT_ACTIONS).toContain(p.action);
    }
  });
});
