import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/jobs-bulk-edit.js — specifically the area-id
 * uniqueness guard on the BULK-EDIT write path (#491 fix).
 *
 * The merge gate for #491 found that validateAreaGroups guarded create / PUT /
 * duplicate / draft, but jobs-bulk-edit.js mutated areaGroups and wrote
 * jobs.json WITHOUT any uniqueness check — so `unarchive-area` could resurrect
 * an archived area whose id collides with a live one, putting two live areas
 * with the same id on disk (the exact silent mis-key the guard exists to
 * prevent: dwellings[areaId] task state, /api/task-toggle's write target, the
 * Phil area selector's first-match find, and the canonical task index all key
 * on a unique live areaId).
 *
 * These exercise the REAL serverless handler (not just validateAreaGroups) with
 * a signed admin session and an in-memory Vercel Blob replacement — same harness
 * shape as task-toggle-api.test.ts. Tests 1 and 3 FAIL on the pre-fix handler
 * (which returned 200 and persisted the collision) and PASS after the fix.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const handlerPath = requireFromHere.resolve("../../../api/jobs-bulk-edit.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>,
) => Promise<unknown>;

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
  return `buhl_session=${auth.signSession({
    userId,
    role,
    exp: Date.now() + 60_000,
  })}`;
}

async function call(jobId: string, operations: unknown[]) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId },
      body: { operations },
      headers: { cookie: cookieFor("u_admin", "admin") },
    },
    res,
  );
  return res;
}

/** Read a job's area groups straight out of the persisted in-memory blob. */
function persistedJob(jobId: string) {
  const data = blob.get("jobs.json") as { jobs?: Array<{ id: string; areaGroups?: unknown }> };
  return (data.jobs || []).find((j) => j.id === jobId);
}
function persistedArea(jobId: string, areaId: string) {
  const job = persistedJob(jobId) as
    | { areaGroups?: Array<{ areas?: Array<{ id: string; name: string; archived?: boolean }> }> }
    | undefined;
  for (const g of job?.areaGroups ?? []) {
    for (const a of g.areas ?? []) if (a.id === areaId) return a;
  }
  return undefined;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    ["users.json", { users: [{ id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] }] }],
    [
      "jobs.json",
      {
        jobs: [
          // A job whose on-disk state already carries an ARCHIVED area sharing an
          // id with a LIVE one (exactly what the jobs.js PUT-by-name reuse can
          // produce). The archived copy is FIRST so findArea(op.areaId) targets
          // it — unarchiving it would make TWO live areas keyed `ar_dup`.
          {
            id: "job-collide",
            name: "Collide",
            status: "active",
            areaGroups: [
              {
                id: "g1",
                name: "Level 1",
                areas: [
                  { id: "ar_dup", name: "Old Kitchen", archived: true },
                  { id: "ar_dup", name: "New Kitchen" },
                ],
              },
            ],
          },
          // A clean job: one live area + one archived area with a DISTINCT id.
          {
            id: "job-clean",
            name: "Clean",
            status: "active",
            areaGroups: [
              {
                id: "g1",
                name: "Level 1",
                areas: [
                  { id: "ar_kitchen", name: "Kitchen" },
                  { id: "ar_store", name: "Store", archived: true },
                ],
              },
            ],
          },
          // A job already corrupted with TWO LIVE areas sharing an id.
          {
            id: "job-prelive-dup",
            name: "Pre-corrupted",
            status: "active",
            areaGroups: [
              {
                id: "g1",
                name: "Level 1",
                areas: [
                  { id: "ar_dup", name: "Live A" },
                  { id: "ar_dup", name: "Live B" },
                ],
              },
            ],
          },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[auditPath];
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

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("jobs-bulk-edit area-id uniqueness guard", () => {
  it("rejects an unarchive that would create two live areas with the same id, and persists NOTHING", async () => {
    const res = await call("job-collide", [{ op: "unarchive-area", areaId: "ar_dup" }]);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("duplicate");
    expect((res.body as { error: string }).error).toContain("ar_dup");

    // The on-disk archived copy must STILL be archived — the batch aborted
    // before writeBlob, so the collision never reached disk.
    const stillArchived = persistedArea("job-collide", "ar_dup");
    expect(stillArchived?.archived).toBe(true);
  });

  it("rejects ANY area op on a job that already has duplicate live area ids (op-agnostic guard)", async () => {
    const res = await call("job-prelive-dup", [
      { op: "rename-area", areaId: "ar_dup", name: "Renamed" },
    ]);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("ar_dup");

    // Nothing persisted: the first ar_dup area keeps its original name.
    expect(persistedArea("job-prelive-dup", "ar_dup")?.name).toBe("Live A");
  });

  it("allows unarchiving an area whose id does NOT collide with a live area", async () => {
    const res = await call("job-clean", [{ op: "unarchive-area", areaId: "ar_store" }]);

    expect(res.statusCode).toBe(200);
    expect((res.body as { applied: number }).applied).toBe(1);
    // The restored area is now live (archived flag cleared) and persisted.
    expect(persistedArea("job-clean", "ar_store")?.archived).toBeUndefined();
  });

  it("still applies a normal area op on a clean job (no false rejection)", async () => {
    const res = await call("job-clean", [
      { op: "rename-area", areaId: "ar_kitchen", name: "Main Kitchen" },
    ]);

    expect(res.statusCode).toBe(200);
    expect((res.body as { applied: number }).applied).toBe(1);
    expect(persistedArea("job-clean", "ar_kitchen")?.name).toBe("Main Kitchen");
  });
});
