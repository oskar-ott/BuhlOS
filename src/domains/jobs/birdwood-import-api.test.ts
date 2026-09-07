import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/birdwood-import.js against the real handler (mocked blob, real HMAC
 * sessions) — the one-off owner phone import. Pins the boundary that makes
 * it safe to expose as a GET: owner-only fail-closed gate, dry-run by
 * default (zero writes), fail-closed target resolution (ambiguity → 409,
 * never a guess), the sanctioned single-writer create, the one-batch-write
 * into-mode, and idempotent re-runs.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/birdwood-import.js");

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let blob: Map<string, unknown>;
let writes: string[];
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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

async function call(opts: {
  method?: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
}) {
  const res = createRes();
  await handler(
    {
      method: opts.method ?? "GET",
      query: opts.query ?? {},
      headers: {
        cookie: `buhl_session=${auth.signSession({
          userId: opts.userId ?? "u_owner",
          role: opts.role ?? "owner",
          exp: Date.now() + 60_000,
        })}`,
      },
    },
    res
  );
  return res;
}

function jobsOnDisk(): Array<Record<string, unknown>> {
  return (blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> }).jobs;
}

function seedJobs(jobs: Array<Record<string, unknown>>) {
  blob.set("jobs.json", { jobs });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  writes = [];
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_owner", username: "oskar", role: "owner" },
          { id: "u_admin", username: "boss", role: "boss" },
        ],
      },
    ],
  ]);
  seedJobs([{ id: "j1", name: "2 Bay St Double Bay", status: "active", areaGroups: [] }]);
  for (const p of [blobPath, authPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        writes.push(key);
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("owner-only boundary", () => {
  it("a non-owner admin gets a fail-closed 403, nothing read into a write", async () => {
    const res = await call({ role: "boss", userId: "u_admin" });
    expect(res.statusCode).toBe(403);
    expect(writes).toEqual([]);
  });

  it("non-GET is 405", async () => {
    const res = await call({ method: "POST" });
    expect(res.statusCode).toBe(405);
  });
});

describe("dry run (no ?confirm)", () => {
  it("returns the plan — 95 tasks, 30 waiting — and writes nothing", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      dryRun: boolean;
      mode: string;
      wouldCreate: string;
      plan: { total: number; waiting: number; townhouses: unknown[] };
    };
    expect(body.dryRun).toBe(true);
    expect(body.mode).toBe("create");
    expect(body.wouldCreate).toContain("Birdwood");
    expect(body.plan.total).toBe(95);
    expect(body.plan.waiting).toBe(30);
    expect(body.plan.townhouses).toHaveLength(7);
    expect(writes).toEqual([]);
  });

  it("with exactly one ACTIVE Birdwood job, the mode is into that job", async () => {
    seedJobs([
      { id: "j1", name: "2 Bay St Double Bay", status: "active", areaGroups: [] },
      { id: "bw1", name: "Birdwood Ave", status: "active", areaGroups: [] },
    ]);
    const res = await call({});
    const body = res.body as { mode: string; target: { id: string } };
    expect(body.mode).toBe("into");
    expect(body.target.id).toBe("bw1");
    expect(writes).toEqual([]);
  });
});

describe("apply (?confirm=import)", () => {
  it("no Birdwood job at all → creates an ACTIVE job through the sanctioned writer, with seeds", async () => {
    const res = await call({ query: { confirm: "import" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { mode: string; jobId: string; tasks: number; philUrl: string };
    expect(body.mode).toBe("create");
    expect(body.tasks).toBe(95);
    expect(body.philUrl).toBe(`/phil/jobs/${body.jobId}`);
    const created = jobsOnDisk().find((j) => j.id === body.jobId) as {
      status: string;
      areaGroups: Array<{ name: string; areas: Array<{ id: string; fitOffTasks: Array<{ id: string }> }> }>;
    };
    expect(created.status).toBe("active");
    expect(created.areaGroups[0]?.name).toBe("Townhouses 1–7");
    expect(created.areaGroups[0]?.areas).toHaveLength(7);
    // Server-minted ids on every area + task.
    for (const a of created.areaGroups[0]!.areas) {
      expect(a.id).toMatch(/^ar_/);
      for (const t of a.fitOffTasks) expect(t.id).toMatch(/^ft_/);
    }
    // The per-job seeds ride the same create (jobs.json + data/tags/temps).
    expect(writes).toContain("jobs.json");
    expect(writes).toContain(`jobs/${body.jobId}/data.json`);
  });

  it("one active Birdwood job → appends the group to it in ONE jobs.json write", async () => {
    seedJobs([
      {
        id: "bw1",
        name: "Birdwood Ave",
        status: "active",
        areaGroups: [{ id: "ag_1", name: "Existing", areas: [{ id: "ar_1", name: "Meter room" }] }],
      },
    ]);
    const res = await call({ query: { confirm: "import" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as { mode: string; jobId: string };
    expect(body.mode).toBe("into");
    expect(body.jobId).toBe("bw1");
    expect(writes).toEqual(["jobs.json"]);
    const job = jobsOnDisk().find((j) => j.id === "bw1") as {
      areaGroups: Array<{ name: string }>;
    };
    expect(job.areaGroups.map((g) => g.name)).toEqual(["Existing", "Townhouses 1–7"]);
  });

  it("re-running after an import is a no-op alreadyImported, nothing written", async () => {
    seedJobs([{ id: "bw1", name: "Birdwood Ave", status: "active", areaGroups: [] }]);
    await call({ query: { confirm: "import" } });
    const wroteOnce = [...writes];
    const res = await call({ query: { confirm: "import" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { alreadyImported: boolean }).alreadyImported).toBe(true);
    expect(writes).toEqual(wroteOnce);
  });

  it("ambiguity fails closed: two Birdwood jobs → 409 with candidates, nothing written", async () => {
    seedJobs([
      { id: "bw1", name: "Birdwood Ave", status: "active", areaGroups: [] },
      { id: "bw2", name: "Birdwood Stage 2", status: "active", areaGroups: [] },
    ]);
    const res = await call({ query: { confirm: "import" } });
    expect(res.statusCode).toBe(409);
    const body = res.body as { candidates: Array<{ id: string }> };
    expect(body.candidates.map((c) => c.id).sort()).toEqual(["bw1", "bw2"]);
    expect(writes).toEqual([]);
  });

  it("?into targets an explicit job even when auto-resolution would refuse", async () => {
    seedJobs([
      { id: "bw1", name: "Birdwood Ave", status: "on_hold", areaGroups: [] },
      { id: "bw2", name: "Birdwood Stage 2", status: "draft", areaGroups: [] },
    ]);
    const res = await call({ query: { confirm: "import", into: "bw2" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobId: string }).jobId).toBe("bw2");
    expect(writes).toEqual(["jobs.json"]);
  });

  it("an empty registry read refuses to write anything", async () => {
    blob.delete("jobs.json");
    const res = await call({ query: { confirm: "import" } });
    expect(res.statusCode).toBe(500);
    expect(writes).toEqual([]);
  });
});
