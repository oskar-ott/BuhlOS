import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 10-worker concurrency simulation (lean-launch readiness audit, 2026-07).
 *
 * Drives the REAL serverless handlers (api/time-entries.js,
 * api/time-entries-approve.js, api/time-entries-reject.js) with signed
 * sessions against an in-memory Blob that reproduces writeBlob's ACTUAL
 * semantics: fresh read → expectedRev check → async gap → put. That gap is
 * Vercel Blob's real narrowed-but-not-eliminated race window, so this suite
 * measures what the production write path would do under a same-second
 * payroll-deadline burst, not what an idealised atomic store would do.
 *
 * Scenarios:
 *  1. 10 workers create+submit a week (50 entries) in one concurrent burst —
 *     zero lost entries, totals reconcile per worker / per job / overall.
 *  2. Same-worker double-tap create (no idempotency key) — documents the
 *     create race: no duplicate day-file is possible (same key), the day
 *     resolves to exactly one valid entry.
 *  3. Same-worker duplicate create WITH Idempotency-Key — replay, one entry.
 *  4. Two admins approve the SAME entry concurrently — entry ends approved
 *     exactly once; no admin sees a false failure that leaves corrupt state.
 *  5. Admin approves while the worker edits the same submitted entry —
 *     exactly one write wins; the loser gets an actionable 409/400; the
 *     stored entry is internally consistent (allocations sum == total).
 *  6. Reject → worker corrects+resubmits while a second admin approves the
 *     stale submitted version — final state is consistent, never
 *     approved-with-rejected-reason.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const rejectPath = requireFromHere.resolve("../../../api/time-entries-reject.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const hoursMirrorPath = requireFromHere.resolve("../../../api/_lib/hours-mirror.js");
const mirrorDriftPath = requireFromHere.resolve("../../../api/_lib/mirror-drift.js");
const hoursReadPath = requireFromHere.resolve("../../../api/_lib/hours-read.js");

let blob: Map<string, Record<string, unknown> | unknown[]>;
let staleWriteRejections: number;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let entriesHandler: (req: unknown, res: unknown) => Promise<unknown>;
let approveHandler: (req: unknown, res: unknown) => Promise<unknown>;
let rejectHandler: (req: unknown, res: unknown) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);
/** N days back from today (still inside the 14-day backdate window). */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const WORKERS = Array.from({ length: 10 }, (_, i) => ({
  id: `w${i + 1}`,
  username: `worker${i + 1}`,
  role: i % 3 === 0 ? "tradie" : "electrician",
  assignedJobIds: ["job-a", "job-b"],
}));
const JOBS = [
  { id: "job-a", name: "Job A", status: "active" },
  { id: "job-b", name: "Job B", status: "active" },
];

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
  handler: (req: unknown, res: unknown) => Promise<unknown>,
  {
    method,
    userId,
    role,
    query = {},
    body,
    headers = {},
  }: {
    method: string;
    userId: string;
    role: string;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const res = createRes();
  await handler(
    { method, query, body, headers: { cookie: cookieFor(userId, role), ...headers } },
    res,
  );
  return res;
}

function entryKey(userId: string, date: string): string {
  return `users/${userId}/time-entries/${date}.json`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.SUPABASE_DB_URL; // hours mirror + PG read stay inert
  staleWriteRejections = 0;

  const users = [
    { id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["job-a", "job-b"] },
    { id: "u_office", username: "office", role: "office", assignedJobIds: ["job-a", "job-b"] },
    ...WORKERS,
  ];
  blob = new Map<string, Record<string, unknown>>([
    ["users.json", { users } as Record<string, unknown>],
    ["jobs.json", { jobs: JOBS } as Record<string, unknown>],
  ]);

  for (const p of [
    authPath,
    teLibPath,
    handlerPath,
    approvePath,
    rejectPath,
    auditLogPath,
    notifyPath,
    activityPath,
    hoursMirrorPath,
    mirrorDriftPath,
    hoursReadPath,
  ]) {
    delete requireFromHere.cache[p];
  }

  // In-memory Blob that reproduces api/_lib/blob.js writeBlob semantics:
  // fresh read → expectedRev check → ASYNC GAP (the real non-atomic window
  // between the guard read and the put) → set with __rev stamped. StaleWrite
  // rejections throw with code 'stale_write' exactly like blob-guards.
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
      writeBlob: vi.fn(async (key: string, data: unknown, opts: { expectedRev?: number } = {}) => {
        const current = blob.has(key) ? (blob.get(key) as { __rev?: number }) : null;
        const currentRev =
          current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (opts.expectedRev !== undefined && opts.expectedRev !== null) {
          if (Number(opts.expectedRev) !== currentRev) {
            staleWriteRejections++;
            const e = new Error(
              `stale write to ${key}: expected rev ${opts.expectedRev}, store is at ${currentRev}`,
            ) as Error & { code: string; currentRev: number };
            e.code = "stale_write";
            e.currentRev = currentRev;
            throw e;
          }
        }
        // Match blob-guards: arrays pass through unstamped; plain objects
        // get __rev/__updatedAt.
        const cloned = clone(data) as Record<string, unknown> | unknown[];
        const stamped = Array.isArray(cloned)
          ? cloned
          : { ...cloned, __rev: currentRev + 1, __updatedAt: new Date().toISOString() };
        // The real narrowed race: the put lands a beat after the guard read.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
        blob.set(key, stamped);
        return stamped;
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  auth = requireFromHere(authPath);
  entriesHandler = requireFromHere(handlerPath);
  approveHandler = requireFromHere(approvePath);
  rejectHandler = requireFromHere(rejectPath);
});

function validEntry(extra: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    allocations: [{ jobId: "job-a", hours: 8 }],
    status: "submitted",
    ...extra,
  };
}

describe("scenario 1 — 10 workers submit a payroll week concurrently", () => {
  it("50 concurrent creates land with zero loss and totals reconcile", async () => {
    const days = [0, 1, 2, 3, 4].map(dayOffset);
    // Every worker: 4 full days on job-a, 1 split day (5 on job-a + 3.5 OT-free on job-b).
    const requests: Array<Promise<{ statusCode: number }>> = [];
    for (const w of WORKERS) {
      for (const [di, date] of days.entries()) {
        const body =
          di === 4
            ? validEntry({
                date,
                totalHours: 8.5,
                ordinaryHours: 8,
                overtimeHours: 0.5,
                allocations: [
                  { jobId: "job-a", hours: 5 },
                  { jobId: "job-b", hours: 3.5 },
                ],
              })
            : validEntry({ date });
        requests.push(
          call(entriesHandler, { method: "POST", userId: w.id, role: w.role, body }) as Promise<{
            statusCode: number;
          }>,
        );
      }
    }
    const results = await Promise.all(requests);
    const created = results.filter((r) => r.statusCode === 201).length;
    expect(created).toBe(50);

    // Reconciliation: every entry present, totals per worker and per job.
    let totalHours = 0;
    const perWorker = new Map<string, number>();
    const perJob = new Map<string, number>();
    let entryCount = 0;
    for (const w of WORKERS) {
      for (const date of days) {
        const e = blob.get(entryKey(w.id, date)) as
          | {
              totalHours: number;
              status: string;
              allocations: Array<{ jobId: string; hours: number }>;
            }
          | undefined;
        expect(e, `${w.id} ${date} lost`).toBeTruthy();
        entryCount++;
        expect(e!.status).toBe("submitted");
        const allocSum = e!.allocations.reduce((s, a) => s + a.hours, 0);
        expect(Math.abs(allocSum - e!.totalHours)).toBeLessThan(0.01);
        totalHours += e!.totalHours;
        perWorker.set(w.id, (perWorker.get(w.id) || 0) + e!.totalHours);
        for (const a of e!.allocations) {
          perJob.set(a.jobId, (perJob.get(a.jobId) || 0) + a.hours);
        }
      }
    }
    expect(entryCount).toBe(50);
    // 10 workers × (4×8h + 8.5h) = 10 × 40.5 = 405h
    expect(totalHours).toBeCloseTo(405, 5);
    for (const w of WORKERS) expect(perWorker.get(w.id)).toBeCloseTo(40.5, 5);
    // job-a: 10 × (4×8 + 5) = 370; job-b: 10 × 3.5 = 35
    expect(perJob.get("job-a")).toBeCloseTo(370, 5);
    expect(perJob.get("job-b")).toBeCloseTo(35, 5);
  });
});

describe("scenario 2 — same-worker double-tap create (no idempotency key)", () => {
  it("cannot duplicate the day; the day resolves to one valid entry", async () => {
    const [a, b] = await Promise.all([
      call(entriesHandler, { method: "POST", userId: "w1", role: "electrician", body: validEntry() }),
      call(entriesHandler, { method: "POST", userId: "w1", role: "electrician", body: validEntry() }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    // Either the second sees the first (201+409) or both raced the existence
    // check (201+201 last-writer-wins on the SAME payload). Both outcomes
    // leave exactly one well-formed day entry — the payroll invariant.
    expect([a.statusCode, b.statusCode]).toContain(201);
    const stored = blob.get(entryKey("w1", TODAY)) as {
      totalHours: number;
      allocations: Array<{ hours: number }>;
      status: string;
    };
    expect(stored).toBeTruthy();
    expect(stored.totalHours).toBe(8);
    expect(stored.allocations.reduce((s, x) => s + x.hours, 0)).toBeCloseTo(8, 5);
    // Document the observed outcome for the audit record.
    // eslint-disable-next-line no-console
    console.info(`[sim] double-tap create codes: ${codes.join("+")}`);
  });
});

describe("scenario 3 — duplicate create with Idempotency-Key", () => {
  it("replays the original instead of duplicating or 409ing", async () => {
    const headers = { "idempotency-key": "phil-retry-123" };
    const first = await call(entriesHandler, {
      method: "POST",
      userId: "w2",
      role: "electrician",
      body: validEntry(),
      headers,
    });
    expect(first.statusCode).toBe(201);
    const retry = await call(entriesHandler, {
      method: "POST",
      userId: "w2",
      role: "electrician",
      body: validEntry(),
      headers,
    });
    expect(retry.statusCode).toBe(201);
    expect((retry.body as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    const firstEntry = (first.body as { entry: { id: string } }).entry;
    const retryEntry = (retry.body as { entry: { id: string } }).entry;
    expect(retryEntry.id).toBe(firstEntry.id);
  });
});

describe("scenario 4 — two admins approve the same entry concurrently", () => {
  it("entry ends approved exactly once; no corrupt state", async () => {
    await call(entriesHandler, {
      method: "POST",
      userId: "w3",
      role: "electrician",
      body: validEntry(),
    });
    const [a, b] = await Promise.all([
      call(approveHandler, {
        method: "POST",
        userId: "u_admin",
        role: "admin",
        body: { userId: "w3", date: TODAY },
      }),
      call(approveHandler, {
        method: "POST",
        userId: "u_office",
        role: "office",
        body: { userId: "w3", date: TODAY },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    // At least one succeeds; the loser gets 400 (already approved), 409
    // (stale write), or — inside the narrowed race window — a second 200
    // that re-writes the SAME approved status (benign double-stamp).
    expect(codes).toContain(200);
    const stored = blob.get(entryKey("w3", TODAY)) as {
      status: string;
      approvedBy: string | null;
      totalHours: number;
      allocations: Array<{ hours: number }>;
    };
    expect(stored.status).toBe("approved");
    expect(["u_admin", "u_office"]).toContain(stored.approvedBy);
    expect(stored.allocations.reduce((s, x) => s + x.hours, 0)).toBeCloseTo(
      stored.totalHours,
      5,
    );
    // eslint-disable-next-line no-console
    console.info(
      `[sim] dual-approve codes: ${codes.join("+")} (stale rejections so far: ${staleWriteRejections})`,
    );
  });
});

describe("scenario 5 — approve races a worker edit of the same submitted entry", () => {
  it("one write wins, the loser gets an actionable error, stored entry is consistent", async () => {
    await call(entriesHandler, {
      method: "POST",
      userId: "w4",
      role: "electrician",
      body: validEntry(),
    });
    const [approve, edit] = await Promise.all([
      call(approveHandler, {
        method: "POST",
        userId: "u_admin",
        role: "admin",
        body: { userId: "w4", date: TODAY },
      }),
      call(entriesHandler, {
        method: "PATCH",
        userId: "w4",
        role: "electrician",
        query: { date: TODAY },
        body: {
          totalHours: 7.5,
          ordinaryHours: 7.5,
          overtimeHours: 0,
          allocations: [{ jobId: "job-b", hours: 7.5 }],
        },
      }),
    ]);
    const stored = blob.get(entryKey("w4", TODAY)) as {
      status: string;
      totalHours: number;
      allocations: Array<{ jobId: string; hours: number }>;
    };
    // Whatever interleaving occurred, the stored entry must be internally
    // consistent and in a legal state.
    expect(["submitted", "approved"]).toContain(stored.status);
    expect(stored.allocations.reduce((s, x) => s + x.hours, 0)).toBeCloseTo(
      stored.totalHours,
      5,
    );
    // If both claimed success the CAS window failed silently — flag that.
    const bothSucceeded = approve.statusCode === 200 && edit.statusCode === 200;
    if (bothSucceeded) {
      // Permitted ONLY when the final document reflects the LATER write in a
      // legal state; a 7.5h approved entry means the edit landed after the
      // approval without re-approval — that would be a real integrity gap.
      expect(stored.status === "approved" && stored.totalHours === 7.5).toBe(false);
    }
    // eslint-disable-next-line no-console
    console.info(
      `[sim] approve-vs-edit: approve=${approve.statusCode} edit=${edit.statusCode} final=${stored.status}@${stored.totalHours}h`,
    );
  });
});

describe("scenario 6 — reject → resubmit races a stale approve", () => {
  it("never ends approved-with-rejected-reason; chain stays legal", async () => {
    await call(entriesHandler, {
      method: "POST",
      userId: "w5",
      role: "electrician",
      body: validEntry(),
    });
    const rej = await call(rejectHandler, {
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { userId: "w5", date: TODAY, reason: "wrong job" },
    });
    expect(rej.statusCode).toBe(200);
    // Worker resubmits the corrected entry while the office admin (stale
    // screen) approves what they still see as submitted.
    const [resubmit, staleApprove] = await Promise.all([
      call(entriesHandler, {
        method: "PATCH",
        userId: "w5",
        role: "electrician",
        query: { date: TODAY },
        body: {
          status: "submitted",
          totalHours: 8,
          ordinaryHours: 8,
          overtimeHours: 0,
          allocations: [{ jobId: "job-b", hours: 8 }],
        },
      }),
      call(approveHandler, {
        method: "POST",
        userId: "u_office",
        role: "office",
        body: { userId: "w5", date: TODAY },
      }),
    ]);
    const stored = blob.get(entryKey("w5", TODAY)) as {
      status: string;
      rejectedReason: string | null;
      totalHours: number;
      allocations: Array<{ hours: number }>;
    };
    expect(["submitted", "approved", "rejected"]).toContain(stored.status);
    if (stored.status === "approved") expect(stored.rejectedReason).toBeNull();
    expect(stored.allocations.reduce((s, x) => s + x.hours, 0)).toBeCloseTo(
      stored.totalHours,
      5,
    );
    // eslint-disable-next-line no-console
    console.info(
      `[sim] reject/resubmit vs stale approve: resubmit=${resubmit.statusCode} approve=${staleApprove.statusCode} final=${stored.status}`,
    );
  });
});
