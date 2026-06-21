import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/dayworks.js — the real serverless handler against a
 * mocked Vercel Blob store and real HMAC sessions (#370). Mirrors
 * variations-api.test.ts / material-requests-api.test.ts.
 *
 * High-risk surface (money + signatures), so the mandatory invariants are
 * test-locked: a signed docket is immutable; amendments are new records; every
 * signature stamp is server-set; nothing writes to time-entries.
 *
 * Covers:
 *   - tier gating: 401 anon, 403 client, 403 field on an UNASSIGNED job, and
 *     field/LH create+sign on an ASSIGNED job; admin full; invoice is admin-only
 *   - create: DW-001, unsigned, self labour-line default, gap-safe sequencing
 *   - validation: description / hours / photos / materials / date
 *   - sign: unsigned → signed, server-stamped signature, no faked image, 409 on
 *     a non-unsigned docket
 *   - invoice: signed → invoiced (manual ref required), 409 from unsigned
 *   - immutability/amend: amend only on signed/invoiced, new back-linked record,
 *     original untouched bar `amended`
 *   - audit: daywork.created / signed / transitioned / amended verbs land
 *   - cross-job rollup: admin-only, aggregates + per-job summary + unsigned-aging
 *   - commercial-not-payroll: no time-entries write on any action
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const dayworksPath = requireFromHere.resolve("../../../api/dayworks.js");

let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
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
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_field", opts.role) },
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
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "leader", role: "leading-hand", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-1", name: "Birdwood", areaGroups: [] },
          { id: "job-2", name: "Other", areaGroups: [] },
          { id: "job-3", name: "Archived", areaGroups: [], archived: true },
        ],
      },
    ],
    ["jobs/job-1/dayworks.json", { dockets: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[dayworksPath];
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
  handler = requireFromHere(dayworksPath);
});

type AuditEntry = {
  action: string;
  actorId: string;
  jobId: string;
  targetType: string;
  metadata?: Record<string, unknown>;
};
function audits(): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const [k, v] of blob.entries()) {
    if (!k.startsWith("audit/")) continue;
    const list = (v as { entries?: AuditEntry[] }).entries;
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}
function dockets(jobId = "job-1"): Array<Record<string, unknown>> {
  return ((blob.get(`jobs/${jobId}/dayworks.json`) as { dockets?: [] })?.dockets || []) as Array<
    Record<string, unknown>
  >;
}
async function createOne(over: Record<string, unknown> = {}, role = "boss", userId = "u_boss") {
  const res = await call({
    method: "POST",
    role,
    userId,
    query: { jobId: "job-1" },
    body: { description: "Extra make-safe, East Gym", ...over },
  });
  return res;
}
async function signOne(id: string, role = "boss", userId = "u_boss", supervisorName = "Jane Builder") {
  return call({ method: "PATCH", role, userId, body: { id, jobId: "job-1", action: "sign", supervisorName } });
}

describe("tier gating", () => {
  it("401 for an anonymous caller", async () => {
    const res = await call({ method: "GET", role: "boss", anon: true, query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a client on a job they 'have'", async () => {
    const res = await call({ method: "GET", role: "client", userId: "u_client", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("403 for a field worker on a job they are NOT assigned to", async () => {
    const res = await call({ method: "POST", role: "electrician", userId: "u_field", query: { jobId: "job-2" }, body: { description: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("a field worker creates + signs on an ASSIGNED job", async () => {
    const created = await createOne({}, "electrician", "u_field");
    expect(created.statusCode).toBe(201);
    const id = (created.body as { docket: { id: string } }).docket.id;
    const signed = await signOne(id, "electrician", "u_field", "Site Super");
    expect(signed.statusCode).toBe(200);
    expect((signed.body as { docket: { status: string } }).docket.status).toBe("signed");
  });
});

describe("create", () => {
  it("admin → 201, DW-001, unsigned, defaults a self labour line", async () => {
    const res = await createOne();
    expect(res.statusCode).toBe(201);
    const d = (res.body as { docket: Record<string, unknown> }).docket;
    expect(d.ref).toBe("DW-001");
    expect(d.seq).toBe(1);
    expect(d.status).toBe("unsigned");
    expect(d.signature).toBeNull();
    expect(d.createdById).toBe("u_boss");
    expect((d.labourLines as unknown[]).length).toBe(1);
    expect((d.labourLines as Array<{ workerId: string }>)[0]!.workerId).toBe("u_boss");
  });

  it("mints sequential refs and is gap-safe (max(seq)+1, not length)", async () => {
    blob.set("jobs/job-1/dayworks.json", {
      dockets: [{ id: "dw_x", jobId: "job-1", ref: "DW-005", seq: 5, status: "signed", createdAt: "2026-06-01T00:00:00.000Z" }],
    });
    const res = await createOne();
    expect((res.body as { docket: { ref: string; seq: number } }).docket.ref).toBe("DW-006");
  });

  it("rejects an empty description, out-of-range hours, >10 photos, negative qty", async () => {
    expect((await createOne({ description: "   " })).statusCode).toBe(400);
    expect((await createOne({ labourLines: [{ workerName: "Sam", hours: 99 }] })).statusCode).toBe(400);
    expect((await createOne({ photoIds: Array.from({ length: 11 }, (_, i) => `p${i}`) })).statusCode).toBe(400);
    expect((await createOne({ materialLines: [{ description: "Cable", quantity: -1 }] })).statusCode).toBe(400);
  });

  it("defaults the date to today and accepts a supplied ISO date", async () => {
    const a = (await createOne()).body as { docket: { date: string } };
    expect(Number.isNaN(Date.parse(a.docket.date))).toBe(false);
    const b = (await createOne({ date: "2026-06-15T00:00:00.000Z" })).body as { docket: { date: string } };
    expect(b.docket.date).toBe("2026-06-15T00:00:00.000Z");
    expect((await createOne({ date: "not-a-date" })).statusCode).toBe(400);
  });
});

describe("sign", () => {
  it("unsigned → signed with a server-stamped signature and NO faked image", async () => {
    const id = (await createOne()).body as { docket: { id: string } };
    const res = await signOne(id.docket.id, "boss", "u_boss", "Jane Builder");
    expect(res.statusCode).toBe(200);
    const d = (res.body as { docket: Record<string, unknown> }).docket;
    expect(d.status).toBe("signed");
    const sig = d.signature as Record<string, unknown>;
    expect(sig.supervisorName).toBe("Jane Builder");
    expect(sig.imageUrl).toBeNull(); // drawn capture is the deferred follow-on
    expect(sig.imageSha256).toBeNull();
    expect(sig.capturedById).toBe("u_boss"); // server-set, not client-trusted
    expect(typeof sig.signedAt).toBe("string");
  });

  it("requires a supervisor name", async () => {
    const id = (await createOne()).body as { docket: { id: string } };
    const res = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id: id.docket.id, jobId: "job-1", action: "sign" } });
    expect(res.statusCode).toBe(400);
  });

  it("409 when signing a docket that is already signed (immutable)", async () => {
    const id = ((await createOne()).body as { docket: { id: string } }).docket.id;
    await signOne(id);
    const again = await signOne(id);
    expect(again.statusCode).toBe(409);
  });
});

describe("invoice (admin-tier, commercial)", () => {
  it("signed → invoiced with a manual ref; field cannot invoice", async () => {
    const id = ((await createOne()).body as { docket: { id: string } }).docket.id;
    await signOne(id);
    const field = await call({ method: "PATCH", role: "electrician", userId: "u_field", body: { id, jobId: "job-1", action: "invoice", invoiceRef: "INV-1" } });
    expect(field.statusCode).toBe(403);
    const noRef = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "invoice" } });
    expect(noRef.statusCode).toBe(400);
    const ok = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "invoice", invoiceRef: "INV-42" } });
    expect(ok.statusCode).toBe(200);
    const d = (ok.body as { docket: Record<string, unknown> }).docket;
    expect(d.status).toBe("invoiced");
    expect(d.invoiceRef).toBe("INV-42");
    expect(d.invoicedById).toBe("u_boss");
  });

  it("409 invoicing an unsigned docket (no skipping the signature)", async () => {
    const id = ((await createOne()).body as { docket: { id: string } }).docket.id;
    const res = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "invoice", invoiceRef: "INV-9" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("immutability / amend", () => {
  it("amends a signed docket into a NEW unsigned record; original is untouched bar `amended`", async () => {
    const id = ((await createOne({ description: "original work" })).body as { docket: { id: string } }).docket.id;
    await signOne(id);
    const res = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "amend" } });
    expect(res.statusCode).toBe(200);
    const amendment = (res.body as { docket: Record<string, unknown> }).docket;
    expect(amendment.status).toBe("unsigned");
    expect(amendment.amendmentOfId).toBe(id);
    expect(amendment.ref).toBe("DW-002");
    expect(amendment.signature).toBeNull();
    // the immutable original keeps its signed content + signature, just flagged
    const original = dockets().find((d) => d.id === id)!;
    expect(original.status).toBe("signed");
    expect(original.amended).toBe(true);
    expect((original.signature as Record<string, unknown>).supervisorName).toBe("Jane Builder");
    expect(original.description).toBe("original work");
  });

  it("409 amending an unsigned docket (edit it directly instead)", async () => {
    const id = ((await createOne()).body as { docket: { id: string } }).docket.id;
    const res = await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "amend" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("audit", () => {
  it("emits daywork.created / signed / transitioned / amended (verbs are allow-listed)", async () => {
    const id = ((await createOne()).body as { docket: { id: string } }).docket.id;
    await signOne(id);
    await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "invoice", invoiceRef: "INV-1" } });
    await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "amend" } });
    const verbs = audits().map((a) => a.action);
    expect(verbs).toContain("daywork.created");
    expect(verbs).toContain("daywork.signed");
    expect(verbs).toContain("daywork.transitioned");
    expect(verbs).toContain("daywork.amended");
    const inv = audits().find((a) => a.action === "daywork.transitioned");
    expect(inv?.metadata?.from).toBe("signed");
    expect(inv?.metadata?.to).toBe("invoiced");
    expect(audits().every((a) => a.targetType === "daywork")).toBe(true);
  });
});

describe("cross-job rollup", () => {
  it("is admin-only and aggregates dockets with a per-job summary + unsigned-aging", async () => {
    // job-1: one fresh unsigned; job-2: one OLD unsigned (aging) + one signed.
    blob.set("jobs/job-1/dayworks.json", {
      dockets: [{ id: "dw_a", jobId: "job-1", ref: "DW-001", seq: 1, status: "unsigned", createdAt: new Date().toISOString() }],
    });
    blob.set("jobs/job-2/dayworks.json", {
      dockets: [
        { id: "dw_b", jobId: "job-2", ref: "DW-001", seq: 1, status: "unsigned", createdAt: "2020-01-01T00:00:00.000Z" },
        { id: "dw_c", jobId: "job-2", ref: "DW-002", seq: 2, status: "signed", createdAt: "2020-01-01T00:00:00.000Z" },
      ],
    });
    const field = await call({ method: "GET", role: "electrician", userId: "u_field", query: {} });
    expect(field.statusCode).toBe(403); // no jobId → admin-tier only

    const res = await call({ method: "GET", role: "boss", userId: "u_boss", query: {} });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      dockets: unknown[];
      summary: { total: number; unsignedAging: number };
      byJob: Array<{ jobId: string; unsignedAging: number }>;
    };
    expect(body.dockets.length).toBe(3);
    expect(body.summary.total).toBe(3);
    expect(body.summary.unsignedAging).toBe(1); // the old job-2 unsigned
    // payment-risk job first
    expect(body.byJob[0]!.jobId).toBe("job-2");
    expect(body.byJob[0]!.unsignedAging).toBe(1);
    // archived job-3 is excluded
    expect(body.byJob.find((j) => j.jobId === "job-3")).toBeUndefined();
  });
});

describe("commercial, not payroll", () => {
  it("no daywork action ever writes a time-entries blob", async () => {
    const id = ((await createOne({ linkedTimeEntryIds: ["te_1"] })).body as { docket: { id: string } }).docket.id;
    await signOne(id);
    await call({ method: "PATCH", role: "boss", userId: "u_boss", body: { id, jobId: "job-1", action: "invoice", invoiceRef: "INV-1" } });
    const wroteTimeEntries = [...blob.keys()].some((k) => k.includes("/time-entries/"));
    expect(wroteTimeEntries).toBe(false);
  });
});
