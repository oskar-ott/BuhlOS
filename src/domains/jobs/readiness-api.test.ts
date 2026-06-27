import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRESTART_ITEMS } from "./readiness";

/**
 * API contract: /api/job-readiness (#371) — resolves the REAL signals the pure
 * computeReadiness() engine consumes, and persists jobs/<id>/prestart.json.
 *
 * Pinned promises:
 *   - GET (admin) returns crew, per-worker induction + licence signals,
 *     safetyDocs:null (#219 not built → "not tracked"), the manual checklist
 *     (defaults seeded un-ticked) and inductionRequired;
 *   - induction maps hasRecord; a worker with no licence on file reads NOT ok;
 *   - admin-tier only — field/LH callers 403 (the hub hides the card);
 *   - tick persists tickedBy/tickedAt + audits; override REQUIRES a reason and
 *     audits; clear-override removes it;
 *   - the JS defaults mirror the TS DEFAULT_PRESTART_ITEMS exactly (no drift).
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/job-readiness.js");

type Res = ReturnType<typeof createRes>;
type Handler = ((req: Record<string, unknown>, res: Res) => Promise<unknown>) & {
  DEFAULT_PRESTART_ITEMS: ReadonlyArray<{ id: string; label: string }>;
};

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
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

async function call(
  viewer: { id: string; role: string } | null,
  opts: { method?: string; query?: Record<string, string>; body?: Record<string, unknown> } = {}
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: opts.method ?? "GET",
      query: opts.query ?? {},
      body: opts.body,
      headers: viewer ? { cookie: cookieFor(viewer.id, viewer.role) } : {},
    },
    res
  );
  return res;
}

const ADMIN = { id: "u_admin", role: "admin" };
const ELEC = { id: "u_elec", role: "electrician" };

type Signals = {
  crew: Array<{ id: string; name: string }>;
  inductions: { byWorkerId: Record<string, boolean> } | null;
  licences: { byWorkerId: Record<string, boolean> } | null;
  safetyDocs: unknown;
  manualItems: Array<{ id: string; ticked: boolean; tickedBy: string | null }>;
  override: { reason: string; by: string } | null;
  inductionRequired: boolean;
};
const signalsOf = (res: Res): Signals => res.body as Signals;

function auditEntries(): Array<Record<string, unknown>> {
  const key = [...blob.keys()].find((k) => k.startsWith("audit/"));
  return key ? (blob.get(key) as { entries: Array<Record<string, unknown>> }).entries : [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
          { id: "u_elec", username: "sparky", role: "electrician", assignedJobIds: ["j1"] },
          { id: "u_tradie", username: "mick", role: "tradie", assignedJobIds: ["j1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["j1"] },
        ],
      },
    ],
    [
      "jobs.json",
      { jobs: [{ id: "j1", name: "Riverside", status: "active", inductionRequired: true }] },
    ],
    // u_elec is inducted; u_tradie is not.
    ["jobs/j1/inductions.json", { records: [{ workerId: "u_elec", completedAt: "2026-06-01T00:00:00Z" }] }],
    // u_elec holds a current electrical licence; u_tradie has none on file.
    [
      "workforce/credentials.json",
      {
        credentials: [
          { id: "c1", userId: "u_elec", typeId: "electrical", label: "Electrical licence", expiryDate: "2099-12-31" },
        ],
      },
    ],
  ]);

  for (const p of [blobSdkPath, blobPath, authPath, auditPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() },
  } as NodeJS.Module;
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
  vi.unstubAllGlobals();
});

describe("GET — signal resolution", () => {
  it("admin gets crew, per-worker induction + licence signals, null safetyDocs, defaults", async () => {
    const res = await call(ADMIN, { query: { jobId: "j1" } });
    expect(res.statusCode).toBe(200);
    const s = signalsOf(res);
    // Client account excluded from crew; only live field crew remain.
    expect(s.crew.map((c) => c.id).sort()).toEqual(["u_elec", "u_tradie"]);
    expect(s.inductions?.byWorkerId).toEqual({ u_elec: true, u_tradie: false });
    expect(s.licences?.byWorkerId).toEqual({ u_elec: true, u_tradie: false });
    expect(s.safetyDocs).toBeNull(); // #219 not built — never faked
    expect(s.inductionRequired).toBe(true);
    expect(s.manualItems.map((i) => i.id)).toEqual(DEFAULT_PRESTART_ITEMS.map((d) => d.id));
    expect(s.manualItems.every((i) => i.ticked === false)).toBe(true);
  });

  it("induction reads satisfied for all crew when the job doesn't require it", async () => {
    (blob.get("jobs.json") as { jobs: Array<{ id: string; inductionRequired: boolean }> }).jobs[0]!.inductionRequired = false;
    const s = signalsOf(await call(ADMIN, { query: { jobId: "j1" } }));
    expect(s.inductions?.byWorkerId).toEqual({ u_elec: true, u_tradie: true });
    expect(s.inductionRequired).toBe(false);
  });

  it("403s a non-admin caller (admin-tier only, v1)", async () => {
    expect((await call(ELEC, { query: { jobId: "j1" } })).statusCode).toBe(403);
  });

  it("404s an unknown job; 400s a missing jobId", async () => {
    expect((await call(ADMIN, { query: { jobId: "ghost" } })).statusCode).toBe(404);
    expect((await call(ADMIN, { query: {} })).statusCode).toBe(400);
  });
});

describe("POST — manual checklist + override persistence", () => {
  it("tick persists tickedBy/tickedAt, audits, and returns fresh signals", async () => {
    const res = await call(ADMIN, {
      method: "POST",
      query: { jobId: "j1" },
      body: { action: "tick", itemId: "insurances", ticked: true },
    });
    expect(res.statusCode).toBe(200);
    const item = signalsOf(res).manualItems.find((i) => i.id === "insurances")!;
    expect(item.ticked).toBe(true);
    expect(item.tickedBy).toBe("boss");
    const stored = blob.get("jobs/j1/prestart.json") as { items: Array<{ id: string; ticked: boolean }> };
    expect(stored.items.find((i) => i.id === "insurances")!.ticked).toBe(true);
    expect(auditEntries().some((e) => e.action === "readiness.item_ticked")).toBe(true);
  });

  it("un-tick clears the attribution", async () => {
    await call(ADMIN, { method: "POST", query: { jobId: "j1" }, body: { action: "tick", itemId: "swms", ticked: true } });
    const res = await call(ADMIN, {
      method: "POST",
      query: { jobId: "j1" },
      body: { action: "tick", itemId: "swms", ticked: false },
    });
    const item = signalsOf(res).manualItems.find((i) => i.id === "swms")!;
    expect(item.ticked).toBe(false);
    expect(item.tickedBy).toBeNull();
  });

  it("404s an unknown checklist item", async () => {
    const res = await call(ADMIN, {
      method: "POST",
      query: { jobId: "j1" },
      body: { action: "tick", itemId: "nope", ticked: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("override REQUIRES a reason; with one it persists + audits, and clears", async () => {
    expect(
      (await call(ADMIN, { method: "POST", query: { jobId: "j1" }, body: { action: "override", reason: "   " } }))
        .statusCode
    ).toBe(400);

    const set = await call(ADMIN, {
      method: "POST",
      query: { jobId: "j1" },
      body: { action: "override", reason: "client signed a waiver" },
    });
    expect(set.statusCode).toBe(200);
    expect(signalsOf(set).override).toMatchObject({ reason: "client signed a waiver", by: "boss" });
    expect(auditEntries().some((e) => e.action === "readiness.overridden")).toBe(true);

    const cleared = await call(ADMIN, { method: "POST", query: { jobId: "j1" }, body: { action: "clear-override" } });
    expect(signalsOf(cleared).override).toBeNull();
    expect(auditEntries().some((e) => e.action === "readiness.override_cleared")).toBe(true);
  });

  it("403s a non-admin writer", async () => {
    const res = await call(ELEC, {
      method: "POST",
      query: { jobId: "j1" },
      body: { action: "tick", itemId: "insurances", ticked: true },
    });
    expect(res.statusCode).toBe(403);
    expect(blob.has("jobs/j1/prestart.json")).toBe(false);
  });
});

describe("defaults parity (no TS/JS drift)", () => {
  it("the API DEFAULT_PRESTART_ITEMS mirror the engine's exactly", () => {
    expect(handler.DEFAULT_PRESTART_ITEMS).toEqual(DEFAULT_PRESTART_ITEMS);
  });
});
