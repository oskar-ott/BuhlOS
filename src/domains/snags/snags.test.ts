import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateSnagPayloadSchema,
  SNAG_DESCRIPTION_MAX,
  SNAG_EVIDENCE_LINK_MAX,
  SNAG_PRIORITIES,
  SNAG_REJECTION_REASON_MAX,
  SNAG_SOURCES,
  SNAG_STATUSES,
  SNAG_TITLE_MAX,
  SnagCreateResponseSchema,
  SnagItemSchema,
  SnagListResponseSchema,
  SnagPrioritySchema,
  SnagStatusSchema,
  SnagTransitionResponseSchema,
  TransitionSnagPayloadSchema,
} from "./schema";
import {
  isActive,
  isDone,
  priorityLabel,
  priorityTone,
  statusLabel,
  statusTone,
} from "./format";
import {
  allowedTransitionsList,
  canFieldViewSnag,
  canRoleTransition,
  canTransition,
  compareForQueue,
} from "./service";
import { createSnag, listSnags, transitionSnag } from "./client";
import type { SnagItem } from "./types";

/* ----------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------- */

const baseSnag: SnagItem = {
  id: "sn_12345678",
  jobId: "birdwood-iv3232",
  title: "Plug missing earth in kitchen",
  description: "Worker noticed the kitchen power point has no earth.",
  summary: null,
  stage: "fitOff",
  areaId: "ar_kitchen",
  areaName: "Kitchen",
  taskId: null,
  taskName: null,
  evidenceIds: [],
  status: "open",
  priority: "high",
  source: "phil",
  createdById: "user-tradie-1",
  createdByName: "Sam",
  createdByRole: "tradie",
  assignedToId: null,
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
  rejectedAt: null,
  rejectedById: null,
  rejectedByName: null,
  rejectionReason: null,
  auditLogIds: ["al_abc"],
  createdAt: "2026-05-25T14:30:00.000Z",
  updatedAt: "2026-05-25T14:30:00.000Z",
};

/* ----------------------------------------------------------------------
 * Schema — SnagItem
 * -------------------------------------------------------------------- */

describe("SnagItemSchema", () => {
  it("accepts a minimal open snag", () => {
    expect(SnagItemSchema.safeParse(baseSnag).success).toBe(true);
  });

  it("accepts a fully populated resolved snag", () => {
    const resolved = {
      ...baseSnag,
      status: "resolved" as const,
      acknowledgedAt: "2026-05-25T15:00:00.000Z",
      acknowledgedById: "user-tradie-1",
      acknowledgedByName: "Sam",
      resolvedAt: "2026-05-25T16:00:00.000Z",
      resolvedById: "user-tradie-1",
      resolvedByName: "Sam",
      taskId: "ft_xyz",
      taskName: "Connect earth",
      evidenceIds: ["ev_aaa11111", "ev_bbb22222"],
    };
    expect(SnagItemSchema.safeParse(resolved).success).toBe(true);
  });

  it("accepts a rejected snag with rejectionReason", () => {
    const rejected = {
      ...baseSnag,
      status: "rejected" as const,
      rejectedAt: "2026-05-25T17:00:00.000Z",
      rejectedById: "user-admin-1",
      rejectedByName: "Anna",
      rejectionReason: "Duplicate of sn_99999999",
    };
    expect(SnagItemSchema.safeParse(rejected).success).toBe(true);
  });

  it("rejects a rejected snag without rejectionReason", () => {
    const broken = { ...baseSnag, status: "rejected" as const, rejectionReason: null };
    expect(SnagItemSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects rejected snag with whitespace-only reason", () => {
    const broken = {
      ...baseSnag,
      status: "rejected" as const,
      rejectionReason: "   ",
    };
    expect(SnagItemSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    const cases = [
      "id",
      "jobId",
      "title",
      "status",
      "priority",
      "source",
      "createdById",
      "createdByName",
      "createdAt",
      "updatedAt",
    ];
    for (const f of cases) {
      const broken = { ...baseSnag } as Record<string, unknown>;
      delete broken[f];
      expect(SnagItemSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects unknown status / priority / source / stage values", () => {
    expect(SnagItemSchema.safeParse({ ...baseSnag, status: "pending" }).success).toBe(
      false
    );
    expect(SnagItemSchema.safeParse({ ...baseSnag, priority: "P1" }).success).toBe(false);
    expect(SnagItemSchema.safeParse({ ...baseSnag, source: "client" }).success).toBe(
      false
    );
    expect(SnagItemSchema.safeParse({ ...baseSnag, stage: "commission" }).success).toBe(
      false
    );
  });

  it("evidenceIds + auditLogIds are required arrays on server-returned snags", () => {
    // Server-side: api/snags.js always writes both arrays (possibly
    // empty). A missing field on the wire is a server bug, so the
    // schema rejects it rather than silently defaulting — that keeps
    // wire-shape regressions loud.
    const missing = { ...baseSnag } as Record<string, unknown>;
    delete missing.evidenceIds;
    expect(SnagItemSchema.safeParse(missing).success).toBe(false);

    const empty = { ...baseSnag, evidenceIds: [], auditLogIds: [] };
    expect(SnagItemSchema.safeParse(empty).success).toBe(true);
  });

  it("passes through unknown forward-compat fields (.passthrough)", () => {
    const future = { ...baseSnag, reviewerNotes: "looks good" };
    const parsed = SnagItemSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { reviewerNotes?: string }).reviewerNotes).toBe(
        "looks good"
      );
    }
  });

  it("enum exports stay in sync with the documented values", () => {
    expect([...SNAG_STATUSES].sort()).toEqual([
      "closed",
      "in_progress",
      "open",
      "rejected",
      "resolved",
      "verified",
    ]);
    expect([...SNAG_PRIORITIES]).toEqual(["low", "normal", "high", "urgent"]);
    expect([...SNAG_SOURCES].sort()).toEqual(["admin", "phil", "system"]);
    expect(SNAG_TITLE_MAX).toBe(120);
    expect(SNAG_DESCRIPTION_MAX).toBe(1000);
    expect(SNAG_REJECTION_REASON_MAX).toBe(500);
    expect(SNAG_EVIDENCE_LINK_MAX).toBe(10);
  });

  it("status/priority enums match the runtime exports", () => {
    expect(SnagStatusSchema.options).toEqual([...SNAG_STATUSES]);
    expect(SnagPrioritySchema.options).toEqual([...SNAG_PRIORITIES]);
  });
});

/* ----------------------------------------------------------------------
 * Schema — CreateSnagPayload
 * -------------------------------------------------------------------- */

describe("CreateSnagPayloadSchema", () => {
  it("accepts a minimal payload with just a title", () => {
    const r = CreateSnagPayloadSchema.safeParse({ title: "Bad join in switchboard" });
    expect(r.success).toBe(true);
    if (r.success) {
      // priority is optional on the wire — the server defaults to
      // 'normal' when missing, so the client doesn't have to send it.
      expect(r.data.priority).toBeUndefined();
    }
  });

  it("rejects when title is empty / whitespace-only / missing", () => {
    expect(CreateSnagPayloadSchema.safeParse({}).success).toBe(false);
    expect(CreateSnagPayloadSchema.safeParse({ title: "" }).success).toBe(false);
    expect(CreateSnagPayloadSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("rejects title longer than SNAG_TITLE_MAX", () => {
    const longTitle = "x".repeat(SNAG_TITLE_MAX + 1);
    expect(CreateSnagPayloadSchema.safeParse({ title: longTitle }).success).toBe(false);
  });

  it("accepts title at SNAG_TITLE_MAX", () => {
    const maxTitle = "x".repeat(SNAG_TITLE_MAX);
    expect(CreateSnagPayloadSchema.safeParse({ title: maxTitle }).success).toBe(true);
  });

  it("rejects description longer than SNAG_DESCRIPTION_MAX", () => {
    const longDesc = "x".repeat(SNAG_DESCRIPTION_MAX + 1);
    expect(
      CreateSnagPayloadSchema.safeParse({ title: "x", description: longDesc }).success
    ).toBe(false);
  });

  it("rejects unknown priority", () => {
    expect(
      CreateSnagPayloadSchema.safeParse({ title: "x", priority: "p1" }).success
    ).toBe(false);
  });

  it("accepts every valid priority", () => {
    for (const p of SNAG_PRIORITIES) {
      expect(
        CreateSnagPayloadSchema.safeParse({ title: "x", priority: p }).success
      ).toBe(true);
    }
  });

  it("rejects taskId without stage", () => {
    expect(
      CreateSnagPayloadSchema.safeParse({ title: "x", taskId: "rt_abc" }).success
    ).toBe(false);
  });

  it("accepts taskId when stage is also provided", () => {
    const r = CreateSnagPayloadSchema.safeParse({
      title: "x",
      taskId: "rt_abc",
      stage: "roughIn",
      areaId: "ar_1",
    });
    expect(r.success).toBe(true);
  });

  it("rejects evidenceIds over the per-snag cap", () => {
    const ids = Array.from({ length: SNAG_EVIDENCE_LINK_MAX + 1 }, (_, i) => `ev_${i}`);
    expect(
      CreateSnagPayloadSchema.safeParse({ title: "x", evidenceIds: ids }).success
    ).toBe(false);
  });

  it("accepts evidenceIds at the per-snag cap", () => {
    const ids = Array.from({ length: SNAG_EVIDENCE_LINK_MAX }, (_, i) => `ev_${i}`);
    expect(
      CreateSnagPayloadSchema.safeParse({ title: "x", evidenceIds: ids }).success
    ).toBe(true);
  });
});

/* ----------------------------------------------------------------------
 * Schema — TransitionSnagPayload
 * -------------------------------------------------------------------- */

describe("TransitionSnagPayloadSchema", () => {
  it("accepts each valid nextStatus", () => {
    for (const s of SNAG_STATUSES) {
      const r = TransitionSnagPayloadSchema.safeParse({
        snagId: "sn_abc12345",
        nextStatus: s,
        ...(s === "rejected" ? { reason: "duplicate" } : {}),
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects rejected transition without a reason", () => {
    const r = TransitionSnagPayloadSchema.safeParse({
      snagId: "sn_abc12345",
      nextStatus: "rejected",
    });
    expect(r.success).toBe(false);
  });

  it("rejects rejected transition with whitespace-only reason", () => {
    const r = TransitionSnagPayloadSchema.safeParse({
      snagId: "sn_abc12345",
      nextStatus: "rejected",
      reason: "   ",
    });
    expect(r.success).toBe(false);
  });

  it("rejects reason longer than SNAG_REJECTION_REASON_MAX", () => {
    const long = "x".repeat(SNAG_REJECTION_REASON_MAX + 1);
    const r = TransitionSnagPayloadSchema.safeParse({
      snagId: "sn_abc12345",
      nextStatus: "rejected",
      reason: long,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown nextStatus", () => {
    const r = TransitionSnagPayloadSchema.safeParse({
      snagId: "sn_abc12345",
      nextStatus: "shipped",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty snagId", () => {
    const r = TransitionSnagPayloadSchema.safeParse({
      snagId: "",
      nextStatus: "in_progress",
    });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema — response wrappers
 * -------------------------------------------------------------------- */

describe("response schemas", () => {
  it("parses an empty list response", () => {
    expect(SnagListResponseSchema.safeParse({ snags: [] }).success).toBe(true);
  });

  it("parses a list response with one snag", () => {
    expect(SnagListResponseSchema.safeParse({ snags: [baseSnag] }).success).toBe(true);
  });

  it("parses a create response with the canonical snag", () => {
    const r = SnagCreateResponseSchema.safeParse({ snagItem: baseSnag });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.snagItem.status).toBe("open");
    }
  });

  it("parses a transition response (same shape)", () => {
    const r = SnagTransitionResponseSchema.safeParse({
      snagItem: {
        ...baseSnag,
        status: "in_progress",
        acknowledgedAt: "2026-05-25T15:00:00.000Z",
        acknowledgedById: "user-tradie-1",
        acknowledgedByName: "Sam",
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a create response shaped like a list response", () => {
    expect(SnagCreateResponseSchema.safeParse({ snags: [baseSnag] }).success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Format helpers
 * -------------------------------------------------------------------- */

describe("format helpers", () => {
  it("statusLabel covers every status", () => {
    expect(statusLabel("open")).toBe("Open");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("resolved")).toBe("Resolved");
    expect(statusLabel("verified")).toBe("Verified");
    expect(statusLabel("closed")).toBe("Closed");
    expect(statusLabel("rejected")).toBe("Rejected");
  });

  it("statusTone maps to the doc 27 §6.2 palette", () => {
    expect(statusTone("open")).toBe("warning");
    expect(statusTone("in_progress")).toBe("info");
    expect(statusTone("resolved")).toBe("info");
    expect(statusTone("verified")).toBe("success");
    expect(statusTone("closed")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
  });

  it("priorityLabel + priorityTone", () => {
    expect(priorityLabel("urgent")).toBe("Urgent");
    expect(priorityLabel("high")).toBe("High");
    expect(priorityLabel("normal")).toBe("Normal");
    expect(priorityLabel("low")).toBe("Low");
    expect(priorityTone("urgent")).toBe("danger");
    expect(priorityTone("high")).toBe("warning");
    expect(priorityTone("normal")).toBe("neutral");
    expect(priorityTone("low")).toBe("neutral");
  });

  it("isActive / isDone partition the statuses correctly", () => {
    expect(isActive("open")).toBe(true);
    expect(isActive("in_progress")).toBe(true);
    expect(isActive("resolved")).toBe(true);
    expect(isActive("verified")).toBe(false);
    expect(isActive("closed")).toBe(false);
    expect(isActive("rejected")).toBe(false);

    expect(isDone("verified")).toBe(true);
    expect(isDone("closed")).toBe(true);
    expect(isDone("open")).toBe(false);
    expect(isDone("rejected")).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Service — state machine
 * -------------------------------------------------------------------- */

describe("service.canTransition", () => {
  it("allows the happy path: null → open → in_progress → resolved → verified → closed", () => {
    expect(canTransition(null, "open")).toBe(true);
    expect(canTransition("open", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "resolved")).toBe(true);
    expect(canTransition("resolved", "verified")).toBe(true);
    expect(canTransition("verified", "closed")).toBe(true);
  });

  it("allows recovery transitions", () => {
    expect(canTransition("in_progress", "open")).toBe(true);
    expect(canTransition("resolved", "in_progress")).toBe(true);
    expect(canTransition("resolved", "open")).toBe(true);
    expect(canTransition("verified", "resolved")).toBe(true);
    expect(canTransition("closed", "verified")).toBe(true);
  });

  it("allows the reject branch", () => {
    expect(canTransition("open", "rejected")).toBe(true);
    expect(canTransition("in_progress", "rejected")).toBe(true);
    expect(canTransition("resolved", "rejected")).toBe(true);
    expect(canTransition("rejected", "open")).toBe(true);
  });

  it("rejects direct skips (open → resolved, open → verified, ...)", () => {
    expect(canTransition("open", "resolved")).toBe(false);
    expect(canTransition("open", "verified")).toBe(false);
    expect(canTransition("open", "closed")).toBe(false);
    expect(canTransition("in_progress", "verified")).toBe(false);
    expect(canTransition("in_progress", "closed")).toBe(false);
    expect(canTransition("resolved", "closed")).toBe(false);
  });

  it("rejects null → anything-other-than-open", () => {
    for (const s of SNAG_STATUSES) {
      if (s === "open") continue;
      expect(canTransition(null, s)).toBe(false);
    }
  });

  it("rejects every other (from, to) pair", () => {
    const allowed = new Set(allowedTransitionsList());
    const FROMS: Array<string | null> = [null, ...SNAG_STATUSES];
    for (const from of FROMS) {
      for (const to of SNAG_STATUSES) {
        const key = `${from ?? "null"}→${to}`;
        const expected = allowed.has(key);
        expect(canTransition(from as never, to)).toBe(expected);
      }
    }
  });
});

describe("service.canRoleTransition", () => {
  const adminCtx = {
    userId: "admin-1",
    role: "admin",
    creatorId: "user-tradie-1",
    assignedToId: null,
  };
  const creatorCtx = {
    userId: "user-tradie-1",
    role: "tradie",
    creatorId: "user-tradie-1",
    assignedToId: null,
  };
  const otherTradieCtx = {
    userId: "user-tradie-2",
    role: "tradie",
    creatorId: "user-tradie-1",
    assignedToId: null,
  };
  const assigneeCtx = {
    userId: "user-tradie-3",
    role: "tradie",
    creatorId: "user-tradie-1",
    assignedToId: "user-tradie-3",
  };
  const clientCtx = {
    userId: "user-client-1",
    role: "client",
    creatorId: "user-tradie-1",
    assignedToId: null,
  };

  it("admin can perform every state-machine-allowed transition", () => {
    const FROMS: Array<string | null> = [null, ...SNAG_STATUSES];
    for (const from of FROMS) {
      for (const to of SNAG_STATUSES) {
        if (canTransition(from as never, to)) {
          expect(canRoleTransition(from as never, to, adminCtx)).toBe(true);
        }
      }
    }
  });

  it("any field role can claim or drop an open snag", () => {
    expect(canRoleTransition("open", "in_progress", otherTradieCtx)).toBe(true);
    expect(canRoleTransition("in_progress", "open", otherTradieCtx)).toBe(true);
  });

  it("creator can mark in_progress → resolved (and re-open)", () => {
    expect(canRoleTransition("in_progress", "resolved", creatorCtx)).toBe(true);
    expect(canRoleTransition("resolved", "in_progress", creatorCtx)).toBe(true);
    expect(canRoleTransition("resolved", "open", creatorCtx)).toBe(true);
  });

  it("assignee can mark in_progress → resolved (and re-open)", () => {
    expect(canRoleTransition("in_progress", "resolved", assigneeCtx)).toBe(true);
    expect(canRoleTransition("resolved", "in_progress", assigneeCtx)).toBe(true);
  });

  it("non-creator non-assignee field user CANNOT resolve", () => {
    expect(canRoleTransition("in_progress", "resolved", otherTradieCtx)).toBe(false);
    expect(canRoleTransition("resolved", "in_progress", otherTradieCtx)).toBe(false);
  });

  it("field users cannot verify, close, reject, or re-open closed/rejected", () => {
    expect(canRoleTransition("resolved", "verified", creatorCtx)).toBe(false);
    expect(canRoleTransition("verified", "closed", creatorCtx)).toBe(false);
    expect(canRoleTransition("open", "rejected", creatorCtx)).toBe(false);
    expect(canRoleTransition("in_progress", "rejected", assigneeCtx)).toBe(false);
    expect(canRoleTransition("closed", "verified", creatorCtx)).toBe(false);
    expect(canRoleTransition("rejected", "open", creatorCtx)).toBe(false);
  });

  it("client role cannot transition anything", () => {
    expect(canRoleTransition("open", "in_progress", clientCtx)).toBe(false);
    expect(canRoleTransition("resolved", "verified", clientCtx)).toBe(false);
  });
});

describe("service.canFieldViewSnag", () => {
  it("admin + LH + tradie can view; client cannot", () => {
    expect(canFieldViewSnag("admin")).toBe(true);
    expect(canFieldViewSnag("leadingHand")).toBe(true);
    expect(canFieldViewSnag("tradie")).toBe(true);
    expect(canFieldViewSnag("apprentice")).toBe(true);
    expect(canFieldViewSnag("client")).toBe(false);
    expect(canFieldViewSnag(null)).toBe(false);
    expect(canFieldViewSnag(undefined)).toBe(false);
  });
});

describe("service.compareForQueue", () => {
  it("status-first then priority-first then newest-first", () => {
    const a = {
      status: "open" as const,
      priority: "normal",
      createdAt: "2026-05-25T10:00:00Z",
    };
    const b = {
      status: "in_progress" as const,
      priority: "urgent",
      createdAt: "2026-05-25T11:00:00Z",
    };
    const c = {
      status: "open" as const,
      priority: "urgent",
      createdAt: "2026-05-25T09:00:00Z",
    };
    const d = {
      status: "open" as const,
      priority: "urgent",
      createdAt: "2026-05-25T12:00:00Z",
    };
    const sorted = [a, b, c, d].slice().sort(compareForQueue);
    // open-urgent (newest first), open-normal, in_progress-urgent
    expect(sorted.map((s) => s.createdAt)).toEqual([
      "2026-05-25T12:00:00Z",
      "2026-05-25T09:00:00Z",
      "2026-05-25T10:00:00Z",
      "2026-05-25T11:00:00Z",
    ]);
  });

  it("closed + rejected sink to the bottom", () => {
    const open = {
      status: "open" as const,
      priority: "normal",
      createdAt: "2026-05-25T10:00:00Z",
    };
    const closed = {
      status: "closed" as const,
      priority: "urgent",
      createdAt: "2026-05-25T20:00:00Z",
    };
    const rejected = {
      status: "rejected" as const,
      priority: "urgent",
      createdAt: "2026-05-25T22:00:00Z",
    };
    const sorted = [closed, rejected, open].slice().sort(compareForQueue);
    expect(sorted.map((s) => s.status)).toEqual(["open", "closed", "rejected"]);
  });
});

/* ----------------------------------------------------------------------
 * Client — list + create + transition wrappers (mocked fetch)
 * -------------------------------------------------------------------- */

describe("snags client wrappers", () => {
  const origFetch = globalThis.fetch;
  let fetchCalls: Array<[string, RequestInit | undefined]>;

  function installFetch(make: () => Response): void {
    fetchCalls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([String(input), init]);
      return Promise.resolve(make());
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("listSnags hits /api/snags?jobId=<id>", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ snags: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await listSnags("birdwood-iv3232");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.snags).toEqual([]);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe("/api/snags?jobId=birdwood-iv3232");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
  });

  it("listSnags URL-encodes the jobId", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ snags: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    await listSnags("job with/slash");
    expect(fetchCalls[0]![0]).toBe("/api/snags?jobId=job%20with%2Fslash");
  });

  it("listSnags surfaces 401 as ok:false", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: "not authenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await listSnags("birdwood-iv3232");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(401);
  });

  it("createSnag refuses to call the server with an invalid payload", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await createSnag("birdwood-iv3232", { title: "" });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("createSnag POSTs a valid payload and parses the canonical response", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ snagItem: baseSnag }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createSnag("birdwood-iv3232", {
      title: "Plug missing earth in kitchen",
      priority: "high",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.snagItem.title).toBe("Plug missing earth in kitchen");
      expect(r.data.snagItem.status).toBe("open");
    }
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![1]?.method).toBe("POST");
  });

  it("createSnag surfaces a 403 from the server", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: "no write access to job" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createSnag("birdwood-iv3232", { title: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(403);
  });

  it("createSnag surfaces a schema mismatch as ok:false", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ wrong: "shape" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createSnag("birdwood-iv3232", { title: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("response schema mismatch");
  });

  it("transitionSnag refuses to call the server with empty snagId", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await transitionSnag("birdwood-iv3232", {
      snagId: "",
      nextStatus: "in_progress",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("transitionSnag refuses to call the server when rejecting without reason", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await transitionSnag("birdwood-iv3232", {
      snagId: "sn_abc12345",
      nextStatus: "rejected",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("transitionSnag POSTs ?action=transition and parses the canonical response", async () => {
    const verifiedItem = {
      ...baseSnag,
      status: "verified" as const,
      resolvedAt: "2026-05-25T16:00:00.000Z",
      resolvedById: "user-tradie-1",
      resolvedByName: "Sam",
      verifiedAt: "2026-05-25T17:00:00.000Z",
      verifiedById: "user-admin-1",
      verifiedByName: "Anna",
    };
    installFetch(
      () =>
        new Response(JSON.stringify({ snagItem: verifiedItem }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await transitionSnag("birdwood-iv3232", {
      snagId: "sn_12345678",
      nextStatus: "verified",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.snagItem.status).toBe("verified");
      expect(r.data.snagItem.verifiedByName).toBe("Anna");
    }
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toContain("jobId=birdwood-iv3232");
    expect(url).toContain("action=transition");
    expect(init?.method).toBe("POST");
  });
});
