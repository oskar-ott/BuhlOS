import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for api/observations.js create — the replay-safety contract (#497).
 *
 * Both create paths (job-scoped observation + the "send to office" item) append
 * to observations.json with a fresh nanoid, so a retry — a capture queued on a
 * dead connection and replayed on reconnect, or retried after a lost-response
 * timeout — would create a DUPLICATE (and, for the office path, re-fan-out the
 * admin push). With a client idempotency key the retry returns the ORIGINAL
 * item and writes nothing new; without a key behaviour is unchanged. Same
 * real-handler harness as observations-api.test.ts: in-memory Blob + real HMAC
 * sessions, push stubbed so the office fan-out is observable.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const obsPath = requireFromHere.resolve("../../../api/observations.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");

let blob: Map<string, unknown>;
let pushes: Array<{ userId: string }>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
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

async function call(opts: {
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  const res = createRes();
  const headers: Record<string, string> = { cookie: cookieFor(opts.userId || "u_field", opts.role) };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  await handler({ method: "POST", query: opts.query || {}, body: opts.body || {}, headers }, res);
  return res;
}

function storedObservations(): Array<{ id: string }> {
  const store = blob.get("observations.json") as { observations?: Array<{ id: string }> } | undefined;
  return store?.observations ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Birdwood", areaGroups: [] }] }],
    ["observations.json", { observations: [] }],
  ]);
  pushes = [];

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[obsPath];
  delete requireFromHere.cache[pushPath];
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
      getWebPush: vi.fn(() => null),
      sendPushToUserId: vi.fn(async (userId: string) => {
        pushes.push({ userId });
        return { sent: 1, pruned: 0, skipped: null };
      }),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(obsPath);
});

describe("POST /api/observations create — replay safety (#497)", () => {
  it("job create: a retry with the SAME key returns the original observation and appends nothing", async () => {
    const first = await call({
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
      body: { type: "blocker", title: "Cable path blocked" },
      idempotencyKey: "obs-abc",
    });
    expect(first.statusCode).toBe(201);
    const firstObs = (first.body as { observation: { id: string } }).observation;
    expect(firstObs.id).toMatch(/^ob_/);
    expect(storedObservations()).toHaveLength(1);

    const replay = await call({
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
      body: { type: "blocker", title: "different text, same key" },
      idempotencyKey: "obs-abc",
    });
    expect(replay.statusCode).toBe(201);
    const replayBody = replay.body as { observation: { id: string; title: string }; idempotentReplay?: boolean };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.observation.id).toBe(firstObs.id); // same item
    expect(replayBody.observation.title).toBe("Cable path blocked"); // original payload
    expect(storedObservations()).toHaveLength(1); // NO second append
  });

  it("job create: DIFFERENT keys both apply (distinct observations)", async () => {
    await call({ role: "electrician", query: { jobId: "job-1" }, body: { type: "note", title: "a" }, idempotencyKey: "k1" });
    await call({ role: "electrician", query: { jobId: "job-1" }, body: { type: "note", title: "b" }, idempotencyKey: "k2" });
    expect(new Set(storedObservations().map((o) => o.id)).size).toBe(2);
  });

  it("job create: without a key behaviour is unchanged — every create appends", async () => {
    await call({ role: "electrician", query: { jobId: "job-1" }, body: { type: "note", title: "a" } });
    await call({ role: "electrician", query: { jobId: "job-1" }, body: { type: "note", title: "a" } });
    expect(storedObservations()).toHaveLength(2);
  });

  it("office item: a retry with the SAME key returns the original AND does not re-fan-out the admin push", async () => {
    const first = await call({
      role: "electrician",
      userId: "u_field",
      query: { scope: "office" },
      body: { type: "note", title: "Parking fine on the ute" },
      idempotencyKey: "off-1",
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.body as { observation: { id: string } }).observation.id;
    expect(storedObservations()).toHaveLength(1);
    expect(pushes.filter((p) => p.userId === "u_boss")).toHaveLength(1); // notified once

    const replay = await call({
      role: "electrician",
      userId: "u_field",
      query: { scope: "office" },
      body: { type: "note", title: "Parking fine on the ute" },
      idempotencyKey: "off-1",
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.body as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    expect((replay.body as { observation: { id: string } }).observation.id).toBe(firstId);
    expect(storedObservations()).toHaveLength(1); // NO second office item
    expect(pushes.filter((p) => p.userId === "u_boss")).toHaveLength(1); // NOT re-notified
  });

  // #577 — observations.json shares ONE ring across the job + office create
  // paths (and is org-wide across jobs). The key must be scoped per op (+ job)
  // so a shared client key can't return the wrong record and silently drop a write.
  type Created = { observation: { id: string; title: string }; idempotentReplay?: boolean };

  it("#577: a job observation and an office item sharing ONE client key do not collide", async () => {
    const job = await call({
      role: "electrician", userId: "u_field", query: { jobId: "job-1" },
      body: { type: "note", title: "job obs" }, idempotencyKey: "shared-k",
    });
    expect(job.statusCode).toBe(201);
    const jobObsId = (job.body as Created).observation.id;

    const office = await call({
      role: "electrician", userId: "u_field", query: { scope: "office" },
      body: { type: "note", title: "office item" }, idempotencyKey: "shared-k",
    });
    expect(office.statusCode).toBe(201);
    const off = office.body as Created;
    expect(off.idempotentReplay).toBeFalsy(); // NOT a wrong replay of the job obs
    expect(off.observation.id).not.toBe(jobObsId); // distinct new item
    expect(off.observation.title).toBe("office item"); // office payload, not the job's
    expect(storedObservations()).toHaveLength(2); // both persisted — no silent loss
  });

  it("#577: two job observations on DIFFERENT jobs sharing one key do not collide", async () => {
    // org-wide store + a per-session client key that repeats across jobs (#143)
    blob.set("users.json", {
      users: [
        { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1", "job-2"] },
        { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
      ],
    });
    blob.set("jobs.json", { jobs: [{ id: "job-1", name: "A", areaGroups: [] }, { id: "job-2", name: "B", areaGroups: [] }] });

    const a = await call({ role: "electrician", userId: "u_field", query: { jobId: "job-1" }, body: { type: "note", title: "on A" }, idempotencyKey: "session-1" });
    const b = await call({ role: "electrician", userId: "u_field", query: { jobId: "job-2" }, body: { type: "note", title: "on B" }, idempotencyKey: "session-1" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((b.body as Created).idempotentReplay).toBeFalsy();
    expect((b.body as Created).observation.id).not.toBe((a.body as Created).observation.id);
    expect((b.body as Created).observation.title).toBe("on B");
    expect(storedObservations()).toHaveLength(2);
  });
});
