import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/variations.js — the real serverless handler against
 * a mocked Vercel Blob store and real HMAC sessions (#280). Mirrors
 * material-requests-api.test.ts / observations-api.test.ts.
 *
 * Covers:
 *   - admin-tier gating (401 anon, 403 field/LH/client, 200/201 admin)
 *   - create (draft, sequential VO-001 ref, integer-cents value)
 *   - the status pipeline + illegal transitions (409)
 *   - THE APPROVAL GATE: approved is unreachable without complete evidence (400)
 *   - "Mark invoiced" requires a manual invoice reference (400 otherwise)
 *   - audit emission (variation.created + variation.transitioned)
 *   - convert-from-observation (api/observations.js?action=convert-to-variation):
 *       admin-tier, default-eligible `variation` type, double-convert 409,
 *       back-link + paired audit (variation.created + observation.converted_to_variation)
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const variationsPath = requireFromHere.resolve("../../../api/variations.js");
const obsPath = requireFromHere.resolve("../../../api/observations.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");

let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;
let obsHandler: (
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
  const token = auth.signSession({ userId, role, exp: Date.now() + 60_000 });
  return `buhl_session=${token}`;
}

async function call(opts: {
  method: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
  via?: "variations" | "observations";
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_field", opts.role) },
  };
  await (opts.via === "observations" ? obsHandler : handler)(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "leader", role: "leading-hand", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs.json",
      { jobs: [{ id: "job-1", name: "Birdwood", areaGroups: [] }] },
    ],
    ["jobs/job-1/data.json", { evidence: [{ id: "ev_1" }], snagsV2: [] }],
    ["jobs/job-1/variations.json", { claims: [] }],
    ["observations.json", { observations: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[variationsPath];
  delete requireFromHere.cache[obsPath];
  delete requireFromHere.cache[pushPath];
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
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: {
      getWebPush: vi.fn(() => null),
      sendPushToUserId: vi.fn(async () => ({ sent: 0, pruned: 0, skipped: null })),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(variationsPath);
  obsHandler = requireFromHere(obsPath);
});

function collectAuditEntries(b: Map<string, unknown>): Array<{
  action: string;
  actorId: string;
  jobId: string;
  targetType: string;
  metadata?: Record<string, unknown>;
}> {
  const out: Array<{
    action: string;
    actorId: string;
    jobId: string;
    targetType: string;
    metadata?: Record<string, unknown>;
  }> = [];
  for (const [k, v] of b.entries()) {
    if (!k.startsWith("audit/")) continue;
    const list = (v as { entries?: typeof out }).entries;
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

const FULL_EVIDENCE = {
  approvedBy: "Jane Builder",
  approvedAt: "2026-06-19T01:00:00.000Z",
  method: "email",
  reference: "RE: VO-001 approved",
};

describe("POST /api/variations (admin create)", () => {
  it("admin creates a claim → 201, draft, VO-001, integer cents, audit", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1" },
      body: { scope: "Extra GPOs, East Gym", valueCents: 123450 },
    });
    expect(res.statusCode).toBe(201);
    const c = (res.body as { claim: Record<string, unknown> }).claim;
    expect(c.scope).toBe("Extra GPOs, East Gym");
    expect(c.ref).toBe("VO-001");
    expect(c.status).toBe("draft");
    expect(c.valueCents).toBe(123450);
    expect(c.createdById).toBe("u_boss");
    expect(c.approval).toBeNull();

    const store = blob.get("jobs/job-1/variations.json") as { claims: { id: string }[] };
    expect(store.claims).toHaveLength(1);
    expect(store.claims[0]!.id).toBe(c.id);

    const created = collectAuditEntries(blob).find((e) => e.action === "variation.created");
    expect(created?.targetType).toBe("variation");
    expect(created?.jobId).toBe("job-1");
    expect(created?.actorId).toBe("u_boss");
  });

  it("mints sequential refs VO-001, VO-002 (collision-safe)", async () => {
    await call({
      method: "POST", role: "boss", userId: "u_boss",
      query: { jobId: "job-1" }, body: { scope: "First" },
    });
    const second = await call({
      method: "POST", role: "boss", userId: "u_boss",
      query: { jobId: "job-1" }, body: { scope: "Second" },
    });
    expect((second.body as { claim: { ref: string } }).claim.ref).toBe("VO-002");
  });

  it("403s a field worker (admin-only)", async () => {
    const res = await call({
      method: "POST", role: "electrician", userId: "u_field",
      query: { jobId: "job-1" }, body: { scope: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a leading-hand (still admin-only)", async () => {
    const res = await call({
      method: "POST", role: "leading-hand", userId: "u_lh",
      query: { jobId: "job-1" }, body: { scope: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s unauthenticated", async () => {
    const res = await call({
      method: "POST", role: "boss", anon: true,
      query: { jobId: "job-1" }, body: { scope: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s missing scope", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss",
      query: { jobId: "job-1" }, body: { valueCents: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a non-integer valueCents", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss",
      query: { jobId: "job-1" }, body: { scope: "x", valueCents: 12.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s missing jobId", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss", body: { scope: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s unknown jobId", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss",
      query: { jobId: "job-missing" }, body: { scope: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/variations (per-job list)", () => {
  beforeEach(() => {
    blob.set("jobs/job-1/variations.json", {
      claims: [
        { id: "vc_a", jobId: "job-1", ref: "VO-001", scope: "a", status: "draft", valueCents: 100, createdAt: "2026-06-18T00:00:00Z" },
        { id: "vc_b", jobId: "job-1", ref: "VO-002", scope: "b", status: "submitted", valueCents: 200, createdAt: "2026-06-19T00:00:00Z" },
      ],
    });
  });

  it("returns claims newest-first for an admin", async () => {
    const res = await call({ method: "GET", role: "boss", userId: "u_boss", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { claims: { id: string }[] }).claims.map((c) => c.id)).toEqual(["vc_b", "vc_a"]);
  });

  it("403s a field worker", async () => {
    const res = await call({ method: "GET", role: "electrician", userId: "u_field", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("403s a client", async () => {
    const res = await call({ method: "GET", role: "client", userId: "u_client", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("401s unauthenticated", async () => {
    const res = await call({ method: "GET", role: "boss", anon: true, query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(401);
  });

  it("400s without a jobId", async () => {
    const res = await call({ method: "GET", role: "boss", userId: "u_boss" });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/variations (pipeline + approval gate + invoice)", () => {
  beforeEach(() => {
    blob.set("jobs/job-1/variations.json", {
      claims: [
        {
          id: "vc_1", jobId: "job-1", ref: "VO-001", scope: "Extra GPOs",
          status: "submitted", valueCents: 50000, approval: null,
          links: { observationId: null, evidenceIds: [], documentIds: [] },
          auditLogIds: [], createdAt: "2026-06-18T00:00:00Z", updatedAt: "2026-06-18T00:00:00Z",
        },
      ],
    });
  });

  it("BLOCKS approved without evidence (the gate) → 400, status unchanged", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "approved" },
    });
    expect(res.statusCode).toBe(400);
    const store = blob.get("jobs/job-1/variations.json") as { claims: { status: string }[] };
    expect(store.claims[0]!.status).toBe("submitted");
  });

  it("BLOCKS approved with INCOMPLETE evidence (missing reference) → 400", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "approved", approval: { ...FULL_EVIDENCE, reference: "" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("BLOCKS approved with an invalid method → 400", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "approved", approval: { ...FULL_EVIDENCE, method: "carrier-pigeon" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ALLOWS approved with complete evidence → 200, stamps evidence + audit (method in metadata)", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "approved", approval: FULL_EVIDENCE },
    });
    expect(res.statusCode).toBe(200);
    const c = (res.body as { claim: Record<string, unknown> }).claim;
    expect(c.status).toBe("approved");
    expect((c.approval as { approvedBy: string }).approvedBy).toBe("Jane Builder");

    const t = collectAuditEntries(blob).find((e) => e.action === "variation.transitioned");
    expect(t?.metadata?.from).toBe("submitted");
    expect(t?.metadata?.to).toBe("approved");
    expect(t?.metadata?.method).toBe("email");
  });

  it("rejects a submitted claim with a decision note", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "rejected", decisionNote: "out of scope" },
    });
    expect(res.statusCode).toBe(200);
    const c = (res.body as { claim: Record<string, unknown> }).claim;
    expect(c.status).toBe("rejected");
    expect(c.decisionNote).toBe("out of scope");
  });

  it("409s an illegal transition (submitted → invoiced)", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "invoiced", invoiceRef: "INV-1" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("Mark invoiced requires a manual invoice reference (no integration)", async () => {
    // submitted → approved (with evidence) → invoiced (needs ref).
    await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "approved", approval: FULL_EVIDENCE },
    });
    const noRef = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "invoiced" },
    });
    expect(noRef.statusCode).toBe(400);

    const withRef = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "invoiced", invoiceRef: "INV-2026-0042" },
    });
    expect(withRef.statusCode).toBe(200);
    const c = (withRef.body as { claim: Record<string, unknown> }).claim;
    expect(c.status).toBe("invoiced");
    expect(c.invoiceRef).toBe("INV-2026-0042");
    expect(c.invoicedAt).toBeTruthy();
  });

  it("edits scope + value on a draft", async () => {
    blob.set("jobs/job-1/variations.json", {
      claims: [
        {
          id: "vc_1", jobId: "job-1", ref: "VO-001", scope: "old", status: "draft",
          valueCents: 100, links: { observationId: null, evidenceIds: [], documentIds: [] },
          auditLogIds: [], createdAt: "2026-06-18T00:00:00Z",
        },
      ],
    });
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", scope: "new scope", valueCents: 99900 },
    });
    expect(res.statusCode).toBe(200);
    const c = (res.body as { claim: Record<string, unknown> }).claim;
    expect(c.scope).toBe("new scope");
    expect(c.valueCents).toBe(99900);
  });

  it("403s a field worker on PATCH", async () => {
    const res = await call({
      method: "PATCH", role: "electrician", userId: "u_field",
      body: { id: "vc_1", jobId: "job-1", status: "rejected" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown id", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "missing", jobId: "job-1", status: "rejected" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an invalid status value", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", jobId: "job-1", status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a PATCH without jobId", async () => {
    const res = await call({
      method: "PATCH", role: "boss", userId: "u_boss",
      body: { id: "vc_1", status: "rejected" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/observations?action=convert-to-variation (#280)", () => {
  beforeEach(() => {
    blob.set("observations.json", {
      observations: [
        {
          id: "ov1", jobId: "job-1", jobName: "Birdwood", type: "variation",
          title: "Client asked for extra downlights in lounge",
          description: "12 extra downlights",
          variationAskedBy: "Site foreman", variationLabourHours: 6,
          status: "new", priority: "high", source: "phil", requiresAction: true,
          photoUrls: [], linkedEvidenceId: "ev_1",
          areaId: null, areaName: null, stage: null, taskId: null, taskName: null,
          assignedToId: null, assignedToName: null,
          createdById: "u_field", createdByName: "Sparky", createdByRole: "electrician",
          convertedTo: null, convertedTargetId: null,
          createdAt: "2026-06-18T00:00:00Z", updatedAt: "2026-06-18T00:00:00Z",
        },
        {
          id: "on1", jobId: "job-1", type: "note", title: "Tidied up",
          status: "new", priority: "low", source: "phil", requiresAction: false,
          photoUrls: [], convertedTo: null, convertedTargetId: null,
          createdById: "u_field", createdByName: "Sparky",
          createdAt: "2026-06-18T00:00:00Z", updatedAt: "2026-06-18T00:00:00Z",
        },
      ],
    });
  });

  it("admin converts a variation-typed observation into a real claim + back-link + dual audit", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "ov1", valueCents: 84000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as {
      observation: Record<string, unknown>;
      variation: Record<string, unknown>;
    };
    // Back-links both ways.
    expect(body.observation.linkedVariationId).toBe(body.variation.id);
    expect(body.observation.convertedTo).toBe("variation");
    expect(body.observation.convertedTargetId).toBe(body.variation.id);
    expect(body.observation.status).toBe("converted");
    expect((body.variation.links as { observationId: string }).observationId).toBe("ov1");
    expect(body.variation.ref).toBe("VO-001");
    expect(body.variation.status).toBe("draft");
    expect(body.variation.scope).toBe("Client asked for extra downlights in lounge");
    expect(body.variation.valueCents).toBe(84000);
    // The field estimate folded into the description.
    expect(String(body.variation.description)).toContain("Asked by: Site foreman");
    // Evidence link carried over.
    expect((body.variation.links as { evidenceIds: string[] }).evidenceIds).toEqual(["ev_1"]);

    // Persisted to the per-job claims blob.
    const store = blob.get("jobs/job-1/variations.json") as { claims: { id: string }[] };
    expect(store.claims.map((c) => c.id)).toEqual([body.variation.id]);

    // Dual audit: variation.created + observation.converted_to_variation.
    const audit = collectAuditEntries(blob);
    expect(audit.find((e) => e.action === "variation.created")).toBeTruthy();
    expect(audit.find((e) => e.action === "observation.converted_to_variation")).toBeTruthy();
  });

  it("409s a second conversion attempt (double-convert guard)", async () => {
    const first = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "ov1" },
    });
    expect(first.statusCode).toBe(201);
    const second = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "ov1" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("400s a non-default type (note) without force=true", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "on1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("201s a non-default type (note) when force=true", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "on1", force: true },
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { variation: { status: string } }).variation.status).toBe("draft");
  });

  it("403s a field worker trying to convert", async () => {
    const res = await call({
      method: "POST", role: "electrician", userId: "u_field", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "ov1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown observation id", async () => {
    const res = await call({
      method: "POST", role: "boss", userId: "u_boss", via: "observations",
      query: { action: "convert-to-variation" }, body: { id: "missing" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("method gating", () => {
  it("405s an unknown method on /api/variations", async () => {
    const res = await call({ method: "DELETE", role: "boss", userId: "u_boss", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(405);
  });
});
