import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #327 — GET /api/job-profitability. Admin-tier only; approved hours costed at
 * the EFFECTIVE-DATED cost rate (#304), non-approved excluded, unrated workers
 * named (never a silent 0), materials labelled a proxy. Walks the per-user
 * time-entry blobs via the @vercel/blob list + global fetch mock (same harness
 * the asset/tags walks use).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const costRatesPath = requireFromHere.resolve("../../../api/_lib/cost-rates.js");
const profitPath = requireFromHere.resolve("../../../api/_lib/job-profitability.js");
const handlerPath = requireFromHere.resolve("../../../api/job-profitability.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

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

async function call(opts: { role: string; userId?: string; query?: Record<string, string> }): Promise<Res> {
  const res = createRes();
  await handler(
    { method: "GET", query: opts.query || {}, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) }, body: undefined },
    res,
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active", contractValue: 120000 }, { id: "job-novalue", name: "No Value", status: "active" }] });
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "admin" },
      { id: "u_field", username: "Sparky", role: "electrician" },
      { id: "u_field2", username: "Mate", role: "tradie" },
      { id: "u_lh", username: "Lead", role: "leadingHand" },
    ],
  });
  // u_field has a $52.50 rate from 2026-01-01; u_field2 has NONE (→ unrated).
  blob.set("workforce/cost-rates.json", {
    rates: { u_field: [{ id: "cr1", costRateCents: 5250, chargeOutRateCents: null, effectiveFrom: "2026-01-01" }] },
  });
  // Approved hours on job-a: u_field 8h (rated), u_field2 4h (unrated). A
  // SUBMITTED entry must be excluded. An entry on another job must be excluded.
  blob.set("users/u_field/time-entries/2026-06-01.json", { userId: "u_field", date: "2026-06-01", status: "approved", allocations: [{ jobId: "job-a", hours: 8 }] });
  blob.set("users/u_field/time-entries/2026-06-03.json", { userId: "u_field", date: "2026-06-03", status: "submitted", allocations: [{ jobId: "job-a", hours: 8 }] });
  blob.set("users/u_field2/time-entries/2026-06-02.json", { userId: "u_field2", date: "2026-06-02", status: "approved", allocations: [{ jobId: "job-a", hours: 4 }] });
  blob.set("users/u_field/time-entries/2026-06-04.json", { userId: "u_field", date: "2026-06-04", status: "approved", allocations: [{ jobId: "other-job", hours: 8 }] });
  blob.set("jobs/job-a/materials-list.json", { costRollup: { receivedExGst: 30000 } });

  for (const p of [authPath, handlerPath, costRatesPath, profitPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/job-profitability — confidentiality + shape (#327)", () => {
  it("403s a leading hand and a field worker", async () => {
    expect((await call({ role: "leadingHand", userId: "u_lh", query: { jobId: "job-a" } })).statusCode).toBe(403);
    expect((await call({ role: "electrician", userId: "u_field", query: { jobId: "job-a" } })).statusCode).toBe(403);
  });

  it("404s an unknown job and 400s a missing jobId", async () => {
    expect((await call({ role: "admin", query: { jobId: "nope" } })).statusCode).toBe(404);
    expect((await call({ role: "admin", query: {} })).statusCode).toBe(400);
  });
});

describe("GET /api/job-profitability — honest margin (#327)", () => {
  it("costs approved hours at the effective rate, names unrated workers, labels materials proxy", async () => {
    const res = await call({ role: "admin", query: { jobId: "job-a" } });
    expect(res.statusCode).toBe(200);
    const b = res.body as {
      contractValueCents: number; labourCostCents: number; materialCostCents: number;
      marginCents: number; completeness: { labour: string; material: string; unratedWorkers: string[] };
      hoursTotal: number; badges: string[];
    };
    // u_field 8h × 5250 = 42000c; u_field2 4h excluded (no rate); submitted + other-job excluded.
    expect(b.labourCostCents).toBe(42000);
    expect(b.completeness.labour).toBe("understated");
    expect(b.completeness.unratedWorkers).toEqual(["Mate"]);
    expect(b.completeness.material).toBe("received_proxy");
    expect(b.materialCostCents).toBe(3_000_000); // $30,000
    expect(b.contractValueCents).toBe(12_000_000); // $120,000
    expect(b.marginCents).toBe(12_000_000 - 42000 - 3_000_000);
    expect(b.hoursTotal).toBe(12); // 8 approved + 4 approved on job-a; submitted/other excluded
    expect(b.badges).toContain("1 worker unrated");
    expect(b.badges).toContain("materials proxy");
  });

  it("returns a null margin (never faked) for a job with no contract value", async () => {
    const res = await call({ role: "admin", query: { jobId: "job-novalue" } });
    expect(res.statusCode).toBe(200);
    const b = res.body as { marginCents: number | null; badges: string[] };
    expect(b.marginCents).toBeNull();
    expect(b.badges).toContain("no contract value set");
  });

  it("returns budget-variance lines (#341): actual vs estimate, null when no estimate", async () => {
    // Give job-a a labour estimate; leave the material estimate unset.
    (blob.get("jobs.json") as { jobs: Array<{ id: string; labourEstimate?: number }> }).jobs
      .find((j) => j.id === "job-a")!.labourEstimate = 500; // $500 = 50,000c
    const res = await call({ role: "admin", query: { jobId: "job-a" } });
    expect(res.statusCode).toBe(200);
    const b = res.body as {
      budget: { labourEstimateCents: number | null; materialEstimateCents: number | null };
      variance: { labour: { actualCents: number; budgetCents: number | null; varianceCents: number | null }; material: { budgetCents: number | null }; total: { actualCents: number; budgetCents: number | null } };
    };
    expect(b.budget.labourEstimateCents).toBe(50000);
    expect(b.budget.materialEstimateCents).toBeNull();
    expect(b.variance.labour).toMatchObject({ actualCents: 42000, budgetCents: 50000, varianceCents: -8000 });
    expect(b.variance.material.budgetCents).toBeNull(); // no material estimate → null, not a fake 0
    expect(b.variance.total.actualCents).toBe(42000 + 3_000_000);
    expect(b.variance.total.budgetCents).toBe(12_000_000); // vs contractValue
  });
});
