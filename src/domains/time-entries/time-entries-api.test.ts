import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/time-entries.js — focused on the role/permission
 * normalisation in foundation/auth-api-role-normalisation:
 *
 *  1. (HIGH) a worker cannot self-approve their own hours via the generic edit
 *     PATCH. Approval must go through the dedicated approve/reject endpoints
 *     (the payroll export keys on status === 'approved', not on approvedBy).
 *  2. (Med) on-behalf logging is gated on the STAFF tier, so an office/pm/boss
 *     (admin tier), not just literal 'admin'/'leadingHand', can log on behalf.
 *
 * Uses the real serverless handler with signed sessions + an in-memory Vercel
 * Blob replacement (same harness as src/domains/jobs/jobs-api.test.ts). Only
 * PATCH/POST paths are exercised, so the @vercel/blob list/put/del calls used
 * by the GET queues are never hit.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

// A date guaranteed to pass the entry's backdating window (today, no future).
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

async function call({
  method,
  userId,
  role,
  query = {},
  body,
}: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    { method, query, body, headers: { cookie: cookieFor(userId, role) } },
    res
  );
  return res;
}

function validEntry(extra: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    allocations: [{ jobId: "job-x", hours: 8 }],
    ...extra,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["job-x"] },
          { id: "u_office", username: "office", role: "office", assignedJobIds: ["job-x"] },
          { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-x"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-x"] },
          { id: "u_field2", username: "mate", role: "tradie", assignedJobIds: ["job-x"] },
        ],
      },
    ],
    // A submitted entry owned by the field worker — used to prove a worker
    // cannot flip it to approved, and that a legit draft->submitted edit works.
    [
      `users/u_field/time-entries/${TODAY}.json`,
      {
        id: "e_field",
        userId: "u_field",
        userName: "sparky",
        userRole: "electrician",
        date: TODAY,
        totalHours: 8,
        ordinaryHours: 8,
        overtimeHours: 0,
        status: "submitted",
        submittedAt: `${TODAY}T08:00:00.000Z`,
        approvedBy: null,
        approvedAt: null,
        rejectedReason: null,
        allocations: [{ jobId: "job-x", hours: 8, notes: null, sortOrder: 0 }],
        createdAt: `${TODAY}T07:00:00.000Z`,
        updatedAt: `${TODAY}T08:00:00.000Z`,
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
        blob.has(key) ? clone(blob.get(key)) : fallback
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

describe("PATCH /api/time-entries — self-approval is blocked (payroll integrity)", () => {
  it("rejects a worker self-approving their own entry via the edit PATCH", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: { status: "approved" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/approve\/reject endpoints/i);
    // And the stored entry must NOT have been flipped to approved.
    expect((blob.get(`users/u_field/time-entries/${TODAY}.json`) as { status: string }).status).toBe(
      "submitted"
    );
  });

  it("rejects approval/rejection via PATCH even for admin (must use the dedicated endpoints)", async () => {
    for (const status of ["approved", "rejected"]) {
      const res = await call({
        method: "PATCH",
        userId: "u_admin",
        role: "admin",
        query: { date: TODAY, userId: "u_field" },
        body: { status },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("still allows a legit draft->submitted edit, and never lets the body inject approval fields", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      // Crafted body tries to smuggle approval fields alongside a normal edit.
      body: validEntry({ status: "submitted", approvedBy: "u_evil", approvedAt: "2020-01-01" }),
    });
    expect(res.statusCode).toBe(200);
    const entry = (res.body as { entry: { status: string; approvedBy: string | null } }).entry;
    expect(entry.status).toBe("submitted");
    expect(entry.approvedBy).toBeNull();
  });
});

describe("on-behalf hours — gated on the staff tier, not literal admin/LH", () => {
  it("allows an office (admin-tier) user to log hours on behalf of a worker", async () => {
    const res = await call({
      method: "POST",
      userId: "u_office",
      role: "office",
      query: { userId: "u_field2" },
      body: validEntry(),
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { entry: { userId: string } }).entry.userId).toBe("u_field2");
  });

  it("blocks a field worker from logging hours on behalf of someone else", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { userId: "u_field2" },
      body: validEntry(),
    });
    expect(res.statusCode).toBe(403);
  });
});
