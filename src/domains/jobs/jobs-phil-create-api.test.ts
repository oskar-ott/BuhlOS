import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phil sharpened W2b — the flag-gated FIELD job create ("+ New job" on
 * /phil/jobs) and the additive `code` field, exercised through the REAL
 * api/jobs.js handler (same in-memory-Blob harness as jobs-api.test.ts).
 *
 * The contract under test:
 *   - flag OFF ⇒ byte-identical current behaviour: POST is literal-admin;
 *     a field/LH caller 403s exactly as today.
 *   - flag ON  ⇒ field/LH may POST the RESTRICTED body only (name + IV####
 *     code + optional siteAddress); the create routes through createJob (ONE
 *     jobs.json write), auto-assigns the creator (ONE users.json write), and
 *     appends a source:'phil' audit entry. Clients stay forbidden.
 *   - `code` is validated (400 bad format), unique (409 duplicate,
 *     case-insensitive) and additive (admin creates keep working with or
 *     without it).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");

let blob: Map<string, unknown>;
let writeBlobMock: ReturnType<typeof vi.fn>;
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

async function post(userId: string, role: string, body: unknown) {
  const res = createRes();
  await handler(
    { method: "POST", query: {}, body, headers: { cookie: cookieFor(userId, role) } },
    res,
  );
  return res;
}

function jobsInStore(): Array<Record<string, unknown>> {
  return (blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> }).jobs;
}

function usersInStore(): Array<Record<string, unknown>> {
  return (blob.get("users.json") as { users: Array<Record<string, unknown>> }).users;
}

function usersWriteCount(): number {
  return writeBlobMock.mock.calls.filter((c) => c[0] === "users.json").length;
}

function jobsWriteCount(): number {
  return writeBlobMock.mock.calls.filter((c) => c[0] === "jobs.json").length;
}

function auditEntries(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [key, val] of blob.entries()) {
    if (key.startsWith("audit/") && val && Array.isArray((val as { entries?: unknown[] }).entries)) {
      rows.push(...(val as { entries: Array<Record<string, unknown>> }).entries);
    }
  }
  return rows;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active"],
          },
          { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-active"] },
          { id: "u_client", username: "builder", role: "client", assignedJobIds: [] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-active", name: "Active", status: "active", code: "IV0041" },
          { id: "job-custom", name: "Custom ref job", status: "active", code: "IV7001" },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[jobsPath];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-redaction.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-audit.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/feature-flags.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/jobs-summary.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-detail-projection.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/audit-log.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-create.js")];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: (writeBlobMock = vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      })),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
      blobUploadedAt: vi.fn(async () => "T1"),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

afterEach(() => {
  delete process.env.FLAG_PHIL_SHARPENED;
  delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
});

describe("POST /api/jobs — flag OFF (byte-identical current behaviour)", () => {
  it("field worker 403s exactly as today", async () => {
    const res = await post("u_field", "electrician", { name: "Site", code: "IV7002" });
    expect(res.statusCode).toBe(403);
    expect(jobsWriteCount()).toBe(0);
  });

  it("leading hand 403s exactly as today", async () => {
    const res = await post("u_lh", "lh", { name: "Site", code: "IV7002" });
    expect(res.statusCode).toBe(403);
  });

  it("admin full create keeps working unchanged (no code required)", async () => {
    const res = await post("u_admin", "admin", { name: "Admin job" });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.name).toBe("Admin job");
    expect(job.code).toBeUndefined();
  });
});

describe("POST /api/jobs — additive `code` field on the admin path", () => {
  it("accepts + stores an IV#### code, uppercased", async () => {
    const res = await post("u_admin", "admin", { name: "Coded job", code: "iv0099" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { job: { code: string } }).job.code).toBe("IV0099");
    expect(jobsInStore().find((j) => j.id === "coded-job")!.code).toBe("IV0099");
  });

  it("rejects a malformed code with 400 and writes nothing", async () => {
    for (const bad of ["IV123", "IV12345", "XX0041", "0041", "IV 0041"]) {
      const res = await post("u_admin", "admin", { name: "Bad", code: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(jobsWriteCount()).toBe(0);
  });

  it("rejects a duplicate code with 409 — case-insensitive", async () => {
    const res = await post("u_admin", "admin", { name: "Dup", code: "iv0041" });
    expect(res.statusCode).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain("IV0041");
    expect(jobsWriteCount()).toBe(0);
  });
});

describe("POST /api/jobs — flag ON field create (phil_sharpened)", () => {
  beforeEach(() => {
    process.env.FLAG_PHIL_SHARPENED = "1";
  });

  it("creates an active job from the restricted body and auto-assigns the creator", async () => {
    const res = await post("u_field", "electrician", {
      name: "Payneham Rd Bakery",
      code: "IV0038",
      siteAddress: "12 Payneham Rd",
    });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.name).toBe("Payneham Rd Bakery");
    expect(job.code).toBe("IV0038");
    expect(job.status).toBe("active");
    expect(job.siteAddress).toBe("12 Payneham Rd");

    // Creator auto-assigned — field visibility is assignedJobIds.
    const creator = usersInStore().find((u) => u.id === "u_field")!;
    expect(creator.assignedJobIds).toContain(job.id);
    // Other users untouched.
    const lh = usersInStore().find((u) => u.id === "u_lh")!;
    expect(lh.assignedJobIds).toEqual(["job-active"]);

    // ONE jobs.json write + ONE users.json write (never loop writes).
    expect(jobsWriteCount()).toBe(1);
    expect(usersWriteCount()).toBe(1);

    // Canonical audit entry, source 'phil'.
    const created = auditEntries().filter((e) => e.action === "job.created");
    expect(created).toHaveLength(1);
    expect((created[0]!.metadata as { source: string }).source).toBe("phil");
    expect(created[0]!.actorId).toBe("u_field");
  });

  it("leading hand may create too", async () => {
    const res = await post("u_lh", "lh", { name: "Norwood Place", code: "IV7002" });
    expect(res.statusCode).toBe(200);
    const lh = usersInStore().find((u) => u.id === "u_lh")!;
    expect(lh.assignedJobIds).toContain((res.body as { job: { id: string } }).job.id);
  });

  it("clients stay forbidden even with the flag on", async () => {
    const res = await post("u_client", "client", { name: "Nope", code: "IV7003" });
    expect(res.statusCode).toBe(403);
  });

  it("lowercase code is normalised; the ServiceMate range and the 7000s are both just codes", async () => {
    for (const [name, code, want] of [
      ["SM range", "iv0102", "IV0102"],
      ["Custom range", "iv7009", "IV7009"],
    ] as const) {
      const res = await post("u_field", "electrician", { name, code });
      expect(res.statusCode).toBe(200);
      expect((res.body as { job: { code: string } }).job.code).toBe(want);
    }
  });

  it("requires name and a well-formed code", async () => {
    expect((await post("u_field", "electrician", { code: "IV7004" })).statusCode).toBe(400);
    expect((await post("u_field", "electrician", { name: "  ", code: "IV7004" })).statusCode).toBe(400);
    expect((await post("u_field", "electrician", { name: "Site" })).statusCode).toBe(400);
    expect((await post("u_field", "electrician", { name: "Site", code: "7004" })).statusCode).toBe(400);
    expect(jobsWriteCount()).toBe(0);
  });

  it("rejects a duplicate code with 409 and preserves the store", async () => {
    const res = await post("u_field", "electrician", { name: "Dup", code: "IV7001" });
    expect(res.statusCode).toBe(409);
    expect(jobsWriteCount()).toBe(0);
    expect(usersWriteCount()).toBe(0);
  });

  it("ignores every non-whitelisted field — structure, money, client, status", async () => {
    const res = await post("u_field", "electrician", {
      name: "Restricted",
      code: "IV7005",
      status: "draft",
      contractValue: 999999,
      clientUserId: "u_client",
      modules: { tags: false },
      areaGroups: [{ name: "Smuggled", areas: [{ name: "A" }] }],
      ref: "smuggled-ref",
      accessNotes: "smuggled",
    });
    expect(res.statusCode).toBe(200);
    const stored = jobsInStore().find((j) => j.name === "Restricted")!;
    expect(stored.status).toBe("active"); // never draft from the field path
    expect(stored.contractValue).toBeUndefined();
    expect(stored.clientUserId).toBeNull();
    expect(stored.areaGroups).toEqual([]);
    expect(stored.ref).toBeUndefined();
    expect(stored.accessNotes).toBeUndefined();
  });

  it("the created job appears in the creator's own field list", async () => {
    const created = await post("u_field", "electrician", { name: "Visible", code: "IV7006" });
    expect(created.statusCode).toBe(200);
    const id = (created.body as { job: { id: string } }).job.id;

    const res = createRes();
    await handler(
      { method: "GET", query: {}, body: undefined, headers: { cookie: cookieFor("u_field", "electrician") } },
      res,
    );
    expect(res.statusCode).toBe(200);
    const rows = (res.body as { jobs: Array<{ id: string; code?: string }> }).jobs;
    expect(rows.map((j) => j.id)).toContain(id);
    // The code rides the field list projection so /phil/jobs can chip it.
    expect(rows.find((j) => j.id === id)!.code).toBe("IV7006");
  });

  it("the code also rides the phil_jobs_summary_read fast-path list (faithful-superset records)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "1";
    const created = await post("u_field", "electrician", { name: "Summary path", code: "IV7007" });
    expect(created.statusCode).toBe(200);
    const id = (created.body as { job: { id: string } }).job.id;

    const res = createRes();
    await handler(
      { method: "GET", query: {}, body: undefined, headers: { cookie: cookieFor("u_field", "electrician") } },
      res,
    );
    expect(res.statusCode).toBe(200);
    const rows = (res.body as { jobs: Array<{ id: string; code?: string }> }).jobs;
    expect(rows.find((j) => j.id === id)!.code).toBe("IV7007");
  });
});
