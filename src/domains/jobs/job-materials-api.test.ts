import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/job-materials.js — the per-job materials SPEND ledger (owner pull
 * 2026-08-23). Admin-tier ONLY, dark behind job_materials_spend (404 while
 * off), job must exist, money in integer cents, soft delete, journalled
 * WITHOUT the amount. Real handler + signed sessions + in-memory blob mock.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const storePath = requireFromHere.resolve("../../../api/_lib/job-materials.js");
const handlerPath = requireFromHere.resolve("../../../api/job-materials.js");

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
  method?: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: opts.method || "GET",
      query: opts.query || {},
      body: opts.body,
      headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) },
    },
    res
  );
  return res;
}

const LINE = { date: "2026-08-20", supplier: "L&H", description: "2.5mm TPS", amountCents: 18450 };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_JOB_MATERIALS_SPEND = "true";
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active" }] }],
    [
      "users.json",
      {
        users: [
          {
            id: "u_admin",
            username: "boss",
            name: "Karen Boss",
            role: "admin",
            assignedJobIds: [],
          },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: ["job-a"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-a"] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, flagsPath, auditPath, storePath, handlerPath])
    delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_JOB_MATERIALS_SPEND;
});

function journalEntries(): Array<{
  action: string;
  targetId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}> {
  const out: Array<{
    action: string;
    targetId: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }> = [];
  for (const [k, v] of blob) {
    if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  }
  return out;
}

describe("api/job-materials — gates", () => {
  it("404s for everyone while the flag is off (dark launch-gate)", async () => {
    delete process.env.FLAG_JOB_MATERIALS_SPEND;
    expect((await call({ role: "admin", query: { jobId: "job-a" } })).statusCode).toBe(404);
  });

  it("a leading hand and a field worker get 404 — the admin-tier flag leaves no trace below the admin tier", async () => {
    // isFlagEnabled targets admin-tier, so the flag reads OFF for them and the
    // handler 404s before the (defence-in-depth) 403 admin check is reached.
    expect(
      (await call({ role: "leadingHand", userId: "u_lh", query: { jobId: "job-a" } })).statusCode
    ).toBe(404);
    expect(
      (await call({ role: "electrician", userId: "u_field", query: { jobId: "job-a" } })).statusCode
    ).toBe(404);
    // Nothing was written or journalled for them.
    expect(blob.has("jobs/job-a/materials-ledger.json")).toBe(false);
  });

  it("400s without a jobId, 404s an unknown job, 405s an unknown method", async () => {
    expect((await call({ role: "admin", query: {} })).statusCode).toBe(400);
    expect((await call({ role: "admin", query: { jobId: "nope" } })).statusCode).toBe(404);
    expect(
      (await call({ role: "admin", method: "PUT", query: { jobId: "job-a" } })).statusCode
    ).toBe(405);
  });
});

describe("api/job-materials — the ledger", () => {
  it("GET on a job with no ledger is an honest empty list, total 0", async () => {
    const res = await call({ role: "admin", query: { jobId: "job-a" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ jobId: "job-a", lines: [], totalCents: 0, count: 0 });
  });

  it("POST validates, stores integer cents attributed to the actor, and returns the new total", async () => {
    const bad = await call({
      role: "admin",
      method: "POST",
      query: { jobId: "job-a" },
      body: { ...LINE, amountCents: 184.5 },
    });
    expect(bad.statusCode).toBe(400);

    const res = await call({
      role: "admin",
      method: "POST",
      query: { jobId: "job-a" },
      body: LINE,
    });
    expect(res.statusCode).toBe(201);
    const b = res.body as {
      line: { id: string; createdBy: string; createdByName: string; amountCents: number };
      totalCents: number;
      count: number;
    };
    expect(b.line).toMatchObject({
      createdBy: "u_admin",
      createdByName: "Karen Boss",
      amountCents: 18450,
      supplier: "L&H",
    });
    expect(b.totalCents).toBe(18450);
    expect(b.count).toBe(1);

    const stored = blob.get("jobs/job-a/materials-ledger.json") as { lines: unknown[] };
    expect(stored.lines).toHaveLength(1);
  });

  it("journals the add WITHOUT the amount (the journal is readable below the admin tier)", async () => {
    await call({ role: "admin", method: "POST", query: { jobId: "job-a" }, body: LINE });
    const entries = journalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "job.material_spend_added", targetId: "job-a" });
    expect(entries[0]!.summary).toContain("L&H");
    expect(JSON.stringify(entries[0])).not.toContain("18450");
    expect(JSON.stringify(entries[0])).not.toContain("184.5");
  });

  it("DELETE soft-removes a line: it leaves the total but stays on record; a second delete 404s", async () => {
    const added = await call({
      role: "admin",
      method: "POST",
      query: { jobId: "job-a" },
      body: LINE,
    });
    const id = (added.body as { line: { id: string } }).line.id;
    await call({
      role: "admin",
      method: "POST",
      query: { jobId: "job-a" },
      body: { ...LINE, supplier: "MM", amountCents: 5000 },
    });

    const res = await call({ role: "admin", method: "DELETE", query: { jobId: "job-a", id } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ totalCents: 5000, count: 1 });
    const stored = blob.get("jobs/job-a/materials-ledger.json") as {
      lines: Array<{ id: string; deletedAt?: string; deletedBy?: string }>;
    };
    const tomb = stored.lines.find((l) => l.id === id)!;
    expect(tomb.deletedAt).toBeTruthy();
    expect(tomb.deletedBy).toBe("u_admin");

    expect(
      (await call({ role: "admin", method: "DELETE", query: { jobId: "job-a", id } })).statusCode
    ).toBe(404);
    expect(
      (await call({ role: "admin", method: "DELETE", query: { jobId: "job-a" } })).statusCode
    ).toBe(400);
    expect(journalEntries().map((e) => e.action)).toEqual([
      "job.material_spend_added",
      "job.material_spend_added",
      "job.material_spend_removed",
    ]);
  });
});
