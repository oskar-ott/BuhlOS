import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #580 — api/quotes.js labour-line money-input validation. Pre-fix,
 * handleLabourAdd Number()-coerced without checking and handleLabourUpdate
 * blind-copied the four numeric fields from the body, so negative/uncapped/NaN
 * values persisted on the line. Real-handler harness (in-memory Blob + real HMAC
 * sessions), same shape as quotes-duplicate-api.test.ts, plus a direct unit test
 * of the exported validator.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const quotesPath = requireFromHere.resolve("../../../api/quotes.js");

const LABOUR_KEY = "quotes/q1/labour-estimate.json";
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let quotes: ((req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>) & {
  validateLabourNumerics: (body: Record<string, unknown>) => { ok: boolean; error?: string; values?: Record<string, number | null> };
};

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(method: string, body: Record<string, unknown>, query: Record<string, string> = {}) {
  const res = createRes();
  await quotes(
    { method, body, query: { action: "labour", id: "q1", ...query }, headers: { cookie: cookieFor("u_admin", "admin") } },
    res,
  );
  return res;
}
const labourLines = () => (blob.get(LABOUR_KEY) as { lines?: Array<Record<string, unknown>> } | undefined)?.lines ?? [];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    ["users.json", { users: [{ id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] }] }],
    // a seeded line for the update tests
    [LABOUR_KEY, { lines: [{ id: "qlab_1", quoteId: "q1", task: "Rough-in", estimatedHours: 10, crewSize: 2, hourlyRate: 60, riskFactor: 1.1 }] }],
  ]);
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[quotesPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  quotes = requireFromHere(quotesPath);
});

describe("POST /api/quotes?action=labour (add) — input validation (#580)", () => {
  it("rejects a negative hourlyRate (400, nothing appended)", async () => {
    const res = await call("POST", { task: "Pull cable", hourlyRate: -5 });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/hourlyRate/);
    expect(labourLines()).toHaveLength(1); // only the seeded line; no append
  });
  it("rejects a non-numeric estimatedHours (\"abc\" → NaN)", async () => {
    expect((await call("POST", { task: "x", estimatedHours: "abc" })).statusCode).toBe(400);
  });
  it("rejects an uncapped riskFactor (2000 > 1000)", async () => {
    expect((await call("POST", { task: "x", riskFactor: 2000 })).statusCode).toBe(400);
  });
  it("accepts valid inputs and stores COERCED numbers (string → number)", async () => {
    const res = await call("POST", { task: "Install GPO", estimatedHours: "8", crewSize: 1, hourlyRate: "72.5", riskFactor: 1.2 });
    expect(res.statusCode).toBe(201);
    const line = (res.body as { line: Record<string, unknown> }).line;
    expect(line.estimatedHours).toBe(8); // number, not "8"
    expect(line.hourlyRate).toBe(72.5);
    expect(line.riskFactor).toBe(1.2);
  });
  it("allows an explicit null hourlyRate (= use the shared cost rate)", async () => {
    const res = await call("POST", { task: "x", hourlyRate: null });
    expect(res.statusCode).toBe(201);
    expect((res.body as { line: { hourlyRate: unknown } }).line.hourlyRate).toBeNull();
  });
});

describe("PATCH /api/quotes?action=labour (update) — input validation (#580)", () => {
  it("rejects a negative estimatedHours and leaves the stored line unchanged", async () => {
    const res = await call("PATCH", { estimatedHours: -3 }, { lineId: "qlab_1" });
    expect(res.statusCode).toBe(400);
    expect(labourLines()[0]!.estimatedHours).toBe(10); // not overwritten
  });
  it("coerces a string update to a number on store (no garbage persists)", async () => {
    const res = await call("PATCH", { estimatedHours: "12", riskFactor: "1.5" }, { lineId: "qlab_1" });
    expect(res.statusCode).toBe(200);
    expect(labourLines()[0]!.estimatedHours).toBe(12); // number, not "12"
    expect(labourLines()[0]!.riskFactor).toBe(1.5);
  });
});

describe("validateLabourNumerics (pure, exported)", () => {
  const ok = (b: Record<string, unknown>) => quotes.validateLabourNumerics(b);
  it("rejects negative, NaN, Infinity and over-cap; accepts valid + null hourlyRate", () => {
    expect(ok({ hourlyRate: -1 }).ok).toBe(false);
    expect(ok({ estimatedHours: "abc" }).ok).toBe(false);
    expect(ok({ riskFactor: Infinity }).ok).toBe(false);
    expect(ok({ crewSize: 1001 }).ok).toBe(false);
    expect(ok({ estimatedHours: "8", hourlyRate: null }).values).toEqual({ estimatedHours: 8, hourlyRate: null });
    expect(ok({}).values).toEqual({}); // absent fields → nothing to validate
  });
});
