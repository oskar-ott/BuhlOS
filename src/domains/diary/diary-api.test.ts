import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: the site diary is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_DIARY = "1";
});
afterAll(() => {
  delete process.env.FLAG_DIARY;
});

/**
 * Integration tests for api/diary.js — the real serverless handler against a
 * mocked Vercel Blob store and real HMAC sessions (#210). Mirrors
 * dayworks-api.test.ts.
 *
 * The diary is delay-claim evidence, so the mandatory integrity rules are
 * test-locked:
 *   - role matrix: admin writes; LH reads; tradie + client → 403 (no leak past
 *     the site-visits attendance line); anon → 401
 *   - one entry per (job,date): a duplicate create is 409 (not an overwrite)
 *   - future dates rejected
 *   - happenings > 5k rejected
 *   - a flagged delay requires a reason
 *   - attendance snapshot is FROZEN at save (denormalised, server-shaped)
 *   - amend appends to amendments[]; the original fields are untouched
 *   - expectedRev conflict (CAS) → write fails, no partial state
 *   - pre-fill-unavailable degradation: a create with NO attendance + a null
 *     fetchedAt still succeeds (the entry is never blocked on attendance)
 *   - audit: diary.created / diary.amended verbs land
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const diaryPath = requireFromHere.resolve("../../../api/diary.js");

let blob: Map<string, unknown>;
let writeShouldThrow: ((key: string, data: unknown, opts?: unknown) => Error | null) | null;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
  method: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role) },
  };
  await handler(req, res);
  return res;
}

/** Today's Sydney date-key (so the future-date tests are not flaky on a boundary). */
function sydneyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2); // +2 UTC days clears any Sydney offset
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  writeShouldThrow = null;
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "leader", role: "leading-hand", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-1", name: "Birdwood", areaGroups: [] },
          { id: "job-2", name: "Other", areaGroups: [] },
        ],
      },
    ],
    ["jobs/job-1/diary.json", { entries: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[diaryPath];
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
      writeBlob: vi.fn(async (key: string, data: unknown, opts?: unknown) => {
        if (writeShouldThrow) {
          const err = writeShouldThrow(key, data, opts);
          if (err) throw err;
        }
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(diaryPath);
});

type AuditEntry = {
  action: string;
  actorId: string;
  jobId: string;
  targetType: string;
  metadata?: Record<string, unknown>;
};
function audits(): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const [k, v] of blob.entries()) {
    if (!k.startsWith("audit/")) continue;
    const list = (v as { entries?: AuditEntry[] }).entries;
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}
function entries(jobId = "job-1"): Array<Record<string, unknown>> {
  return ((blob.get(`jobs/${jobId}/diary.json`) as { entries?: [] })?.entries || []) as Array<
    Record<string, unknown>
  >;
}

async function createOne(over: Record<string, unknown> = {}, role = "boss", userId = "u_boss", jobId = "job-1") {
  return call({
    method: "POST",
    role,
    userId,
    query: { jobId },
    body: { date: sydneyToday(), happenings: "Rough-in level 2", ...over },
  });
}

describe("role matrix", () => {
  it("401 for an anonymous caller", async () => {
    const res = await call({ method: "GET", role: "boss", anon: true, query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a client on a job they 'have' (no leak past site-visits)", async () => {
    const res = await call({ method: "GET", role: "client", userId: "u_client", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("403 for a tradie even on an ASSIGNED job", async () => {
    const res = await call({ method: "GET", role: "electrician", userId: "u_field", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(403);
  });

  it("an LH on the job can READ", async () => {
    const res = await call({ method: "GET", role: "leading-hand", userId: "u_lh", query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toEqual([]);
  });

  it("an LH on the job CANNOT write (admin only)", async () => {
    const res = await createOne({}, "leading-hand", "u_lh");
    expect(res.statusCode).toBe(403);
  });

  it("an LH off the job is 403 (requireAuth job gate)", async () => {
    const res = await call({ method: "GET", role: "leading-hand", userId: "u_lh", query: { jobId: "job-2" } });
    expect(res.statusCode).toBe(403);
  });

  it("admin (boss) writes", async () => {
    const res = await createOne();
    expect(res.statusCode).toBe(201);
  });

  it("400 when jobId is missing", async () => {
    const res = await call({ method: "GET", role: "boss", userId: "u_boss", query: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("create", () => {
  it("admin → 201 with a shaped, stamped entry", async () => {
    const res = await createOne();
    expect(res.statusCode).toBe(201);
    const e = (res.body as { entry: Record<string, unknown> }).entry;
    expect(typeof e.id).toBe("string");
    expect(e.date).toBe(sydneyToday());
    expect(e.happenings).toBe("Rough-in level 2");
    expect(e.delay).toEqual({ flagged: false, reason: null });
    expect(e.createdById).toBe("u_boss");
    expect(Array.isArray(e.amendments)).toBe(true);
  });

  it("409 for a SECOND entry on the same (job,date) — pointing at amend", async () => {
    const first = await createOne();
    expect(first.statusCode).toBe(201);
    const dup = await createOne();
    expect(dup.statusCode).toBe(409);
    expect((dup.body as { code?: string }).code).toBe("duplicate_date");
    // The original is NOT overwritten — still one entry.
    expect(entries()).toHaveLength(1);
  });

  it("rejects a FUTURE date", async () => {
    const res = await createOne({ date: tomorrow() });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/future/i);
  });

  it("rejects happenings over 5k chars", async () => {
    const res = await createOne({ happenings: "x".repeat(5001) });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty happenings + a bad date shape", async () => {
    expect((await createOne({ happenings: "   " })).statusCode).toBe(400);
    expect((await createOne({ date: "2026-6-1" })).statusCode).toBe(400);
  });

  it("requires a reason when the delay is flagged", async () => {
    const bad = await createOne({ delay: { flagged: true } });
    expect(bad.statusCode).toBe(400);
    const ok = await createOne({ delay: { flagged: true, reason: "Rain stopped the pour" } });
    expect(ok.statusCode).toBe(201);
    expect((ok.body as { entry: { delay: { reason: string } } }).entry.delay.reason).toBe(
      "Rain stopped the pour",
    );
  });

  it("FREEZES a denormalised attendance snapshot (extra fields dropped)", async () => {
    const res = await createOne({
      attendance: [
        { userId: "u_field", userName: "Sam", hours: 8, status: "approved", rate: 9999 },
      ],
      attendanceSource: { fetchedAt: "2026-06-15T07:55:00.000Z", adjusted: true },
    });
    expect(res.statusCode).toBe(201);
    const e = (res.body as { entry: Record<string, unknown> }).entry;
    expect(e.attendance).toEqual([
      { userId: "u_field", userName: "Sam", hours: 8, status: "approved" },
    ]);
    expect(e.attendanceSource).toEqual({ fetchedAt: "2026-06-15T07:55:00.000Z", adjusted: true });
  });

  it("pre-fill-unavailable degradation: a create with NO attendance still succeeds", async () => {
    const res = await createOne({ attendanceSource: { fetchedAt: null, adjusted: false } });
    expect(res.statusCode).toBe(201);
    const e = (res.body as { entry: Record<string, unknown> }).entry;
    expect(e.attendance).toEqual([]);
    expect((e.attendanceSource as { fetchedAt: unknown }).fetchedAt).toBeNull();
  });

  it("a stale-write (expectedRev) conflict fails the write", async () => {
    writeShouldThrow = () => {
      const err = new Error("revision conflict") as Error & { code?: string };
      err.code = "stale_write";
      return err;
    };
    const res = await createOne();
    expect(res.statusCode).toBe(502);
    // Nothing persisted.
    expect(entries()).toHaveLength(0);
  });
});

describe("amend (append-only)", () => {
  async function seed() {
    const created = await createOne({ happenings: "Original happenings" });
    return (created.body as { entry: { id: string; date: string } }).entry;
  }

  it("appends an amendment WITHOUT mutating the original fields", async () => {
    const original = await seed();
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", action: "amend" },
      body: { id: original.id, note: "fixed the level", changes: { happenings: "Corrected happenings" } },
    });
    expect(res.statusCode).toBe(200);
    const e = (res.body as { entry: Record<string, unknown> }).entry;
    // Original happenings untouched.
    expect(e.happenings).toBe("Original happenings");
    const ams = e.amendments as Array<{ changes: { happenings: string }; note: string }>;
    expect(ams).toHaveLength(1);
    expect(ams[0]!.changes.happenings).toBe("Corrected happenings");
    expect(ams[0]!.note).toBe("fixed the level");
  });

  it("404 when amending a missing entry", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", action: "amend" },
      body: { id: "di_nope", changes: { happenings: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 for an empty amendment (no changed fields)", async () => {
    const original = await seed();
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", action: "amend" },
      body: { id: original.id, changes: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("an amendment's flagged delay still requires a reason", async () => {
    const original = await seed();
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", action: "amend" },
      body: { id: original.id, changes: { delay: { flagged: true } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("an LH cannot amend (admin only)", async () => {
    const original = await seed();
    const res = await call({
      method: "POST",
      role: "leading-hand",
      userId: "u_lh",
      query: { jobId: "job-1", action: "amend" },
      body: { id: original.id, changes: { happenings: "x" } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("audit", () => {
  it("emits diary.created on create and diary.amended on amend", async () => {
    const created = await createOne();
    const id = (created.body as { entry: { id: string } }).entry.id;
    await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", action: "amend" },
      body: { id, changes: { happenings: "changed" } },
    });
    const verbs = audits().map((a) => a.action);
    expect(verbs).toContain("diary.created");
    expect(verbs).toContain("diary.amended");
    const createdAudit = audits().find((a) => a.action === "diary.created");
    expect(createdAudit?.targetType).toBe("diary");
    expect(createdAudit?.jobId).toBe("job-1");
  });
});

describe("GET range filter", () => {
  it("filters entries to [fromDate, toDate] and a gap is simply absent", async () => {
    blob.set("jobs/job-1/diary.json", {
      entries: [
        { id: "a", jobId: "job-1", date: "2026-06-10", happenings: "a", delay: { flagged: false, reason: null }, attendance: [], attendanceSource: { fetchedAt: null, adjusted: false }, amendments: [], createdById: "u_boss", createdByName: "Boss", createdAt: "2026-06-10T00:00:00Z", auditLogIds: [] },
        { id: "b", jobId: "job-1", date: "2026-06-15", happenings: "b", delay: { flagged: false, reason: null }, attendance: [], attendanceSource: { fetchedAt: null, adjusted: false }, amendments: [], createdById: "u_boss", createdByName: "Boss", createdAt: "2026-06-15T00:00:00Z", auditLogIds: [] },
      ],
    });
    const res = await call({
      method: "GET",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", fromDate: "2026-06-12", toDate: "2026-06-20" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { entries: Array<{ date: string }>; filters: Record<string, unknown> };
    expect(body.entries.map((e) => e.date)).toEqual(["2026-06-15"]);
    expect(body.filters.fromDate).toBe("2026-06-12");
  });

  it("400 for a malformed date filter", async () => {
    const res = await call({
      method: "GET",
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", fromDate: "2026/06/12" },
    });
    expect(res.statusCode).toBe(400);
  });
});
