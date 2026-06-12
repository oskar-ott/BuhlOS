import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the licence alert cron (#331):
 * GET /api/notifications?action=send-licence-reminders against the REAL
 * handler — same harness as the #305 tag-reminders test (blob + push fakes
 * via require.cache).
 *
 * Pinned end to end:
 *   - run 1: admins get ONE digest of every crossing (→ /employees); each
 *     affected worker gets their OWN tickets only (→ /v2/phil)
 *   - run 2 on identical data: SILENT (licence-reminder-state.json dedupe)
 *   - a renewal prunes state + stops alerting (engine + cron together)
 *   - archived workers and notificationPrefs.licenceReminders === false
 *     never push; uninvolved workers never push
 *   - PII: pushes name the ticket type, NEVER the licence number
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const libAssetsPath = requireFromHere.resolve("../../../api/_lib/assets.js");
const tagCompliancePath = requireFromHere.resolve("../../../api/_lib/tag-compliance.js");
const licenceCompliancePath = requireFromHere.resolve("../../../api/_lib/licence-compliance.js");
const handlerPath = requireFromHere.resolve("../../../api/notifications.js");

type Res = ReturnType<typeof createRes>;
type PushCall = {
  userId: string;
  payload: { title: string; body: string; url: string; tag: string };
};

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
    {
      method: "GET",
      query: { action: "send-licence-reminders" },
      headers: {},
      body: undefined,
    },
    res
  );
  return res;
}

/** ISO YYYY-MM-DD `days` from today (local). */
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
      // admin tier but opted out of licence reminders — stays silent.
      {
        id: "u_office",
        username: "office",
        role: "office",
        pushSubscriptions: SUB,
        notificationPrefs: { licenceReminders: false },
      },
      { id: "u_elec", username: "sparky", role: "electrician", pushSubscriptions: SUB },
      { id: "u_tradie", username: "mick", role: "tradie", pushSubscriptions: SUB },
      // archived worker with an expired ticket — record retained, never alerts.
      {
        id: "u_gone",
        username: "gone",
        role: "tradie",
        archived: true,
        pushSubscriptions: SUB,
      },
      { id: "u_client", username: "client", role: "client", pushSubscriptions: SUB },
    ],
  });
  blob.set("workforce/credentials.json", {
    credentials: [
      // expired electrical licence on the live electrician
      {
        id: "c_exp",
        kind: "licence",
        userId: "u_elec",
        userName: "sparky",
        typeId: "electrical",
        label: "Electrical licence",
        number: "QLD-SECRET-1",
        expiryDate: iso(-3),
      },
      // EWP inside the 14d band on the tradie
      {
        id: "c_14",
        kind: "licence",
        userId: "u_tradie",
        userName: "mick",
        typeId: "ewp",
        label: "EWP",
        number: "EWP-SECRET-2",
        expiryDate: iso(10),
      },
      // white card with no expiry — never alerts
      {
        id: "c_never",
        kind: "licence",
        userId: "u_elec",
        userName: "sparky",
        typeId: "white-card",
        label: "White card",
        expiryDate: null,
      },
      // archived worker's expired ticket — retained, silent
      {
        id: "c_gone",
        kind: "licence",
        userId: "u_gone",
        userName: "gone",
        typeId: "electrical",
        label: "Electrical licence",
        expiryDate: iso(-30),
      },
    ],
  });

  for (const p of [authPath, handlerPath, libAssetsPath, tagCompliancePath, licenceCompliancePath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
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
    })
  );

  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pushedTo(userId: string): PushCall[] {
  return pushCalls.filter((c) => c.userId === userId);
}

describe("send-licence-reminders — daily worker-ticket alerts (#331)", () => {
  it("run 1 alerts admins (digest) + each worker (own tickets); run 2 is SILENT", async () => {
    const res1 = await runCron();
    expect(res1.statusCode).toBe(200);
    const body1 = res1.body as { crossed: number; sent: number };
    // c_exp (expired) + c_14 (t14). Never: no-expiry, archived worker's.
    expect(body1.crossed).toBe(2);

    // Admin digest: both crossings, one push, → /employees.
    expect(pushedTo("u_admin")).toHaveLength(1);
    const adminPush = pushedTo("u_admin")[0]!.payload;
    expect(adminPush.title).toContain("1 expired");
    expect(adminPush.title).toContain("1 due in 14d");
    expect(adminPush.body).toContain("Electrical licence — sparky");
    expect(adminPush.url).toBe("/employees");
    expect(adminPush.tag).toBe("buhl-licence-alerts");

    // Workers: own tickets only, → the Phil self-view.
    expect(pushedTo("u_elec")).toHaveLength(1);
    const elecPush = pushedTo("u_elec")[0]!.payload;
    expect(elecPush.title).toContain("Your tickets");
    expect(elecPush.title).toContain("1 expired");
    expect(elecPush.title).not.toContain("due in 14d"); // mick's EWP isn't theirs
    expect(elecPush.url).toBe("/v2/phil");

    expect(pushedTo("u_tradie")).toHaveLength(1);
    expect(pushedTo("u_tradie")[0]!.payload.title).toContain("1 due in 14d");

    // Opt-out, archived, client: silent.
    expect(pushedTo("u_office")).toHaveLength(0);
    expect(pushedTo("u_gone")).toHaveLength(0);
    expect(pushedTo("u_client")).toHaveLength(0);

    // PII: licence numbers never reach a push payload.
    expect(JSON.stringify(pushCalls)).not.toContain("QLD-SECRET-1");
    expect(JSON.stringify(pushCalls)).not.toContain("EWP-SECRET-2");

    // State persisted per key.
    const state = blob.get("licence-reminder-state.json") as {
      entries: Record<string, { threshold: string }>;
    };
    expect(state.entries["licence:c_exp"]!.threshold).toBe("expired");
    expect(state.entries["licence:c_14"]!.threshold).toBe("t14");

    // Run 2: nothing new crossed → no pushes.
    pushCalls = [];
    const res2 = await runCron();
    expect((res2.body as { crossed: number }).crossed).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });

  it("a renewal prunes state and stops the alerts", async () => {
    await runCron();
    pushCalls = [];
    // The office records the renewed electrical licence (same worker+type,
    // later expiry) — the engine's renewal collapse supersedes c_exp.
    const creds = blob.get("workforce/credentials.json") as {
      credentials: Array<Record<string, unknown>>;
    };
    creds.credentials.push({
      id: "c_renewed",
      kind: "licence",
      userId: "u_elec",
      userName: "sparky",
      typeId: "electrical",
      label: "Electrical licence",
      expiryDate: iso(365),
    });
    blob.set("workforce/credentials.json", creds);

    const res = await runCron();
    expect((res.body as { crossed: number }).crossed).toBe(0);
    expect(pushedTo("u_elec")).toHaveLength(0);
    const state = blob.get("licence-reminder-state.json") as {
      entries: Record<string, unknown>;
    };
    expect(state.entries["licence:c_exp"]).toBeUndefined(); // pruned
  });

  it("503s loudly when push is unconfigured (compliance must not fail silent)", async () => {
    const pushModule = requireFromHere.cache[pushPath]!;
    (pushModule.exports as { getWebPush: () => unknown }).getWebPush = () => null;
    delete requireFromHere.cache[handlerPath];
    handler = requireFromHere(handlerPath);
    const res = await runCron();
    expect(res.statusCode).toBe(503);
  });
});
