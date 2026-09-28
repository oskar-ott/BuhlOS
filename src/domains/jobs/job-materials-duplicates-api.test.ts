import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/job-materials.js — "Possible duplicate cost" (2026-09-27). A docket typed
 * into the manual ledger that a CONFIRMED supplier invoice already books on
 * the job is warned about (409), never silently blocked and never silently
 * double-counted; an explicit override needs a reason and is journalled. The
 * check runs server-side on EVERY POST; when the invoice store cannot be
 * reached the save proceeds and says so. Real handler, signed sessions,
 * in-memory blob, and a fake invoice store that records how it was scoped.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const ledgerLibPath = requireFromHere.resolve("../../../api/_lib/job-materials.js");
const dbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");
const invoiceStorePath = requireFromHere.resolve("../../../api/_lib/invoices/store.js");
const handlerPath = requireFromHere.resolve("../../../api/job-materials.js");

type Res = ReturnType<typeof createRes>;
type Allocation = {
  invoiceId: string;
  amountCents: number;
  confirmedAt: string | null;
  supplierName: string | null;
  supplierKey: string | null;
  supplierInvoiceNumber: string | null;
  invoiceDate: string | null;
  documentType: string | null;
  source: string | null;
};

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let allocations: Allocation[];
let storeCalls: Array<{ tenantId: string; jobId: string }>;
let dbThrows: boolean;

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
async function post(body: unknown, role = "admin", userId = "u_admin"): Promise<Res> {
  const res = createRes();
  await handler(
    { method: "POST", query: { jobId: "job-a" }, body, headers: { cookie: cookieFor(userId, role) } },
    res,
  );
  return res;
}
function journalEntries(): Array<{ action: string; summary: string; metadata?: Record<string, unknown> }> {
  const out: Array<{ action: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) {
    if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  }
  return out;
}
function mock(path: string, exports: unknown) {
  requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
}

const CONFIRMED: Allocation = {
  invoiceId: "inv-482",
  amountCents: 18450,
  confirmedAt: "2026-09-20T03:00:00.000Z",
  supplierName: "L & H Group Pty Ltd",
  supplierKey: "l and h",
  supplierInvoiceNumber: "INV-00482",
  invoiceDate: "2026-09-18",
  documentType: "invoice",
  source: "email",
};
const TYPED = { date: "2026-09-19", supplier: "L&H", description: "2.5mm TPS", amountCents: 18450 };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_JOB_MATERIALS_SPEND = "true";
  allocations = [CONFIRMED];
  storeCalls = [];
  dbThrows = false;
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active" }] }],
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: ["job-a"] },
        ],
      },
    ],
  ]);
  for (const p of [authPath, flagsPath, auditPath, ledgerLibPath, handlerPath]) delete requireFromHere.cache[p];
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => {
      blob.set(key, clone(data));
    }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, {
    getDb: () => {
      if (dbThrows) throw new Error("SUPABASE_DB_URL is not set");
      return {};
    },
  });
  mock(invoiceStorePath, {
    resolveTenant: async () => ({ id: "t-1", slug: "buhl" }),
    jobActiveAllocations: async (_sql: unknown, tenantId: string, jobId: string) => {
      storeCalls.push({ tenantId, jobId });
      return clone(allocations);
    },
  });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});
afterEach(() => {
  delete process.env.FLAG_JOB_MATERIALS_SPEND;
  delete requireFromHere.cache[dbPath];
  delete requireFromHere.cache[invoiceStorePath];
});

describe("api/job-materials — possible duplicate cost", () => {
  it("warns (409) with the confirmed invoice that looks like the same cost, and books nothing", async () => {
    const res = await post(TYPED);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error: "possible_duplicate",
      jobId: "job-a",
      candidates: [{ invoiceId: "inv-482", strength: "amount_date", supplierInvoiceNumber: "INV-00482" }],
    });
    expect(blob.has("jobs/job-a/materials-ledger.json")).toBe(false);
    expect(journalEntries()).toEqual([]);
  });

  it("the check is scoped to the resolved tenant and this job — never another job's invoices", async () => {
    await post(TYPED);
    expect(storeCalls).toEqual([{ tenantId: "t-1", jobId: "job-a" }]);
  });

  it("a typed invoice number matches the confirmed invoice's number → strongest warning", async () => {
    const res = await post({ ...TYPED, amountCents: 999, reference: "inv 00482" });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ candidates: [{ strength: "reference" }] });
  });

  it("no look-alike → saved as before, reported as checked and clear", async () => {
    allocations = [{ ...CONFIRMED, supplierName: "Bunnings", supplierKey: "bunnings" }];
    const res = await post(TYPED);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ duplicateCheck: "clear", count: 1, totalCents: 18450 });
    expect(journalEntries().map((e) => e.action)).toEqual(["job.material_spend_added"]);
  });

  it("an override needs a reason: 400 without one, nothing saved", async () => {
    const res = await post({ ...TYPED, override: { reason: " " } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("reason") });
    expect(blob.has("jobs/job-a/materials-ledger.json")).toBe(false);
  });

  it("an override with a reason saves the line, stamps the override on it, and journals it without the amount", async () => {
    const res = await post({ ...TYPED, reference: "D-77", override: { reason: "cash-sale docket, not the emailed invoice" } });
    expect(res.statusCode).toBe(201);
    const body = res.body as { duplicateCheck: string; line: Record<string, unknown> };
    expect(body.duplicateCheck).toBe("overridden");
    expect(body.line).toMatchObject({
      reference: "D-77",
      duplicateOverride: {
        reason: "cash-sale docket, not the emailed invoice",
        invoiceIds: ["inv-482"],
        strength: "amount_date",
        by: "u_admin",
        byName: "Karen Boss",
      },
    });
    const entries = journalEntries();
    expect(entries.map((e) => e.action)).toEqual([
      "job.material_spend_added",
      "job.material_spend_duplicate_override",
    ]);
    const override = entries[1];
    expect(override?.summary).toContain("despite a possible duplicate");
    expect(override?.metadata).toMatchObject({ invoiceIds: ["inv-482"], reason: "cash-sale docket, not the emailed invoice", supplier: "L&H" });
    expect(JSON.stringify(override)).not.toContain("18450");
  });

  it("an override sent when nothing looks alike is ignored: saved plainly, no override stamp, no override journal", async () => {
    allocations = [];
    const res = await post({ ...TYPED, override: { reason: "just in case" } });
    expect(res.statusCode).toBe(201);
    expect((res.body as { line: Record<string, unknown> }).line.duplicateOverride).toBeUndefined();
    expect(journalEntries().map((e) => e.action)).toEqual(["job.material_spend_added"]);
  });

  it("when the invoice store cannot be reached the save proceeds and says the check was unavailable", async () => {
    dbThrows = true;
    const res = await post(TYPED);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ duplicateCheck: "unavailable" });
    expect(storeCalls).toEqual([]);
  });

  it("a store error mid-check is also 'unavailable', never a 500 and never a silent 'clear'", async () => {
    mock(invoiceStorePath, {
      resolveTenant: async () => ({ id: "t-1", slug: "buhl" }),
      jobActiveAllocations: async () => {
        throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
      },
    });
    delete requireFromHere.cache[handlerPath];
    handler = requireFromHere(handlerPath);
    const res = await post(TYPED);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ duplicateCheck: "unavailable" });
  });

  it("below the admin tier the endpoint stays invisible, override or not", async () => {
    const res = await post({ ...TYPED, override: { reason: "trust me" } }, "leadingHand", "u_lh");
    expect(res.statusCode).toBe(404);
    expect(storeCalls).toEqual([]);
  });

  it("the check runs on every POST — a second identical save after an override is warned again", async () => {
    const first = await post({ ...TYPED, override: { reason: "cash-sale docket" } });
    expect(first.statusCode).toBe(201);
    const second = await post(TYPED);
    expect(second.statusCode).toBe(409);
    expect(storeCalls).toHaveLength(2);
  });
});
