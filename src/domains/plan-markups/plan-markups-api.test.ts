import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the REAL api/plan-markups.js serverless handler with
 * signed sessions + an in-memory Vercel Blob (mirrors jobs-api.test.ts).
 *
 * Covers the Phase 2 permission + validation contract end-to-end:
 *   - admin/office/LH-on-job create/update/archive/toggle visibleToPhil
 *   - field GET returns ONLY visibleToPhil non-archived markups; cannot write
 *   - LH off-job + client + unknown denied
 *   - office-only + archived markups hidden from the field
 *   - markups on a superseded plan never reach the field
 *   - invalid type/coords rejected; plan/page scoping; page1 ≠ page2
 *   - original plans-index.json is never mutated
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/plan-markups.js");

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
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    { method: opts.method, query: opts.query ?? {}, body: opts.body, headers: { cookie: cookieFor(opts.userId, opts.role) } },
    res,
  );
  return res;
}

const PIN = (over: Record<string, unknown> = {}) => ({
  planId: "plan-current",
  pageIndex: 0,
  type: "pin",
  x: 0.5,
  y: 0.5,
  ...over,
});

function markupsBlob(): Array<Record<string, unknown>> {
  const d = blob.get("jobs/job-1/drawing-markups.json") as { markups?: Array<Record<string, unknown>> } | undefined;
  return d?.markups ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
          { id: "u_office", username: "office", role: "office", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-1"] },
          { id: "u_lh2", username: "lead2", role: "lh", assignedJobIds: ["job-2"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_field2", username: "appy", role: "tradie", assignedJobIds: ["job-2"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
          { id: "u_unknown", username: "subbie", role: "subcontractor", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs/job-1/plans-index.json",
      {
        plans: [
          { id: "plan-current", status: "current", drawingNumber: "E-01", revision: "B", pages: [{ pageIndex: 0 }, { pageIndex: 1 }] },
          { id: "plan-super", status: "superseded", drawingNumber: "E-01", revision: "A", pages: [{ pageIndex: 0 }] },
          { id: "plan-arch", status: "archived", pages: [{ pageIndex: 0 }] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (k: string, fb: unknown) => (blob.has(k) ? clone(blob.get(k)) : fb)),
      writeBlob: vi.fn(async (k: string, d: unknown) => { blob.set(k, clone(d)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("create (POST) — management roles only", () => {
  it("admin creates a pin (office-only by default, archived false)", async () => {
    const res = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN() });
    expect(res.statusCode).toBe(200);
    const m = (res.body as { markup: Record<string, unknown> }).markup;
    expect(m).toMatchObject({ type: "pin", planId: "plan-current", pageIndex: 0, visibleToPhil: false, archived: false, createdBy: "boss" });
    expect(typeof m.id).toBe("string");
    // denormalised display context copied from the plan row
    expect(m).toMatchObject({ drawingNumber: "E-01", revision: "B" });
  });

  it("office (admin tier) and LH-on-job can create; LH off-job cannot", async () => {
    expect((await call({ method: "POST", userId: "u_office", role: "office", query: { jobId: "job-1" }, body: PIN() })).statusCode).toBe(200);
    expect((await call({ method: "POST", userId: "u_lh", role: "lh", query: { jobId: "job-1" }, body: PIN() })).statusCode).toBe(200);
    expect((await call({ method: "POST", userId: "u_lh2", role: "lh", query: { jobId: "job-1" }, body: PIN() })).statusCode).toBe(403);
  });

  it("accepts a line with two points and an area with three", async () => {
    const line = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: { planId: "plan-current", pageIndex: 0, type: "line", points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] } });
    expect(line.statusCode).toBe(200);
    const area = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: { planId: "plan-current", pageIndex: 0, type: "area", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } });
    expect(area.statusCode).toBe(200);
  });

  it("rejects invalid type, out-of-range coords, bad line point count, and over-long text", async () => {
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ type: "blob" }) })).statusCode).toBe(400);
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ x: 1.5 }) })).statusCode).toBe(400);
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: { planId: "plan-current", pageIndex: 0, type: "line", points: [{ x: 0, y: 0 }] } })).statusCode).toBe(400);
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ text: "a".repeat(2001) }) })).statusCode).toBe(400);
  });

  it("rejects an unregistered page, a missing plan, and an archived plan", async () => {
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ pageIndex: 9 }) })).statusCode).toBe(400);
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ planId: "nope" }) })).statusCode).toBe(404);
    expect((await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ planId: "plan-arch" }) })).statusCode).toBe(400);
  });

  it("never mutates the original plans-index.json", async () => {
    const before = clone(blob.get("jobs/job-1/plans-index.json"));
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN() });
    expect(blob.get("jobs/job-1/plans-index.json")).toEqual(before);
  });
});

describe("field workers cannot write", () => {
  it.each(["POST", "PATCH", "DELETE"])("403s a field worker on %s", async (method) => {
    const res = await call({ method, userId: "u_field", role: "electrician", query: { jobId: "job-1", id: "mk_x" }, body: PIN() });
    expect(res.statusCode).toBe(403);
  });

  it("403s a client, unknown assigned role, and off-job worker's GET", async () => {
    expect((await call({ method: "GET", userId: "u_client", role: "client", query: { jobId: "job-1", planId: "plan-current", page: "0" } })).statusCode).toBe(403);
    expect((await call({ method: "GET", userId: "u_unknown", role: "subcontractor", query: { jobId: "job-1", planId: "plan-current", page: "0" } })).statusCode).toBe(403);
    expect((await call({ method: "GET", userId: "u_field2", role: "tradie", query: { jobId: "job-1", planId: "plan-current", page: "0" } })).statusCode).toBe(403);
  });
});

describe("update (PATCH) + archive (DELETE)", () => {
  async function seedPin(over: Record<string, unknown> = {}) {
    const res = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN(over) });
    return (res.body as { markup: { id: string } }).markup.id;
  }

  it("admin edits text and toggles visibleToPhil", async () => {
    const id = await seedPin();
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { text: "Isolate before work", visibleToPhil: true } });
    expect(res.statusCode).toBe(200);
    const m = (res.body as { markup: Record<string, unknown> }).markup;
    expect(m).toMatchObject({ text: "Isolate before work", visibleToPhil: true, updatedBy: "boss" });
  });

  it("rejects unknown PATCH fields implicitly (only known keys applied) and bad coords", async () => {
    const id = await seedPin();
    // type change is ignored (not a handled field); coords still validated.
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { x: 2 } });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE soft-archives (record preserved, archived=true)", async () => {
    const id = await seedPin();
    const res = await call({ method: "DELETE", userId: "u_admin", role: "admin", query: { jobId: "job-1", id } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { markup: { archived: boolean } }).markup.archived).toBe(true);
    expect(markupsBlob().find((m) => m.id === id)?.archived).toBe(true);
  });
});

describe("#233 as-built designation (PATCH asBuilt)", () => {
  async function seedPin(over: Record<string, unknown> = {}) {
    const res = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN(over) });
    return (res.body as { markup: { id: string } }).markup.id;
  }

  it("admin can designate a markup as-built (canManageJob)", async () => {
    const id = await seedPin();
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { asBuilt: true } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { markup: { asBuilt: boolean } }).markup.asBuilt).toBe(true);
    expect(markupsBlob().find((m) => m.id === id)?.asBuilt).toBe(true);
  });

  it("LH-on-job can designate; LH off-job and field workers cannot (canManageJob-only)", async () => {
    const id = await seedPin();
    expect((await call({ method: "PATCH", userId: "u_lh", role: "lh", query: { jobId: "job-1", id }, body: { asBuilt: true } })).statusCode).toBe(200);
    // LH off-job and a field worker are blocked at the manage gate.
    expect((await call({ method: "PATCH", userId: "u_lh2", role: "lh", query: { jobId: "job-1", id }, body: { asBuilt: true } })).statusCode).toBe(403);
    expect((await call({ method: "PATCH", userId: "u_field", role: "electrician", query: { jobId: "job-1", id }, body: { asBuilt: true } })).statusCode).toBe(403);
  });

  it("can clear an as-built designation (asBuilt:false)", async () => {
    const id = await seedPin();
    await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { asBuilt: true } });
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { asBuilt: false } });
    expect(res.statusCode).toBe(200);
    expect(markupsBlob().find((m) => m.id === id)?.asBuilt).toBe(false);
  });

  it("rejects a non-boolean asBuilt (400)", async () => {
    const id = await seedPin();
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id }, body: { asBuilt: "yes" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an as-built designation on a markup whose plan is archived (400)", async () => {
    // Seed a markup directly onto the archived plan (the create guard would
    // otherwise refuse to place one there).
    blob.set("jobs/job-1/drawing-markups.json", {
      markups: [
        { id: "mk_arch", jobId: "job-1", planId: "plan-arch", pageIndex: 0, type: "pin", x: 0.5, y: 0.5, visibleToPhil: false, archived: false },
      ],
    });
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id: "mk_arch" }, body: { asBuilt: true } });
    expect(res.statusCode).toBe(400);
    expect(markupsBlob().find((m) => m.id === "mk_arch")?.asBuilt).toBeUndefined();
  });

  it("ALLOWS an as-built designation on a superseded plan (honest as-built on an older rev)", async () => {
    blob.set("jobs/job-1/drawing-markups.json", {
      markups: [
        { id: "mk_super", jobId: "job-1", planId: "plan-super", pageIndex: 0, type: "pin", x: 0.5, y: 0.5, visibleToPhil: false, archived: false, revision: "A" },
      ],
    });
    const res = await call({ method: "PATCH", userId: "u_admin", role: "admin", query: { jobId: "job-1", id: "mk_super" }, body: { asBuilt: true } });
    expect(res.statusCode).toBe(200);
    expect(markupsBlob().find((m) => m.id === "mk_super")?.asBuilt).toBe(true);
  });
});

describe("GET visibility — office vs field", () => {
  async function seedTwo() {
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ visibleToPhil: true, label: "Shared" }) });
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ visibleToPhil: false, label: "Office only" }) });
  }

  it("office sees ALL non-archived; field sees only visibleToPhil", async () => {
    await seedTwo();
    const office = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-current", page: "0" } });
    expect((office.body as { markups: unknown[] }).markups).toHaveLength(2);

    const field = await call({ method: "GET", userId: "u_field", role: "electrician", query: { jobId: "job-1", planId: "plan-current", page: "0" } });
    const fm = (field.body as { markups: Array<{ label: string; visibleToPhil: boolean }> }).markups;
    expect(fm).toHaveLength(1);
    expect(fm[0]).toMatchObject({ label: "Shared", visibleToPhil: true });
  });

  it("hides archived markups from both office and field", async () => {
    const created = await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ visibleToPhil: true }) });
    const id = (created.body as { markup: { id: string } }).markup.id;
    await call({ method: "DELETE", userId: "u_admin", role: "admin", query: { jobId: "job-1", id } });
    const office = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-current", page: "0" } });
    expect((office.body as { markups: unknown[] }).markups).toHaveLength(0);
    const field = await call({ method: "GET", userId: "u_field", role: "electrician", query: { jobId: "job-1", planId: "plan-current", page: "0" } });
    expect((field.body as { markups: unknown[] }).markups).toHaveLength(0);
  });

  it("page 1 markups do not appear on page 0", async () => {
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ pageIndex: 1, visibleToPhil: true }) });
    const p0 = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-current", page: "0" } });
    const p1 = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-current", page: "1" } });
    expect((p0.body as { markups: unknown[] }).markups).toHaveLength(0);
    expect((p1.body as { markups: unknown[] }).markups).toHaveLength(1);
  });

  it("never shows markups on a superseded plan to the field", async () => {
    // admin can place an overlay on a superseded plan...
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ planId: "plan-super", visibleToPhil: true }) });
    const office = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-super", page: "0" } });
    expect((office.body as { markups: unknown[] }).markups).toHaveLength(1);
    // ...but the field never sees overlays on a non-current plan.
    const field = await call({ method: "GET", userId: "u_field", role: "electrician", query: { jobId: "job-1", planId: "plan-super", page: "0" } });
    expect((field.body as { markups: unknown[] }).markups).toHaveLength(0);
  });

  it("404s GET for a missing plan", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "nope", page: "0" } });
    expect(res.statusCode).toBe(404);
  });

  it("returns every page when `page` is omitted (viewer fetches once per plan)", async () => {
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ pageIndex: 0 }) });
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { jobId: "job-1" }, body: PIN({ pageIndex: 1 }) });
    const all = await call({ method: "GET", userId: "u_admin", role: "admin", query: { jobId: "job-1", planId: "plan-current" } });
    expect((all.body as { markups: unknown[] }).markups).toHaveLength(2);
  });
});
