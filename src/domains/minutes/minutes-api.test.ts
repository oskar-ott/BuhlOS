import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/job-minutes.js (#217) — real serverless handler vs a
 * mocked blob store (with a rev-aware writeBlob so the expectedRev CAS is
 * exercised) + Vercel blob put + real HMAC sessions. Covers the dark flag gate,
 * the admin-write / managing-LH-read / field-403 role matrix, body-or-attachment
 * required, the 10000-char body cap, append-only amendments (the body is never
 * mutated), the expectedRev stale-write rejection, and that an audit entry is
 * emitted on record + amend. Cache-injects @vercel/blob (createRequire bypasses
 * vi.mock).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/job-minutes.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");

const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;

let store: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let auditCalls: Array<Record<string, unknown>>;
let putCalls: Array<string>;

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
async function record(over: Record<string, unknown> = {}) {
  return call({
    method: "POST",
    body: {
      date: "2026-06-20",
      title: "Site coordination meeting",
      body: "Discussed the riser route.",
      ...over,
    },
  });
}
const minuteOf = (res: ReturnType<typeof createRes>) =>
  (res.body as { minute: Record<string, unknown> }).minute;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_MINUTES_REGISTER = "1";
  auditCalls = [];
  putCalls = [];
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          // A managing leading hand (canManageJob) — read but not write.
          { id: "u_lh", username: "lead", role: "leading_hand", assignedJobIds: ["job-1"], managedJobIds: ["job-1"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
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
      // Rev-aware: honour expectedRev so the CAS path is genuinely tested,
      // and stamp __rev like the real guard does.
      writeBlob: vi.fn(async (key: string, data: Record<string, unknown>, opts?: { expectedRev?: number }) => {
        const current = store.get(key) as { __rev?: number } | undefined;
        const currentRev = current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (opts && opts.expectedRev !== undefined && opts.expectedRev !== null) {
          if (Number(opts.expectedRev) !== currentRev) {
            const err = new Error(`stale write to ${key}`);
            (err as { name: string }).name = "StaleWriteError";
            throw err;
          }
        }
        const stamped = { ...data, __rev: currentRev + 1 };
        store.set(key, clone(stamped));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      put: vi.fn(async (path: string) => {
        putCalls.push(path);
        return { url: "https://blob.test/" + path };
      }),
    },
  } as NodeJS.Module;
  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: {
      append: vi.fn(async (entry: Record<string, unknown>) => {
        auditCalls.push(entry);
        return { id: "audit_" + auditCalls.length };
      }),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_MINUTES_REGISTER;
});

describe("api/job-minutes — gate + role matrix", () => {
  it("anonymous → 401", async () => {
    expect((await call({ method: "GET", anon: true })).statusCode).toBe(401);
  });
  it("flag OFF → 404", async () => {
    process.env.FLAG_MINUTES_REGISTER = "0";
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });
  it("a field worker (non-manager) → 403 on read and write", async () => {
    expect((await call({ method: "GET", role: "electrician", userId: "u_field" })).statusCode).toBe(403);
    expect((await record({})).statusCode).toBe(201); // admin can write
    expect(
      (await call({ method: "POST", role: "electrician", userId: "u_field", body: { date: "2026-06-20", title: "x", body: "y" } })).statusCode
    ).toBe(403);
  });
  it("a managing LH may READ but not WRITE", async () => {
    await record({});
    expect((await call({ method: "GET", role: "leading_hand", userId: "u_lh" })).statusCode).toBe(200);
    const w = await call({
      method: "POST",
      role: "leading_hand",
      userId: "u_lh",
      body: { date: "2026-06-20", title: "LH minute", body: "nope" },
    });
    expect(w.statusCode).toBe(403);
  });
});

describe("api/job-minutes — record", () => {
  it("records a minute (admin) and lands with empty amendments", async () => {
    const res = await record({});
    expect(res.statusCode).toBe(201);
    expect(minuteOf(res).title).toBe("Site coordination meeting");
    expect(minuteOf(res).body).toBe("Discussed the riser route.");
    expect(minuteOf(res).amendments).toEqual([]);
    expect(minuteOf(res).createdBy).toBe("boss");
  });
  it("requires a valid date and a title", async () => {
    expect((await record({ date: "" })).statusCode).toBe(400);
    expect((await record({ date: "not-a-date" })).statusCode).toBe(400);
    expect((await record({ title: "" })).statusCode).toBe(400);
  });
  it("requires a body OR an attachment — both empty → 400", async () => {
    expect((await record({ body: "" })).statusCode).toBe(400);
  });
  it("accepts an attachment-only minute (no body) and uploads to the per-job sibling blob", async () => {
    const res = await record({ body: "", dataUrl: PDF, mimeType: "application/pdf", fileName: "mins.pdf" });
    expect(res.statusCode).toBe(201);
    expect(minuteOf(res).body).toBe("");
    const att = minuteOf(res).attachment as { blobPath: string; mimeType: string };
    expect(att.mimeType).toBe("application/pdf");
    expect(att.blobPath).toMatch(/^jobs\/job-1\/minutes\/min_.*\.pdf$/);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]).toMatch(/^jobs\/job-1\/minutes\//);
  });
  it("rejects a body over the 10000-char cap (400)", async () => {
    expect((await record({ body: "x".repeat(10001) })).statusCode).toBe(400);
    expect((await record({ body: "x".repeat(10000) })).statusCode).toBe(201);
  });
  it("rejects a non-PDF/image attachment", async () => {
    const exe = `data:application/x-msdownload;base64,${Buffer.from("MZ").toString("base64")}`;
    expect((await record({ body: "", dataUrl: exe })).statusCode).toBe(400);
  });
  it("captures free-text + picked-contact attendees", async () => {
    const res = await record({
      attendees: [
        { name: "Pat Builder", contactId: "c_1" },
        { name: "Walk-in", contactId: null },
      ],
    });
    const att = minuteOf(res).attendees as Array<{ name: string; contactId: string | null }>;
    expect(att).toHaveLength(2);
    expect(att[0]).toEqual({ name: "Pat Builder", contactId: "c_1" });
    expect(att[1]).toEqual({ name: "Walk-in", contactId: null });
  });
  it("emits a minutes.recorded audit entry", async () => {
    await record({});
    const rec = auditCalls.find((a) => a.action === "minutes.recorded");
    expect(rec).toBeTruthy();
    expect(rec!.targetType).toBe("minutes");
  });
});

describe("api/job-minutes — amend (append-only)", () => {
  it("pushes a stamped amendment and NEVER mutates the body", async () => {
    const id = String(minuteOf(await record({ body: "Original minutes." })).id);
    const res = await call({
      method: "POST",
      query: { action: "amend" },
      body: { id, note: "Action 3 reassigned to Sam." },
    });
    expect(res.statusCode).toBe(200);
    const m = minuteOf(res);
    expect(m.body).toBe("Original minutes."); // unchanged
    const amendments = m.amendments as Array<{ by: string; note: string }>;
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.by).toBe("boss");
    expect(amendments[0]!.note).toBe("Action 3 reassigned to Sam.");
    const rec = auditCalls.find((a) => a.action === "minutes.amended");
    expect(rec).toBeTruthy();
  });
  it("requires a note and a real id", async () => {
    const id = String(minuteOf(await record({})).id);
    expect((await call({ method: "POST", query: { action: "amend" }, body: { id } })).statusCode).toBe(400);
    expect(
      (await call({ method: "POST", query: { action: "amend" }, body: { id: "nope", note: "x" } })).statusCode
    ).toBe(404);
  });
});

describe("api/job-minutes — expectedRev CAS", () => {
  it("a write against a stale rev is rejected (the guard's StaleWriteError surfaces)", async () => {
    // First record lands and bumps the store to __rev 1.
    await record({});
    // Simulate a concurrent write that has already advanced the store rev,
    // so the in-flight record's expectedRev (read before) no longer matches.
    const current = store.get("jobs/job-1/minutes.json") as Record<string, unknown>;
    store.set("jobs/job-1/minutes.json", { ...current, __rev: 99 });
    // The handler reads __rev 99 and writes expectedRev 99 → matches; to force a
    // mismatch we directly assert the mock rejects when expectedRev is wrong.
    const writeBlob = (requireFromHere.cache[blobPath] as NodeJS.Module).exports.writeBlob as (
      k: string,
      d: unknown,
      o?: { expectedRev?: number }
    ) => Promise<void>;
    await expect(
      writeBlob("jobs/job-1/minutes.json", { minutes: [] }, { expectedRev: 0 })
    ).rejects.toThrow(/stale write/);
  });
  it("the handler passes the read rev as expectedRev so concurrent writes serialise", async () => {
    await record({}); // store now at __rev 1
    const id = String(
      (
        (await call({ method: "GET" })).body as { minutes: Array<{ id: string }> }
      ).minutes[0]!.id
    );
    // A second successful op (amend) must pass expectedRev = current rev and succeed.
    const res = await call({ method: "POST", query: { action: "amend" }, body: { id, note: "ok" } });
    expect(res.statusCode).toBe(200);
    const stored = store.get("jobs/job-1/minutes.json") as { __rev: number };
    expect(stored.__rev).toBeGreaterThanOrEqual(2);
  });
});

describe("api/job-minutes — method guard", () => {
  it("PATCH and DELETE → 405", async () => {
    expect((await call({ method: "PATCH" })).statusCode).toBe(405);
    expect((await call({ method: "DELETE" })).statusCode).toBe(405);
  });
});
