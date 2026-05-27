import { describe, expect, it } from "vitest";
import { deriveAttention } from "./PhilJobAttention";
import type { Job } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";

/* ----------------------------------------------------------------------
 * Fixtures — only the fields deriveAttention reads. Everything else is
 * either covered by the domain schemas or irrelevant to the predicate.
 * -------------------------------------------------------------------- */

const baseJob: Job = {
  id: "birdwood-iv3232",
  name: "Birdwood Pub fitout",
} as Job;

function snag(over: Partial<SnagItem>): SnagItem {
  return {
    id: over.id ?? "sn_default",
    jobId: "birdwood-iv3232",
    title: over.title ?? "A snag",
    description: null,
    summary: null,
    stage: null,
    areaId: null,
    areaName: null,
    taskId: null,
    taskName: null,
    evidenceIds: [],
    status: over.status ?? "open",
    priority: "normal",
    source: "phil",
    createdById: "user-tradie-1",
    createdByName: "Sam",
    createdByRole: "tradie",
    assignedToId: over.assignedToId ?? null,
    assignedToName: null,
    acknowledgedAt: null,
    acknowledgedById: null,
    acknowledgedByName: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    verifiedAt: null,
    verifiedById: null,
    verifiedByName: null,
    closedAt: null,
    closedById: null,
    closedByName: null,
    rejectedAt: over.status === "rejected" ? "2026-05-25T17:00:00.000Z" : null,
    rejectedById: over.status === "rejected" ? "user-admin-1" : null,
    rejectedByName: over.status === "rejected" ? "Anna" : null,
    rejectionReason: over.status === "rejected" ? "Duplicate" : null,
    auditLogIds: [],
    createdAt: "2026-05-25T14:30:00.000Z",
    updatedAt: "2026-05-25T14:30:00.000Z",
  } as SnagItem;
}

function itp(over: Partial<ITPInstance>): ITPInstance {
  return {
    id: over.id ?? "itp_default",
    templateId: "tpl_default",
    templateSnapshot: {
      name: "MSB energisation",
      points: [],
    },
    scope: "job",
    status: over.status ?? "pending",
    results: {},
    archived: over.archived ?? false,
    createdAt: "2026-05-26T08:00:00.000Z",
    createdBy: "anna",
    updatedAt: "2026-05-26T08:00:00.000Z",
  } as ITPInstance;
}

const viewerId = "user-tradie-1";

/* ----------------------------------------------------------------------
 * Tests
 * -------------------------------------------------------------------- */

describe("deriveAttention", () => {
  it("returns no items for a clean job", () => {
    const { items, total } = deriveAttention({
      job: baseJob,
      snags: [],
      itps: [],
      viewerId,
    });
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it("surfaces a single rejected snag with the snag title", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [snag({ id: "sn_1", title: "Earth missing", status: "rejected" })],
      itps: [],
      viewerId,
    });
    expect(items).toHaveLength(1);
    const row = items[0]!;
    expect(row.id).toBe("rejected:sn_1");
    expect(row.tone).toBe("danger");
    expect(row.title).toBe("Earth missing");
    expect(row.anchor).toBe("#phil-job-snags");
    // Bible §07 — reasonShown is mandatory.
    expect(row.reasonShown.length).toBeGreaterThan(10);
  });

  it("collapses multiple rejected snags into one row", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [
        snag({ id: "sn_1", status: "rejected" }),
        snag({ id: "sn_2", status: "rejected" }),
      ],
      itps: [],
      viewerId,
    });
    const rejectedRows = items.filter((i) => i.id.startsWith("rejected:"));
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0]!.title).toBe("2 snags rejected");
  });

  it("surfaces open snags assigned to the viewer", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [
        snag({ id: "sn_1", status: "open", assignedToId: viewerId }),
        snag({ id: "sn_2", status: "in_progress", assignedToId: viewerId }),
        snag({ id: "sn_3", status: "open", assignedToId: "other-user" }),
      ],
      itps: [],
      viewerId,
    });
    const mine = items.find((i) => i.id === "assigned:me");
    expect(mine).toBeDefined();
    expect(mine!.title).toBe("2 snags assigned to you");
    expect(mine!.tone).toBe("warning");
  });

  it("ignores resolved snags assigned to the viewer", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [
        snag({ id: "sn_1", status: "resolved", assignedToId: viewerId }),
        snag({ id: "sn_2", status: "verified", assignedToId: viewerId }),
      ],
      itps: [],
      viewerId,
    });
    expect(items.find((i) => i.id === "assigned:me")).toBeUndefined();
  });

  it("surfaces pending ITPs", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [],
      itps: [
        itp({ id: "itp_1", status: "pending" }),
        itp({ id: "itp_2", status: "in-progress" }),
      ],
      viewerId,
    });
    const itpRow = items.find((i) => i.id === "itp:pending");
    expect(itpRow).toBeDefined();
    expect(itpRow!.title).toBe("1 ITP to start");
  });

  it("ignores archived pending ITPs", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [],
      itps: [itp({ id: "itp_1", status: "pending", archived: true })],
      viewerId,
    });
    expect(items.find((i) => i.id === "itp:pending")).toBeUndefined();
  });

  it("surfaces induction required as an info-tone alert", () => {
    const inducedJob = { ...baseJob, inductionRequired: true } as Job;
    const { items } = deriveAttention({
      job: inducedJob,
      snags: [],
      itps: [],
      viewerId,
    });
    const induction = items.find((i) => i.id === "induction");
    expect(induction).toBeDefined();
    expect(induction!.tone).toBe("info");
    expect(induction!.anchor).toBe("#phil-job-site");
  });

  it("caps visible items at three and reports the original total", () => {
    const inducedJob = { ...baseJob, inductionRequired: true } as Job;
    const { items, total } = deriveAttention({
      job: inducedJob,
      snags: [
        snag({ id: "sn_1", status: "rejected" }),
        snag({ id: "sn_2", status: "open", assignedToId: viewerId }),
      ],
      itps: [itp({ id: "itp_1", status: "pending" })],
      viewerId,
    });
    // rejected + assigned + itp + induction = 4 candidates
    expect(total).toBe(4);
    expect(items).toHaveLength(3);
    // Rejected snags win the priority order; induction drops off the
    // bottom because it's the lowest-severity row.
    expect(items[0]!.id).toBe("rejected:sn_1");
    expect(items.find((i) => i.id === "induction")).toBeUndefined();
  });

  it("suppresses the assigned-to-me row when viewerId is missing", () => {
    const { items } = deriveAttention({
      job: baseJob,
      snags: [snag({ id: "sn_1", status: "open", assignedToId: "anyone" })],
      itps: [],
      viewerId: null,
    });
    expect(items.find((i) => i.id === "assigned:me")).toBeUndefined();
  });
});
