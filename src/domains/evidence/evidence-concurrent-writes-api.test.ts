import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Concurrent evidence writes must not lose rows (#157/#511 pattern applied to
 * jobs/<id>/data.json — the lean-launch audit's P1-2).
 *
 * The mocked store models each PUT as atomic (an object-store PUT is), with
 * the async scheduling gap BEFORE the write — so the window between a
 * handler's document read and its write moment is real, but the
 * expectedRev check-and-set inside writeBlob is adjacent. Under that model:
 * the OLD create/review path (no expectedRev, document read at handler
 * start) deterministically loses the slower writer's row; the fixed path
 * detects the conflict (stale_write), re-reads, re-applies and converges
 * with no loss. The residual sub-writeBlob race Vercel Blob cannot close
 * ("narrows the race, can't eliminate it" — api/_lib/blob.js) is documented
 * in api/evidence.js and the lean-launch audit; its structural close-out is
 * the evidence PG-as-source rung, not more Blob retries.
 *
 * Pinned here:
 *  1. Two workers capture photos into the SAME job at the same moment →
 *     both evidence rows survive.
 *  2. A 6-photo burst from three workers → all six rows survive.
 *  3. An admin review racing a worker capture → both the new row and the
 *     review land; neither write is lost.
 *  4. A stale review (item moved underneath) answers 409, never re-applies.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/evidence.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const idempotencyPath = requireFromHere.resolve("../../../api/_lib/idempotency.js");

let blob: Map<string, Record<string, unknown> | unknown[]>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: unknown, res: unknown) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(c: number) {
      this.statusCode = c;
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
function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call({
  method,
  userId,
  role,
  query = {},
  body,
}: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler({ method, query, body, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

const DATA_KEY = "jobs/job-a/data.json";

function photoBody(n: number) {
  return {
    kind: "photo",
    photoId: `ph_${n}`,
    photoUrl: `https://blob.example/photo-${n}.jpg`,
    note: `capture ${n}`,
  };
}

function evidenceRows(): Array<{ id: string; note: string | null; status: string }> {
  const doc = blob.get(DATA_KEY) as { evidence?: Array<{ id: string; note: string | null; status: string }> };
  return (doc && doc.evidence) || [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";

  blob = new Map<string, Record<string, unknown> | unknown[]>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["job-a"] },
          { id: "w1", username: "alice", role: "electrician", assignedJobIds: ["job-a"] },
          { id: "w2", username: "bob", role: "tradie", assignedJobIds: ["job-a"] },
          { id: "w3", username: "cam", role: "electrician", assignedJobIds: ["job-a"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active" }] }],
  ]);

  for (const p of [authPath, handlerPath, auditLogPath, idempotencyPath]) {
    delete requireFromHere.cache[p];
  }

  // Faithful writeBlob emulation: fresh read → expectedRev check → async gap →
  // stamped set. Same shape as hours-concurrency-sim.test.ts.
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
        // Scheduling gap BEFORE the write moment — interleaves handlers.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
        // Atomic check-and-set (no await between check and set).
        const current = blob.has(key) ? (blob.get(key) as { __rev?: number }) : null;
        const currentRev =
          current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
        if (opts.expectedRev !== undefined && opts.expectedRev !== null) {
          if (Number(opts.expectedRev) !== currentRev) {
            const e = new Error(
              `stale write to ${key}: expected rev ${opts.expectedRev}, store is at ${currentRev}`,
            ) as Error & { code: string; currentRev: number };
            e.code = "stale_write";
            e.currentRev = currentRev;
            throw e;
          }
        }
        const cloned = clone(data) as Record<string, unknown> | unknown[];
        const stamped = Array.isArray(cloned)
          ? cloned
          : { ...cloned, __rev: currentRev + 1, __updatedAt: new Date().toISOString() };
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
  handler = requireFromHere(handlerPath);
});

describe("concurrent evidence captures on one job", () => {
  it("two simultaneous captures both survive (the P1-2 lost-update)", async () => {
    const [a, b] = await Promise.all([
      call({ method: "POST", userId: "w1", role: "electrician", query: { jobId: "job-a" }, body: photoBody(1) }),
      call({ method: "POST", userId: "w2", role: "tradie", query: { jobId: "job-a" }, body: photoBody(2) }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const rows = evidenceRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.note))).toEqual(new Set(["capture 1", "capture 2"]));
  });

  it("a 6-photo burst from three workers keeps all six rows", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        call({
          method: "POST",
          userId: `w${(n % 3) + 1}`,
          role: "electrician",
          query: { jobId: "job-a" },
          body: photoBody(n),
        }),
      ),
    );
    for (const r of results) expect(r.statusCode).toBe(201);
    const rows = evidenceRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.note))).toEqual(
      new Set([1, 2, 3, 4, 5, 6].map((n) => `capture ${n}`)),
    );
  });

  it("admin review racing a worker capture — neither write is lost", async () => {
    const first = await call({
      method: "POST",
      userId: "w1",
      role: "electrician",
      query: { jobId: "job-a" },
      body: photoBody(1),
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.body as { evidenceItem: { id: string } }).evidenceItem.id;

    const [review, capture] = await Promise.all([
      call({
        method: "POST",
        userId: "u_admin",
        role: "admin",
        query: { jobId: "job-a", action: "review" },
        body: { evidenceId: firstId, status: "reviewed" },
      }),
      call({ method: "POST", userId: "w2", role: "tradie", query: { jobId: "job-a" }, body: photoBody(2) }),
    ]);
    expect(review.statusCode).toBe(200);
    expect(capture.statusCode).toBe(201);
    const rows = evidenceRows();
    expect(rows).toHaveLength(2);
    const reviewed = rows.find((r) => r.id === firstId);
    expect(reviewed?.status).toBe("reviewed");
  });

  it("a stale review answers 409 when the item moved underneath", async () => {
    const first = await call({
      method: "POST",
      userId: "w1",
      role: "electrician",
      query: { jobId: "job-a" },
      body: photoBody(1),
    });
    const firstId = (first.body as { evidenceItem: { id: string } }).evidenceItem.id;
    const ok = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { jobId: "job-a", action: "review" },
      body: { evidenceId: firstId, status: "reviewed" },
    });
    expect(ok.statusCode).toBe(200);

    // Second admin decides from a stale screen: the submitted→rejected
    // transition is now illegal (item is reviewed) — the fast-fail transition
    // check answers 400; a CAS-window interleaving answers 409 from the fresh
    // re-check. Either way the stale decision is never applied.
    const stale = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { jobId: "job-a", action: "review" },
      body: { evidenceId: firstId, status: "rejected", rejectionReason: "stale decision" },
    });
    expect([400, 409]).toContain(stale.statusCode);
    const rows = evidenceRows();
    expect(rows.find((r) => r.id === firstId)?.status).toBe("reviewed");
  });
});
