import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: job attribution on POST /api/time-entries.
 *
 * A FIELD worker logging their own hours may only attribute a non-null
 * allocation jobId to a job they are assigned to that is active (not draft /
 * archived). Arbitrary, unassigned, draft or archived jobIds are rejected
 * (403). On CREATE a null jobId is still accepted server-side for backward
 * compatibility (legacy submissions / overhead) — the Phil UI is what blocks
 * a null jobId when the worker has active assigned jobs. On PATCH
 * (self-edit), a null jobId is now REJECTED server-side (2026-07-26
 * owner-directed — the documented follow-up is closed for edits).
 *
 * Admin/LH and on-behalf flows keep their existing latitude (the check is
 * scoped to non-delegated field submissions), and PR #64 approval/PATCH
 * protections are unaffected (covered by time-entries-api.test.ts).
 *
 * Harness mirrors time-entries-api.test.ts: real auth + time-entries libs,
 * an in-memory blob Map injected into the require cache.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);

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

async function post(
  userId: string,
  role: string,
  body: unknown,
  query: Record<string, string> = {},
) {
  const res = createRes();
  await handler(
    { method: "POST", query, body, headers: { cookie: cookieFor(userId, role) } },
    res,
  );
  return res;
}

function entryFor(jobId: string | null) {
  return {
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId, hours: 8 }],
  };
}

function storedFor(userId: string) {
  return blob.get(`users/${userId}/time-entries/${TODAY}.json`) as
    | { allocations: Array<{ jobId: string | null }> }
    | undefined;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          // field worker assigned to active + archived + draft jobs (NOT job-unassigned)
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active", "job-archived", "job-draft"],
          },
          { id: "u_office", username: "office", role: "office", assignedJobIds: [] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-active", name: "Active Job", status: "active" },
          { id: "job-archived", name: "Old Job", status: "archived" },
          { id: "job-draft", name: "Draft Job", status: "draft" },
          { id: "job-unassigned", name: "Someone Else's Job", status: "active" },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[teLibPath];
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
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/time-entries — field job attribution", () => {
  it("accepts an active job the worker is assigned to", async () => {
    const res = await post("u_field", "electrician", entryFor("job-active"));
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBe("job-active");
  });

  it("rejects an ARCHIVED job (assigned but not active)", async () => {
    const res = await post("u_field", "electrician", entryFor("job-archived"));
    expect(res.statusCode).toBe(403);
    expect(storedFor("u_field")).toBeUndefined();
  });

  it("rejects a DRAFT job (assigned but not active)", async () => {
    const res = await post("u_field", "electrician", entryFor("job-draft"));
    expect(res.statusCode).toBe(403);
  });

  it("now accepts any active job the worker is NOT assigned to (all-jobs access)", async () => {
    const res = await post("u_field", "electrician", entryFor("job-unassigned"));
    expect(res.statusCode).toBe(201);
  });

  it("rejects an arbitrary / unknown jobId", async () => {
    const res = await post("u_field", "electrician", entryFor("job-does-not-exist"));
    expect(res.statusCode).toBe(403);
  });

  it("still accepts a null jobId from the field (backward-compat; UI blocks it)", async () => {
    const res = await post("u_field", "electrician", entryFor(null));
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBeNull();
  });
});

describe("POST /api/time-entries — admin/on-behalf latitude preserved", () => {
  it("lets office log on behalf of the worker against the worker's active job", async () => {
    const res = await post("u_office", "office", entryFor("job-active"), {
      userId: "u_field",
    });
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBe("job-active");
  });

  it("does not apply the field attribution gate to office on-behalf (job-unassigned allowed)", async () => {
    // The hours belong to the worker, but the office actor keeps latitude to
    // attribute — the field gate is intentionally scoped to non-delegated
    // field self-submissions only.
    const res = await post("u_office", "office", entryFor("job-unassigned"), {
      userId: "u_field",
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /api/time-entries — one active entry per worker+date", () => {
  it("refuses a duplicate submission for the same date with 409", async () => {
    const first = await post("u_field", "electrician", entryFor("job-active"));
    expect(first.statusCode).toBe(201);
    const dupe = await post("u_field", "electrician", entryFor("job-active"));
    expect(dupe.statusCode).toBe(409);
  });
});

// ── PATCH /api/time-entries — the edit/resubmit path ─────────────────────────
//
// Parity with the create gate: until this gate existed, the Phil UI was the
// ONLY thing stopping a field worker from re-allocating their hours to an
// arbitrary / unassigned / archived job on resubmit (documented in
// docs/phil-hours-job-attribution.md as a follow-up). These tests pin the
// server-side rule.

async function patch(
  userId: string,
  role: string,
  body: unknown,
  query: Record<string, string> = {},
) {
  const res = createRes();
  await handler(
    {
      method: "PATCH",
      query: { date: TODAY, ...query },
      body,
      headers: { cookie: cookieFor(userId, role) },
    },
    res,
  );
  return res;
}

/** Seed a stored entry for u_field directly into the blob map. */
function seedStoredEntry(status: string, jobId: string | null) {
  blob.set(`users/u_field/time-entries/${TODAY}.json`, {
    id: "te_seeded",
    userId: "u_field",
    userName: "sparky",
    userRole: "electrician",
    date: TODAY,
    startTime: null,
    endTime: null,
    breakMinutes: 30,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    otOverridden: false,
    notes: null,
    status,
    submittedAt: status === "draft" ? null : `${TODAY}T08:00:00.000Z`,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: status === "rejected" ? "Wrong job — reallocate" : null,
    allocations: [{ jobId, hours: 8, notes: null, sortOrder: 0 }],
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T08:00:00.000Z`,
  });
}

function resubmitBody(jobId: string | null) {
  return {
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId, hours: 8 }],
    notes: null,
  };
}

describe("PATCH /api/time-entries — field job attribution on self-edits", () => {
  it("resubmits a rejected entry to an active assigned job (rejected → submitted)", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-active"));
    expect(res.statusCode).toBe(200);
    const stored = storedFor("u_field") as unknown as {
      status: string;
      rejectedReason: string | null;
      allocations: Array<{ jobId: string | null }>;
    };
    expect(stored.status).toBe("submitted");
    expect(stored.rejectedReason).toBeNull();
    expect(stored.allocations[0]?.jobId).toBe("job-active");
  });

  it("now allows re-allocating to any active job (all-jobs access)", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-unassigned"));
    expect(res.statusCode).toBe(200);
    const stored = storedFor("u_field") as unknown as {
      status: string;
      allocations: Array<{ jobId: string | null }>;
    };
    expect(stored.allocations[0]?.jobId).toBe("job-unassigned"); // re-allocated
  });

  it("rejects re-allocating to an ARCHIVED assigned job", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-archived"));
    expect(res.statusCode).toBe(403);
  });

  it("rejects re-allocating to a DRAFT assigned job", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-draft"));
    expect(res.statusCode).toBe(403);
  });

  it("rejects re-allocating to an unknown jobId", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-does-not-exist"));
    expect(res.statusCode).toBe(403);
  });

  it("REJECTS a null jobId on a field self-edit (2026-07-26 owner-directed — the documented hole is closed)", async () => {
    seedStoredEntry("rejected", null);
    const res = await patch("u_field", "electrician", resubmitBody(null));
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/active job/i);
    // The stored entry is untouched — still the rejected null-job legacy row.
    const stored = storedFor("u_field") as unknown as { status: string };
    expect(stored.status).toBe("rejected");
  });

  it("still lets a delegated (office) edit carry a null jobId (latitude preserved)", async () => {
    seedStoredEntry("rejected", null);
    const res = await patch("u_office", "office", resubmitBody(null), { userId: "u_field" });
    expect(res.statusCode).toBe(200);
  });

  it("leaves edits that don't touch allocations alone (notes-only edit of an archived-job entry)", async () => {
    // The stored entry points at a job that has since been archived. A
    // notes-only PATCH must not be blocked by the attribution gate — only
    // PATCHes that actually send `allocations` are validated.
    seedStoredEntry("draft", "job-archived");
    const res = await patch("u_field", "electrician", { notes: "forgot the gate code" });
    expect(res.statusCode).toBe(200);
  });

  it("does not apply the field gate to delegated (office) edits", async () => {
    seedStoredEntry("rejected", "job-active");
    const res = await patch("u_office", "office", resubmitBody("job-unassigned"), {
      userId: "u_field",
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("PATCH /api/time-entries — approved entries stay locked for workers", () => {
  it("blocks the worker from editing an approved entry", async () => {
    seedStoredEntry("approved", "job-active");
    const res = await patch("u_field", "electrician", { notes: "tweak" });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toContain("approved");
  });

  it("blocks the worker from resubmitting an approved entry", async () => {
    seedStoredEntry("approved", "job-active");
    const res = await patch("u_field", "electrician", resubmitBody("job-active"));
    expect(res.statusCode).toBe(403);
    const stored = storedFor("u_field") as unknown as { status: string };
    expect(stored.status).toBe("approved");
  });
});
