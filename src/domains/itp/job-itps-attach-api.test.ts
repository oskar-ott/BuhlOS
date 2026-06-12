import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for POST /api/job-itps?action=attach (#387) against the
 * REAL handler — the endpoint the v2 attach modal now calls (its only UI
 * caller died in the legacy cutover). Standard harness: signed sessions +
 * in-memory blob via require.cache injection.
 *
 * Pins the contract the modal builds on:
 *   - canManageJob parity: admin TIER attaches any job; a leading hand only
 *     their assigned jobs; field workers never (they can SEE the queue, not
 *     grow it); clients 403 at the job gate.
 *   - snapshot semantics: the instance copies the template's name + points
 *     at attach time, EXCLUDING archived points, so later template edits
 *     don't rewrite history.
 *   - scope validation: job|level|area|switchboard only.
 *
 * NOT pinned: attaching an archived TEMPLATE (the server doesn't guard it
 * yet — that's #284's AC; the modal never offers archived templates because
 * GET /api/itp-templates excludes them server-side by default).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-itps.js");
const templatesPath = requireFromHere.resolve("../../../api/itp-templates.js");

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

async function attach(
  userId: string,
  role: string,
  body: Record<string, unknown>,
  jobId = "j1",
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId, action: "attach" },
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
      body,
    },
    res,
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
      { id: "u_lh_other", username: "lead2", role: "leadingHand", assignedJobIds: ["j2"], passwordHash: "$2a$10$x" },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      { id: "j1", name: "Riverside" },
      { id: "j2", name: "Depot" },
    ],
  });
  blob.set("itp-templates.json", {
    templates: [
      {
        id: "tpl_rough",
        name: "Rough-in QA",
        category: "Electrical",
        points: [
          { id: "p1", label: "Cables supported" },
          { id: "p2", label: "Old check", archived: true },
          { id: "p3", label: "Penetrations sealed" },
        ],
      },
    ],
  });

  for (const p of [authPath, handlerPath, templatesPath]) delete requireFromHere.cache[p];
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

describe("POST /api/job-itps?action=attach (#387)", () => {
  it("admin TIER attaches with a point snapshot that excludes archived points", async () => {
    const res = await attach("u_admin", "office", {
      templateId: "tpl_rough",
      scope: "area",
      scopeId: "a1",
    });
    expect(res.statusCode).toBe(201);
    const inst = (res.body as { instance: Record<string, unknown> }).instance;
    expect(inst).toMatchObject({
      templateId: "tpl_rough",
      scope: "area",
      scopeId: "a1",
      status: "pending",
    });
    const snapshot = inst.templateSnapshot as { name: string; points: Array<{ id: string }> };
    expect(snapshot.name).toBe("Rough-in QA");
    expect(snapshot.points.map((p) => p.id)).toEqual(["p1", "p3"]);

    // persisted into the job's instances store
    const stored = blob.get("jobs/j1/itps.json") as { instances: unknown[] };
    expect(stored.instances).toHaveLength(1);
  });

  it("a leading hand attaches on THEIR assigned job…", async () => {
    const res = await attach("u_lh", "lh", { templateId: "tpl_rough", scope: "job" });
    expect(res.statusCode).toBe(201);
  });

  it("…but not on a job they're not assigned to", async () => {
    const res = await attach("u_lh_other", "leadingHand", {
      templateId: "tpl_rough",
      scope: "job",
    });
    expect(res.statusCode).toBe(403);
  });

  it("a field worker on the job can see the queue but cannot attach", async () => {
    const res = await attach("u_field", "electrician", {
      templateId: "tpl_rough",
      scope: "job",
    });
    expect(res.statusCode).toBe(403);
  });

  it("REFUSES an archived template (#284 closes the gap #387 deferred)", async () => {
    blob.set("itp-templates.json", {
      templates: [{ id: "tpl_old", name: "Retired QA", archived: true, points: [] }],
    });
    const res = await attach("u_admin", "office", { templateId: "tpl_old", scope: "job" });
    expect(res.statusCode).toBe(400);
  });

  it("editing a template NEVER mutates an attached instance (snapshot semantics, #284)", async () => {
    const attached = await attach("u_admin", "office", { templateId: "tpl_rough", scope: "job" });
    expect(attached.statusCode).toBe(201);

    // PATCH the template through the REAL templates handler
    const templatesHandler = requireFromHere(templatesPath) as typeof handler;
    const res = createRes();
    await templatesHandler(
      {
        method: "PATCH",
        query: { id: "tpl_rough" },
        headers: {
          cookie: `buhl_session=${auth.signSession({ userId: "u_admin", role: "office", exp: Date.now() + 60_000 })}`,
        },
        body: { name: "Renamed QA", points: [{ label: "Completely different", type: "note" }] },
      },
      res,
    );
    expect(res.statusCode).toBe(200);

    const stored = blob.get("jobs/j1/itps.json") as {
      instances: Array<{ templateSnapshot: { name: string; points: Array<{ id: string }> } }>;
    };
    expect(stored.instances[0]!.templateSnapshot.name).toBe("Rough-in QA");
    expect(stored.instances[0]!.templateSnapshot.points.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("rejects an unknown scope and a missing template", async () => {
    const badScope = await attach("u_admin", "office", {
      templateId: "tpl_rough",
      scope: "building",
    });
    expect(badScope.statusCode).toBe(400);

    const missing = await attach("u_admin", "office", { templateId: "tpl_nope", scope: "job" });
    expect(missing.statusCode).toBe(404);
  });
});
