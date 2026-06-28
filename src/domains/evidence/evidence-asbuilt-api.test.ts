import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #233 — api/evidence.js flag-asbuilt integration tests.
 *
 * Same real-handler harness as evidence-pairing-api.test.ts: an in-memory Blob
 * is injected, the audit writers are stubbed, and the real handler runs against
 * a seeded data.json.
 *
 * Locks the PERMISSION ASYMMETRY (easy to get wrong):
 *   - FLAG  (asBuilt=true):  the capturer of THIS row may flag their OWN; an
 *     admin or a leading-hand-on-the-job may flag ANY; a different tradie → 403;
 *     a client → 403; unauth → 401.
 *   - UNFLAG (asBuilt=false): the capturer may clear their OWN; an admin may
 *     clear ANY; a leading-hand who isn't the capturer → 403 (admin only).
 * Plus: idempotent no-op, 404 for a missing row, and the summary asBuilt count.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const jobAuditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const handlerPath = requireFromHere.resolve("../../../api/evidence.js");

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
const DATA_KEY = `jobs/${JOB}/data.json`;

interface Row {
  id: string;
  jobId?: string;
  kind?: "photo" | "note";
  capturedById?: string;
  asBuilt?: boolean;
  [k: string]: unknown;
}

function photoRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    jobId: JOB,
    kind: "photo",
    photoId: `ph_${id}`,
    photoUrl: `https://blob.example/${id}.jpg`,
    note: null,
    capturedById: "u_field",
    capturedByName: "Sam",
    capturedByRole: "electrician",
    capturedAt: "2026-05-25T10:00:00.000Z",
    status: "submitted",
    source: "phil",
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    rejectionReason: null,
    pairedWithId: null,
    auditLogIds: ["al_seed"],
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:00.000Z",
    ...over,
  };
}

function seed(rows: Row[]): void {
  blob.set(DATA_KEY, { dwellings: {}, snags: [], evidence: rows, notes: [] });
}

function storedById(id: string): Row | undefined {
  const data = blob.get(DATA_KEY) as { evidence?: Row[] } | undefined;
  return (data?.evidence ?? []).find((e) => e.id === id);
}

async function flag(
  body: Record<string, unknown>,
  { userId = "u_field", role = "electrician", withCookie = true }: { userId?: string; role?: string; withCookie?: boolean } = {},
) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId: JOB, action: "flag-asbuilt" },
      headers: withCookie ? { cookie: cookieFor(userId, role) } : {},
      body,
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
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [JOB] },
          { id: "u_other", username: "mate", role: "electrician", assignedJobIds: [JOB] },
          { id: "u_lh", username: "boss-lh", role: "leadinghand", assignedJobIds: [JOB] },
          { id: "u_lh_off", username: "lh-off", role: "leadinghand", assignedJobIds: ["job-2"] },
          { id: "u_admin", username: "anna", role: "admin", assignedJobIds: [] },
          { id: "u_client", username: "owner", role: "client", assignedJobIds: [JOB] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [{ id: JOB, name: "Active", status: "active", areaGroups: [] }],
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
  requireFromHere.cache[auditLogPath] = {
    id: auditLogPath,
    filename: auditLogPath,
    loaded: true,
    exports: { append: vi.fn(async () => ({ id: "al_new" })) },
  } as NodeJS.Module;
  requireFromHere.cache[jobAuditPath] = {
    id: jobAuditPath,
    filename: jobAuditPath,
    loaded: true,
    exports: { appendAudit: vi.fn(async () => null) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/evidence flag-asbuilt — flag (asBuilt=true)", () => {
  it("the capturing worker can flag their OWN capture", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { evidenceItem: Row }).evidenceItem.asBuilt).toBe(true);
    expect(storedById("ev1")?.asBuilt).toBe(true);
    expect(storedById("ev1")?.auditLogIds).toContain("al_new");
  });

  it("a DIFFERENT tradie (not the capturer) is 403", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_other", role: "electrician" });
    expect(res.statusCode).toBe(403);
    expect(storedById("ev1")?.asBuilt).toBeUndefined();
  });

  it("a leading hand ON the job can flag ANY capture", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_lh", role: "leadinghand" });
    expect(res.statusCode).toBe(200);
    expect(storedById("ev1")?.asBuilt).toBe(true);
  });

  it("a leading hand OFF the job cannot flag someone else's — 403", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_lh_off", role: "leadinghand" });
    expect(res.statusCode).toBe(403);
  });

  it("an admin can flag ANY capture (even on an unassigned job)", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(storedById("ev1")?.asBuilt).toBe(true);
  });

  it("a client is 403 (read-only role)", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(403);
  });

  it("an unauthenticated request is 401", async () => {
    seed([photoRow("ev1")]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { withCookie: false });
    expect(res.statusCode).toBe(401);
  });

  it("404s a missing evidence row", async () => {
    seed([photoRow("ev1")]);
    const res = await flag({ evidenceId: "ghost", asBuilt: true }, { userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent — re-flagging an already-flagged row is a 200 no-op", async () => {
    seed([photoRow("ev1", { asBuilt: true, capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: true }, { userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { idempotentNoop?: boolean }).idempotentNoop).toBe(true);
  });

  it("rejects a non-boolean asBuilt (400)", async () => {
    seed([photoRow("ev1")]);
    const res = await flag({ evidenceId: "ev1", asBuilt: "yes" }, { userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/evidence flag-asbuilt — unflag (asBuilt=false)", () => {
  it("the capturer can clear their OWN flag", async () => {
    seed([photoRow("ev1", { asBuilt: true, capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: false }, { userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect(storedById("ev1")?.asBuilt).toBe(false);
  });

  it("an admin can clear ANY flag", async () => {
    seed([photoRow("ev1", { asBuilt: true, capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: false }, { userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(storedById("ev1")?.asBuilt).toBe(false);
  });

  it("a leading hand who isn't the capturer CANNOT unflag — 403 (admin only)", async () => {
    seed([photoRow("ev1", { asBuilt: true, capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: false }, { userId: "u_lh", role: "leadinghand" });
    expect(res.statusCode).toBe(403);
    expect(storedById("ev1")?.asBuilt).toBe(true);
  });

  it("is idempotent — clearing an unflagged row is a 200 no-op", async () => {
    seed([photoRow("ev1", { capturedById: "u_field" })]);
    const res = await flag({ evidenceId: "ev1", asBuilt: false }, { userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { idempotentNoop?: boolean }).idempotentNoop).toBe(true);
  });
});
