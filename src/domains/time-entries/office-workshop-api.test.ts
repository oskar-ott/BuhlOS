import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Office and Workshop, end to end through the real handlers (owner pull
 * 2026-11-06): a field worker logs a day split between Workshop and a job,
 * fixes a day to all-Office, the office's approval queue names both places,
 * the office approves, and the payroll export carries "Workshop" / "Office"
 * rows as ordinary hours. A made-up place id is still refused.
 *
 * Harness mirrors time-entry-actions-api.test.ts: real auth + time-entries
 * libs and handlers; an in-memory store injected into the require cache — no
 * real Blob is touched (preview deployments share production's store, so
 * this is the only safe place to exercise writes).
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const notifyRoutingPath = requireFromHere.resolve("../../../api/_lib/notify-routing.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const entriesPath = requireFromHere.resolve("../../../api/time-entries.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const exportPath = requireFromHere.resolve("../../../api/time-entries-export.js");

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);
const ENTRY_PATH = (userId: string) => `users/${userId}/time-entries/${TODAY}.json`;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let entries: Handler;
let approve: Handler;
let exportEntries: Handler;

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

async function send(
  handler: Handler,
  method: string,
  userId: string,
  role: string,
  body: unknown,
  query: Record<string, string> = {}
) {
  const res = createRes();
  await handler({ method, body, query, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

function day(allocations: Array<{ jobId: string; hours: number }>) {
  const totalHours = allocations.reduce((s, a) => s + a.hours, 0);
  return {
    date: TODAY,
    totalHours,
    ordinaryHours: Math.min(totalHours, 7.6),
    overtimeHours: Math.max(0, Math.round((totalHours - 7.6) * 100) / 100),
    status: "submitted",
    allocations,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_office", username: "office", name: "Office Admin", role: "office", assignedJobIds: [] },
          { id: "u_sam", username: "sam", name: "Sam Sparky", role: "tradie", assignedJobIds: ["smith-st"] },
          { id: "u_jo", username: "jo", name: "Jo Apprentice", role: "tradie", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "smith-st", name: "Smith St Rewire", status: "active" }] }],
  ]);

  for (const p of [
    blobSdkPath,
    blobPath,
    authPath,
    timeEntriesLibPath,
    pushPath,
    notifyPath,
    notifyRoutingPath,
    activityPath,
    entriesPath,
    approvePath,
    exportPath,
  ]) {
    delete requireFromHere.cache[p];
  }

  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({
        blobs: [...blob.keys()]
          .filter((key) => key.includes("/time-entries/"))
          .map((pathname) => ({ pathname, url: `https://blob.test/${encodeURIComponent(pathname)}` })),
      })),
      put: vi.fn(),
      del: vi.fn(),
    },
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
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { sendPushToUserId: vi.fn(async () => {}) },
  } as NodeJS.Module;
  requireFromHere.cache[activityPath] = {
    id: activityPath,
    filename: activityPath,
    loaded: true,
    exports: { appendActivity: vi.fn(async () => {}) },
  } as NodeJS.Module;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
      const value = blob.get(pathname);
      return { ok: value !== undefined, json: async () => clone(value) };
    })
  );

  auth = requireFromHere(authPath);
  entries = requireFromHere(entriesPath);
  approve = requireFromHere(approvePath);
  exportEntries = requireFromHere(exportPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Office and Workshop through the hours API", () => {
  it("a worker logs Workshop + a job, the office sees both named, approves, and payroll names them", async () => {
    // Sam: 4h Workshop + 3h 36m Smith St.
    const logged = await send(entries, "POST", "u_sam", "tradie", day([
      { jobId: "place:workshop", hours: 4 },
      { jobId: "smith-st", hours: 3.6 },
    ]));
    expect(logged.statusCode).toBe(201);
    expect(
      (blob.get(ENTRY_PATH("u_sam")) as { allocations: Array<{ jobId: string }> }).allocations.map(
        (a) => a.jobId
      )
    ).toEqual(["place:workshop", "smith-st"]);

    // Jo is on no jobs: a whole Office day.
    const office = await send(entries, "POST", "u_jo", "tradie", day([{ jobId: "place:office", hours: 7.6 }]));
    expect(office.statusCode).toBe(201);

    // The office's approval queue names the places.
    const queue = await send(entries, "GET", "u_office", "office", undefined, { scope: "approver" });
    expect(queue.statusCode).toBe(200);
    const names = (queue.body as { entries: Array<{ userId: string; allocations: Array<{ jobName: string | null }> }> })
      .entries
      .map((e) => [e.userId, e.allocations.map((a) => a.jobName)]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["u_sam", ["Workshop", "Smith St Rewire"]],
        ["u_jo", ["Office"]],
      ])
    );

    // Approve both, then the payroll export carries named, ordinary-pay rows.
    for (const userId of ["u_sam", "u_jo"]) {
      const res = await send(approve, "POST", "u_office", "office", { userId, date: TODAY });
      expect(res.statusCode).toBe(200);
    }
    const exported = await send(exportEntries, "GET", "u_office", "office", undefined, {
      format: "json",
      dryRun: "1",
      fromDate: TODAY,
      toDate: TODAY,
    });
    expect(exported.statusCode).toBe(200);
    const rows = (exported.body as {
      rows: Array<{ workerId: string; jobName: string; jobId: string; hours: number; dayType: string | null }>;
    }).rows.map((r) => [r.workerId, r.jobName, r.jobId, r.hours, r.dayType]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["u_sam", "Workshop", "place:workshop", 4, null],
        ["u_sam", "Smith St Rewire", "smith-st", 3.6, null],
        ["u_jo", "Office", "place:office", 7.6, null],
      ])
    );
    expect(rows).toHaveLength(3);
  });

  it("a worker can change a job day to all Workshop", async () => {
    expect((await send(entries, "POST", "u_sam", "tradie", day([{ jobId: "smith-st", hours: 7.6 }]))).statusCode).toBe(201);
    const changed = await send(
      entries,
      "PATCH",
      "u_sam",
      "tradie",
      day([{ jobId: "place:workshop", hours: 7.6 }]),
      { date: TODAY }
    );
    expect(changed.statusCode).toBe(200);
    expect(
      (blob.get(ENTRY_PATH("u_sam")) as { allocations: Array<{ jobId: string }> }).allocations[0]!.jobId
    ).toBe("place:workshop");
  });

  it("a made-up place is still refused", async () => {
    const res = await send(entries, "POST", "u_sam", "tradie", day([{ jobId: "place:garage", hours: 7.6 }]));
    expect(res.statusCode).toBe(403);
    expect(blob.has(ENTRY_PATH("u_sam"))).toBe(false);
  });
});
