import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the Thursday payroll-reminder cron (#392):
 * GET /api/payroll-reminder against the REAL handler — same harness as the
 * licence/tag-reminders tests (blob + push fakes via require.cache).
 *
 * Pinned end to end:
 *   - CRON_SECRET path: wrong/missing secret → 401; Bearer or x-cron-secret
 *     → allowed; production with NO secret configured → 503 fail-closed
 *   - public holiday → silent 200 skip, zero pushes
 *   - `hours` kill-switch off (flags.json override) → silent 200 skip —
 *     a pending-hours push must not outlive the surface it deep-links
 *   - pending submitted entries push admin-tier subscribers ONLY; archived
 *     admins, field workers and sub-less admins stay silent — and
 *     notificationPrefs are IGNORED (owner-critical `alwaysOn` class per
 *     docs/notifications.md §5: the payroll nudge has no mute)
 *   - the window is the last TWO Sydney weeks (Monday of the previous week
 *     → today) so the Monday-morning fire sees the just-closed week's
 *     stragglers; anything older is excluded
 *   - payload: count title, "<h>h pending · oldest from <day>" body,
 *     tap → /hours/approvals, per-day dedupe tag
 *   - nothing pending → silent 200 skip
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const holidaysPath = requireFromHere.resolve("../../../api/_lib/public-holidays.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/payroll-reminder.js");

type Res = ReturnType<typeof createRes>;
type PushCall = {
  userId: string;
  payload: { title: string; body: string; url: string; tag: string };
};

let blob: Map<string, unknown>;
let pushCalls: PushCall[];
let holidayToday: boolean;
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

const ENV_SNAP = {
  CRON_SECRET: process.env.CRON_SECRET,
  VERCEL_ENV: process.env.VERCEL_ENV,
  FLAG_HOURS: process.env.FLAG_HOURS,
};

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

async function runCron(headers: Record<string, string> = {}): Promise<Res> {
  const res = createRes();
  await handler({ method: "GET", query: {}, headers, body: undefined }, res);
  return res;
}

/** ISO YYYY-MM-DD in Sydney, `offsetDays` from now — the same clock the
 *  handler's sydneyToday() reads, so fixtures dated 0 are always in the
 *  window, -7 always lands in the PREVIOUS Sydney week (still in the
 *  two-week window), and -35 is always before it. */
function sydneyISO(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

/** Mirror of the handler's prettyDate — pins the human date format. */
function pretty(yyyymmdd: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(yyyymmdd + "T00:00:00Z"));
}

function setEntry(userId: string, date: string, status: string, totalHours: number) {
  blob.set(`users/${userId}/time-entries/${date}.json`, { date, status, totalHours });
}

const SUB = [{ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  delete process.env.CRON_SECRET; // no secret configured → cron calls allowed
  delete process.env.VERCEL_ENV;
  delete process.env.FLAG_HOURS; // `hours` resolves via flags.json → default (on)

  blob = new Map<string, unknown>();
  pushCalls = [];
  holidayToday = false;

  blob.set("users.json", {
    users: [
      { id: "u_boss", username: "boss", role: "admin", pushSubscriptions: SUB },
      { id: "u_office", username: "office", role: "office", pushSubscriptions: SUB },
      // admin tier with prefs set to mute everything — STILL pushed: this
      // reminder is owner-critical `alwaysOn` (docs/notifications.md §5).
      {
        id: "u_muted",
        username: "quiet",
        role: "admin",
        pushSubscriptions: SUB,
        notificationPrefs: { payrollReminder: false, dailyDigest: false },
      },
      { id: "u_gone", username: "gone", role: "admin", archived: true, pushSubscriptions: SUB },
      { id: "u_nosub", username: "nosub", role: "admin" },
      { id: "u_sparky", username: "sparky", role: "electrician", pushSubscriptions: SUB },
    ],
  });

  for (const p of [handlerPath, authPath, flagsPath]) {
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
  requireFromHere.cache[holidaysPath] = {
    id: holidaysPath,
    filename: holidaysPath,
    loaded: true,
    exports: {
      isPublicHoliday: vi.fn(() => holidayToday),
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
  for (const [k, v] of Object.entries(ENV_SNAP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function pushedTo(userId: string): PushCall[] {
  return pushCalls.filter((c) => c.userId === userId);
}

describe("payroll-reminder cron — Thursday pending-hours nudge (#392)", () => {
  it("rejects a wrong or missing secret when CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = "s3cret";
    setEntry("u_sparky", sydneyISO(0), "submitted", 8);

    expect((await runCron()).statusCode).toBe(401);
    expect((await runCron({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  it("accepts the Vercel Bearer header and the manual x-cron-secret header", async () => {
    process.env.CRON_SECRET = "s3cret";
    setEntry("u_sparky", sydneyISO(0), "submitted", 8);

    const viaBearer = await runCron({ authorization: "Bearer s3cret" });
    expect(viaBearer.statusCode).toBe(200);
    expect((viaBearer.body as { ok: boolean }).ok).toBe(true);

    const viaHeader = await runCron({ "x-cron-secret": "s3cret" });
    expect(viaHeader.statusCode).toBe(200);
  });

  it("fails closed in production when CRON_SECRET is not configured", async () => {
    process.env.VERCEL_ENV = "production";
    const res = await runCron();
    expect(res.statusCode).toBe(503);
    expect(pushCalls).toHaveLength(0);
  });

  it("stays silent on a public holiday", async () => {
    holidayToday = true;
    setEntry("u_sparky", sydneyISO(0), "submitted", 8);

    const res = await runCron();
    expect(res.statusCode).toBe(200);
    expect((res.body as { skipped: string }).skipped).toBe("public holiday");
    expect(pushCalls).toHaveLength(0);
  });

  it("stays silent when the hours kill-switch is off (no trace of a hidden surface)", async () => {
    blob.set("flags.json", { flags: { hours: false } });
    setEntry("u_sparky", sydneyISO(0), "submitted", 8);

    const res = await runCron();
    expect(res.statusCode).toBe(200);
    expect((res.body as { skipped: string }).skipped).toBe("hours flag off");
    expect(pushCalls).toHaveLength(0);
  });

  it("stays silent when nothing is pending", async () => {
    setEntry("u_sparky", sydneyISO(0), "approved", 8);

    const res = await runCron();
    expect(res.statusCode).toBe(200);
    expect((res.body as { skipped: string }).skipped).toBe("no pending entries");
    expect(pushCalls).toHaveLength(0);
  });

  it("counts last week's stragglers — the Monday-morning fire must see the just-closed week", async () => {
    setEntry("u_sparky", sydneyISO(-7), "submitted", 8); // always in the previous Sydney week

    const res = await runCron();
    expect(res.statusCode).toBe(200);
    const body = res.body as { pendingCount: number; oldestDate: string };
    expect(body.pendingCount).toBe(1);
    expect(body.oldestDate).toBe(sydneyISO(-7));
    expect(pushCalls).toHaveLength(3);
    expect(pushedTo("u_boss")[0]!.payload.body).toContain(`oldest from ${pretty(sydneyISO(-7))}`);
  });

  it("pushes admin-tier subscribers only, with count + hours + oldest day → /hours/approvals", async () => {
    const today = sydneyISO(0);
    setEntry("u_sparky", today, "submitted", 8);
    setEntry("u_mick", today, "submitted", 3.5);
    setEntry("u_third", today, "approved", 6); // approved — not pending
    setEntry("u_sparky", sydneyISO(-35), "submitted", 40); // before the two-week window — excluded

    const res = await runCron();
    expect(res.statusCode).toBe(200);
    const body = res.body as { sent: number; pendingCount: number; pendingHours: number };
    expect(body.pendingCount).toBe(2);
    expect(body.pendingHours).toBe(11.5);

    // Live admin-tier subscribers push — INCLUDING the prefs-muted admin
    // (alwaysOn: no mute for the payroll nudge). Archived, sub-less and
    // field stay silent.
    expect(pushedTo("u_boss")).toHaveLength(1);
    expect(pushedTo("u_office")).toHaveLength(1);
    expect(pushedTo("u_muted")).toHaveLength(1);
    expect(pushedTo("u_gone")).toHaveLength(0);
    expect(pushedTo("u_nosub")).toHaveLength(0);
    expect(pushedTo("u_sparky")).toHaveLength(0);
    expect(pushCalls).toHaveLength(3);

    const payload = pushedTo("u_boss")[0]!.payload;
    expect(payload.title).toBe("2 hours entries awaiting approval");
    expect(payload.body).toBe(`11.5h pending · oldest from ${pretty(today)}`);
    expect(payload.url).toBe("/hours/approvals");
    expect(payload.tag).toBe(`buhl-payroll-reminder-${today}`);
  });
});
