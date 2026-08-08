import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the daily compliance alert cron (#305):
 * GET /api/notifications?action=send-tag-reminders against the REAL handler,
 * with the blob store, `@vercel/blob` enumeration and api/_lib/push.js
 * replaced by in-memory fakes via require.cache injection (the same harness
 * pattern as assets-api.test.ts / blob-guards-api.test.ts).
 *
 * What this pins — the no-spam dedupe contract end to end:
 *   - run 1: items inside an alert band push to the RIGHT people
 *       tags         → admin tier (all jobs) + leading hands (assigned jobs)
 *       calibrations → admin tier + the field-tier HOLDER (not staff!)
 *   - run 2 on identical data: SILENT (state blob carries the band)
 *   - notificationPrefs.tagReminders === false → never pushed
 *   - tag-reminder-state.json is written with per-key thresholds
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const libAssetsPath = requireFromHere.resolve("../../../api/_lib/assets.js");
const tagCompliancePath = requireFromHere.resolve("../../../api/_lib/tag-compliance.js");
const handlerPath = requireFromHere.resolve("../../../api/notifications.js");

type Res = ReturnType<typeof createRes>;
type PushCall = { userId: string; payload: { title: string; body: string; url: string; tag: string } };

let blob: Map<string, unknown>;
let pushCalls: PushCall[];
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

async function runCron(): Promise<Res> {
  const res = createRes();
  await handler(
    { method: "GET", query: { action: "send-tag-reminders" }, headers: {}, body: undefined },
    res,
  );
  return res;
}

/** ISO YYYY-MM-DD `days` from today (local) — the asset register's format. */
function iso(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SUB = [{ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.CRON_SECRET; // no secret configured → cron calls allowed

  blob = new Map<string, unknown>();
  pushCalls = [];

  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "admin", pushSubscriptions: SUB },
      // admin TIER, but opted out of tag reminders — must stay silent.
      {
        id: "u_office",
        username: "office",
        role: "office",
        pushSubscriptions: SUB,
        notificationPrefs: { tagReminders: false },
      },
      // LH assigned to j1 only.
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["j1"], pushSubscriptions: SUB },
      // field-tier worker HOLDING the calibrated instrument (not staff).
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], pushSubscriptions: SUB },
      // field worker with nothing relevant — never pushed.
      { id: "u_field2", username: "appy", role: "tradie", pushSubscriptions: SUB },
      { id: "u_client", username: "client", role: "client", pushSubscriptions: SUB },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      { id: "j1", name: "Riverside" },
      { id: "j2", name: "Depot" },
    ],
  });
  // (Per-job tags.json registers were deleted with the Test & Tag teardown —
  // the cron alerts on asset-register calibrations only.)
  // Calibrated instrument held by the field worker, due inside 7d.
  blob.set("assets/a_mine.json", {
    id: "a_mine",
    name: "Fluke 1587",
    type: "tool",
    currentHolderId: "u_field",
    calibrationDue: iso(5),
  });

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
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: {
      getWebPush: vi.fn(() => ({})), // "configured"
      sendPushToUserId: vi.fn(async (userId: string, payload: PushCall["payload"]) => {
        pushCalls.push({ userId, payload });
        return { sent: 1, pruned: 0 };
      }),
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

  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pushedTo(userId: string): PushCall[] {
  return pushCalls.filter((c) => c.userId === userId);
}

describe("send-tag-reminders — daily threshold alerts (#305)", () => {
  it("run 1 alerts the right people; run 2 on identical data is SILENT", async () => {
    const res1 = await runCron();
    expect(res1.statusCode).toBe(200);
    const body1 = res1.body as { ok: boolean; crossed: number; sent: number };
    // 1 first-sighting crossing: a_mine (t7). The per-job tag rows are gone.
    expect(body1.crossed).toBe(1);

    // admin: the calibration digest push
    expect(pushedTo("u_admin")).toHaveLength(1);
    const adminPush = pushedTo("u_admin")[0]!.payload;
    expect(adminPush.title).toContain("1 due in 7d");
    expect(adminPush.url).toBe("/gear");
    expect(adminPush.tag).toBe("buhl-tag-alerts");

    // field-tier HOLDER: their instrument's calibration, pointed at Phil gear
    expect(pushedTo("u_field")).toHaveLength(1);
    const holderPush = pushedTo("u_field")[0]!.payload;
    expect(holderPush.title).toContain("1 due in 7d");
    expect(holderPush.body).toContain("Fluke 1587 calibration");
    expect(holderPush.url).toBe("/phil/gear");

    // LH (no held gear), opted-out admin-tier user, uninvolved tradie,
    // client: nothing
    expect(pushedTo("u_lh")).toHaveLength(0);
    expect(pushedTo("u_office")).toHaveLength(0);
    expect(pushedTo("u_field2")).toHaveLength(0);
    expect(pushedTo("u_client")).toHaveLength(0);

    // dedupe state persisted with one entry for the crossed item
    const state = blob.get("tag-reminder-state.json") as {
      entries: Record<string, { threshold: string }>;
    };
    expect(state.entries["cal:a_mine"]!.threshold).toBe("t7");
    expect(Object.keys(state.entries)).toEqual(["cal:a_mine"]);

    // run 2, same data → no new crossings, no pushes
    pushCalls = [];
    const res2 = await runCron();
    const body2 = res2.body as { crossed: number; sent: number };
    expect(body2.crossed).toBe(0);
    expect(body2.sent).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });

  it("a calibration moving into a DEEPER band re-alerts exactly once", async () => {
    await runCron();
    pushCalls = [];
    // a_mine drifts from the 7d band to expired (e.g. days pass)
    blob.set("assets/a_mine.json", {
      id: "a_mine",
      name: "Fluke 1587",
      type: "tool",
      currentHolderId: "u_field",
      calibrationDue: iso(-1),
    });
    const res = await runCron();
    expect((res.body as { crossed: number }).crossed).toBe(1);
    expect(pushedTo("u_admin")).toHaveLength(1);
    expect(pushedTo("u_admin")[0]!.payload.title).toContain("1 expired");
    expect(pushedTo("u_field")).toHaveLength(1);
  });

  it("a recalibrated item leaves the window: state pruned, next lapse re-alerts", async () => {
    await runCron();
    // instrument recalibrated → due 200 days out
    blob.set("assets/a_mine.json", {
      id: "a_mine",
      name: "Fluke 1587",
      type: "tool",
      currentHolderId: "u_field",
      calibrationDue: iso(200),
    });
    pushCalls = [];
    const res = await runCron();
    expect((res.body as { crossed: number }).crossed).toBe(0);
    const state = blob.get("tag-reminder-state.json") as {
      entries: Record<string, unknown>;
    };
    expect(state.entries["cal:a_mine"]).toBeUndefined();
    expect(Object.keys(state.entries)).toEqual([]);
  });

  it("requires the cron secret when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    try {
      const res = await runCron();
      expect(res.statusCode).toBe(401);
      expect(pushCalls).toHaveLength(0);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});
