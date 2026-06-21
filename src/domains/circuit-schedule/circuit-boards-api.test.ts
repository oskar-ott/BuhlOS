import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the `boards` facet of /api/job-circuits against the
 * REAL handler — the rich AS/NZS-3000 circuit schedule the office builder +
 * Phil field view share. Standard harness: signed sessions + in-memory blob
 * via require.cache injection (mirrors job-itps-attach-api.test.ts).
 *
 * Pins:
 *   - GET returns { switchboards, circuits, boards }.
 *   - PUT boards persists onto job.circuitBoards, mints + preserves ids,
 *     normalises enums/numbers, stamps updated/updatedBy on content change.
 *   - additive: PUT boards never touches the legacy switchboards/circuits
 *     register on the same job.
 *   - auth: a viewer who can see the job reads it; only canManageJob writes.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const handlerPath = requireFromHere.resolve("../../../api/job-circuits.js");

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
  query: Record<string, string> = {},
): Promise<Res> {
  const res = createRes();
  return handler(
    {
      method,
      query: { jobId, ...query },
      headers: { cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}` },
      body,
    },
    res,
  ).then(() => res);
}

const ADMIN = ["u_admin", "office"] as const;
const FIELD = ["u_field", "electrician"] as const;
const LH_OTHER = ["u_lh_other", "leadingHand"] as const;
const CLIENT = ["u_client", "client"] as const;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
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

  for (const p of [authPath, auditPath, handlerPath]) delete requireFromHere.cache[p];
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
type Board = { id: string; name: string; supply: string; status: string; updated: string; updatedBy: string; circuits: Array<{ id: string }> };

describe("GET /api/job-circuits boards facet", () => {
  it("returns switchboards + circuits + boards (empty by default)", async () => {
    const res = await call("GET", ...ADMIN, undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ jobId: "j1", switchboards: [], circuits: [], boards: [] });
  });
});

describe("PUT /api/job-circuits boards facet", () => {
  it("persists boards, mints board + circuit ids, normalises, stamps the editor", async () => {
    const res = await call("PUT", ...ADMIN, {
      boards: [{ name: "Main switchboard", supply: "3ph", ways: 12, circuits: [{ desc: "Lighting" }, { desc: "GPOs" }] }],
    });
    expect(res.statusCode).toBe(200);
    const boards = (res.body as { boards: Board[] }).boards;
    expect(boards).toHaveLength(1);
    const b = boards[0]!;
    expect(b.id).toMatch(/^cb_/);
    expect(b.supply).toBe("3ph");
    expect(b.status).toBe("draft"); // unspecified → default
    expect(b.circuits).toHaveLength(2);
    expect(b.circuits.every((c) => /^cc_/.test(c.id))).toBe(true);
    expect(b.updatedBy).toBe("boss");
    expect(Number.isNaN(Date.parse(b.updated))).toBe(false);
    // persisted onto the job record
    const job = jobsStore().jobs.find((j) => j.id === "j1")!;
    expect((job.circuitBoards as unknown[]).length).toBe(1);
  });

  it("preserves a client-supplied id and rejects duplicate board ids", async () => {
    const keep = await call("PUT", ...ADMIN, { boards: [{ id: "cb_keep", name: "DB-1" }] });
    expect((keep.body as { boards: Board[] }).boards[0]!.id).toBe("cb_keep");

    const dup = await call("PUT", ...ADMIN, { boards: [{ id: "x", name: "A" }, { id: "x", name: "B" }] });
    expect(dup.statusCode).toBe(400);
    expect((dup.body as { error: string }).error).toMatch(/duplicate/);
  });

  it("requires a board name", async () => {
    const res = await call("PUT", ...ADMIN, { boards: [{ supply: "1ph" }] });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/name required/);
  });

  it("does not rewrite updated/updatedBy when content is unchanged", async () => {
    const first = await call("PUT", ...ADMIN, { boards: [{ id: "cb_a", name: "DB-A", circuits: [{ id: "cc_1", desc: "L1" }] }] });
    const b1 = (first.body as { boards: Board[] }).boards[0]!;
    // Re-PUT the exact normalised board back — no content change.
    const second = await call("PUT", ...ADMIN, { boards: [b1] });
    const b2 = (second.body as { boards: Board[] }).boards[0]!;
    expect(b2.updated).toBe(b1.updated);
    expect(b2.updatedBy).toBe(b1.updatedBy);
  });

  it("is additive — never touches the legacy switchboards/circuits register", async () => {
    const job = jobsStore().jobs.find((j) => j.id === "j1")!;
    job.switchboards = [{ id: "sb_1", code: "MSB" }];
    job.circuits = [{ id: "ci_1", number: "C1", switchboardId: "sb_1", type: "power", status: "planned" }];

    await call("PUT", ...ADMIN, { boards: [{ name: "DB-1" }] });

    const res = await call("GET", ...ADMIN, undefined);
    const body = res.body as { switchboards: unknown[]; circuits: unknown[]; boards: unknown[] };
    expect(body.switchboards).toHaveLength(1);
    expect(body.circuits).toHaveLength(1);
    expect(body.boards).toHaveLength(1);
  });
});

describe("install normalisation", () => {
  it("normalises each way's install state (unknown → todo, valid kept)", async () => {
    const res = await call("PUT", ...ADMIN, {
      boards: [{ name: "DB-1", circuits: [{ desc: "a", install: "installed" }, { desc: "b", install: "bogus" }, { desc: "c" }] }],
    });
    expect(res.statusCode).toBe(200);
    const circuits = (res.body as { boards: Array<{ circuits: Array<{ install: string }> }> }).boards[0]!.circuits;
    expect(circuits.map((c) => c.install)).toEqual(["installed", "todo", "todo"]);
  });
});

describe("auth on the boards facet — the schedule is field-owned", () => {
  it("an assigned field worker can read AND write the boards (owns the schedule)", async () => {
    expect((await call("GET", ...FIELD, undefined)).statusCode).toBe(200);
    const put = await call("PUT", ...FIELD, { boards: [{ name: "DB-1" }] });
    expect(put.statusCode).toBe(200);
    // …and the server stamps the field worker as the editor.
    expect((put.body as { boards: Board[] }).boards[0]!.updatedBy).toBe("sparky");
  });

  it("but an assigned field worker still cannot touch the legacy register", async () => {
    const res = await call("PUT", ...FIELD, { switchboards: [{ code: "MSB" }] });
    expect(res.statusCode).toBe(403);
  });

  it("a client who can see the job is read-only (never writes boards)", async () => {
    expect((await call("GET", ...CLIENT, undefined)).statusCode).toBe(200);
    expect((await call("PUT", ...CLIENT, { boards: [{ name: "DB-1" }] })).statusCode).toBe(403);
  });

  it("a leading hand not assigned to the job cannot even read it", async () => {
    expect((await call("GET", ...LH_OTHER, undefined)).statusCode).toBe(403);
  });
});

describe("POST ?action=set-install — the one-tap field path", () => {
  async function seedBoard(): Promise<{ boardId: string; circuitId: string }> {
    const res = await call("PUT", ...ADMIN, {
      boards: [{ id: "cb_1", name: "DB-1", circuits: [{ id: "cc_1", desc: "GPOs" }] }],
    });
    expect(res.statusCode).toBe(200);
    return { boardId: "cb_1", circuitId: "cc_1" };
  }

  it("an assigned field worker marks a way installed; it persists + stamps them", async () => {
    const { boardId, circuitId } = await seedBoard();
    const res = await call("POST", ...FIELD, { boardId, circuitId, install: "installed" }, "j1", { action: "set-install" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ boardId, circuitId, install: "installed" });
    const job = jobsStore().jobs.find((j) => j.id === "j1")!;
    const board = (job.circuitBoards as Array<{ id: string; updatedBy: string; circuits: Array<{ id: string; install: string }> }>)[0]!;
    expect(board.circuits[0]!.install).toBe("installed");
    expect(board.updatedBy).toBe("sparky");
  });

  it("rejects an unknown install value", async () => {
    const { boardId, circuitId } = await seedBoard();
    const res = await call("POST", ...FIELD, { boardId, circuitId, install: "done" }, "j1", { action: "set-install" });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown circuit", async () => {
    await seedBoard();
    const res = await call("POST", ...FIELD, { boardId: "cb_1", circuitId: "nope", install: "tested" }, "j1", { action: "set-install" });
    expect(res.statusCode).toBe(404);
  });

  it("a client cannot set install state", async () => {
    const { boardId, circuitId } = await seedBoard();
    const res = await call("POST", ...CLIENT, { boardId, circuitId, install: "installed" }, "j1", { action: "set-install" });
    expect(res.statusCode).toBe(403);
  });
});
