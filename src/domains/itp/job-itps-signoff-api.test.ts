import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: ITP / QA is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_ITP = "1";
});
afterAll(() => {
  delete process.env.FLAG_ITP;
});

/**
 * Integration tests for POST /api/job-itps?action=signoff (+ reopen) against
 * the REAL handler — the #289 persistence slice: the independence-override
 * justification is now written ON the instance (signOffOverride), not only
 * into audit-log metadata, so the compliance pack can read it without a
 * time-windowed audit scan.
 *
 * Same harness as job-itps-submit-api.test.ts (signed sessions + in-memory
 * blob via require.cache injection). Sign-off is admin-only; `office` is an
 * admin-tier role (isAdminRole).
 *
 * Pins:
 *   - independent sign-off (signer recorded 0 points) → no signOffOverride;
 *   - sign-off over the threshold WITHOUT a justification → 409, unchanged;
 *   - sign-off over the threshold WITH a justification → 200 and the
 *     override { justification, ratio, by, at } is persisted on the instance;
 *   - canSignOff behaviour is unchanged at the current threshold (0.5): a
 *     signer at ratio 0.5 signs off cleanly, over 0.5 needs justification;
 *   - reopen clears signOffOverride alongside the sign-off stamps.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-itps.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

/** A recorded result attributed to a given user. */
const RESULT = (byUserId: string) => ({
  value: true,
  note: "",
  byUserId,
  byUsername: byUserId,
  at: "2026-06-17T09:00:00.000Z",
});

/**
 * Seed one witnessed instance with `adminPoints` points recorded by the
 * admin (u_admin) and `otherPoints` recorded by the field worker (u_field),
 * so the recorded-by-signer ratio for u_admin is adminPoints / total.
 */
function seedWitnessed(adminPoints: number, otherPoints: number, over: Record<string, unknown> = {}) {
  const total = adminPoints + otherPoints;
  const points = Array.from({ length: total }, (_, i) => ({
    id: `p${i}`,
    label: `Point ${i}`,
    type: "signoff",
    required: true,
  }));
  const results: Record<string, unknown> = {};
  for (let i = 0; i < adminPoints; i += 1) results[`p${i}`] = RESULT("u_admin");
  for (let i = adminPoints; i < total; i += 1) results[`p${i}`] = RESULT("u_field");

  blob.set("jobs/j1/itps.json", {
    instances: [
      {
        id: "itp_1",
        templateId: "tpl_x",
        status: "witnessed",
        archived: false,
        results,
        templateSnapshot: { name: "Rough-in QA", points },
        createdAt: "2026-06-17T08:00:00.000Z",
        createdBy: "boss",
        updatedAt: "2026-06-17T08:30:00.000Z",
        ...over,
      },
    ],
  });
}

async function call(
  action: string,
  userId: string,
  role: string,
  body: Record<string, unknown>,
  jobId = "j1",
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId, action },
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
      body,
    },
    res,
  );
  return res;
}

const signoff = (userId: string, role: string, body: Record<string, unknown>) =>
  call("signoff", userId, role, body);

function storedInstance(id: string): Record<string, unknown> | undefined {
  const store = blob.get("jobs/j1/itps.json") as { instances: Array<{ id: string }> };
  return store.instances.find((i) => i.id === id) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }] });

  for (const p of [authPath, handlerPath]) delete requireFromHere.cache[p];
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

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/job-itps?action=signoff — independence override persistence (#289)", () => {
  it("independent sign-off (signer recorded 0 points) → 200, NO signOffOverride", () => {
    // ratio 0 — everything was recorded by the field worker.
    return (async () => {
      seedWitnessed(0, 4);
      const res = await signoff("u_admin", "office", { instanceId: "itp_1" });
      expect(res.statusCode).toBe(200);
      const inst = storedInstance("itp_1")!;
      expect(inst.status).toBe("signed-off");
      expect(inst.signedOffBy).toBe("boss");
      expect(inst.signOffOverride).toBeUndefined();
    })();
  });

  it("ratio exactly 0.5 signs off cleanly (threshold unchanged) → no override", async () => {
    seedWitnessed(2, 2); // ratio 0.5, not strictly over the 0.5 threshold
    const res = await signoff("u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(200);
    expect(storedInstance("itp_1")!.signOffOverride).toBeUndefined();
  });

  it("over the threshold WITHOUT a justification → 409 (contract unchanged)", async () => {
    seedWitnessed(3, 1); // ratio 0.75 > 0.5
    const res = await signoff("u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("override justification");
    expect((res.body as { ratio: number }).ratio).toBeCloseTo(0.75);
    // Not signed off — untouched.
    expect(storedInstance("itp_1")!.status).toBe("witnessed");
    expect(storedInstance("itp_1")!.signOffOverride).toBeUndefined();
  });

  it("over the threshold WITH a justification → 200 and persists signOffOverride on the instance", async () => {
    seedWitnessed(3, 1); // ratio 0.75
    const res = await signoff("u_admin", "office", {
      instanceId: "itp_1",
      overrideJustification: "Solo call-out — I recorded and signed",
    });
    expect(res.statusCode).toBe(200);
    const inst = storedInstance("itp_1")! as {
      status: string;
      signedOffBy: string;
      signedOffAt: string;
      signOffOverride: { justification: string; ratio: number; by: string; at: string };
    };
    expect(inst.status).toBe("signed-off");
    expect(inst.signOffOverride).toEqual({
      justification: "Solo call-out — I recorded and signed",
      ratio: 0.75,
      by: "boss",
      at: inst.signedOffAt, // captured at the sign-off moment
    });
  });

  it("ratio 1.0 (solo job) with a justification persists the full override", async () => {
    seedWitnessed(4, 0); // ratio 1.0
    const res = await signoff("u_admin", "office", {
      instanceId: "itp_1",
      overrideJustification: "Everything was mine on this one",
    });
    expect(res.statusCode).toBe(200);
    const inst = storedInstance("itp_1")! as {
      signOffOverride: { ratio: number; justification: string };
    };
    expect(inst.signOffOverride.ratio).toBeCloseTo(1);
    expect(inst.signOffOverride.justification).toBe("Everything was mine on this one");
  });

  it("a justification supplied when NOT required is still persisted (honest record of what was entered)", async () => {
    // ratio 0.5 — not over threshold, but the admin typed a reason anyway.
    seedWitnessed(2, 2);
    const res = await signoff("u_admin", "office", {
      instanceId: "itp_1",
      overrideJustification: "Noting I helped record two points",
    });
    expect(res.statusCode).toBe(200);
    expect(
      (storedInstance("itp_1")! as { signOffOverride?: { justification: string } })
        .signOffOverride?.justification,
    ).toBe("Noting I helped record two points");
  });

  it("reopen clears signOffOverride alongside the stamps", async () => {
    seedWitnessed(3, 1);
    await signoff("u_admin", "office", {
      instanceId: "itp_1",
      overrideJustification: "override",
    });
    expect(storedInstance("itp_1")!.signOffOverride).toBeDefined();

    const res = await call("reopen", "u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(200);
    const inst = storedInstance("itp_1")!;
    expect(inst.status).toBe("witnessed");
    expect(inst.signedOffBy).toBeUndefined();
    expect(inst.signOffOverride).toBeUndefined();
  });

  it("re-signing off independently after a reopen clears a stale override", async () => {
    // First sign-off carries an override, then reopen, then re-record so the
    // signer no longer owns a majority, then sign off clean → no override.
    seedWitnessed(3, 1);
    await signoff("u_admin", "office", { instanceId: "itp_1", overrideJustification: "first" });
    await call("reopen", "u_admin", "office", { instanceId: "itp_1" });

    // Reattribute all points to the field worker so the admin's ratio is 0.
    const store = blob.get("jobs/j1/itps.json") as {
      instances: Array<{ id: string; results: Record<string, { byUserId: string }> }>;
    };
    const target = store.instances.find((i) => i.id === "itp_1")!;
    for (const k of Object.keys(target.results)) target.results[k]!.byUserId = "u_field";
    blob.set("jobs/j1/itps.json", store);

    const res = await signoff("u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(200);
    expect(storedInstance("itp_1")!.signOffOverride).toBeUndefined();
  });

  it("the persisted instance still parses cleanly (schema-valid passthrough)", async () => {
    seedWitnessed(3, 1);
    const res = await signoff("u_admin", "office", {
      instanceId: "itp_1",
      overrideJustification: "keeping the record honest",
    });
    // The handler returns the instance it wrote; the schema import is exercised
    // by the domain tests — here we assert the shape the pack will consume.
    const inst = (res.body as { instance: Record<string, unknown> }).instance;
    expect(inst.status).toBe("signed-off");
    expect(inst.signOffOverride).toMatchObject({
      justification: "keeping the record honest",
      by: "boss",
    });
  });
});
