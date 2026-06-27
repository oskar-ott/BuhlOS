import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/certificates.js (#231) — real serverless handler vs a
 * mocked blob store + Vercel blob put + real HMAC sessions. Covers the dark flag
 * gate, the admin-upload / crew-read split, reference + issue-date capture (with
 * date normalisation), and the method guard. Cache-injects @vercel/blob (the
 * createRequire path bypasses vi.mock).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/certificates.js");
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
function uploadCert(over: Record<string, unknown> = {}) {
  return call({
    method: "POST",
    body: {
      type: "certificate",
      title: "Electrical safety certificate",
      referenceNo: "CES-2026-014",
      issuedAt: "2026-06-20",
      dataUrl: PDF,
      mimeType: "application/pdf",
      ...over,
    },
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_CERTIFICATES_REGISTER = "1";
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
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
  delete process.env.FLAG_CERTIFICATES_REGISTER;
});

describe("api/certificates — gate", () => {
  it("anonymous → 401", async () => {
    expect((await call({ method: "GET", anon: true })).statusCode).toBe(401);
  });
  it("flag OFF → 404", async () => {
    process.env.FLAG_CERTIFICATES_REGISTER = "0";
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });
  it("a client → 403", async () => {
    expect((await call({ method: "GET", role: "client", userId: "u_client" })).statusCode).toBe(
      403
    );
  });
});

describe("api/certificates — upload (admin/manager only)", () => {
  it("a field worker cannot upload → 403", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      body: { type: "certificate", title: "x", dataUrl: PDF },
    });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a bad type / missing title / missing file", async () => {
    expect((await uploadCert({ type: "nope" })).statusCode).toBe(400);
    expect((await uploadCert({ title: "" })).statusCode).toBe(400);
    expect((await uploadCert({ dataUrl: undefined })).statusCode).toBe(400);
  });
  it("admin upload → 201 with reference + issue date, current", async () => {
    const res = await uploadCert();
    expect(res.statusCode).toBe(201);
    const c = (res.body as { certificate: Record<string, unknown> }).certificate;
    expect(c.type).toBe("certificate");
    expect(c.referenceNo).toBe("CES-2026-014");
    expect(c.issuedAt).toBe("2026-06-20");
    expect(c.status).toBe("current");
    expect(String(c.url)).toContain("blob.test");
  });
  it("normalises a junk issue date to empty (undated)", async () => {
    const res = await uploadCert({ issuedAt: "last tuesday" });
    const c = (res.body as { certificate: { issuedAt: string } }).certificate;
    expect(c.issuedAt).toBe("");
  });
});

describe("api/certificates — read", () => {
  it("lists current certificates for admin and assigned crew", async () => {
    await uploadCert({ title: "Cert A" });
    const admin = await call({ method: "GET" });
    expect(admin.statusCode).toBe(200);
    expect((admin.body as { certificates: unknown[] }).certificates).toHaveLength(1);

    const field = await call({ method: "GET", role: "electrician", userId: "u_field" });
    expect(field.statusCode).toBe(200);
    expect((field.body as { certificates: unknown[] }).certificates).toHaveLength(1);
  });
  it("a wrong method → 405", async () => {
    expect((await call({ method: "PUT" })).statusCode).toBe(405);
  });
});
