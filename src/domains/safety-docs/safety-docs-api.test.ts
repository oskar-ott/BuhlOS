import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/safety-docs.js (#219) — the real serverless handler
 * against a mocked blob store + Vercel blob put + real HMAC sessions. Covers the
 * dark flag gate, the admin/crew auth split, upload + versioning, the
 * SELF-ATTRIBUTED acknowledgement (identity from session, never the body),
 * idempotency, the office rollup, and that a new version resets acknowledgement.
 */

// NB: the handler is loaded via createRequire (native CJS), which bypasses
// vi.mock — so @vercel/blob is mocked by cache injection in beforeEach, the same
// way ./_lib/blob is (the material-requests-api.test.ts pattern).
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/safety-docs.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");

const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;

let store: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: { jobId: "job-1", ...(opts.query || {}) },
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}
async function uploadSwms(title = "Working at Heights", supersedesId?: string) {
  return call({
    method: "POST",
    body: { type: "swms", title, dataUrl: PDF, mimeType: "application/pdf", supersedesId },
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_SAFETY_DOCS = "1";
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_field2", username: "mate", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, auditPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { put: vi.fn(async (path: string) => ({ url: "https://blob.test/" + path })) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_SAFETY_DOCS;
});

describe("api/safety-docs — gate", () => {
  it("anonymous → 401", async () => {
    const res = await call({ method: "GET", anon: true });
    expect(res.statusCode).toBe(401);
  });
  it("flag OFF → 404 (invisible)", async () => {
    process.env.FLAG_SAFETY_DOCS = "0";
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(404);
  });
  it("a client → 403 (never sees job safety docs)", async () => {
    const res = await call({ method: "GET", role: "client", userId: "u_client" });
    expect(res.statusCode).toBe(403);
  });
});

describe("api/safety-docs — upload (admin/manager only)", () => {
  it("a field worker cannot upload → 403", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      body: { type: "swms", title: "x", dataUrl: PDF },
    });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a bad type / missing title / missing file", async () => {
    expect(
      (await call({ method: "POST", body: { type: "nope", title: "x", dataUrl: PDF } })).statusCode
    ).toBe(400);
    expect((await call({ method: "POST", body: { type: "swms", dataUrl: PDF } })).statusCode).toBe(
      400
    );
    expect((await call({ method: "POST", body: { type: "swms", title: "x" } })).statusCode).toBe(
      400
    );
  });
  it("admin upload → 201, version 1, current", async () => {
    const res = await uploadSwms();
    expect(res.statusCode).toBe(201);
    const doc = (
      res.body as { document: { version: number; status: string; type: string; url: string } }
    ).document;
    expect(doc.version).toBe(1);
    expect(doc.status).toBe("current");
    expect(doc.type).toBe("swms");
    expect(doc.url).toContain("blob.test");
  });
});

describe("api/safety-docs — acknowledge is server-attributed + idempotent", () => {
  it("uses the session identity, NOT a body-supplied userId", async () => {
    const docId = (await uploadSwms()).body as { document: { id: string } };
    const id = docId.document.id;
    const res = await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: id, userId: "u_hacker", userName: "Mallory" }, // spoofed identity ignored
    });
    expect(res.statusCode).toBe(201);
    const ack = (res.body as { ack: { userId: string; userName: string } }).ack;
    expect(ack.userId).toBe("u_field");
    expect(ack.userName).toBe("sparky");
  });
  it("a second acknowledgement is idempotent (200 already)", async () => {
    const id = ((await uploadSwms()).body as { document: { id: string } }).document.id;
    const first = await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: id },
    });
    expect(first.statusCode).toBe(201);
    const second = await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: id },
    });
    expect(second.statusCode).toBe(200);
    expect((second.body as { already: boolean }).already).toBe(true);
  });
  it("acknowledging an unknown doc → 404", async () => {
    const res = await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("api/safety-docs — rollup + field view", () => {
  it("admin sees acknowledged vs outstanding across assigned crew", async () => {
    const id = ((await uploadSwms()).body as { document: { id: string } }).document.id;
    await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: id },
    });

    const admin = await call({ method: "GET" });
    expect(admin.statusCode).toBe(200);
    const rollup = (
      admin.body as {
        rollup: Array<{
          acknowledged: Array<{ userId: string }>;
          outstanding: Array<{ userId: string }>;
        }>;
      }
    ).rollup;
    expect(rollup).toHaveLength(1);
    expect(rollup[0]!.acknowledged.map((a) => a.userId)).toEqual(["u_field"]);
    expect(rollup[0]!.outstanding.map((o) => o.userId)).toEqual(["u_field2"]);

    const field = await call({ method: "GET", role: "electrician", userId: "u_field" });
    expect((field.body as { acknowledgedDocIds: string[] }).acknowledgedDocIds).toEqual([id]);
  });
});

describe("api/safety-docs — a new version resets acknowledgement", () => {
  it("supersedes the prior, bumps the version, and drops the old ack from current", async () => {
    const v1 = ((await uploadSwms("Heights v1")).body as { document: { id: string } }).document.id;
    await call({
      method: "POST",
      query: { action: "acknowledge" },
      role: "electrician",
      userId: "u_field",
      body: { docId: v1 },
    });

    const v2res = await uploadSwms("Heights v2", v1);
    expect(v2res.statusCode).toBe(201);
    const v2 = (v2res.body as { document: { version: number; supersedesId: string } }).document;
    expect(v2.version).toBe(2);
    expect(v2.supersedesId).toBe(v1);

    // only the current (v2) doc is listed, and u_field has NOT acknowledged it
    const field = await call({ method: "GET", role: "electrician", userId: "u_field" });
    const fieldBody = field.body as {
      documents: Array<{ version: number }>;
      acknowledgedDocIds: string[];
    };
    expect(fieldBody.documents).toHaveLength(1);
    expect(fieldBody.documents[0]!.version).toBe(2);
    expect(fieldBody.acknowledgedDocIds).toEqual([]); // the v1 ack does not carry to v2
  });
});

describe("api/safety-docs — method guard", () => {
  it("PUT → 405", async () => {
    expect((await call({ method: "PUT" })).statusCode).toBe(405);
  });
});
