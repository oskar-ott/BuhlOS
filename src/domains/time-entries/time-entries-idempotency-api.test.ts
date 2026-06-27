import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/time-entries.js — the replay-safety contract (#497).
 *
 * A field worker on bad signal can submit, lose the response to a timeout, and
 * tap again — or (later) an offline outbox replays a queued write on reconnect.
 * With a client Idempotency-Key the retry must resolve to the ORIGINAL entry
 * (POST) or the original edit (PATCH) instead of a duplicate / a confusing 409 /
 * a second audit row. Without a key, behaviour is unchanged.
 *
 * Same real-handler harness as time-entries-api.test.ts: the serverless handler
 * with signed sessions over an in-memory Vercel Blob. The mock writeBlob clones
 * via JSON.stringify, so a successful persist also PROVES the recorded snapshot
 * carries no circular reference (the entry IS the stored document here).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);
const ENTRY_PATH = (userId: string, date: string) => `users/${userId}/time-entries/${date}.json`;
const AUDIT_PATH = (userId: string) =>
  `users/${userId}/time-entries-audit/${TODAY.slice(0, 7)}.json`;

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

async function call({
  method,
  userId,
  role,
  query = {},
  body,
  idempotencyKey,
}: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
}) {
  const res = createRes();
  const headers: Record<string, string> = { cookie: cookieFor(userId, role) };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  await handler({ method, query, body, headers }, res);
  return res;
}

function newEntryBody(extra: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    allocations: [{ jobId: "job-x", hours: 8 }],
    ...extra,
  };
}

/** A complete stored DRAFT entry for the PATCH tests. */
function seedDraft(userId = "u_field") {
  blob.set(ENTRY_PATH(userId, TODAY), {
    id: "e_seed",
    userId,
    userName: "sparky",
    userRole: "electrician",
    date: TODAY,
    startTime: null,
    endTime: null,
    breakMinutes: 30,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    otOverridden: false,
    notes: null,
    status: "draft",
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    allocations: [{ jobId: "job-x", hours: 8, notes: null, sortOrder: 0 }],
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T07:00:00.000Z`,
  });
}

function storedEntry(userId = "u_field"): Record<string, unknown> | undefined {
  return blob.get(ENTRY_PATH(userId, TODAY)) as Record<string, unknown> | undefined;
}

function auditRows(userId = "u_field"): unknown[] {
  return (blob.get(AUDIT_PATH(userId)) as unknown[] | undefined) ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["job-x"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-x"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-x", name: "Job X", status: "active" }] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[teLibPath];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        // clone() = JSON round-trip → throws on a circular reference, so a
        // passing write also asserts the idempotency snapshot is acyclic.
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/time-entries — replay safety (#497)", () => {
  it("same key replay returns the original entry and creates no duplicate", async () => {
    const first = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody({ status: "submitted" }),
      idempotencyKey: "te-1",
    });
    expect(first.statusCode).toBe(201);
    const firstEntry = (first.body as { entry: { id: string } }).entry;
    expect(firstEntry.id).toBeTruthy();

    const replay = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      // A VALID but different payload (10h, allocations sum to 10) — the replay
      // must ignore it and return the original 8h entry, not re-validate-and-write.
      body: newEntryBody({
        status: "submitted",
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 2,
        allocations: [{ jobId: "job-x", hours: 10 }],
      }),
      idempotencyKey: "te-1",
    });
    expect(replay.statusCode).toBe(201);
    const replayBody = replay.body as {
      entry: { id: string; totalHours: number };
      idempotentReplay?: boolean;
    };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.entry.id).toBe(firstEntry.id); // same entry
    expect(replayBody.entry.totalHours).toBe(8); // ORIGINAL payload, not the replay's 10
    // The stored day-file is untouched by the replay.
    expect(storedEntry()?.totalHours).toBe(8);
  });

  it("the ring persists on the stored entry but never leaks to the client", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
      idempotencyKey: "te-ring",
    });
    expect(res.statusCode).toBe(201);
    // Response is clean — no internal bookkeeping field.
    expect((res.body as { entry: Record<string, unknown> }).entry.__idempotency).toBeUndefined();
    // …but the stored document carries the scoped key for future replays.
    const ring = storedEntry()?.__idempotency as Array<{ key: string }> | undefined;
    expect(ring?.some((e) => e.key === `entry:u_field:${TODAY}:te-ring`)).toBe(true);
  });

  it("different keys on the same user+date still hit the duplicate-date 409 (rule not bypassed)", async () => {
    const first = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
      idempotencyKey: "k1",
    });
    expect(first.statusCode).toBe(201);

    const second = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
      idempotencyKey: "k2",
    });
    expect(second.statusCode).toBe(409);
  });

  it("without a key, a same-date repeat is the unchanged 409 (backward compatible)", async () => {
    const first = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
    });
    expect(first.statusCode).toBe(201);
    const second = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("PATCH /api/time-entries — replay safety (#497)", () => {
  it("same key replay of a draft→submitted edit returns the original and writes no second audit row", async () => {
    seedDraft();
    const body = newEntryBody({ status: "submitted", notes: "fixed up" });

    const first = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body,
      idempotencyKey: "te-patch-1",
    });
    expect(first.statusCode).toBe(200);
    expect((first.body as { entry: { status: string } }).entry.status).toBe("submitted");
    const auditAfterFirst = auditRows().length;
    expect(auditAfterFirst).toBeGreaterThanOrEqual(1);

    const replay = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body,
      idempotencyKey: "te-patch-1",
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.body as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    // No second audit row for the replayed edit.
    expect(auditRows().length).toBe(auditAfterFirst);
  });

  it("a replay never unlocks an entry that was approved after the original edit", async () => {
    seedDraft();
    const body = newEntryBody({ status: "submitted" });
    const first = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body,
      idempotencyKey: "te-patch-2",
    });
    expect(first.statusCode).toBe(200);

    // Admin approves it out-of-band (ring preserved, as the approve path spreads
    // the existing entry).
    const approved = { ...(storedEntry() as Record<string, unknown>), status: "approved" };
    blob.set(ENTRY_PATH("u_field", TODAY), approved);

    const replay = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body,
      idempotencyKey: "te-patch-2",
    });
    // Replay returns the original (pre-approval) result — it does NOT 403 and it
    // does NOT rewrite the now-approved entry.
    expect(replay.statusCode).toBe(200);
    expect((replay.body as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    expect(storedEntry()?.status).toBe("approved"); // unchanged — stays locked
  });

  it("without a key, an edit applies normally (no replay short-circuit)", async () => {
    seedDraft();
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: newEntryBody({ status: "submitted", notes: "no key" }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { idempotentReplay?: boolean }).idempotentReplay).toBeUndefined();
    expect(storedEntry()?.status).toBe("submitted");
  });
});

describe("the __idempotency ring is bounded (#497)", () => {
  it("never grows past the cap across many distinct keyed edits — oldest trimmed", async () => {
    // One create + 54 notes-only edits, each with a distinct key = 55 keys.
    const create = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: newEntryBody(),
      idempotencyKey: "c0",
    });
    expect(create.statusCode).toBe(201);
    for (let i = 1; i <= 54; i++) {
      const res = await call({
        method: "PATCH",
        userId: "u_field",
        role: "electrician",
        query: { date: TODAY },
        body: { notes: `edit ${i}` },
        idempotencyKey: `p${i}`,
      });
      expect(res.statusCode).toBe(200);
    }
    const ring = storedEntry()?.__idempotency as Array<{ key: string }>;
    expect(ring).toHaveLength(50); // DEFAULT_MAX_KEYS — bounded
    expect(ring.some((e) => e.key === `entry:u_field:${TODAY}:c0`)).toBe(false); // oldest trimmed
    expect(ring.some((e) => e.key === `entry:u_field:${TODAY}:p54`)).toBe(true); // newest kept
  });
});
