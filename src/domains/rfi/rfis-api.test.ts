import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/rfis.js (#276) — real serverless handler vs a mocked
 * blob store + mocked email lib + real HMAC sessions. Covers the flag/auth gate,
 * raise + sequential refs, the open→sent→answered→closed lifecycle, the REAL
 * email send on "send" (and that status never claims sent without a send), and
 * the close-needs-answer-or-reason rule.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const emailPath = requireFromHere.resolve("../../../api/_lib/email.js");
const handlerPath = requireFromHere.resolve("../../../api/rfis.js");

let store: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let sendEmail: ReturnType<typeof vi.fn>;
let emailConfigured: boolean;

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
async function raise(over: Record<string, unknown> = {}) {
  return call({
    method: "POST",
    body: { subject: "Where does the panel go?", question: "Drawing A-101 is silent.", ...over },
  });
}
const rfiOf = (res: ReturnType<typeof createRes>) =>
  (res.body as { rfi: Record<string, unknown> }).rfi;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_RFI_REGISTER = "1";
  emailConfigured = true;
  sendEmail = vi.fn(async () => ({ id: "email_1" }));
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_field2", username: "offsite", role: "electrician", assignedJobIds: [] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, auditPath, emailPath, handlerPath])
    delete requireFromHere.cache[p];
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
  requireFromHere.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: {
      sendEmail: (...args: unknown[]) => sendEmail(...args),
      isEmailConfigured: () => emailConfigured,
      companyName: () => "Buhl Electrical",
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_RFI_REGISTER;
  delete process.env.FLAG_PHIL_SHARPENED;
});

describe("api/rfis — gate", () => {
  it("anonymous → 401", async () => {
    expect((await call({ method: "GET", anon: true })).statusCode).toBe(401);
  });
  it("flag OFF → 404", async () => {
    process.env.FLAG_RFI_REGISTER = "0";
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });
  it("a field worker (non-manager) → 403", async () => {
    expect((await call({ method: "GET", role: "electrician", userId: "u_field" })).statusCode).toBe(
      403
    );
  });
});

describe("api/rfis — field raise (phil_sharpened widening)", () => {
  const fieldRaise = (userId: string, over: Record<string, unknown> = {}) =>
    call({
      method: "POST",
      role: "electrician",
      userId,
      body: { subject: "Where does the panel go?", question: "Drawing A-101 is silent.", ...over },
    });

  it("flag OFF → an assigned field worker's POST raise 403s exactly as today", async () => {
    expect((await fieldRaise("u_field")).statusCode).toBe(403);
  });

  it("flag ON → an UNASSIGNED field worker still 403s", async () => {
    process.env.FLAG_PHIL_SHARPENED = "1";
    expect((await fieldRaise("u_field2")).statusCode).toBe(403);
  });

  it("flag ON → an assigned field worker raises: 201, real sequential ref, open, raisedBy the worker", async () => {
    process.env.FLAG_PHIL_SHARPENED = "1";
    const res = await fieldRaise("u_field", {
      askedOf: "dave@builder.example",
      areaId: "area-1",
      observationId: "obs_1",
    });
    expect(res.statusCode).toBe(201);
    const rfi = rfiOf(res);
    expect(rfi.ref).toBe("RFI-001");
    expect(rfi.status).toBe("open");
    expect(rfi.raisedById).toBe("u_field");
    expect(rfi.askedOf).toBe("dave@builder.example");
    expect(rfi.areaId).toBe("area-1");
    expect(rfi.observationId).toBe("obs_1");
    // Refs stay sequential across raisers.
    expect(rfiOf(await raise({ subject: "Admin follow-up" })).ref).toBe("RFI-002");
  });

  it("flag ON → raise is the ONLY widened door: GET / send / answer / close / PATCH stay 403", async () => {
    process.env.FLAG_PHIL_SHARPENED = "1";
    const id = String(rfiOf(await fieldRaise("u_field")).id);
    const field = { role: "electrician", userId: "u_field" };
    expect((await call({ method: "GET", ...field })).statusCode).toBe(403);
    expect(
      (await call({ method: "POST", query: { action: "send" }, body: { id }, ...field })).statusCode,
    ).toBe(403);
    expect(
      (await call({ method: "POST", query: { action: "answer" }, body: { id, answer: "x" }, ...field }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call({ method: "POST", query: { action: "close" }, body: { id, reason: "x" }, ...field }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call({ method: "PATCH", query: { id }, body: { subject: "edit" }, ...field })).statusCode,
    ).toBe(403);
  });

  it("flag ON → the admin path is unchanged", async () => {
    process.env.FLAG_PHIL_SHARPENED = "1";
    const res = await raise();
    expect(res.statusCode).toBe(201);
    expect(rfiOf(res).raisedById).toBe("u_boss");
  });
});

describe("api/rfis — raise + sequential refs", () => {
  it("assigns RFI-001, RFI-002 and lands open", async () => {
    const a = await raise();
    expect(a.statusCode).toBe(201);
    expect(rfiOf(a).ref).toBe("RFI-001");
    expect(rfiOf(a).status).toBe("open");
    const b = await raise({ subject: "Second" });
    expect(rfiOf(b).ref).toBe("RFI-002");
  });
  it("rejects a missing subject / question", async () => {
    expect((await raise({ subject: "" })).statusCode).toBe(400);
    expect((await raise({ question: "" })).statusCode).toBe(400);
  });
});

describe("api/rfis — send performs a real email and only then stamps sent", () => {
  it("sends to askedOf, sets sentAt, calls the email lib", async () => {
    const id = String(rfiOf(await raise({ askedOf: "pm@builder.example" })).id);
    const res = await call({ method: "POST", query: { action: "send" }, body: { id } });
    expect(res.statusCode).toBe(200);
    expect(rfiOf(res).status).toBe("sent");
    expect(rfiOf(res).sentAt).toBeTruthy();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0]![0] as { to: string; subject: string };
    expect(arg.to).toBe("pm@builder.example");
    expect(arg.subject).toContain("RFI-001");
  });
  it("won't send without a recipient email", async () => {
    const id = String(rfiOf(await raise()).id); // no askedOf
    expect(
      (await call({ method: "POST", query: { action: "send" }, body: { id } })).statusCode
    ).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("won't claim sent when email isn't configured (503, no status change)", async () => {
    emailConfigured = false;
    const id = String(rfiOf(await raise({ askedOf: "pm@builder.example" })).id);
    const res = await call({ method: "POST", query: { action: "send" }, body: { id } });
    expect(res.statusCode).toBe(503);
    const list = (await call({ method: "GET" })).body as { rfis: Array<{ status: string }> };
    expect(list.rfis[0]!.status).toBe("open"); // never flipped to sent
  });
});

describe("api/rfis — answer + close", () => {
  it("records an answer (→ answered) and requires answer text", async () => {
    const id = String(rfiOf(await raise()).id);
    expect(
      (await call({ method: "POST", query: { action: "answer" }, body: { id } })).statusCode
    ).toBe(400);
    const res = await call({
      method: "POST",
      query: { action: "answer" },
      body: { id, answer: "Panel goes in riser 2." },
    });
    expect(res.statusCode).toBe(200);
    expect(rfiOf(res).status).toBe("answered");
    expect(rfiOf(res).answer).toBe("Panel goes in riser 2.");
    expect(rfiOf(res).answeredBy).toBe("boss");
  });
  it("close needs an answer or a no-longer-required reason", async () => {
    const id = String(rfiOf(await raise()).id);
    expect(
      (await call({ method: "POST", query: { action: "close" }, body: { id } })).statusCode
    ).toBe(400);
    const res = await call({
      method: "POST",
      query: { action: "close" },
      body: { id, reason: "Resolved on site" },
    });
    expect(res.statusCode).toBe(200);
    expect(rfiOf(res).status).toBe("closed");
    expect(rfiOf(res).closedReason).toBe("Resolved on site");
  });
});

describe("api/rfis — edit + method guard", () => {
  it("edits an open RFI but not a sent one", async () => {
    const id = String(rfiOf(await raise({ askedOf: "pm@builder.example" })).id);
    const edit = await call({ method: "PATCH", query: { id }, body: { subject: "Reworded" } });
    expect(edit.statusCode).toBe(200);
    expect(rfiOf(edit).subject).toBe("Reworded");
    await call({ method: "POST", query: { action: "send" }, body: { id } });
    expect(
      (await call({ method: "PATCH", query: { id }, body: { subject: "Again" } })).statusCode
    ).toBe(409);
  });
  it("a wrong method → 405", async () => {
    expect((await call({ method: "PUT" })).statusCode).toBe(405);
  });
});
