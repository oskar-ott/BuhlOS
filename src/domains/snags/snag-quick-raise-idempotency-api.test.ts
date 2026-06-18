import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for api/snag-quick-raise.js — the replay-safety contract (#497).
 *
 * snag-quick-raise appends one snag to jobs/<id>/data.json with a fresh random
 * id, so a retry (a snag queued offline and replayed on reconnect, or retried
 * after a lost-response timeout) would create a DUPLICATE. With a client
 * idempotency key the retry returns the original snag and appends nothing;
 * without a key, behaviour is unchanged. Same real-handler harness as
 * evidence-create-idempotency-api.test.ts: an in-memory Blob is injected and
 * notify() is stubbed so the test asserts only the snag write.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const handlerPath = requireFromHere.resolve("../../../api/snag-quick-raise.js");

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
const DWELLING = "area-1";
const DATA_KEY = `jobs/${JOB}/data.json`;

async function raise({
  idempotencyKey,
  desc = "Scratched architrave",
}: {
  idempotencyKey?: string;
  desc?: string;
}) {
  const res = createRes();
  const headers: Record<string, string> = { cookie: cookieFor("u_field", "electrician") };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  await handler(
    {
      method: "POST",
      query: { jobId: JOB },
      headers,
      body: { dwelling: DWELLING, desc },
    },
    res,
  );
  return res;
}

function storedSnags(): Array<{ id: string }> {
  const data = blob.get(DATA_KEY) as { snags?: Array<{ id: string }> } | undefined;
  return data?.snags ?? [];
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
    [
      "jobs.json",
      {
        jobs: [
          {
            id: JOB,
            name: "Active",
            status: "active",
            areaGroups: [{ areas: [{ id: DWELLING, name: "Unit 1" }] }],
          },
        ],
      },
    ],
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
  // Stub notify so the test observes only the snag write (no push fan-out).
  requireFromHere.cache[notifyPath] = {
    id: notifyPath,
    filename: notifyPath,
    loaded: true,
    exports: { notify: vi.fn(async () => undefined) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/snag-quick-raise — replay safety (#497)", () => {
  it("a retry with the SAME idempotency key returns the original snag and appends nothing", async () => {
    const first = await raise({ idempotencyKey: "snag-abc" });
    expect(first.statusCode).toBe(201);
    const firstSnag = (first.body as { snag: { id: string } }).snag;
    expect(firstSnag.id).toMatch(/^s_/);
    expect(storedSnags()).toHaveLength(1);

    const replay = await raise({ idempotencyKey: "snag-abc", desc: "different text, same key" });
    expect(replay.statusCode).toBe(201);
    const replayBody = replay.body as { snag: { id: string; desc: string }; idempotentReplay?: boolean };
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.snag.id).toBe(firstSnag.id); // same snag, not a new one
    expect(replayBody.snag.desc).toBe("Scratched architrave"); // original payload, byte-identical
    expect(storedSnags()).toHaveLength(1); // NO second append
  });

  it("two raises with DIFFERENT keys both apply (distinct snags)", async () => {
    await raise({ idempotencyKey: "snag-1" });
    await raise({ idempotencyKey: "snag-2" });
    const ids = storedSnags().map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("without a key, behaviour is unchanged — every raise appends (no accidental dedupe)", async () => {
    await raise({});
    await raise({});
    expect(storedSnags()).toHaveLength(2);
  });
});
