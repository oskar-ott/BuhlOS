import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Harness coverage for api/quote-rate-presets.js (#193) — the labour rate-preset
 * store, exercised through the REAL handler with blob storage mocked to a Map
 * (house pattern: quotes-v2-api.test.ts). Auth is the real module; only blob is
 * mocked, and users.json is seeded so requireAuth resolves the cookie's userId.
 *
 * Pins:
 *   - tier-aware auth: GET open to office tier, writes admin-tier only (never a
 *     literal role === 'admin' check — the #123/#156 bug class)
 *   - CRUD round-trip: create → list → update → archive → list filters
 *   - name uniqueness 409 among LIVE presets; archiving frees the name
 *   - validation 400: missing/oversized name, negative/NaN rate
 *   - write-failure → 502
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/quote-rate-presets.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
/** When set, the NEXT writeBlob to this key throws once. */
let failNextWrite: { key: string; error: Error } | null;

const STORE_KEY = "quote-rate-presets.json";

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
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

interface CallOpts {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  as?: [string, string] | null;
}

async function call({ method, query = {}, body = {}, as = ["u_est", "estimator"] }: CallOpts) {
  const res = createRes();
  await handler(
    {
      method,
      body,
      query,
      headers: as ? { cookie: cookieFor(as[0], as[1]) } : {},
    },
    res
  );
  return res;
}

type PresetRow = {
  id: string;
  name: string;
  loadedCostRate: number;
  sellRate: number;
  archived: boolean;
};

function listBody(res: Res): PresetRow[] {
  return (res.body as { presets: PresetRow[] }).presets;
}
function createdPreset(res: Res): PresetRow {
  return (res.body as { preset: PresetRow }).preset;
}
function storeOf(): { presets: PresetRow[]; updatedAt?: string; updatedBy?: string } {
  return blob.get(STORE_KEY) as { presets: PresetRow[] };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  failNextWrite = null;
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_est", username: "quinn", role: "estimator", assignedJobIds: [] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_office", username: "ollie", role: "office", assignedJobIds: [] },
          { id: "u_acct", username: "andy", role: "accounts", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "tradie", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadinghand", assignedJobIds: [] },
          { id: "u_client", username: "cleo", role: "client", assignedJobIds: [] },
        ],
      },
    ],
    // start with an empty store (handler falls back to {presets:[]} either way)
  ]);

  for (const modulePath of [blobPath, authPath, handlerPath]) {
    delete requireFromHere.cache[modulePath];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        if (failNextWrite && failNextWrite.key === key) {
          const err = failNextWrite.error;
          failNextWrite = null;
          throw err;
        }
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

/** Create a preset via the handler and return the created row. */
async function createPreset(over: Partial<PresetRow> = {}, as?: [string, string]) {
  return call({
    method: "POST",
    as,
    body: { name: "Standard sparky", loadedCostRate: 72, sellRate: 110, ...over },
  });
}

describe("auth — tier-aware (GET office tier, writes admin-only)", () => {
  it("estimator (admin tier) can read and write", async () => {
    expect((await call({ method: "GET" })).statusCode).toBe(200);
    expect((await createPreset()).statusCode).toBe(201);
  });

  it("boss (admin tier) can write", async () => {
    expect((await createPreset({}, ["u_boss", "boss"])).statusCode).toBe(201);
  });

  it("office is part of the ADMIN tier here — can GET AND POST", async () => {
    // NB: in api/_lib/auth.js 'office' ∈ ADMIN_ROLES, so the {roles:['admin']}
    // write gate admits it. The read-only office-tier roles are leadingHand /
    // accounts (covered below).
    expect((await call({ method: "GET", as: ["u_office", "office"] })).statusCode).toBe(200);
    expect((await createPreset({}, ["u_office", "office"])).statusCode).toBe(201);
  });

  it("leading-hand can GET (200) but not POST (403)", async () => {
    expect((await call({ method: "GET", as: ["u_lh", "leadinghand"] })).statusCode).toBe(200);
    expect((await createPreset({}, ["u_lh", "leadinghand"])).statusCode).toBe(403);
  });

  it("accounts can GET (200) but not POST (403)", async () => {
    expect((await call({ method: "GET", as: ["u_acct", "accounts"] })).statusCode).toBe(200);
    expect((await createPreset({}, ["u_acct", "accounts"])).statusCode).toBe(403);
  });

  it("field and client roles are 403 on writes", async () => {
    for (const as of [["u_field", "tradie"], ["u_client", "client"]] as Array<[string, string]>) {
      expect((await createPreset({}, as)).statusCode).toBe(403);
      expect((await call({ method: "PUT", body: { id: "x" }, as })).statusCode).toBe(403);
    }
    // client is not office tier → 403 even on GET
    expect((await call({ method: "GET", as: ["u_client", "client"] })).statusCode).toBe(403);
  });

  it("no session → 401", async () => {
    expect((await call({ method: "GET", as: null })).statusCode).toBe(401);
    expect((await call({ method: "POST", as: null })).statusCode).toBe(401);
  });
});

describe("CRUD round-trip", () => {
  it("create → list → update → archive → list filters", async () => {
    // create
    const created = createdPreset(await createPreset());
    expect(created).toMatchObject({
      name: "Standard sparky",
      loadedCostRate: 72,
      sellRate: 110,
      archived: false,
    });
    expect(created.id).toMatch(/^qrp_/);

    // list shows it
    let rows = listBody(await call({ method: "GET" }));
    expect(rows.map((r) => r.id)).toEqual([created.id]);

    // update rates + name
    const upd = await call({
      method: "PUT",
      body: { id: created.id, name: "Premium sparky", loadedCostRate: 85, sellRate: 130 },
    });
    expect(upd.statusCode).toBe(200);
    expect(createdPreset(upd)).toMatchObject({ name: "Premium sparky", loadedCostRate: 85, sellRate: 130 });

    // archive via PUT {archived:true}
    const arch = await call({ method: "PUT", body: { id: created.id, archived: true } });
    expect(arch.statusCode).toBe(200);
    expect(createdPreset(arch).archived).toBe(true);

    // default list excludes archived
    rows = listBody(await call({ method: "GET" }));
    expect(rows).toEqual([]);

    // includeArchived shows it
    rows = listBody(await call({ method: "GET", query: { includeArchived: "1" } }));
    expect(rows.map((r) => r.id)).toEqual([created.id]);
    expect(rows.map((r) => r.archived)).toEqual([true]);

    // archived preset remains in the store (snapshot history preserved)
    expect(storeOf().presets.length).toBe(1);
  });

  it("stamps audit fields + store-level updatedAt/updatedBy", async () => {
    await createPreset({}, ["u_boss", "boss"]);
    const store = storeOf();
    expect(store.updatedBy).toBe("u_boss");
    expect(store.presets[0]).toMatchObject({ createdBy: "u_boss", updatedBy: "u_boss" });
  });

  it("PUT unknown id → 404", async () => {
    expect((await call({ method: "PUT", body: { id: "qrp_nope" } })).statusCode).toBe(404);
  });

  it("PUT missing id → 400", async () => {
    expect((await call({ method: "PUT", body: {} })).statusCode).toBe(400);
  });
});

describe("name uniqueness", () => {
  it("creating a second LIVE preset with the same name → 409", async () => {
    await createPreset({ name: "Day rate" });
    const dup = await createPreset({ name: "Day rate" });
    expect(dup.statusCode).toBe(409);
    expect(storeOf().presets.length).toBe(1);
  });

  it("archiving a preset FREES its name for a new live preset", async () => {
    const a = createdPreset(await createPreset({ name: "Day rate" }));
    await call({ method: "PUT", body: { id: a.id, archived: true } });
    const b = await createPreset({ name: "Day rate" });
    expect(b.statusCode).toBe(201); // name freed by archiving
    expect(storeOf().presets.filter((p) => !p.archived).length).toBe(1);
  });

  it("PUT renaming onto another LIVE preset's name → 409", async () => {
    await createPreset({ name: "Day rate" });
    const b = createdPreset(await createPreset({ name: "Night rate" }));
    const clash = await call({ method: "PUT", body: { id: b.id, name: "Day rate" } });
    expect(clash.statusCode).toBe(409);
  });

  it("PUT keeping the same name on the same preset is allowed (no self-collision)", async () => {
    const a = createdPreset(await createPreset({ name: "Day rate" }));
    const same = await call({ method: "PUT", body: { id: a.id, name: "Day rate", loadedCostRate: 99 } });
    expect(same.statusCode).toBe(200);
    expect(createdPreset(same).loadedCostRate).toBe(99);
  });
});

describe("validation 400", () => {
  it("missing / blank name", async () => {
    expect((await createPreset({ name: "" })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { loadedCostRate: 1, sellRate: 1 } })).statusCode).toBe(400);
  });

  it("name longer than 80 chars", async () => {
    expect((await createPreset({ name: "x".repeat(81) })).statusCode).toBe(400);
  });

  it("negative or NaN rates", async () => {
    expect((await createPreset({ loadedCostRate: -1 })).statusCode).toBe(400);
    expect((await createPreset({ sellRate: -5 })).statusCode).toBe(400);
    expect(
      (await call({ method: "POST", body: { name: "Bad", loadedCostRate: "abc", sellRate: 10 } })).statusCode
    ).toBe(400);
    expect(
      (await call({ method: "POST", body: { name: "Bad", loadedCostRate: 10, sellRate: null } })).statusCode
    ).toBe(400);
  });

  it("zero rates are allowed (>= 0)", async () => {
    expect((await createPreset({ name: "Free", loadedCostRate: 0, sellRate: 0 })).statusCode).toBe(201);
  });

  it("PUT rejects an invalid rate", async () => {
    const a = createdPreset(await createPreset());
    expect((await call({ method: "PUT", body: { id: a.id, loadedCostRate: -3 } })).statusCode).toBe(400);
  });
});

describe("write-failure path", () => {
  it("POST returns 502 when the blob write throws", async () => {
    failNextWrite = { key: STORE_KEY, error: new Error("blob down") };
    const res = await createPreset();
    expect(res.statusCode).toBe(502);
  });

  it("PUT returns 502 when the blob write throws", async () => {
    const a = createdPreset(await createPreset());
    failNextWrite = { key: STORE_KEY, error: new Error("blob down") };
    const res = await call({ method: "PUT", body: { id: a.id, loadedCostRate: 80 } });
    expect(res.statusCode).toBe(502);
  });
});

describe("method gate", () => {
  it("DELETE → 405 (archiving is via PUT)", async () => {
    expect((await call({ method: "DELETE" })).statusCode).toBe(405);
  });
});
