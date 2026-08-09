import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for "fix the hours and approve"
 * (api/time-entries-amend-approve.js) — the owner-directed motion that lets the
 * office correct an obvious mis-entry at approval time instead of bouncing the
 * day back to the worker.
 *
 * This is PAY, so the tests pin the guardrails, not just the happy path:
 * admin-tier only, reason required, submitted-only, ONE atomic write with the
 * entry's CAS revision, OT re-split from the corrected total, allocations that
 * must still sum, jobs that must still be real + active, and the amendment
 * metadata the worker's screen reads.
 *
 * Harness mirrors time-entry-actions-api.test.ts (module-cache injection of the
 * blob/push/activity layers) so the two suites can't drift.
 */
const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const amendPath = requireFromHere.resolve("../../../api/time-entries-amend-approve.js");

const TODAY = new Date().toISOString().slice(0, 10);
const ENTRY_PATH = (userId: string) => `users/${userId}/time-entries/${TODAY}.json`;

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

interface StoredEntry {
  status: string;
  totalHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  otOverridden?: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
  allocations: Array<{ jobId: string | null; hours: number; sortOrder?: number }>;
  amendedBy?: string;
  amendedByName?: string | null;
  amendedAt?: string;
  amendedReason?: string;
  amendedFrom?: {
    totalHours: number;
    ordinaryHours?: number;
    overtimeHours?: number;
    allocations: Array<{ jobId: string | null; hours: number }>;
  };
  __idempotency?: unknown[];
}

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let amend: Handler;
let auditRows: Array<Record<string, unknown>>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function user(id: string, role: string, assignedJobIds: string[] = []) {
  return { id, username: id, role, assignedJobIds };
}

/** A submitted 8h 22m day on one job — the live incident's shape. */
function entry(over: Partial<StoredEntry> = {}) {
  return {
    id: "entry_u_field",
    userId: "u_field",
    userName: "Sparky",
    userRole: "tradie",
    date: TODAY,
    totalHours: 8.37,
    ordinaryHours: 8,
    overtimeHours: 0.37,
    status: "submitted",
    submittedAt: `${TODAY}T08:00:00.000Z`,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "job-x", hours: 8.37, notes: null, sortOrder: 0 }],
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T08:00:00.000Z`,
    __rev: "r1",
    ...over,
  };
}

function setEntry(over: Partial<StoredEntry> = {}) {
  blob.set(ENTRY_PATH("u_field"), entry(over));
}

function stored(userId = "u_field") {
  return blob.get(ENTRY_PATH(userId)) as unknown as StoredEntry;
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

async function call(actorId: string, role: string, body: unknown, method = "POST") {
  const res = createRes();
  await amend({ method, body, query: {}, headers: { cookie: cookieFor(actorId, role) } }, res);
  return res;
}

/** The default correction: 8h 22m → 8h 36m (8.6h), with a reason. */
const FIX = { userId: "u_field", date: TODAY, totalHours: 8.6, reason: "Typo — you meant 8h 36m" };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  auditRows = [];
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          user("u_admin", "admin"),
          user("u_office", "office"),
          user("u_lh", "leadingHand", ["job-x"]),
          user("u_field", "tradie", ["job-x"]),
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-x", name: "Job X", status: "active" },
          { id: "job-y", name: "Job Y", status: "active" },
          { id: "job-old", name: "Job Old", status: "archived" },
        ],
      },
    ],
  ]);
  setEntry();

  for (const modulePath of [
    blobSdkPath,
    blobPath,
    authPath,
    timeEntriesLibPath,
    pushPath,
    activityPath,
    auditLogPath,
    amendPath,
  ]) {
    delete requireFromHere.cache[modulePath];
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
  requireFromHere.cache[auditLogPath] = {
    id: auditLogPath,
    filename: auditLogPath,
    loaded: true,
    exports: {
      append: vi.fn(async (row: Record<string, unknown>) => {
        auditRows.push(row);
      }),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  amend = requireFromHere(amendPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pushMock() {
  return (requireFromHere.cache[pushPath] as NodeJS.Module).exports
    .sendPushToUserId as ReturnType<typeof vi.fn>;
}
function activityMock() {
  return (requireFromHere.cache[activityPath] as NodeJS.Module).exports
    .appendActivity as ReturnType<typeof vi.fn>;
}

describe("amend + approve — the happy path (the live incident)", () => {
  it("corrects 8h 22m to 8h 36m AND approves in one write", async () => {
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(200);
    const e = stored();
    expect(e.status).toBe("approved");
    expect(e.approvedBy).toBe("u_admin");
    expect(e.totalHours).toBe(8.6);
    // The single allocation moved with the total — no orphaned job hours.
    expect(e.allocations).toHaveLength(1);
    expect(e.allocations[0]!.jobId).toBe("job-x");
    expect(e.allocations[0]!.hours).toBe(8.6);
  });

  it("re-splits OT from the CORRECTED total, never the old one", async () => {
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(200);
    const e = stored();
    expect(e.ordinaryHours).toBe(7.6);
    expect(e.overtimeHours).toBe(1); // 8.6 - 7.6, recomputed at the standard-day boundary
    expect(e.ordinaryHours + e.overtimeHours).toBeCloseTo(e.totalHours, 5);
  });

  it("a manual OT override does not survive the amend — the split is derived again", async () => {
    setEntry({ otOverridden: true, ordinaryHours: 8.37, overtimeHours: 0 });
    await call("u_admin", "admin", { ...FIX, totalHours: 10 });
    // Split re-derived at the standard-day boundary (7.6h, owner 2026-08-09).
    const e = stored();
    expect(e.otOverridden).toBe(false);
    expect(e.ordinaryHours).toBe(7.6);
    expect(e.overtimeHours).toBe(2.4);
  });

  it("rewrites every allocation of a SPLIT day and derives the total", async () => {
    setEntry({
      totalHours: 8,
      ordinaryHours: 8,
      overtimeHours: 0,
      allocations: [
        { jobId: "job-x", hours: 5, sortOrder: 0 },
        { jobId: "job-y", hours: 3, sortOrder: 1 },
      ],
    });
    const res = await call("u_admin", "admin", {
      userId: "u_field",
      date: TODAY,
      reason: "Three hours were on the Depot, not Job X",
      allocations: [
        { jobId: "job-x", hours: 6 },
        { jobId: "job-y", hours: 3 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const e = stored();
    expect(e.totalHours).toBe(9);
    expect(e.allocations.map((a) => a.hours)).toEqual([6, 3]);
    expect(e.allocations.map((a) => a.sortOrder)).toEqual([0, 1]);
    // 9h total → 1.4h OT past the standard day (7.6h boundary, owner 2026-08-09).
    expect(e.overtimeHours).toBe(1.4);
  });

  it("returns the corrected entry and never leaks the idempotency ring", async () => {
    setEntry({
      __idempotency: [{ key: `entry:u_field:${TODAY}:k1`, result: { id: "entry_u_field" }, at: TODAY }],
    });
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(200);
    const body = res.body as { entry: Record<string, unknown> };
    expect(body.entry.totalHours).toBe(8.6);
    expect(body.entry.__idempotency).toBeUndefined();
    // …but the STORED ring survives, so an in-flight create/edit replay still
    // resolves (same contract as approve/reject).
    expect(stored().__idempotency).toHaveLength(1);
  });
});

describe("the worker always sees it — amendment metadata + push", () => {
  it("stamps who/when/why and the full BEFORE picture on the entry", async () => {
    await call("u_admin", "admin", FIX);
    const e = stored();
    expect(e.amendedBy).toBe("u_admin");
    expect(e.amendedByName).toBe("u_admin");
    expect(typeof e.amendedAt).toBe("string");
    expect(e.amendedReason).toBe("Typo — you meant 8h 36m");
    expect(e.amendedFrom).toMatchObject({
      totalHours: 8.37,
      ordinaryHours: 8,
      overtimeHours: 0.37,
    });
    expect(e.amendedFrom!.allocations).toEqual([
      { jobId: "job-x", hours: 8.37, notes: null, sortOrder: 0 },
    ]);
  });

  it("pushes the worker the real before → after in duration words, deep-linked to their hours", async () => {
    await call("u_admin", "admin", FIX);
    expect(pushMock()).toHaveBeenCalledWith(
      "u_field",
      expect.objectContaining({
        title: "Hours adjusted and approved",
        url: "/phil/hours",
        body: expect.stringContaining("8h 22m → 8h 36m"),
      })
    );
    const payload = pushMock().mock.calls[0]![1] as { body: string };
    expect(payload.body).toContain("adjusted and approved");
    // Durations, never decimals — the dialect the whole fix exists to protect.
    expect(payload.body).not.toContain("8.37");
  });
});

describe("audit trail", () => {
  it("writes the canonical journal row with the reason AND the before-total", async () => {
    await call("u_admin", "admin", FIX);
    const row = auditRows.find((r) => r.action === "hours.amended_approved");
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ actorId: "u_admin", targetType: "time_entry", jobId: "job-x" });
    expect(row!.metadata).toMatchObject({
      userId: "u_field",
      date: TODAY,
      status: "approved",
      totalHours: 8.6,
      fromTotalHours: 8.37,
      reason: "Typo — you meant 8h 36m",
    });
  });

  it("writes the activity row and the per-user audit row (with the diff)", async () => {
    await call("u_admin", "admin", FIX);
    expect(activityMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hours.amended_approved",
        actor: "u_admin",
        reason: "Typo — you meant 8h 36m",
        meta: expect.objectContaining({ fromTotalHours: 8.37, totalHours: 8.6 }),
      })
    );
    const auditKey = `users/u_field/time-entries-audit/${TODAY.slice(0, 7)}.json`;
    const log = blob.get(auditKey) as Array<Record<string, unknown>>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "amended-approved", changedBy: "u_admin" });
    expect(log[0]!.note).toBe("Typo — you meant 8h 36m");
    expect(log[0]!.diff).toMatchObject({
      totalHours: { from: 8.37, to: 8.6 },
      status: { from: "submitted", to: "approved" },
    });
  });
});

describe("who may fix hours — admin tier only", () => {
  it("403s a leading hand, and the entry stays submitted at its original hours", async () => {
    const res = await call("u_lh", "leadingHand", FIX);
    expect(res.statusCode).toBe(403);
    expect(stored().status).toBe("submitted");
    expect(stored().totalHours).toBe(8.37);
  });

  it("403s a field worker", async () => {
    const res = await call("u_field", "tradie", { ...FIX, userId: "u_other" });
    expect(res.statusCode).toBe(403);
  });

  it("allows the wider admin tier (office), not just role 'admin'", async () => {
    const res = await call("u_office", "office", FIX);
    expect(res.statusCode).toBe(200);
    expect(stored().approvedBy).toBe("u_office");
  });

  it("refuses to let anyone fix their OWN hours", async () => {
    blob.set(ENTRY_PATH("u_admin"), { ...entry(), userId: "u_admin", id: "entry_u_admin" });
    const res = await call("u_admin", "admin", { ...FIX, userId: "u_admin" });
    expect(res.statusCode).toBe(403);
  });

  it("401s without a session", async () => {
    const res = createRes();
    await amend({ method: "POST", body: FIX, query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it("405s a non-POST", async () => {
    const res = await call("u_admin", "admin", FIX, "GET");
    expect(res.statusCode).toBe(405);
  });
});

describe("what may be fixed — submitted only, reason required", () => {
  it("requires a reason (empty/whitespace is not a reason)", async () => {
    const missing = await call("u_admin", "admin", { ...FIX, reason: "" });
    expect(missing.statusCode).toBe(400);
    expect((missing.body as { error: string }).error).toMatch(/reason/i);

    const blank = await call("u_admin", "admin", { ...FIX, reason: "   " });
    expect(blank.statusCode).toBe(400);
    expect(stored().status).toBe("submitted");
  });

  it("409s an already-approved day — reopen it first", async () => {
    setEntry({ status: "approved" });
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ currentStatus: "approved" });
    expect(stored().totalHours).toBe(8.37);
  });

  it("409s a draft and a rejected day too", async () => {
    for (const status of ["draft", "rejected"]) {
      setEntry({ status });
      const res = await call("u_admin", "admin", FIX);
      expect(res.statusCode).toBe(409);
      expect(stored().status).toBe(status);
    }
  });

  it("404s a day with no entry", async () => {
    blob.delete(ENTRY_PATH("u_field"));
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(404);
  });

  it("400s without userId/date or without any new time", async () => {
    expect((await call("u_admin", "admin", { date: TODAY, reason: "x" })).statusCode).toBe(400);
    expect((await call("u_admin", "admin", { userId: "u_field", reason: "x" })).statusCode).toBe(400);
    const noTime = await call("u_admin", "admin", { userId: "u_field", date: TODAY, reason: "x" });
    expect(noTime.statusCode).toBe(400);
    expect((noTime.body as { error: string }).error).toMatch(/totalHours or allocations/);
  });
});

describe("validation — identical rules to the worker's own submission", () => {
  it("rejects a total over the 16h day cap and a zero/negative total", async () => {
    const tooBig = await call("u_admin", "admin", { ...FIX, totalHours: 17 });
    expect(tooBig.statusCode).toBe(400);
    expect((tooBig.body as { error: string }).error).toMatch(/16/);

    const zero = await call("u_admin", "admin", { ...FIX, totalHours: 0 });
    expect(zero.statusCode).toBe(400);
    expect(stored().status).toBe("submitted");
  });

  it("rejects allocations that don't sum to the stated total", async () => {
    const res = await call("u_admin", "admin", {
      userId: "u_field",
      date: TODAY,
      reason: "wrong sum",
      totalHours: 9,
      allocations: [{ jobId: "job-x", hours: 5 }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/sum/i);
    expect(stored().status).toBe("submitted");
  });

  it("refuses to spread a bare total across a SPLIT day — it asks for each job", async () => {
    setEntry({
      totalHours: 8,
      allocations: [
        { jobId: "job-x", hours: 5 },
        { jobId: "job-y", hours: 3 },
      ],
    });
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/split across jobs/);
  });

  it("rejects an allocation pointed at an archived or unknown job", async () => {
    const archived = await call("u_admin", "admin", {
      userId: "u_field",
      date: TODAY,
      reason: "wrong job",
      allocations: [{ jobId: "job-old", hours: 8 }],
    });
    expect(archived.statusCode).toBe(400);
    expect((archived.body as { error: string }).error).toMatch(/active job/);

    const unknown = await call("u_admin", "admin", {
      userId: "u_field",
      date: TODAY,
      reason: "wrong job",
      allocations: [{ jobId: "job-nope", hours: 8 }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(stored().status).toBe("submitted");
  });

  it("rejects an empty allocations array", async () => {
    const res = await call("u_admin", "admin", {
      userId: "u_field",
      date: TODAY,
      reason: "x",
      allocations: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it("still fixes a timesheet older than the worker's 14-day backdating window", async () => {
    // The date isn't moving — the backdate rule protects LOGGING, not correcting.
    const oldDate = "2026-01-05";
    blob.set(`users/u_field/time-entries/${oldDate}.json`, { ...entry(), date: oldDate });
    const res = await call("u_admin", "admin", { ...FIX, date: oldDate });
    expect(res.statusCode).toBe(200);
    const e = blob.get(`users/u_field/time-entries/${oldDate}.json`) as unknown as StoredEntry;
    expect(e.status).toBe("approved");
    expect(e.totalHours).toBe(8.6);
  });
});

describe("concurrency — one guarded write, never a clobber", () => {
  it("threads the entry's revision as the CAS expectation", async () => {
    await call("u_admin", "admin", FIX);
    const writeBlob = (requireFromHere.cache[blobPath] as NodeJS.Module).exports
      .writeBlob as ReturnType<typeof vi.fn>;
    const entryWrite = writeBlob.mock.calls.find(
      (c) => String(c[0]).endsWith(`/time-entries/${TODAY}.json`)
    )!;
    expect(entryWrite[2]).toMatchObject({ expectedRev: "r1" });
  });

  it("409s a stale write (the day moved underneath the decision) without amending", async () => {
    const writeBlob = (requireFromHere.cache[blobPath] as NodeJS.Module).exports.writeBlob as {
      mockImplementationOnce: (fn: () => Promise<never>) => void;
    };
    writeBlob.mockImplementationOnce(async () => {
      throw Object.assign(new Error("stale"), { code: "stale_write", currentRev: "r9" });
    });
    const res = await call("u_admin", "admin", FIX);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: "conflict", currentRev: "r9" });
    expect(stored().status).toBe("submitted");
    expect(stored().totalHours).toBe(8.37);
  });
});
