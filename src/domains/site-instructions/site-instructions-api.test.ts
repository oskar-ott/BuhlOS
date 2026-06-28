import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteInstructionSchema } from "./schema";

/**
 * Integration tests for api/site-instructions.js — the real serverless handler,
 * exercised against a mocked Vercel Blob store and real HMAC sessions (the
 * observations-api.test.ts pattern). Covers the flag gate, the admin/manager
 * permission split, record + ref numbering, the acknowledge/close state
 * machine, post-ack text immutability, and that the audit append accepts the
 * new instruction.* verbs (auditLogIds populated end-to-end).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const siPath = requireFromHere.resolve("../../../api/site-instructions.js");

let blob: Map<string, unknown>;
let flagEnabled: boolean;

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
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role) },
  };
  await handler(req, res);
  return res;
}

const VALID = {
  instructedBy: { name: "Bob Builder", contactId: "c_1", email: "bob@site.test" },
  channel: "phone",
  instructionText: "Move the GPO in unit 4 kitchen to the east wall.",
  dateReceived: "2026-06-12",
};

async function record(extra: Record<string, unknown> = {}) {
  return call({
    method: "POST",
    role: "admin",
    userId: "u_admin",
    query: { jobId: "job-1" },
    body: { ...VALID, ...extra },
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  flagEnabled = true;
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
          { id: "u_mgr", username: "lh", role: "leading_hand", assignedJobIds: ["job-1"], managedJobIds: ["job-1"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Birdwood", managingLeadingHandId: "u_mgr" }] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[siPath];
  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[flagsPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[flagsPath] = {
    id: flagsPath,
    filename: flagsPath,
    loaded: true,
    exports: { isFlagEnabled: vi.fn(async () => flagEnabled) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(siPath);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/site-instructions", () => {
  it("404s when the flag is off", async () => {
    flagEnabled = false;
    const res = await call({ method: "GET", role: "admin", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(404);
  });

  it("admin reads the (empty) register", async () => {
    const res = await call({ method: "GET", role: "admin", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ instructions: [] });
  });

  it("the managing leading hand may read", async () => {
    const res = await call({ method: "GET", role: "leading_hand", userId: "u_mgr", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
  });

  it("a field worker who doesn't manage the job is forbidden", async () => {
    const res = await call({ method: "GET", role: "electrician", userId: "u_field", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("requires a jobId", async () => {
    const res = await call({ method: "GET", role: "admin", query: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/site-instructions (record)", () => {
  it("admin records a valid instruction → 201, SI-001, status recorded, audit written", async () => {
    const res = await record();
    expect(res.statusCode).toBe(201);
    const si = (res.body as { instruction: unknown }).instruction;
    expect(SiteInstructionSchema.safeParse(si).success).toBe(true);
    const parsed = SiteInstructionSchema.parse(si);
    expect(parsed.ref).toBe("SI-001");
    expect(parsed.status).toBe("recorded");
    expect(parsed.recordedBy).toBe("boss");
    expect(parsed.instructedBy.name).toBe("Bob Builder");
    expect(parsed.emailSentAt).toBeNull();
    // The audit append accepted instruction.created (the 3-copy sync works).
    expect(parsed.auditLogIds.length).toBe(1);
  });

  it("numbers refs sequentially, never reusing", async () => {
    await record();
    const second = await record({ instructionText: "Second instruction." });
    expect((second.body as { instruction: { ref: string } }).instruction.ref).toBe("SI-002");
  });

  it("a managing LH cannot write (read-only)", async () => {
    const res = await call({
      method: "POST",
      role: "leading_hand",
      userId: "u_mgr",
      query: { jobId: "job-1" },
      body: VALID,
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects bad input (missing name / bad channel / no date / empty text / overlong)", async () => {
    expect((await record({ instructedBy: { name: "", contactId: null, email: null } })).statusCode).toBe(400);
    expect((await record({ channel: "carrier-pigeon" })).statusCode).toBe(400);
    expect((await record({ dateReceived: "nope" })).statusCode).toBe(400);
    expect((await record({ instructionText: "   " })).statusCode).toBe(400);
    expect((await record({ instructionText: "x".repeat(2001) })).statusCode).toBe(400);
  });
});

describe("acknowledge / close state machine", () => {
  async function recordedId(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await record(extra);
    return (res.body as { instruction: { id: string } }).instruction.id;
  }

  it("acknowledge moves recorded → acknowledged and records who/how, not a send claim", async () => {
    const id = await recordedId();
    const res = await call({
      method: "POST",
      role: "admin",
      query: { jobId: "job-1", action: "acknowledge" },
      body: { id, channel: "email" },
    });
    expect(res.statusCode).toBe(200);
    const si = (res.body as { instruction: { status: string; acknowledgedAt: string; acknowledgementChannel: string; emailSentAt: null } }).instruction;
    expect(si.status).toBe("acknowledged");
    expect(si.acknowledgedAt).toBeTruthy();
    expect(si.acknowledgementChannel).toBe("email");
    expect(si.emailSentAt).toBeNull(); // honesty: recorded ≠ sent
  });

  it("acknowledging an already-acknowledged instruction is a 409", async () => {
    const id = await recordedId();
    await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "acknowledge" }, body: { id, channel: "phone" } });
    const again = await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "acknowledge" }, body: { id, channel: "phone" } });
    expect(again.statusCode).toBe(409);
  });

  it("the instruction text is frozen once acknowledged (PATCH text → 409)", async () => {
    const id = await recordedId();
    await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "acknowledge" }, body: { id, channel: "phone" } });
    const patch = await call({ method: "PATCH", role: "admin", query: { jobId: "job-1" }, body: { id, instructionText: "changed after ack" } });
    expect(patch.statusCode).toBe(409);
  });

  it("flag + link stay editable after acknowledge (raise an RFI on a confirmed instruction)", async () => {
    const id = await recordedId();
    await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "acknowledge" }, body: { id, channel: "phone" } });
    const patch = await call({ method: "PATCH", role: "admin", query: { jobId: "job-1" }, body: { id, costTimeImplication: true, linkedRfiId: "rfi_99" } });
    expect(patch.statusCode).toBe(200);
    const si = (patch.body as { instruction: { costTimeImplication: boolean; linkedRfiId: string } }).instruction;
    expect(si.costTimeImplication).toBe(true);
    expect(si.linkedRfiId).toBe("rfi_99");
  });

  it("close moves to closed and refuses to close twice", async () => {
    const id = await recordedId();
    const closed = await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "close" }, body: { id, reason: "verbal only, no cost" } });
    expect(closed.statusCode).toBe(200);
    expect((closed.body as { instruction: { status: string } }).instruction.status).toBe("closed");
    const again = await call({ method: "POST", role: "admin", query: { jobId: "job-1", action: "close" }, body: { id } });
    expect(again.statusCode).toBe(409);
  });
});
