import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #304 — api/cost-rates.js handler. Admin-tier ONLY (a leading hand is 403),
 * append-only effective-dated history, and a coverage report. Real handler +
 * signed sessions + in-memory blob mock.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const storePath = requireFromHere.resolve("../../../api/_lib/cost-rates.js");
const handlerPath = requireFromHere.resolve("../../../api/cost-rates.js");

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(opts: {
  method?: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    {
      method: opts.method || "GET",
      query: opts.query || {},
      body: opts.body,
      headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) },
    },
    res,
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: [] },
        ],
      },
    ],
  ]);

  for (const p of [authPath, storePath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("api/cost-rates.js — confidentiality gate (#304)", () => {
  it("403s a leading hand (a mate can never read pay rates)", async () => {
    const res = await call({ role: "leadingHand", userId: "u_lh", query: { userId: "u_field" } });
    expect(res.statusCode).toBe(403);
  });

  it("403s a field worker", async () => {
    const res = await call({ role: "electrician", userId: "u_field", query: { userId: "u_field" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("api/cost-rates.js — read + append (#304)", () => {
  it("returns empty history before any rate is set", async () => {
    const res = await call({ role: "admin", query: { userId: "u_field" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ userId: "u_field", history: [], current: null });
  });

  it("POST appends an effective-dated rate and returns the updated history", async () => {
    const res = await call({
      method: "POST",
      role: "admin",
      body: { userId: "u_field", costRateCents: 5250, effectiveFrom: "2026-01-01" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as { history: unknown[]; current: { costRateCents: number; setBy: string } | null };
    expect(body.history).toHaveLength(1);
    expect(body.current?.costRateCents).toBe(5250);
    expect(body.current?.setBy).toBe("u_admin"); // editor recorded
    // persisted confidentially, outside users.json
    expect(blob.get("workforce/cost-rates.json")).toBeTruthy();
    const fieldUser = (blob.get("users.json") as { users: Array<{ id: string; hourlyRate?: unknown }> }).users.find((u) => u.id === "u_field");
    expect(fieldUser?.hourlyRate).toBeUndefined();
  });

  it("a second POST appends (never overwrites) — history grows", async () => {
    await call({ method: "POST", role: "admin", body: { userId: "u_field", costRateCents: 5000, effectiveFrom: "2026-01-01" } });
    const res = await call({ method: "POST", role: "admin", body: { userId: "u_field", costRateCents: 5500, effectiveFrom: "2026-06-01" } });
    expect(res.statusCode).toBe(201);
    expect((res.body as { history: unknown[] }).history).toHaveLength(2);
  });

  it("404s a rate for a non-existent user", async () => {
    const res = await call({ method: "POST", role: "admin", body: { userId: "nope", costRateCents: 5000, effectiveFrom: "2026-01-01" } });
    expect(res.statusCode).toBe(404);
  });

  it("400s an invalid rate (non-integer cents)", async () => {
    const res = await call({ method: "POST", role: "admin", body: { userId: "u_field", costRateCents: 52.5, effectiveFrom: "2026-01-01" } });
    expect(res.statusCode).toBe(400);
  });

  it("coverage lists hours-tracked workers without a rate", async () => {
    await call({ method: "POST", role: "admin", body: { userId: "u_field", costRateCents: 5000, effectiveFrom: "2026-01-01" } });
    const res = await call({ role: "admin", query: { action: "coverage" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { tracked: number; rated: number; unrated: Array<{ id: string }> };
    expect(body.tracked).toBe(2); // field + LH
    expect(body.rated).toBe(1);
    expect(body.unrated.map((u) => u.id)).toEqual(["u_lh"]);
  });
});
