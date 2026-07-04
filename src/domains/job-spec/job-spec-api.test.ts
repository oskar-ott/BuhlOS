import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/job-spec against the REAL handler — the product-spec register on a job
 * (Job Builder redesign · Wave 3; the product half of "Spec & circuits").
 * Standard harness: signed sessions + in-memory blob via require.cache
 * injection (mirrors circuit-boards-api.test.ts).
 *
 * Pins:
 *   - GET returns { systems } ([] by default); anyone who can see the job reads.
 *   - PUT persists onto job.productSpec, mints ps_/pl_ ids, preserves supplied
 *     ids, normalises qty (int ≥ 0, junk/blank → null — never an invented 0).
 *   - validation: system name + line product required; duplicate ids 400.
 *   - auth: only canManageJob writes (unassigned LH 403s, client 403s).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-spec.js");

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
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

function call(
  method: string,
  userId: string,
  role: string,
  body: Record<string, unknown> | undefined,
  jobId = "j1",
): Promise<Res> {
  const res = createRes();
  return handler(
    {
      method,
      query: { jobId },
      headers: { cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}` },
      body,
    },
    res,
  ).then(() => res);
}

const ADMIN = ["u_admin", "office"] as const;
const LH_OTHER = ["u_lh_other", "leadingHand"] as const;
const CLIENT = ["u_client", "client"] as const;

type SpecSystem = {
  id: string;
  name: string;
  edgeNote: string;
  lines: Array<{ id: string; qty: number | null; product: string; supplier: string }>;
};

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh_other", username: "lead2", role: "leadingHand", assignedJobIds: ["j2"], passwordHash: "$2a$10$x" },
      { id: "u_client", username: "owner", role: "client", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      { id: "j1", name: "Riverside", clientUserId: "u_client" },
      { id: "j2", name: "Depot" },
    ],
  });

  for (const p of [authPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

function jobsStore() {
  return blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
}

describe("GET /api/job-spec", () => {
  it("returns empty systems by default", async () => {
    const res = await call("GET", ...ADMIN, undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ systems: [] });
  });

  it("404s an unknown job and 403s a viewer who can't see the job", async () => {
    const missing = await call("GET", ...ADMIN, undefined, "j9");
    expect(missing.statusCode).toBe(404);
    const other = await call("GET", ...LH_OTHER, undefined); // assigned j2, asks j1
    expect(other.statusCode).toBe(403);
  });

  it("lets the job's client read (but never write)", async () => {
    const read = await call("GET", ...CLIENT, undefined);
    expect(read.statusCode).toBe(200);
    const write = await call("PUT", ...CLIENT, { systems: [] });
    expect(write.statusCode).toBe(403);
  });
});

describe("PUT /api/job-spec", () => {
  it("persists systems onto job.productSpec, mints ps_/pl_ ids, normalises qty", async () => {
    const res = await call("PUT", ...ADMIN, {
      systems: [
        {
          name: "Power / GPOs",
          edgeNote: "Anything not on E-201 rev C is a variation.",
          lines: [
            { qty: "16", product: "Clipsal Iconic 3025 double GPO, white", supplier: "" },
            { qty: "", product: "Iconic 3041 single GPO", supplier: "joiner supplies carcass" },
            { qty: "junk", product: "USB-C combo mech" },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const systems = (res.body as { systems: SpecSystem[] }).systems;
    expect(systems).toHaveLength(1);
    const s = systems[0]!;
    expect(s.id).toMatch(/^ps_/);
    expect(s.edgeNote).toContain("variation");
    expect(s.lines.map((l) => l.id).every((id) => /^pl_/.test(id))).toBe(true);
    // qty: "16" → 16; "" → null; junk → null (never a fake 0)
    expect(s.lines.map((l) => l.qty)).toEqual([16, null, null]);
    expect(s.lines[1]!.supplier).toBe("joiner supplies carcass");
    // persisted on the job record
    const job = jobsStore().jobs.find((j) => j.id === "j1")!;
    expect((job.productSpec as SpecSystem[])[0]!.name).toBe("Power / GPOs");
  });

  it("preserves supplied ids and rejects duplicates", async () => {
    const keep = await call("PUT", ...ADMIN, {
      systems: [{ id: "ps_keep", name: "Lighting", lines: [{ id: "pl_keep", product: "90mm LED downlight 3000K" }] }],
    });
    const kept = (keep.body as { systems: SpecSystem[] }).systems[0]!;
    expect(kept.id).toBe("ps_keep");
    expect(kept.lines[0]!.id).toBe("pl_keep");

    const dup = await call("PUT", ...ADMIN, {
      systems: [{ id: "x", name: "A", lines: [] }, { id: "x", name: "B", lines: [] }],
    });
    expect(dup.statusCode).toBe(400);
    expect((dup.body as { error: string }).error).toMatch(/duplicate/);
  });

  it("requires a system name and a line product", async () => {
    const noName = await call("PUT", ...ADMIN, { systems: [{ lines: [] }] });
    expect(noName.statusCode).toBe(400);
    expect((noName.body as { error: string }).error).toMatch(/name required/);

    const noProduct = await call("PUT", ...ADMIN, { systems: [{ name: "Smoke", lines: [{ qty: 2 }] }] });
    expect(noProduct.statusCode).toBe(400);
    expect((noProduct.body as { error: string }).error).toMatch(/product required/);
  });

  it("403s a manager of a different job", async () => {
    const res = await call("PUT", ...LH_OTHER, { systems: [] });
    expect(res.statusCode).toBe(403);
  });
});
