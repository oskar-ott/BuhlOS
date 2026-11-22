import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/domains/audit-log/schema";
import { JobInvoicingResponseSchema } from "./schema";
import { createMemoryStore, type MemoryStore } from "./test-helpers/memory-store";

/**
 * api/customer-invoices.js — the real handler with signed sessions, the flag
 * via env, an in-memory Blob (jobs.json + the audit journal) and an in-memory
 * stand-in for the Postgres store (the real SQL is exercised by
 * customer-invoices-store.pg.test.ts). Covers gating, validation, the money
 * the payload reports, compare-and-swap conflicts and the audit journal.
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const authPath = resolve("../../../api/_lib/auth.js");
const flagsPath = resolve("../../../api/_lib/feature-flags.js");
const auditPath = resolve("../../../api/_lib/audit-log.js");
const dbPath = resolve("../../../api/_lib/supabase-db.js");
const storePath = resolve("../../../api/_lib/customer-invoices/store.js");
const lookupsPath = resolve("../../../api/_lib/customer-invoices/xero-lookups.js");
const handlerPath = resolve("../../../api/customer-invoices.js");

type Res = ReturnType<typeof createRes>;

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let mem: MemoryStore;
let dbMode: string[];
let dbThrows: boolean;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; },
    end() { return this; },
  };
}

function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(opts: { method?: string; role?: string; userId?: string; anonymous?: boolean; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  await handler({
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body,
    headers: opts.anonymous ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin") },
  }, res);
  return res;
}

type Payload = ReturnType<typeof JobInvoicingResponseSchema.parse>;
const payload = (r: Res): Payload => JobInvoicingResponseSchema.parse(r.body);

function journal() {
  const out: Array<{ action: string; targetType: string; targetId: string; jobId?: string; summary: string; metadata?: Record<string, unknown> }> = [];
  for (const [k, v] of blob) if (k.startsWith("audit/")) out.push(...((v as { entries: typeof out }).entries || []));
  return out;
}

const addStage = (stage: Record<string, unknown>, jobId = "tower") =>
  call({ method: "POST", query: { action: "stage-add" }, body: { jobId, stage } });

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_CUSTOMER_INVOICES = "true";
  blob = new Map<string, unknown>([
    ["jobs.json", { jobs: [
      { id: "tower", name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", status: "active", contractValue: 250000 },
      { id: "nocontract", name: "Small Shop", code: "IV7001", status: "active" },
      { id: "gone", name: "Deleted Job", status: "active", deleted: true },
    ] }],
    ["users.json", { users: [
      { id: "u_admin", username: "boss", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_lh", username: "lead", name: "Lead Hand", role: "leadingHand", assignedJobIds: ["tower"] },
      { id: "u_field", username: "sparky", name: "Sparky", role: "electrician", assignedJobIds: ["tower"] },
    ] }],
  ]);
  mem = createMemoryStore();
  dbMode = [];
  dbThrows = false;
  for (const p of [authPath, flagsPath, auditPath, handlerPath]) delete requireFromHere.cache[p];
  const mock = (path: string, exports: unknown) => {
    requireFromHere.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeJS.Module;
  };
  mock(blobPath, {
    readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
    writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
    setNoCache: vi.fn(),
  });
  mock(dbPath, {
    getDb: (o: { mode: string }) => {
      if (dbThrows) throw Object.assign(new Error("no db"), { code: "supabase_unavailable" });
      dbMode.push(o.mode);
      return {};
    },
  });
  mock(storePath, mem);
  // The schedule must work with Xero not connected at all (P8). The Xero
  // routes and readiness states are covered in customer-invoices-xero-api.test.ts.
  mock(lookupsPath, {
    readiness: async () => ({ state: "disconnected", organisationName: null, externalTenantId: null }),
    assertReady: () => { throw new Error("no Xero call is expected in the schedule tests"); },
  });
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete process.env.FLAG_CUSTOMER_INVOICES;
});

describe("api/customer-invoices — gating", () => {
  const probes: Array<Parameters<typeof call>[0]> = [
    { query: { jobId: "tower" } },
    { method: "POST", query: { action: "stage-add" }, body: { jobId: "tower", stage: { title: "x", basis: "amount", amountCents: 100 } } },
    { method: "POST", query: { action: "stage-edit", id: "00000000-0000-4000-8000-000000000001" }, body: {} },
    { method: "POST", query: { action: "stage-remove", id: "00000000-0000-4000-8000-000000000001" }, body: {} },
    { method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } },
  ];

  it("is invisible (404) on every route while the flag is off, and touches no store", async () => {
    delete process.env.FLAG_CUSTOMER_INVOICES;
    for (const p of probes) {
      const r = await call(p);
      expect(r.statusCode).toBe(404);
    }
    expect(dbMode).toEqual([]);
    expect(mem.rows).toEqual([]);
  });

  it("refuses a request with no session (401) on every route", async () => {
    for (const p of probes) {
      const r = await call({ ...p, anonymous: true });
      expect(r.statusCode).toBe(401);
    }
    expect(mem.rows).toEqual([]);
  });

  it("is office-only: a leading hand and a field worker never get in, on any route", async () => {
    // The flag is admin-tier, so below the office tier it resolves OFF and the
    // route is invisible (404) before the role check is even reached — the
    // 403 behind it is defence in depth. Either way: no data, no store call.
    for (const who of [{ userId: "u_lh", role: "leadingHand" }, { userId: "u_field", role: "electrician" }]) {
      for (const p of probes) {
        const r = await call({ ...p, ...who });
        expect(r.statusCode).toBe(404);
        expect(r.body).toEqual({ error: "not found" });
      }
    }
    expect(dbMode).toEqual([]);
    expect(mem.rows).toEqual([]);
  });

  it("answers 503 with a stable code when the store can't be reached or isn't seeded", async () => {
    dbThrows = true;
    expect((await call({ query: { jobId: "tower" } })).body).toEqual({ error: "store_unavailable" });
    dbThrows = false;
    mem.setTenant(null);
    const r = await call({ query: { jobId: "tower" } });
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: "store_unprovisioned" });
  });

  it("opens the database read-only for a GET and for writing otherwise", async () => {
    await call({ query: { jobId: "tower" } });
    await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 });
    expect(dbMode).toEqual(["read", "write"]);
  });
});

describe("api/customer-invoices — reading a job", () => {
  it("an untouched job reports its contract, no stages, and the whole contract still to invoice", async () => {
    const r = await call({ query: { jobId: "tower" } });
    expect(r.statusCode).toBe(200);
    const p = payload(r);
    expect(p.job).toEqual({ name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 250_000_00 });
    expect(p.stages).toEqual([]);
    expect(p.profile).toMatchObject({ retentionBp: 0, version: null });
    expect(p.totals).toMatchObject({ plannedCount: 0, plannedGrossCents: 0, claimedCents: 0, stillToInvoiceCents: 250_000_00, overContract: false });
    // …and that Xero isn't connected, without that getting in the schedule's way.
    expect(p.xero).toEqual({
      state: "disconnected", organisationName: null, settingsComplete: false, sendReady: false,
      client: { linked: false, name: null, otherOrganisation: false, suggestion: null },
    });
  });

  it("a job with no contract value reports unknown — never a made-up zero", async () => {
    const p = payload(await call({ query: { jobId: "nocontract" } }));
    expect(p.job.contractCents).toBeNull();
    expect(p.totals.stillToInvoiceCents).toBeNull();
  });

  it("404s an unknown or deleted job and 400s a missing jobId", async () => {
    expect((await call({ query: { jobId: "nope" } })).body).toEqual({ error: "job_not_found" });
    expect((await call({ query: { jobId: "gone" } })).statusCode).toBe(404);
    expect((await call({})).statusCode).toBe(400);
  });
});

describe("api/customer-invoices — stages", () => {
  it("adds a % stage and works it out from the contract", async () => {
    const r = await addStage({ title: "Deposit", basis: "percent", percentBp: 2000, plannedDate: "2026-12-01" });
    expect(r.statusCode).toBe(201);
    const p = payload(r);
    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]).toMatchObject({ title: "Deposit", basis: "percent", percentBp: 2000, amountCents: null, state: "planned", display: "planned", plannedDate: "2026-12-01" });
    expect(p.stages[0]!.computed).toEqual({ grossCents: 50_000_00, retentionBp: 0, retentionCents: 0, netCents: 50_000_00, reason: null });
    expect(p.totals).toMatchObject({ plannedCount: 1, plannedGrossCents: 50_000_00, stillToInvoiceCents: 250_000_00 });
  });

  it("adds a dollar stage with extra lines", async () => {
    const p = payload(await addStage({
      title: "November claim", basis: "amount", amountCents: 12_000_00,
      extraLines: [{ description: "Variation 3 — extra power points", amountCents: 1_200_00 }],
    }));
    expect(p.stages[0]!.computed.grossCents).toBe(13_200_00);
    expect(p.stages[0]!.extraLines).toEqual([{ description: "Variation 3 — extra power points", amountCents: 1_200_00 }]);
  });

  it("a % stage on a job with no contract is saved and named as not worked out", async () => {
    const p = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 }, "nocontract"));
    expect(p.stages[0]!.computed).toMatchObject({ grossCents: null, netCents: null, reason: "no_contract_value" });
    expect(p.totals).toMatchObject({ plannedCount: 1, unresolvedCount: 1, plannedGrossCents: 0 });
  });

  it("takes the job's retention off each stage once it is set", async () => {
    await addStage({ title: "Rough-in", basis: "amount", amountCents: 20_000_00 });
    const r = await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } });
    expect(r.statusCode).toBe(200);
    const p = payload(r);
    expect(p.profile).toMatchObject({ retentionBp: 500, version: 1 });
    expect(p.stages[0]!.computed).toMatchObject({ grossCents: 20_000_00, retentionBp: 500, retentionCents: 1_000_00, netCents: 19_000_00 });
    expect(p.totals.plannedNetCents).toBe(19_000_00);
  });

  it("flags planned stages that add up past the contract, without blocking them", async () => {
    await addStage({ title: "A", basis: "percent", percentBp: 6000 });
    const r = await addStage({ title: "B", basis: "percent", percentBp: 6000 });
    expect(r.statusCode).toBe(201);
    expect(payload(r).totals.overContract).toBe(true);
  });

  it("edits a planned stage and bumps its version", async () => {
    const added = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 }));
    const s = added.stages[0]!;
    const r = await call({
      method: "POST", query: { action: "stage-edit", id: s.id },
      body: { stage: { title: "Deposit (revised)", basis: "amount", amountCents: 40_000_00 }, expectedVersion: s.version },
    });
    expect(r.statusCode).toBe(200);
    const after = payload(r).stages[0]!;
    expect(after).toMatchObject({ title: "Deposit (revised)", basis: "amount", amountCents: 40_000_00, percentBp: null, version: s.version + 1 });
    expect(after.computed.grossCents).toBe(40_000_00);
  });

  it("refuses a stale edit (someone else saved first) and changes nothing", async () => {
    const s = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 })).stages[0]!;
    await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "First", basis: "percent", percentBp: 2500 }, expectedVersion: s.version } });
    const r = await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "Second", basis: "percent", percentBp: 3000 }, expectedVersion: s.version } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: "stale_version" });
    expect(mem.rows[0]).toMatchObject({ title: "First", percentBp: 2500 });
  });

  it("removes a planned stage, and refuses a stale remove", async () => {
    const s = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 })).stages[0]!;
    const stale = await call({ method: "POST", query: { action: "stage-remove", id: s.id }, body: { expectedVersion: s.version + 5 } });
    expect(stale.statusCode).toBe(409);
    expect(mem.rows).toHaveLength(1);
    const r = await call({ method: "POST", query: { action: "stage-remove", id: s.id }, body: { expectedVersion: s.version } });
    expect(r.statusCode).toBe(200);
    expect(payload(r).stages).toEqual([]);
    expect(mem.rows).toEqual([]);
  });

  it("a stage that is no longer planned can't be edited or removed here", async () => {
    const s = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 })).stages[0]!;
    mem.rows[0]!.state = "sent";
    const edit = await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "x", basis: "percent", percentBp: 100 }, expectedVersion: s.version } });
    expect(edit.statusCode).toBe(409);
    expect(edit.body).toEqual({ error: "stage_not_editable" });
    const rm = await call({ method: "POST", query: { action: "stage-remove", id: s.id }, body: { expectedVersion: s.version } });
    expect(rm.body).toEqual({ error: "stage_not_editable" });
    expect(mem.rows).toHaveLength(1);
  });

  it("404s an edit or remove of a stage that doesn't exist, and 400s a malformed id", async () => {
    const missing = "00000000-0000-4000-8000-00000000ffff";
    expect((await call({ method: "POST", query: { action: "stage-remove", id: missing }, body: { expectedVersion: 1 } })).body).toEqual({ error: "stage_not_found" });
    expect((await call({ method: "POST", query: { action: "stage-edit", id: "not-a-uuid" }, body: {} })).statusCode).toBe(400);
  });

  it("can't add a stage to an unknown or deleted job", async () => {
    expect((await addStage({ title: "x", basis: "amount", amountCents: 100 }, "nope")).statusCode).toBe(404);
    expect((await addStage({ title: "x", basis: "amount", amountCents: 100 }, "gone")).statusCode).toBe(404);
    expect(mem.rows).toEqual([]);
  });
});

describe("api/customer-invoices — validation (nothing malformed reaches the store)", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["no title", { title: "  ", basis: "amount", amountCents: 100 }],
    ["amount basis with no amount", { title: "x", basis: "amount" }],
    ["percent basis with no percent", { title: "x", basis: "percent" }],
    ["zero amount", { title: "x", basis: "amount", amountCents: 0 }],
    ["negative amount", { title: "x", basis: "amount", amountCents: -500 }],
    ["fractional cents", { title: "x", basis: "amount", amountCents: 100.5 }],
    ["amount as a string", { title: "x", basis: "amount", amountCents: "100" }],
    ["percent over 100", { title: "x", basis: "percent", percentBp: 10001 }],
    ["zero percent", { title: "x", basis: "percent", percentBp: 0 }],
    ["unknown basis", { title: "x", basis: "hours", amountCents: 100 }],
    ["bad planned date", { title: "x", basis: "amount", amountCents: 100, plannedDate: "1/12/2026" }],
    ["extra line with no description", { title: "x", basis: "amount", amountCents: 100, extraLines: [{ description: "", amountCents: 5 }] }],
    ["extra line with a negative amount", { title: "x", basis: "amount", amountCents: 100, extraLines: [{ description: "y", amountCents: -5 }] }],
    ["retention over 100%", { title: "x", basis: "amount", amountCents: 100, retentionBp: 10001 }],
    ["an unknown field", { title: "x", basis: "amount", amountCents: 100, state: "sent" }],
  ];
  for (const [name, stage] of bad) {
    it(`refuses a stage with ${name}`, async () => {
      const r = await addStage(stage);
      expect(r.statusCode).toBe(400);
      expect((r.body as { error: string }).error).toBe("invalid_request");
      expect(mem.rows).toEqual([]);
    });
  }

  it("refuses more than 20 extra lines", async () => {
    const extraLines = Array.from({ length: 21 }, (_, i) => ({ description: `L${i}`, amountCents: 100 }));
    expect((await addStage({ title: "x", basis: "amount", amountCents: 100, extraLines })).statusCode).toBe(400);
  });

  it("refuses a bad retention and an edit with no version", async () => {
    expect((await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 10001, expectedVersion: null } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 2.5, expectedVersion: null } })).statusCode).toBe(400);
    const s = payload(await addStage({ title: "Deposit", basis: "percent", percentBp: 2000 })).stages[0]!;
    const r = await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "y", basis: "percent", percentBp: 100 } } });
    expect(r.statusCode).toBe(400);
  });

  it("answers 405 for a method / action it doesn't serve", async () => {
    expect((await call({ method: "DELETE", query: { jobId: "tower" } })).statusCode).toBe(405);
    // Things BuhlOS must never do in Xero have no route at all (ADR rule 2).
    for (const action of ["approve", "authorise", "email", "void", "delete", "pay"]) {
      const r = await call({ method: "POST", query: { action, id: "00000000-0000-4000-8000-000000000001" }, body: {} });
      expect(r.statusCode, action).toBe(405);
    }
  });
});

describe("api/customer-invoices — retention profile", () => {
  it("saves, then needs the current version to change it again", async () => {
    const first = payload(await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } }));
    expect(first.profile.version).toBe(1);
    const replay = await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 1000, expectedVersion: null } });
    expect(replay.statusCode).toBe(409);
    const second = payload(await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 0, expectedVersion: 1 } }));
    expect(second.profile).toMatchObject({ retentionBp: 0, version: 2 });
  });
});

describe("api/customer-invoices — audit journal", () => {
  it("journals every mutation with a registered verb and target — and never an amount", async () => {
    const s = payload(await addStage({ title: "Deposit", basis: "amount", amountCents: 54_321_00, extraLines: [{ description: "Var", amountCents: 9_876_00 }] })).stages[0]!;
    await call({ method: "POST", query: { action: "stage-edit", id: s.id }, body: { stage: { title: "Deposit", basis: "amount", amountCents: 65_432_00 }, expectedVersion: s.version } });
    await call({ method: "PUT", query: { action: "profile" }, body: { jobId: "tower", retentionBp: 500, expectedVersion: null } });
    await call({ method: "POST", query: { action: "stage-remove", id: s.id }, body: { expectedVersion: s.version + 1 } });

    const entries = journal();
    expect(entries.map((e) => e.action)).toEqual([
      "customer_invoice.stage_added",
      "customer_invoice.stage_edited",
      "customer_invoice.profile_updated",
      "customer_invoice.stage_removed",
    ]);
    for (const e of entries) {
      // An unknown verb / target is dropped SILENTLY by the journal — so being
      // here at all proves the CJS registry; this pins the TS mirror too.
      expect(AUDIT_ACTIONS).toContain(e.action);
      expect(AUDIT_TARGET_TYPES).toContain(e.targetType);
      expect(e.targetType).toBe("customer_invoice");
      expect(e.jobId).toBe("tower");
      const text = JSON.stringify(e);
      for (const amount of ["54321", "65432", "9876", "5432100", "6543200"]) expect(text).not.toContain(amount);
    }
    expect(entries[0]!.targetId).toBe(s.id);
    expect(entries[2]!.targetId).toBe("tower");
  });

  it("writes nothing to the journal for a refused request", async () => {
    await addStage({ title: "", basis: "amount", amountCents: 100 });
    await call({ method: "POST", query: { action: "stage-remove", id: "00000000-0000-4000-8000-00000000ffff" }, body: { expectedVersion: 1 } });
    expect(journal()).toEqual([]);
  });
});
