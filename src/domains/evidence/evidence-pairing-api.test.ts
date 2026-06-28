import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #263 — api/evidence.js link / unlink integration tests.
 *
 * Same real-handler harness as evidence-create-idempotency-api.test.ts: an
 * in-memory Blob is injected, the audit writers are stubbed, and the real
 * handler runs against a seeded data.json.
 *
 * Covers the link matrix the issue calls for: resolve, self-link reject,
 * cross-job reject, note-kind reject, permission-by-role, idempotent
 * re-link, unlink, and the BEFORE-ROW-UNTOUCHED invariant (the before row
 * must stay byte-identical across a link AND an unlink).
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
const OTHER_JOB = "job-2";
const DATA_KEY = `jobs/${JOB}/data.json`;

interface Row {
  id: string;
  jobId?: string;
  kind?: "photo" | "note";
  capturedById?: string;
  pairedWithId?: string | null;
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

async function call(
  action: "link" | "unlink",
  body: Record<string, unknown>,
  { userId = "u_field", role = "electrician" }: { userId?: string; role?: string } = {},
) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId: JOB, action },
      headers: { cookie: cookieFor(userId, role) },
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
          { id: "u_admin", username: "anna", role: "admin", assignedJobIds: [] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: JOB, name: "Active", status: "active", areaGroups: [] },
          { id: OTHER_JOB, name: "Other", status: "active", areaGroups: [] },
        ],
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

describe("POST /api/evidence link (#263)", () => {
  it("links the AFTER to the BEFORE and returns the canonical after item", async () => {
    seed([photoRow("after"), photoRow("before")]);
    const res = await call("link", { afterId: "after", beforeId: "before" });
    expect(res.statusCode).toBe(200);
    const item = (res.body as { evidenceItem: Row }).evidenceItem;
    expect(item.id).toBe("after");
    expect(item.pairedWithId).toBe("before");
    expect(storedById("after")?.pairedWithId).toBe("before");
  });

  it("appends the audit id to the AFTER row only", async () => {
    seed([photoRow("after"), photoRow("before")]);
    await call("link", { afterId: "after", beforeId: "before" });
    expect(storedById("after")?.auditLogIds).toContain("al_new");
    expect(storedById("before")?.auditLogIds).toEqual(["al_seed"]);
  });

  it("BEFORE-ROW-UNTOUCHED invariant: the before row is byte-identical after a link", async () => {
    seed([photoRow("after"), photoRow("before")]);
    const beforeSnapshot = JSON.stringify(storedById("before"));
    const res = await call("link", { afterId: "after", beforeId: "before" });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(storedById("before"))).toBe(beforeSnapshot);
  });

  it("rejects a self-link (400)", async () => {
    seed([photoRow("after"), photoRow("before")]);
    const res = await call("link", { afterId: "after", beforeId: "after" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects when the before is on another job — only this-job rows resolve (404)", async () => {
    // The before id only exists on OTHER_JOB; it must not resolve on JOB.
    blob.set(`jobs/${OTHER_JOB}/data.json`, {
      dwellings: {},
      snags: [],
      evidence: [photoRow("xjob", { jobId: OTHER_JOB })],
      notes: [],
    });
    seed([photoRow("after")]);
    const res = await call("link", { afterId: "after", beforeId: "xjob" });
    expect(res.statusCode).toBe(404);
    expect(storedById("after")?.pairedWithId).toBeNull();
  });

  it("rejects note-kind pairing (400)", async () => {
    seed([photoRow("after"), photoRow("noteRow", { kind: "note", photoId: null, photoUrl: null, note: "x" })]);
    const res = await call("link", { afterId: "after", beforeId: "noteRow" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects when the after evidence does not exist (404)", async () => {
    seed([photoRow("before")]);
    const res = await call("link", { afterId: "ghost", beforeId: "before" });
    expect(res.statusCode).toBe(404);
  });

  describe("permission by role", () => {
    it("allows the AFTER's capturing worker", async () => {
      seed([photoRow("after", { capturedById: "u_field" }), photoRow("before")]);
      const res = await call("link", { afterId: "after", beforeId: "before" }, { userId: "u_field", role: "electrician" });
      expect(res.statusCode).toBe(200);
    });

    it("allows an admin even for someone else's capture", async () => {
      seed([photoRow("after", { capturedById: "u_field" }), photoRow("before")]);
      const res = await call("link", { afterId: "after", beforeId: "before" }, { userId: "u_admin", role: "admin" });
      expect(res.statusCode).toBe(200);
    });

    it("forbids a different field worker (not the capturer) — 403", async () => {
      seed([photoRow("after", { capturedById: "u_field" }), photoRow("before")]);
      const res = await call("link", { afterId: "after", beforeId: "before" }, { userId: "u_other", role: "electrician" });
      expect(res.statusCode).toBe(403);
      expect(storedById("after")?.pairedWithId).toBeNull();
    });

    it("forbids an LH who isn't the capturer — 403", async () => {
      seed([photoRow("after", { capturedById: "u_field" }), photoRow("before")]);
      const res = await call("link", { afterId: "after", beforeId: "before" }, { userId: "u_lh", role: "leadinghand" });
      expect(res.statusCode).toBe(403);
    });
  });

  it("is idempotent — a re-link to the same before is a 200 no-op", async () => {
    seed([photoRow("after", { pairedWithId: "before" }), photoRow("before")]);
    const res = await call("link", { afterId: "after", beforeId: "before" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { idempotentNoop?: boolean }).idempotentNoop).toBe(true);
    expect(storedById("after")?.pairedWithId).toBe("before");
  });
});

describe("POST /api/evidence unlink (#263)", () => {
  it("clears pairedWithId on the AFTER and returns the canonical item", async () => {
    seed([photoRow("after", { pairedWithId: "before" }), photoRow("before")]);
    const res = await call("unlink", { afterId: "after" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { evidenceItem: Row }).evidenceItem.pairedWithId).toBeNull();
    expect(storedById("after")?.pairedWithId).toBeNull();
  });

  it("BEFORE-ROW-UNTOUCHED invariant: the before row is byte-identical after an unlink", async () => {
    seed([photoRow("after", { pairedWithId: "before" }), photoRow("before")]);
    const beforeSnapshot = JSON.stringify(storedById("before"));
    await call("unlink", { afterId: "after" });
    expect(JSON.stringify(storedById("before"))).toBe(beforeSnapshot);
  });

  it("is idempotent — unlink an already-unpaired row is a 200 no-op", async () => {
    seed([photoRow("after", { pairedWithId: null })]);
    const res = await call("unlink", { afterId: "after" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { idempotentNoop?: boolean }).idempotentNoop).toBe(true);
  });

  it("uses the same permission gate — a non-capturer field worker is 403", async () => {
    seed([photoRow("after", { capturedById: "u_field", pairedWithId: "before" }), photoRow("before")]);
    const res = await call("unlink", { afterId: "after" }, { userId: "u_other", role: "electrician" });
    expect(res.statusCode).toBe(403);
    expect(storedById("after")?.pairedWithId).toBe("before");
  });
});
