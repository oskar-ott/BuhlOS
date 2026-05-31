import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/material-requests.js — the real serverless
 * handler against a mocked Vercel Blob store and real HMAC sessions.
 *
 * Mirrors observations-api.test.ts pattern (mock blob, sign session, call
 * handler). Covers cross-job/job-scoped GET, admin-only POST + PATCH,
 * legal/illegal state transitions, supplier/orderRef/cancelReason field
 * handling, and audit emission for material_request.created and
 * material_request.transitioned.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const mrPath = requireFromHere.resolve("../../../api/material-requests.js");

let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

function cookieFor(userId: string, role: string): string {
  const token = auth.signSession({
    userId,
    role,
    exp: Date.now() + 60_000,
  });
  return `buhl_session=${token}`;
}

async function call(opts: {
  method: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon
      ? {}
      : { cookie: cookieFor(opts.userId || "u_field", opts.role) },
  };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-1"],
          },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          {
            id: "u_lh",
            username: "leader",
            role: "leading-hand",
            assignedJobIds: ["job-1"],
          },
          {
            id: "u_client",
            username: "client",
            role: "client",
            assignedJobIds: ["job-1"],
          },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-1",
            name: "Birdwood",
            areaGroups: [
              {
                id: "g1",
                name: "Ground",
                areas: [
                  {
                    id: "ar_1",
                    name: "Riser",
                    roughInTasks: [{ id: "t_rough_1", name: "Pull power" }],
                    fitOffTasks: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    ["jobs/job-1/data.json", { evidence: [{ id: "ev_1" }], snagsV2: [] }],
    ["material-requests.json", { requests: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[mrPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(mrPath);
});

function collectAuditEntries(b: Map<string, unknown>): Array<{
  action: string;
  actorId: string;
  jobId: string;
  targetType: string;
  metadata?: unknown;
}> {
  const out: Array<{
    action: string;
    actorId: string;
    jobId: string;
    targetType: string;
    metadata?: unknown;
  }> = [];
  for (const [k, v] of b.entries()) {
    if (!k.startsWith("audit/")) continue;
    const list = (
      v as {
        entries?: Array<{
          action: string;
          actorId: string;
          jobId: string;
          targetType: string;
          metadata?: unknown;
        }>;
      }
    ).entries;
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

describe("POST /api/material-requests (admin create)", () => {
  it("admin creates a request → 201 + persisted + audit", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: { item: "25mm conduit", quantity: 20, unit: "m", urgency: "high" },
    });
    expect(res.statusCode).toBe(201);
    const req = (res.body as { request: Record<string, unknown> }).request;
    expect(req.item).toBe("25mm conduit");
    expect(req.quantity).toBe(20);
    expect(req.unit).toBe("m");
    expect(req.urgency).toBe("high");
    expect(req.status).toBe("requested");
    expect(req.source).toBe("buhlos");
    expect(req.requestedById).toBe("u_boss");
    expect(req.jobName).toBe("Birdwood");

    const store = blob.get("material-requests.json") as {
      requests: { id: string }[];
    };
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]!.id).toBe(req.id);

    const audit = collectAuditEntries(blob);
    const created = audit.find((e) => e.action === "material_request.created");
    expect(created?.targetType).toBe("material_request");
    expect(created?.actorId).toBe("u_boss");
    expect(created?.jobId).toBe("job-1");
  });

  it("stamps area + task names when area/task provided", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: {
        item: "tray",
        quantity: 6,
        unit: "ea",
        areaId: "ar_1",
        taskId: "t_rough_1",
        stage: "roughIn",
      },
    });
    expect(res.statusCode).toBe(201);
    const req = (res.body as { request: Record<string, unknown> }).request;
    expect(req.areaName).toBe("Riser");
    expect(req.taskName).toBe("Pull power");
    expect(req.stage).toBe("roughIn");
  });

  it("403s a field worker (admin-only POST)", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
      body: { item: "x", quantity: 1, unit: "ea" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a leading-hand on POST (still admin-only)", async () => {
    const res = await call({
      method: "POST",
      role: "leading-hand",
      userId: "u_lh",
      query: { jobId: "job-1" },
      body: { item: "x", quantity: 1, unit: "ea" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s unauthenticated", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      anon: true,
      query: { jobId: "job-1" },
      body: { item: "x", quantity: 1, unit: "ea" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s missing item", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: { quantity: 5, unit: "m" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on quantity <= 0", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: { item: "x", quantity: 0, unit: "m" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on missing unit", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: { item: "x", quantity: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s missing jobId", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      body: { item: "x", quantity: 1, unit: "ea" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s unknown jobId", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-missing" },
      body: { item: "x", quantity: 1, unit: "ea" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/material-requests", () => {
  beforeEach(() => {
    blob.set("material-requests.json", {
      requests: [
        {
          id: "mr1",
          jobId: "job-1",
          item: "conduit",
          quantity: 20,
          unit: "m",
          status: "requested",
          urgency: "high",
          source: "observation",
          requestedAt: "2026-05-02T00:00:00Z",
          requestedById: "u_boss",
          requestedByName: "Boss",
          auditLogIds: [],
          createdAt: "2026-05-02T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
        },
        {
          id: "mr2",
          jobId: "job-2",
          item: "tray",
          quantity: 6,
          unit: "ea",
          status: "delivered",
          urgency: "normal",
          source: "buhlos",
          requestedAt: "2026-05-01T00:00:00Z",
          requestedById: "u_boss",
          requestedByName: "Boss",
          auditLogIds: [],
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        },
      ],
    });
  });

  it("cross-job inbox returns all for admin", async () => {
    const res = await call({
      method: "GET",
      role: "boss",
      userId: "u_boss",
    });
    expect(res.statusCode).toBe(200);
    const list = (res.body as { requests: { id: string }[] }).requests;
    expect(list.map((r) => r.id)).toEqual(["mr1", "mr2"]);
  });

  it("cross-job inbox 403s a field worker", async () => {
    const res = await call({
      method: "GET",
      role: "electrician",
      userId: "u_field",
    });
    expect(res.statusCode).toBe(403);
  });

  it("cross-job inbox 403s a leading-hand", async () => {
    const res = await call({
      method: "GET",
      role: "leading-hand",
      userId: "u_lh",
    });
    expect(res.statusCode).toBe(403);
  });

  it("cross-job inbox 401s unauthenticated", async () => {
    const res = await call({ method: "GET", role: "boss", anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("filters by status", async () => {
    const res = await call({
      method: "GET",
      role: "boss",
      userId: "u_boss",
      query: { status: "delivered" },
    });
    expect(
      (res.body as { requests: { id: string }[] }).requests.map((r) => r.id)
    ).toEqual(["mr2"]);
  });

  it("filters by urgency", async () => {
    const res = await call({
      method: "GET",
      role: "boss",
      userId: "u_boss",
      query: { urgency: "high" },
    });
    expect(
      (res.body as { requests: { id: string }[] }).requests.map((r) => r.id)
    ).toEqual(["mr1"]);
  });

  it("job-scoped GET returns only that job for an assigned field worker", async () => {
    const res = await call({
      method: "GET",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.body as { requests: { id: string }[] }).requests.map((r) => r.id)
    ).toEqual(["mr1"]);
  });

  it("job-scoped GET 403s a field worker on an unassigned job", async () => {
    blob.set("jobs.json", {
      jobs: [
        { id: "job-2", name: "Other", areaGroups: [] },
        { id: "job-1", name: "Birdwood", areaGroups: [] },
      ],
    });
    const res = await call({
      method: "GET",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-2" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("job-scoped GET 403s a client", async () => {
    const res = await call({
      method: "GET",
      role: "client",
      userId: "u_client",
      query: { jobId: "job-1" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/material-requests (state machine + fields)", () => {
  beforeEach(() => {
    blob.set("material-requests.json", {
      requests: [
        {
          id: "mr1",
          jobId: "job-1",
          item: "conduit",
          quantity: 20,
          unit: "m",
          status: "requested",
          urgency: "normal",
          source: "buhlos",
          requestedAt: "2026-05-02T00:00:00Z",
          requestedById: "u_boss",
          requestedByName: "Boss",
          auditLogIds: [],
          createdAt: "2026-05-02T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
        },
      ],
    });
  });

  it("admin approves requested → approved (stamps approvedBy + audit)", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", status: "approved" },
    });
    expect(res.statusCode).toBe(200);
    const r = (res.body as { request: Record<string, unknown> }).request;
    expect(r.status).toBe("approved");
    expect(r.approvedById).toBe("u_boss");
    expect(r.approvedAt).toBeTruthy();

    const audit = collectAuditEntries(blob);
    const t = audit.find((e) => e.action === "material_request.transitioned");
    expect(t).toBeTruthy();
    expect(
      (t?.metadata as { from: { status: string }; to: { status: string } })
        .from.status
    ).toBe("requested");
    expect(
      (t?.metadata as { from: { status: string }; to: { status: string } }).to
        .status
    ).toBe("approved");
  });

  it("admin marks ordered with supplier + orderRef stored", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: {
        id: "mr1",
        status: "ordered",
        supplier: "CMI Cabling",
        orderRef: "PO-4521",
        supplierNote: "ETA Fri",
      },
    });
    expect(res.statusCode).toBe(200);
    const r = (res.body as { request: Record<string, unknown> }).request;
    expect(r.status).toBe("ordered");
    expect(r.supplier).toBe("CMI Cabling");
    expect(r.orderRef).toBe("PO-4521");
    expect(r.supplierNote).toBe("ETA Fri");
    expect(r.orderedById).toBe("u_boss");
  });

  it("ordered → delivered with deliveryNote", async () => {
    // Walk requested → ordered → delivered in two calls.
    await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", status: "ordered", supplier: "CMI" },
    });
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: {
        id: "mr1",
        status: "delivered",
        deliveryNote: "All units received",
      },
    });
    expect(res.statusCode).toBe(200);
    const r = (res.body as { request: Record<string, unknown> }).request;
    expect(r.status).toBe("delivered");
    expect(r.deliveryNote).toBe("All units received");
    expect(r.deliveredById).toBe("u_boss");
    expect(r.deliveredAt).toBeTruthy();
  });

  it("409s an illegal transition (requested → delivered)", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", status: "delivered" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("400s cancelled without cancelReason", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", status: "cancelled" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cancels with required reason → stamps + records reason in metadata", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: {
        id: "mr1",
        status: "cancelled",
        cancelReason: "duplicate request",
      },
    });
    expect(res.statusCode).toBe(200);
    const r = (res.body as { request: Record<string, unknown> }).request;
    expect(r.status).toBe("cancelled");
    expect(r.cancelReason).toBe("duplicate request");
    expect(r.cancelledById).toBe("u_boss");

    const audit = collectAuditEntries(blob);
    const t = audit.find((e) => e.action === "material_request.transitioned");
    expect((t?.metadata as { cancelReason: string }).cancelReason).toBe(
      "duplicate request"
    );
  });

  it("urgency bump without status change still emits transitioned", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", urgency: "urgent" },
    });
    expect(res.statusCode).toBe(200);
    const audit = collectAuditEntries(blob);
    const t = audit.find((e) => e.action === "material_request.transitioned");
    expect(t).toBeTruthy();
    expect(
      (t?.metadata as { changedFields: string[] }).changedFields
    ).toContain("urgency");
  });

  it("free-text supplierNote edit alone does NOT emit a transitioned entry", async () => {
    // (PATCH only — no status / urgency / supplier / orderRef change.)
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", supplierNote: "added a clarification" },
    });
    expect(res.statusCode).toBe(200);
    const audit = collectAuditEntries(blob);
    expect(
      audit.find((e) => e.action === "material_request.transitioned")
    ).toBeUndefined();
  });

  it("403s a field worker on PATCH", async () => {
    const res = await call({
      method: "PATCH",
      role: "electrician",
      userId: "u_field",
      body: { id: "mr1", status: "approved" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a leading-hand on PATCH", async () => {
    const res = await call({
      method: "PATCH",
      role: "leading-hand",
      userId: "u_lh",
      body: { id: "mr1", status: "approved" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s unknown id", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "missing", status: "approved" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s invalid status value", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s overlong supplier", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "mr1", supplier: "x".repeat(200) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("method gating", () => {
  it("405s an unknown method", async () => {
    const res = await call({
      method: "DELETE",
      role: "boss",
      userId: "u_boss",
    });
    expect(res.statusCode).toBe(405);
  });
});
