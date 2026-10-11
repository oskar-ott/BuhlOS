import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hours integrity under Vercel Blob's CDN (2026-10-09, after the 5 Oct pay
 * week that never reached accounts — the third payroll incident of this class).
 *
 * The store is authoritative; the CDN in front of it can keep serving the
 * PREVIOUS version of a day-file for up to ~60s after it changes, and a 404
 * for a day created moments ago. These tests run the REAL storage layer
 * (api/_lib/blob.js), the REAL hours library and REAL handlers against a
 * simulated store whose CDN can be told to lie, and pin the guarantees:
 *
 *   · a decision is never made on a version the store doesn't hold
 *     (readBlobVerified: head()/list() metadata — byte size + PUT time —
 *     against the fetched body; retry, then refuse);
 *   · a write based on a stale copy is refused, never silently written over
 *     newer hours (the compare-and-swap baseline is verified — before this it
 *     read through the same CDN and agreed with the stale copy);
 *   · approving a day approves the hours the store holds NOW, not an older copy;
 *   · a create never overwrites a day that already exists because the CDN said
 *     "404".
 */

const requireFromHere = createRequire(import.meta.url);
const sdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const guardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const entriesHandlerPath = requireFromHere.resolve("../../../api/time-entries.js");

const HOST = "store.public.blob.vercel-storage.com";
const urlFor = (pathname: string) => `https://${HOST}/${pathname}`;
const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

/** What the store holds (authoritative) and what its CDN serves. */
let store: Map<string, { body: string; uploadedAt: Date }>;
let cdnServes: Map<string, string | 404>; // per-key lie: a stale body, or a 404
let cdnLiesFor: Map<string, number>; // how many fetches the lie lasts (Infinity = all)

class BlobNotFoundError extends Error {}

type BlobLib = {
  readBlobVerified: (key: string) => Promise<{ value: Record<string, unknown> | null; meta: unknown }>;
  writeBlob: (key: string, data: unknown, opts?: Record<string, unknown>) => Promise<void>;
  __setVerifiedReadDelaysForTests: (d: number[]) => void;
  __learnPublicHost: (url: string, pathname: string) => void;
  __setTestOverrides: (o: Record<string, unknown> | null) => void;
};
type TimeEntriesLib = {
  ENTRY_PATH: (userId: string, date: string) => string;
  readEntryVerified: (userId: string, date: string) => Promise<Record<string, unknown> | null>;
  writeEntry: (userId: string, entry: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
};

let blobLib: BlobLib;
let lib: TimeEntriesLib;

function putRaw(key: string, doc: unknown, uploadedAt = new Date()) {
  store.set(key, { body: JSON.stringify(doc), uploadedAt });
}
function stored(key: string): Record<string, unknown> {
  return JSON.parse(store.get(key)!.body);
}
/** Make the CDN serve `stale` (a doc, or 404) for `key` for the next `times` fetches. */
function cdnLie(key: string, stale: unknown | 404, times = Infinity) {
  cdnServes.set(key, stale === 404 ? 404 : JSON.stringify(stale));
  cdnLiesFor.set(key, times);
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  store = new Map();
  cdnServes = new Map();
  cdnLiesFor = new Map();
  for (const p of [
    sdkPath,
    blobPath,
    guardsPath,
    auditPath,
    activityPath,
    notifyPath,
    timeEntriesPath,
    authPath,
    approvePath,
    entriesHandlerPath,
  ]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      BlobNotFoundError,
      // The store's own metadata — API-fresh, never the CDN.
      list: vi.fn(async (opts: { prefix?: string }) => ({
        blobs: [...store.entries()]
          .filter(([k]) => k.startsWith(opts.prefix ?? ""))
          .map(([pathname, v]) => ({
            pathname,
            url: urlFor(pathname),
            size: Buffer.byteLength(v.body, "utf8"),
            uploadedAt: v.uploadedAt,
          })),
        hasMore: false,
      })),
      head: vi.fn(async (url: string) => {
        const pathname = pathOf(url);
        const v = store.get(pathname);
        if (!v) throw new BlobNotFoundError("The requested blob does not exist");
        return {
          url: urlFor(pathname),
          pathname,
          size: Buffer.byteLength(v.body, "utf8"),
          uploadedAt: v.uploadedAt,
        };
      }),
      put: vi.fn(async (pathname: string, body: string) => {
        store.set(pathname, { body, uploadedAt: new Date() });
        return { url: urlFor(pathname) };
      }),
      del: vi.fn(async () => {}),
    },
  } as NodeJS.Module;
  for (const [p, exportsObj] of [
    [auditPath, { append: vi.fn(async () => ({ id: "al_x" })) }],
    [activityPath, { appendActivity: vi.fn(async () => null) }],
    [notifyPath, { notify: vi.fn(async () => null) }],
  ] as const) {
    requireFromHere.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj } as NodeJS.Module;
  }
  // The CDN: serves the store's current body unless told to lie for a key.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = pathOf(url);
      const lies = cdnLiesFor.get(pathname) ?? 0;
      let body: string | 404 | undefined;
      if (lies > 0 && cdnServes.has(pathname)) {
        body = cdnServes.get(pathname);
        cdnLiesFor.set(pathname, lies - 1);
      } else {
        body = store.get(pathname)?.body;
      }
      if (body === undefined || body === 404) {
        return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
      }
      const text = body;
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    }),
  );
  blobLib = requireFromHere(blobPath);
  blobLib.__setVerifiedReadDelaysForTests([0, 0]); // two instant retries
  blobLib.__learnPublicHost(urlFor("seed.json"), "seed.json");
  lib = requireFromHere(timeEntriesPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const W = "u_field";
const DATE = new Date().toISOString().slice(0, 10);
const KEY = () => lib.ENTRY_PATH(W, DATE);

/** A day exactly as writeBlob stores it (storage stamp + rev). */
function day(over: Record<string, unknown>, stampMsAgo: number, rev: number) {
  return {
    id: "te1",
    userId: W,
    userName: "Sparky",
    userRole: "electrician",
    date: DATE,
    status: "submitted",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    allocations: [{ jobId: "j1", hours: 7.6, notes: null, sortOrder: 0 }],
    __rev: rev,
    __updatedAt: new Date(Date.now() - stampMsAgo).toISOString(),
    ...over,
  };
}

/** The worker corrected 7.6h → 9.6h five seconds ago; the CDN still serves 7.6h. */
function seedCorrectedDayWithStaleCdn() {
  const before = day({}, 60_000, 2);
  const corrected = day(
    {
      totalHours: 9.6,
      ordinaryHours: 7.6,
      overtimeHours: 2,
      allocations: [{ jobId: "j1", hours: 9.6, notes: null, sortOrder: 0 }],
    },
    5_100,
    3,
  );
  putRaw(KEY(), corrected, new Date(Date.now() - 5_000));
  cdnLie(KEY(), before);
  return { before, corrected };
}

describe("readBlobVerified — a decision is never made on a version the store doesn't hold", () => {
  it("rides out a stale CDN copy and returns the CURRENT version", async () => {
    const { corrected } = seedCorrectedDayWithStaleCdn();
    cdnLiesFor.set(KEY(), 1); // the CDN catches up after one stale answer
    const got = await lib.readEntryVerified(W, DATE);
    expect(got?.totalHours).toBe(corrected.totalHours);
    expect(got?.__rev).toBe(3);
  });

  it("REFUSES (retryable, never stale content) when the CDN keeps serving the old version", async () => {
    seedCorrectedDayWithStaleCdn();
    await expect(lib.readEntryVerified(W, DATE)).rejects.toMatchObject({
      code: "stale_write",
      name: "StaleReadError",
    });
  });

  it("a day created moments ago that the CDN still 404s is NOT 'absent' — retry, then refuse", async () => {
    putRaw(KEY(), day({}, 2_100, 1), new Date(Date.now() - 2_000));
    cdnLie(KEY(), 404);
    await expect(lib.readEntryVerified(W, DATE)).rejects.toMatchObject({ code: "stale_write" });
  });

  it("genuine absence is the store's answer (head → not found) → null", async () => {
    expect(await lib.readEntryVerified(W, DATE)).toBeNull();
  });

  it("works without a learned host too (exact-match list() instead of head())", async () => {
    blobLib.__setTestOverrides({}); // forget the host
    const { corrected } = seedCorrectedDayWithStaleCdn();
    cdnLiesFor.set(KEY(), 1);
    expect((await lib.readEntryVerified(W, DATE))?.totalHours).toBe(corrected.totalHours);
  });
});

describe("writeEntry — a write based on a stale copy is refused, never silently written over newer hours", () => {
  it("THE LOST UPDATE: approving the stale 7.6h copy over the worker's 9.6h correction throws stale_write; the store keeps 9.6h", async () => {
    const { before } = seedCorrectedDayWithStaleCdn();
    // A writer that decided on the stale copy (rev 2) — no verified baseline.
    const approvedFromStale = { ...before, status: "approved", approvedBy: "u_boss" };
    await expect(lib.writeEntry(W, approvedFromStale)).rejects.toMatchObject({ code: "stale_write" });
    expect(stored(KEY()).totalHours).toBe(9.6);
    expect(stored(KEY()).status).toBe("submitted");
  });

  it("…and once the CDN has caught up, the verified baseline still catches the stale decision (rev 2 vs the store's rev 3)", async () => {
    const { before } = seedCorrectedDayWithStaleCdn();
    cdnLiesFor.set(KEY(), 0); // the CDN now tells the truth to the conflict check
    const approvedFromStale = { ...before, status: "approved" };
    await expect(lib.writeEntry(W, approvedFromStale)).rejects.toMatchObject({
      code: "stale_write",
      expectedRev: 2,
      currentRev: 3,
    });
    expect(stored(KEY()).totalHours).toBe(9.6);
  });

  it("(the old guard, for the record) a conflict check that reads through the CDN agrees with the stale copy and OVERWRITES the correction", async () => {
    const { before } = seedCorrectedDayWithStaleCdn();
    await blobLib.writeBlob(KEY(), { ...before, status: "approved" }, { expectedRev: 2 });
    expect(stored(KEY()).totalHours).toBe(7.6); // 9.6h silently lost — what verifyCurrent prevents
  });

  it("a write based on the VERIFIED current version lands, with the next revision", async () => {
    seedCorrectedDayWithStaleCdn();
    cdnLiesFor.set(KEY(), 1);
    const current = (await lib.readEntryVerified(W, DATE))!;
    await lib.writeEntry(W, { ...current, status: "approved" }, { basedOn: current });
    expect(stored(KEY())).toMatchObject({ status: "approved", totalHours: 9.6, __rev: 4 });
  });

  it("creates (no __rev) stay unguarded writes", async () => {
    await lib.writeEntry(W, day({}, 0, 0) as Record<string, unknown> & { __rev?: number });
    expect(store.has(KEY())).toBe(true);
  });
});

describe("handlers decide on the store's current version", () => {
  async function asBoss(handlerPath: string, body: Record<string, unknown>, method = "POST", query = {}) {
    putRaw("users.json", {
      users: [
        { id: "u_boss", username: "boss", role: "admin" },
        { id: W, username: "sparky", name: "Sparky", role: "electrician", assignedJobIds: ["j1"] },
      ],
    });
    putRaw("jobs.json", { jobs: [{ id: "j1", name: "Riverside", status: "active" }] });
    const auth = requireFromHere(authPath) as { signSession: (p: Record<string, unknown>) => string };
    const handler = requireFromHere(handlerPath) as (
      req: Record<string, unknown>,
      res: ReturnType<typeof createRes>,
    ) => Promise<unknown>;
    const res = createRes();
    await handler(
      {
        method,
        query,
        body,
        headers: {
          cookie: `buhl_session=${auth.signSession({ userId: body.__as ?? "u_boss", role: body.__role ?? "admin", exp: Date.now() + 60_000 })}`,
        },
      },
      res,
    );
    return res;
  }

  it("approve: the CDN still shows 7.6h, the store holds the worker's 9.6h correction — 9.6h is what gets approved", async () => {
    seedCorrectedDayWithStaleCdn();
    cdnLiesFor.set(KEY(), 1);
    const res = await asBoss(approvePath, { userId: W, date: DATE });
    expect(res.statusCode).toBe(200);
    expect(stored(KEY())).toMatchObject({ status: "approved", totalHours: 9.6, overtimeHours: 2 });
  });

  it("approve: a day whose current version can't be confirmed is a retryable 409 — never decided on, never a 404", async () => {
    seedCorrectedDayWithStaleCdn(); // the CDN lies for every fetch
    const res = await asBoss(approvePath, { userId: W, date: DATE });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: "conflict", code: "stale_read" });
    expect(stored(KEY()).status).toBe("submitted");
  });

  it("create: the CDN 404s a day the store already holds — 409 'already exists', the existing day is NOT overwritten", async () => {
    const existing = day({ totalHours: 9.6, ordinaryHours: 7.6, overtimeHours: 2 }, 3_100, 1);
    putRaw(KEY(), existing, new Date(Date.now() - 3_000));
    cdnLie(KEY(), 404, 1); // the CDN's negative cache, then it catches up
    const res = await asBoss(entriesHandlerPath, {
      __as: W,
      __role: "electrician",
      date: DATE,
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [{ jobId: "j1", hours: 7.6 }],
      status: "submitted",
    });
    expect(res.statusCode).toBe(409);
    expect(stored(KEY()).totalHours).toBe(9.6);
  });
});
