import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The weekday "Did you log your hours?" push stays quiet on a public holiday
 * (2026-10-11). On Labour Day — Mon 5 Oct 2026 — it reminded the crew, and
 * four of them logged the holiday as a normal job day. The boards never ask
 * for hours on a public holiday; neither does the reminder now. An ordinary
 * weekday still reminds anyone with nothing logged.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const cronAuthPath = requireFromHere.resolve("../../../api/_lib/cron-auth.js");
const notificationsPath = requireFromHere.resolve("../../../api/notifications.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let sendPush: ReturnType<typeof vi.fn>;

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

function loadHandler(): (req: Record<string, unknown>, res: Res) => Promise<unknown> {
  for (const p of [authPath, cronAuthPath, notificationsPath]) delete requireFromHere.cache[p];
  return requireFromHere(notificationsPath);
}

async function remindAt(iso: string): Promise<Res> {
  vi.setSystemTime(new Date(iso));
  const res = createRes();
  await loadHandler()({ method: "GET", query: { action: "send-daily-reminders" }, headers: {} }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.CRON_SECRET; // local dev: cron auth passes
  delete process.env.VERCEL_ENV;
  vi.useFakeTimers({ toFake: ["Date"] });

  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      {
        id: "u_dylan",
        name: "Dylan Sinclair",
        role: "electrician",
        pushSubscriptions: [{ endpoint: "https://push.example/dylan" }],
      },
    ],
  });
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? JSON.parse(JSON.stringify(blob.get(key))) : fallback,
      ),
      writeBlob: vi.fn(async () => {}),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  sendPush = vi.fn(async () => ({ sent: 1, pruned: 0 }));
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { getWebPush: vi.fn(() => ({})), sendPushToUserId: sendPush },
  } as NodeJS.Module;
});

afterEach(() => {
  vi.useRealTimers();
  delete requireFromHere.cache[blobPath];
  delete requireFromHere.cache[pushPath];
});

describe("send-daily-reminders — public holidays", () => {
  it("Labour Day (Mon 5 Oct 2026, 4:30pm Sydney): nobody is reminded", async () => {
    const res = await remindAt("2026-10-05T05:30:00Z");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, date: "2026-10-05", sent: 0, skipped: "public holiday" });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("an ordinary weekday (Tue 6 Oct): a worker with nothing logged is still reminded", async () => {
    const res = await remindAt("2026-10-06T05:30:00Z");
    expect(res.statusCode).toBe(200);
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0]![0]).toBe("u_dylan");
  });
});
