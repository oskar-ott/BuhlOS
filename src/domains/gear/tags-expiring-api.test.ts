import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for GET /api/tags-expiring (#305) against the REAL
 * handler, with signed sessions and an in-memory Vercel Blob (mirrors the
 * harness in assets-api.test.ts, including the `@vercel/blob` list + global
 * fetch mock the asset enumeration path needs).
 *
 * Pins the contract the rest of the compliance loop builds on:
 *   - legacy `tags` response keys preserved EXACTLY (raw tag id, ''-defaulted
 *     strings, expiryISO/daysToExpiry/status, withinDays echoed);
 *   - visibility: admin TIER sees all jobs; field/LH only assignedJobIds;
 *     clients 403;
 *   - additive `calibrations`: admin sees all, a worker only the gear THEY
 *     currently hold.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const libAssetsPath = requireFromHere.resolve("../../../api/_lib/assets.js");
const tagCompliancePath = requireFromHere.resolve("../../../api/_lib/tag-compliance.js");
const handlerPath = requireFromHere.resolve("../../../api/tags-expiring.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

async function call({
  userId,
  role,
  query = {},
}: {
  userId: string;
  role: string;
  query?: Record<string, string>;
}): Promise<Res> {
  const res = createRes();
  await handler(
    { method: "GET", query, headers: { cookie: cookieFor(userId, role) }, body: undefined },
    res,
  );
  return res;
}

/** dd/mm/yyyy for a date `days` from today (local) — tags store this format. */
function ddmm(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
/** ISO YYYY-MM-DD for a date `days` from today (local) — assets store this. */
function iso(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x" },
      { id: "u_office", username: "office", role: "office", passwordHash: "$2a$10$x" },
      {
        id: "u_field",
        username: "sparky",
        role: "electrician",
        assignedJobIds: ["j1"],
        passwordHash: "$2a$10$x",
      },
      { id: "u_client", username: "client", role: "client", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      { id: "j1", name: "Riverside" },
      { id: "j2", name: "Depot" },
    ],
  });
  blob.set("jobs/j1/tags.json", {
    tags: [
      {
        id: "t_exp",
        tagNumber: "T-100",
        applianceType: "Drill",
        owner: "Sam",
        result: "pass",
        expiryDate: ddmm(-2),
      },
      { id: "t_far", tagNumber: "T-101", expiryDate: ddmm(60) },
    ],
  });
  blob.set("jobs/j2/tags.json", {
    tags: [{ id: "t_soon", tagNumber: "T-200", applianceType: "Saw", expiryDate: ddmm(5) }],
  });
  // Calibrated instruments: one held by u_field (due soon), one in depot (expired).
  blob.set("assets/a_mine.json", {
    id: "a_mine",
    name: "Fluke 1587",
    type: "tool",
    currentHolderId: "u_field",
    calibrationDue: iso(6),
  });
  blob.set("assets/a_depot.json", {
    id: "a_depot",
    name: "Megger",
    type: "tool",
    currentHolderId: null,
    calibrationDue: iso(-1),
  });
  blob.set("assets/a_nocal.json", { id: "a_nocal", name: "Ladder", type: "other", currentHolderId: "u_field" });

  for (const p of [authPath, handlerPath, libAssetsPath, tagCompliancePath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...blob.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(async () => ({})),
    },
  } as NodeJS.Module;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
      if (!blob.has(key)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => clone(blob.get(key)) };
    }),
  );

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type TagRow = {
  id: string;
  jobId: string;
  jobName: string;
  tagNumber: string;
  applianceType: string;
  owner: string;
  result: string;
  expiryDate: string;
  expiryISO: string;
  daysToExpiry: number;
  status: string;
};
type CalRow = { assetId: string; holderId: string | null; status: string };
type Body = { tags: TagRow[]; calibrations: CalRow[]; withinDays: number };

describe("GET /api/tags-expiring — tags (legacy shape after the Test & Tag teardown)", () => {
  it("the tags key is ALWAYS an empty array — the per-job registers are gone", async () => {
    const res = await call({ userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { tags: unknown[] }).tags).toEqual([]);
  });

  it("clients are 403", async () => {
    const res = await call({ userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/tags-expiring — calibrations (#305 additive)", () => {
  it("admin sees ALL flagged calibrations, expired-first", async () => {
    const res = await call({ userId: "u_admin", role: "admin" });
    const body = res.body as Body;
    expect(body.calibrations.map((c) => c.assetId)).toEqual(["a_depot", "a_mine"]);
    expect(body.calibrations[0]).toMatchObject({ status: "expired" });
  });

  it("a worker sees ONLY calibrations on gear THEY hold", async () => {
    const res = await call({ userId: "u_field", role: "electrician" });
    const body = res.body as Body;
    expect(body.calibrations.map((c) => c.assetId)).toEqual(["a_mine"]);
    expect(body.calibrations[0]).toMatchObject({ holderId: "u_field", status: "expiring" });
  });
});
