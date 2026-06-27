import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #342 — GET /api/utilisation. Admin-tier only; per-worker utilisation over the
 * trailing weeks against 7.6h × Mon–Fri, + a crew capacity roll-up. Walks the
 * per-user time-entry blobs via the @vercel/blob list + fetch mock. Entries are
 * dated relative to "today" (the endpoint uses real Date) via the same mondayOf.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const utilLibPath = requireFromHere.resolve("../../../api/_lib/utilisation.js");
const handlerPath = requireFromHere.resolve("../../../api/utilisation.js");
const { mondayOf } = requireFromHere(utilLibPath) as { mondayOf: (d: string) => string };

const THIS_MONDAY = mondayOf(new Date().toISOString().slice(0, 10));

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200, body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { role: string; userId?: string; query?: Record<string, string> }): Promise<Res> {
  const res = createRes();
  await handler({ method: "GET", query: opts.query || {}, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) }, body: undefined }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "admin", createdAt: "2020-01-01T00:00:00Z" },
      { id: "u_field", username: "Sparky", role: "electrician", createdAt: "2020-01-01T00:00:00Z" },
      { id: "u_lh", username: "Lead", role: "leadingHand", createdAt: "2020-01-01T00:00:00Z" },
    ],
  });
  // Sparky logged a full standard week (38h approved) this week.
  blob.set(`users/u_field/time-entries/${THIS_MONDAY}.json`, { userId: "u_field", date: THIS_MONDAY, status: "approved", totalHours: 38, allocations: [{ jobId: "job-a", hours: 38 }] });
  // The LH logged half a week, submitted not yet approved.
  blob.set(`users/u_lh/time-entries/${THIS_MONDAY}.json`, { userId: "u_lh", date: THIS_MONDAY, status: "submitted", totalHours: 19, allocations: [{ jobId: "job-a", hours: 19 }] });

  for (const p of [authPath, handlerPath, utilLibPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fb: unknown) => (blob.has(key) ? clone(blob.get(key)) : fb)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath, filename: vercelBlobPath, loaded: true,
    exports: {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...blob.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(async () => ({})),
    },
  } as NodeJS.Module;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
    if (!blob.has(key)) return { ok: false, json: async () => null };
    return { ok: true, json: async () => clone(blob.get(key)) };
  }));

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/utilisation (#342)", () => {
  it("403s a leading hand and a field worker", async () => {
    expect((await call({ role: "leadingHand", userId: "u_lh" })).statusCode).toBe(403);
    expect((await call({ role: "electrician", userId: "u_field" })).statusCode).toBe(403);
  });

  it("returns per-worker utilisation against 38h and a crew roll-up", async () => {
    const res = await call({ role: "admin", query: { weeks: "2" } });
    expect(res.statusCode).toBe(200);
    const b = res.body as {
      weeks: string[];
      workers: Array<{ userId: string; weeks: Array<{ weekStart: string; pct: number | null; approvedHours: number; submittedHours: number }> }>;
      crew: { expectedHours: number; approvedHours: number; submittedHours: number; spareHours: number; workers: number };
    };
    expect(b.weeks).toContain(THIS_MONDAY);
    // tracked workers only (admin excluded); Sparky + Lead.
    const sparky = b.workers.find((w) => w.userId === "u_field")!;
    const thisWeek = sparky.weeks.find((w) => w.weekStart === THIS_MONDAY)!;
    expect(thisWeek.approvedHours).toBe(38);
    expect(thisWeek.pct).toBe(100); // 38 / 38
    const lead = b.workers.find((w) => w.userId === "u_lh")!;
    expect(lead.weeks.find((w) => w.weekStart === THIS_MONDAY)!.pct).toBe(50); // 19 submitted / 38
    // crew this week: 2 tracked workers × 38 expected; 38 approved + 19 submitted; spare 76-57=19.
    expect(b.crew.workers).toBe(2);
    expect(b.crew.expectedHours).toBe(76);
    expect(b.crew.spareHours).toBe(19);
  });
});
