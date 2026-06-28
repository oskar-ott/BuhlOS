import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #293 — conditional ("only-if") points against the REAL api/job-itps.js
 * handler. Pins the behaviour the Phil + admin surfaces depend on:
 *
 *   - record rejection: recording a non-applicable point → 400 with an
 *     honest message ("This check does not apply to this ITP.");
 *   - witnessed gate: a non-applicable REQUIRED point is filtered out of
 *     requiredPointsComplete, so it can NEVER block reaching witnessed —
 *     an instance can submit once every APPLICABLE required point is done;
 *   - snapshot semantics: applicability reads templateSnapshot.onlyIf, so
 *     editing the live template does NOT change an existing instance's
 *     checklist.
 *
 * Same harness as job-itps-submit-api.test.ts.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-itps.js");
const tplHandlerPath = requireFromHere.resolve("../../../api/itp-templates.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let tplHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

const RESULT = (byUserId = "u_field") => ({
  value: true,
  note: "",
  byUsername: "sparky",
  at: "2026-06-17T09:00:00.000Z",
});

/**
 * Seed one area-scoped instance whose snapshot has:
 *   p_all  — required, no condition (applies everywhere)
 *   p_sb   — required, onlyIf scopeType=switchboard (does NOT apply to area)
 *   p_area — required, onlyIf scopeType=[area, level] (applies to area)
 */
function seedInstance(
  scope = "area",
  results: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) {
  blob.set("jobs/j1/itps.json", {
    instances: [
      {
        id: "itp_1",
        templateId: "tpl_x",
        scope,
        status: "in-progress",
        archived: false,
        results,
        templateSnapshot: {
          name: "Rough-in QA",
          points: [
            { id: "p_all", label: "Cables supported", type: "signoff", required: true },
            {
              id: "p_sb",
              label: "Board schedule",
              type: "signoff",
              required: true,
              onlyIf: { scopeType: "switchboard" },
            },
            {
              id: "p_area",
              label: "Penetrations sealed",
              type: "signoff",
              required: true,
              onlyIf: { scopeType: ["area", "level"] },
            },
          ],
        },
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
  blob.set("itp-templates.json", { templates: [] });

  for (const p of [authPath, handlerPath, tplHandlerPath]) {
    delete requireFromHere.cache[p];
  }
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
  tplHandler = requireFromHere(tplHandlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("record rejection — non-applicable point (#293)", () => {
  it("rejects a record on a point that does not apply to the scope (400)", async () => {
    seedInstance("area");
    const res = await call("record", "u_field", "electrician", {
      instanceId: "itp_1",
      pointId: "p_sb", // switchboard-only on an area instance
      value: true,
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "This check does not apply to this ITP.",
    );
    // Nothing was recorded.
    expect((storedInstance("itp_1")!.results as Record<string, unknown>).p_sb).toBeUndefined();
  });

  it("allows a record on an applicable point", async () => {
    seedInstance("area");
    const res = await call("record", "u_field", "electrician", {
      instanceId: "itp_1",
      pointId: "p_area",
      value: true,
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows the same switchboard-only point when the instance IS a switchboard", async () => {
    seedInstance("switchboard");
    const res = await call("record", "u_field", "electrician", {
      instanceId: "itp_1",
      pointId: "p_sb",
      value: true,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("witnessed gate — non-applicable required point filtered (#293)", () => {
  it("a non-applicable required point can NEVER block reaching witnessed", async () => {
    // Record only the two APPLICABLE required points (p_all, p_area).
    // p_sb is required but switchboard-only → not applicable to an area
    // instance, so it must not hold submit back.
    seedInstance("area", {
      p_all: RESULT(),
      p_area: RESULT(),
    });
    const res = await call("submit", "u_field", "electrician", {
      instanceId: "itp_1",
    });
    expect(res.statusCode).toBe(200);
    expect(storedInstance("itp_1")!.status).toBe("witnessed");
  });

  it("still blocks submit when an APPLICABLE required point is open", async () => {
    // p_area (applicable, required) left open → submit blocked.
    seedInstance("area", { p_all: RESULT() });
    const res = await call("submit", "u_field", "electrician", {
      instanceId: "itp_1",
    });
    expect(res.statusCode).toBe(409);
    expect(storedInstance("itp_1")!.status).toBe("in-progress");
  });
});

describe("snapshot semantics — live template edit does NOT change an instance (#293)", () => {
  it("editing the live template's conditions leaves the existing instance's checklist intact", async () => {
    // Existing area instance: p_sb is switchboard-only (not applicable) and
    // is the only thing missing; p_all + p_area are recorded → submittable.
    seedInstance("area", {
      p_all: RESULT(),
      p_area: RESULT(),
    });

    // Now an admin edits the LIVE template so p_sb becomes area-applicable
    // (scopeType=area) — i.e. retro-tightening. This must NOT affect the
    // already-attached snapshot.
    blob.set("itp-templates.json", {
      templates: [
        {
          id: "tpl_x",
          name: "Rough-in QA",
          archived: false,
          createdAt: "2026-06-17T07:00:00.000Z",
          createdBy: "boss",
          updatedAt: "2026-06-17T07:00:00.000Z",
          points: [
            { id: "p_all", label: "Cables supported", type: "signoff", required: true },
            { id: "p_sb", label: "Board schedule", type: "signoff", required: true, onlyIf: { scopeType: "area" } },
            { id: "p_area", label: "Penetrations sealed", type: "signoff", required: true, onlyIf: { scopeType: ["area", "level"] } },
          ],
        },
      ],
    });

    // The instance is evaluated against its OWN snapshot (p_sb still
    // switchboard-only there), so submit still succeeds without recording p_sb.
    const res = await call("submit", "u_field", "electrician", {
      instanceId: "itp_1",
    });
    expect(res.statusCode).toBe(200);
    expect(storedInstance("itp_1")!.status).toBe("witnessed");
    // The instance's snapshot was never rewritten by the template edit.
    const snap = (storedInstance("itp_1")!.templateSnapshot as {
      points: Array<{ id: string; onlyIf?: { scopeType: unknown } }>;
    });
    const sb = snap.points.find((p) => p.id === "p_sb");
    expect(sb!.onlyIf).toEqual({ scopeType: "switchboard" });
  });
});
