import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inductionStateFor } from "./induction";

/**
 * API contract: /api/job-inductions (#332) — the per-job induction register.
 *
 * Pinned promises:
 *   - self-confirm records the SESSION identity (assignment-gated, live
 *     account, field-visible job — draft/archived blocked for field);
 *   - double-tap is idempotent: the existing record returns, no duplicate;
 *   - office backfill is admin-only, lands under its own audit verb
 *     (induction.backfilled vs induction.confirmed) and may target an
 *     unassigned worker (paper reality);
 *   - crew status = CURRENT assignment ∩ records — a worker added after the
 *     others were inducted reads "not yet", never a false complete;
 *   - field workers never read each other's induction state (full view is
 *     admin-tier; ?mine=1 is scoped by the session);
 *   - jobs without the flag refuse confirms (400) — zero behaviour change.
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/job-inductions.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;

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

async function call(
  viewer: { id: string; role: string } | null,
  opts: { method?: string; query?: Record<string, string>; body?: Record<string, unknown> } = {}
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: opts.method ?? "GET",
      query: opts.query ?? {},
      body: opts.body,
      headers: viewer ? { cookie: cookieFor(viewer.id, viewer.role) } : {},
    },
    res
  );
  return res;
}

const ADMIN = { id: "u_admin", role: "admin" };
const ELEC = { id: "u_elec", role: "electrician" };
const TRADIE = { id: "u_tradie", role: "tradie" };
const OUTSIDER = { id: "u_out", role: "tradie" };
const CLIENT = { id: "u_client", role: "client" };

function recordOf(res: Res): Record<string, unknown> {
  return (res.body as { record: Record<string, unknown> }).record;
}

function ledger(jobId: string): Array<Record<string, unknown>> {
  return (
    (blob.get(`jobs/${jobId}/inductions.json`) as { records: Array<Record<string, unknown>> })
      ?.records ?? []
  );
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
          { id: "u_elec", username: "sparky", role: "electrician", assignedJobIds: ["j1", "j2"] },
          { id: "u_tradie", username: "mick", role: "tradie", assignedJobIds: ["j1"] },
          { id: "u_out", username: "out", role: "tradie", assignedJobIds: [] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["j1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "j1", name: "Riverside", status: "active", inductionRequired: true },
          { id: "j2", name: "Depot", status: "active", inductionRequired: false },
          { id: "j_draft", name: "Draft", status: "draft", inductionRequired: true },
        ],
      },
    ],
  ]);

  for (const p of [blobSdkPath, blobPath, authPath, auditPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() },
  } as NodeJS.Module;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
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

describe("inductionStateFor — the pure three-state helper", () => {
  it("not-required when the flag is off/null, regardless of records", () => {
    expect(inductionStateFor(false, null)).toBe("not-required");
    expect(inductionStateFor(null, { completedAt: "2026-06-01T00:00:00Z" })).toBe("not-required");
    expect(inductionStateFor(undefined, null)).toBe("not-required");
  });
  it("required when flagged and no record; done once the record exists", () => {
    expect(inductionStateFor(true, null)).toBe("required");
    expect(inductionStateFor(true, { completedAt: "2026-06-01T00:00:00Z" })).toBe("done");
  });
});

describe("POST — worker self-confirm", () => {
  it("records the session identity on an assigned, flagged job", async () => {
    const res = await call(ELEC, { method: "POST", body: { jobId: "j1", note: "Done with Dave" } });
    expect(res.statusCode).toBe(201);
    expect(recordOf(res)).toMatchObject({
      jobId: "j1",
      workerId: "u_elec",
      workerName: "sparky",
      recordedBy: "u_elec",
      backfill: false,
      note: "Done with Dave",
    });
    expect(ledger("j1")).toHaveLength(1);
  });

  it("client-supplied workerId is never honoured for a non-admin (#112 attribution rule)", async () => {
    const res = await call(ELEC, {
      method: "POST",
      body: { jobId: "j1", workerId: "u_tradie" },
    });
    // Worker naming someone else = backfill attempt → office only.
    expect(res.statusCode).toBe(403);
    expect(ledger("j1")).toHaveLength(0);
  });

  it("double-tap is idempotent — existing record back, no duplicate", async () => {
    const first = await call(ELEC, { method: "POST", body: { jobId: "j1" } });
    expect(first.statusCode).toBe(201);
    const again = await call(ELEC, { method: "POST", body: { jobId: "j1" } });
    expect(again.statusCode).toBe(200);
    expect((again.body as { already?: boolean }).already).toBe(true);
    expect(recordOf(again).id).toBe(recordOf(first).id);
    expect(ledger("j1")).toHaveLength(1);
  });

  it("403s a worker not assigned to the job", async () => {
    const res = await call(OUTSIDER, { method: "POST", body: { jobId: "j1" } });
    expect(res.statusCode).toBe(403);
  });

  it("400s a job that does not require induction — zero behaviour change", async () => {
    const res = await call(ELEC, { method: "POST", body: { jobId: "j2" } });
    expect(res.statusCode).toBe(400);
  });

  it("403s field confirms on a draft job (office-only estate)", async () => {
    // Assign the worker to the draft job so ONLY the status guard trips.
    const users = blob.get("users.json") as { users: Array<{ id: string; assignedJobIds: string[] }> };
    users.users.find((u) => u.id === "u_elec")!.assignedJobIds.push("j_draft");
    const res = await call(ELEC, { method: "POST", body: { jobId: "j_draft" } });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown job; clients are locked out entirely", async () => {
    const ghost = await call(ELEC, { method: "POST", body: { jobId: "j_ghost" } });
    expect(ghost.statusCode).toBe(404);
    const client = await call(CLIENT, { method: "POST", body: { jobId: "j1" } });
    expect(client.statusCode).toBe(403);
  });
});

describe("POST — office backfill", () => {
  it("admin records for a worker under the BACKFILL verb, recorder retained", async () => {
    const res = await call(ADMIN, {
      method: "POST",
      body: { jobId: "j1", workerId: "u_tradie", note: "Paper form 10 Jun" },
    });
    expect(res.statusCode).toBe(201);
    expect(recordOf(res)).toMatchObject({
      workerId: "u_tradie",
      recordedBy: "u_admin",
      backfill: true,
    });
    // Audit: distinguishable verb.
    const auditKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    expect(auditKeys).toHaveLength(1);
    const entries = (blob.get(auditKeys[0]!) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({
      action: "induction.backfilled",
      targetType: "induction",
      jobId: "j1",
    });
  });

  it("self-confirm audits under induction.confirmed (distinct from backfill)", async () => {
    await call(ELEC, { method: "POST", body: { jobId: "j1" } });
    const auditKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    const entries = (blob.get(auditKeys[0]!) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]!.action).toBe("induction.confirmed");
  });

  it("backfill may target an unassigned worker (paper reality) but never by a field caller", async () => {
    const unassigned = await call(ADMIN, {
      method: "POST",
      body: { jobId: "j1", workerId: "u_out" },
    });
    expect(unassigned.statusCode).toBe(201);
    const field = await call(TRADIE, {
      method: "POST",
      body: { jobId: "j1", workerId: "u_out" },
    });
    expect(field.statusCode).toBe(403);
  });

  it("re-recording over an existing record APPENDS (re-induction), never edits", async () => {
    await call(ELEC, { method: "POST", body: { jobId: "j1" } });
    const again = await call(ADMIN, {
      method: "POST",
      body: { jobId: "j1", workerId: "u_elec", note: "New site rules" },
    });
    expect(again.statusCode).toBe(201);
    expect(ledger("j1")).toHaveLength(2); // append-only history
  });
});

describe("GET — scoping and crew status", () => {
  beforeEach(async () => {
    await call(ELEC, { method: "POST", body: { jobId: "j1" } });
  });

  it("?jobId&mine=1 returns my latest record; nothing for the uninducted", async () => {
    const mine = await call(ELEC, { query: { jobId: "j1", mine: "1" } });
    expect(mine.statusCode).toBe(200);
    expect(recordOf(mine)).toMatchObject({ workerId: "u_elec" });
    const none = await call(TRADIE, { query: { jobId: "j1", mine: "1" } });
    expect((none.body as { record: unknown }).record).toBeNull();
  });

  it("?mine=1 history fans out across MY jobs with job names", async () => {
    const res = await call(ELEC, { query: { mine: "1" } });
    expect(res.statusCode).toBe(200);
    const records = (res.body as { records: Array<{ jobId: string; jobName: string }> }).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "j1", jobName: "Riverside" });
  });

  it("full per-job view is admin-only; crew = current assignment ∩ records", async () => {
    const field = await call(ELEC, { query: { jobId: "j1" } });
    expect(field.statusCode).toBe(403);

    const admin = await call(ADMIN, { query: { jobId: "j1" } });
    expect(admin.statusCode).toBe(200);
    const body = admin.body as {
      crew: Array<{ workerId: string; inducted: boolean }>;
      inductionRequired: boolean;
    };
    expect(body.inductionRequired).toBe(true);
    // j1's live crew: u_elec (inducted) + u_tradie (not yet). The client
    // account assigned to j1 is not crew; u_out isn't assigned.
    expect(body.crew.map((c) => `${c.workerId}:${c.inducted}`).sort()).toEqual([
      "u_elec:true",
      "u_tradie:false",
    ]);
  });

  it("a worker assigned AFTER others were inducted reads not-yet — no false complete", async () => {
    const users = blob.get("users.json") as { users: Array<{ id: string; assignedJobIds: string[] }> };
    users.users.find((u) => u.id === "u_out")!.assignedJobIds.push("j1");
    const admin = await call(ADMIN, { query: { jobId: "j1" } });
    const crew = (admin.body as { crew: Array<{ workerId: string; inducted: boolean }> }).crew;
    expect(crew.find((c) => c.workerId === "u_out")).toMatchObject({ inducted: false });
  });

  it("unassigning an inducted worker keeps the record but drops them from crew", async () => {
    const users = blob.get("users.json") as { users: Array<{ id: string; assignedJobIds: string[] }> };
    users.users.find((u) => u.id === "u_elec")!.assignedJobIds = ["j2"];
    const admin = await call(ADMIN, { query: { jobId: "j1" } });
    const crew = (admin.body as { crew: Array<{ workerId: string }> }).crew;
    expect(crew.find((c) => c.workerId === "u_elec")).toBeUndefined();
    expect(ledger("j1")).toHaveLength(1); // history retained
  });
});
