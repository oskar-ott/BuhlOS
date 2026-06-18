import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for api/evidence.js create — the replay-safety contract (#497).
 *
 * The offline capture queue (#143) will replay a queued evidence create on
 * reconnect (or retry after a lost-response timeout). With a client idempotency
 * key, that retry must return the ORIGINAL item and append NOTHING — without a
 * key, behaviour is unchanged (every create applies). Same real-handler harness
 * as task-toggle-api.test.ts: an in-memory Blob is injected; the audit modules
 * are stubbed so the test asserts only the evidence write.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const jobAuditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const handlerPath = requireFromHere.resolve("../../../api/evidence.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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

const JOB = "job-1";
const DATA_KEY = `jobs/${JOB}/data.json`;

async function create({
  idempotencyKey,
  note = "snapped the board",
}: {
  idempotencyKey?: string;
  note?: string;
}) {
  const res = createRes();
  const headers: Record<string, string> = { cookie: cookieFor("u_field", "electrician") };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  await handler(
    {
      method: "POST",
      query: { jobId: JOB },
      headers,
      body: { kind: "note", note },
    },
    res,
  );
  return res;
}

function storedEvidence(): Array<{ id: string }> {
  const data = blob.get(DATA_KEY) as { evidence?: Array<{ id: string }> } | undefined;
  return data?.evidence ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [JOB] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: JOB, name: "Active", status: "active", areaGroups: [] }] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  // Stub the audit writers so the test observes only the evidence write.
  requireFromHere.cache[auditLogPath] = {
    id: auditLogPath,
    filename: auditLogPath,
    loaded: true,
    exports: { append: vi.fn(async () => null) },
  } as NodeJS.Module;
  requireFromHere.cache[jobAuditPath] = {
    id: jobAuditPath,
    filename: jobAuditPath,
    loaded: true,
    exports: { appendAudit: vi.fn(async () => null) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/evidence create — replay safety (#497)", () => {
  it("a retry with the SAME idempotency key returns the original item and appends nothing", async () => {
    const first = await create({ idempotencyKey: "cap-abc" });
    expect(first.statusCode).toBe(201);
    const firstItem = (first.body as { evidenceItem: { id: string } }).evidenceItem;
    expect(firstItem.id).toMatch(/^ev_/);
    expect(storedEvidence()).toHaveLength(1);

    const replay = await create({ idempotencyKey: "cap-abc", note: "different note, same key" });
    expect(replay.statusCode).toBe(201);
    const replayBody = replay.body as { evidenceItem: { id: string }; idempotentReplay?: boolean };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.evidenceItem.id).toBe(firstItem.id); // same item, not a new one
    expect(storedEvidence()).toHaveLength(1); // NO second append
  });

  it("two creates with DIFFERENT keys both apply (distinct items)", async () => {
    await create({ idempotencyKey: "cap-1" });
    await create({ idempotencyKey: "cap-2" });
    const ids = storedEvidence().map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("without a key, behaviour is unchanged — every create appends (no accidental dedupe)", async () => {
    await create({});
    await create({});
    expect(storedEvidence()).toHaveLength(2);
  });
});
