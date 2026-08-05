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
 * Blob replacement (same harness as src/domains/jobs/jobs-api.test.ts). The
 * @vercel/blob list() used by the GET paths is stubbed EMPTY, which doubles as
 * the eventual-consistency fixture for the read-your-writes overlay tests.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");
// #390: the handler now appends to the canonical audit journal. audit-log.js
// binds readBlob/writeBlob at module load, so it must re-require against the
// fresh blob mock each test or its writes land in a stale Map.
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");

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

// Scan every canonical audit month bucket (audit/<yyyy-mm>.json) and flatten
// its entries. The per-user hours audit lives under
// users/<id>/time-entries-audit/ and is deliberately excluded.
function auditEntries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [key, val] of blob.entries()) {
    if (
      key.startsWith("audit/") &&
      val &&
      Array.isArray((val as { entries?: unknown[] }).entries)
    ) {
      out.push(...(val as { entries: Array<Record<string, unknown>> }).entries);
    }
  }
  return out;
}

const hoursActions = () =>
  auditEntries()
    .filter((e) => String(e.action).startsWith("hours."))
    .map((e) => e.action);

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
    // job-x is an active job every seeded user is assigned to, so field
    // self-submissions pass the create-path attribution gate (a field worker
    // may only log against an active job they're assigned to).
    [
      "jobs.json",
      { jobs: [{ id: "job-x", name: "Job X", status: "active" }] },
    ],
    // A submitted entry owned by the field worker — used to prove a worker
    // cannot flip it to approved and that legitimate edits still work.
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
  delete requireFromHere.cache[auditLogPath];
  // The GET list path calls @vercel/blob's list() directly. Stub it EMPTY to
  // model the store's eventual consistency (a just-written day file missing
  // from the listing) — the read-your-writes overlay must still surface the
  // entry via readBlob.
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({ blobs: [] })),
      put: vi.fn(async () => ({})),
      del: vi.fn(async () => {}),
    },
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

  it("allows a legitimate edit while ignoring injected control metadata", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: validEntry({
        notes: "Legitimate site note",
        approvedBy: "u_evil",
        approvedAt: "2020-01-01",
        rejectedBy: "u_evil",
        rejectedAt: "2020-01-01",
        exportedAt: "2020-01-01",
        exportId: "exp_evil",
        reopenedBy: "u_evil",
        reopenedAt: "2020-01-01",
        unknownControl: "ignored",
      }),
    });
    expect(res.statusCode).toBe(200);
    const entry = (res.body as { entry: Record<string, unknown> }).entry;
    expect(entry.status).toBe("submitted");
    expect(entry.notes).toBe("Legitimate site note");
    expect(entry.approvedBy).toBeNull();
    expect(entry.approvedAt).toBeNull();
    expect(entry.rejectedBy).toBeUndefined();
    expect(entry.rejectedAt).toBeUndefined();
    expect(entry.exportedAt).toBeUndefined();
    expect(entry.exportId).toBeUndefined();
    expect(entry.reopenedBy).toBeUndefined();
    expect(entry.reopenedAt).toBeUndefined();
    expect(entry.unknownControl).toBeUndefined();
    // 2026-07-26 owner-directed: a content edit of a still-submitted entry is
    // stamped ("changed since sent") and journalled in the canonical audit
    // log — the office CAN later see the day changed after it was sent.
    expect(entry.editedWhileSubmittedAt).toBeTruthy();
    expect(hoursActions()).toEqual(["hours.edited_while_submitted"]);
  });

  it("a worker editing a submitted day cannot smuggle status: 'approved' in the same PATCH", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: validEntry({ status: "approved", notes: "sneaky" }),
    });
    expect(res.statusCode).toBe(403);
    const stored = blob.get(`users/u_field/time-entries/${TODAY}.json`) as {
      status: string;
      notes: string | null;
      editedWhileSubmittedAt?: string;
    };
    expect(stored.status).toBe("submitted");
    expect(stored.notes).toBeFalsy(); // the ride-along content edit didn't land either
    expect(stored.editedWhileSubmittedAt).toBeUndefined();
    expect(hoursActions()).toEqual([]);
  });

  it("rejects a field self-edit that attributes hours to no job (jobId: null) — the PATCH null-job hole is closed", async () => {
    // 2026-07-26 owner-directed. Same 403 error shape as the create-path
    // active-job gate; create keeps its backward-compat null acceptance.
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: validEntry({ allocations: [{ jobId: null, hours: 8 }] }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/active job/i);
    const stored = blob.get(`users/u_field/time-entries/${TODAY}.json`) as {
      allocations: Array<{ jobId: string | null }>;
    };
    expect(stored.allocations[0]?.jobId).toBe("job-x"); // unchanged
  });

  it("blocks generic status rewinds instead of letting PATCH unsubmit hours", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: { status: "draft" },
    });
    expect(res.statusCode).toBe(403);
    expect((blob.get(`users/u_field/time-entries/${TODAY}.json`) as { status: string }).status).toBe(
      "submitted"
    );
  });

  it("keeps the explicit rejected-to-submitted correction workflow", async () => {
    const key = `users/u_field/time-entries/${TODAY}.json`;
    blob.set(key, {
      ...(blob.get(key) as Record<string, unknown>),
      status: "rejected",
      rejectedReason: "Wrong allocation",
      rejectedBy: "u_office",
      rejectedAt: `${TODAY}T09:00:00.000Z`,
    });
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: validEntry({ status: "submitted", notes: "Corrected" }),
    });
    expect(res.statusCode).toBe(200);
    const entry = (res.body as { entry: { status: string; rejectedReason: string | null } }).entry;
    expect(entry.status).toBe("submitted");
    expect(entry.rejectedReason).toBeNull();
  });

  it("allows an office user to edit a worker entry on behalf", async () => {
    const res = await call({
      method: "PATCH",
      userId: "u_office",
      role: "office",
      query: { date: TODAY, userId: "u_field" },
      body: validEntry({ notes: "Office correction" }),
    });
    expect(res.statusCode).toBe(200);
    const entry = (res.body as { entry: { notes: string; updatedBy: string } }).entry;
    expect(entry.notes).toBe("Office correction");
    expect(entry.updatedBy).toBe("u_office");
  });

  it("denies delegated edits for an unknown-role target", async () => {
    blob.set("users.json", {
      users: [
        ...((blob.get("users.json") as { users: unknown[] }).users || []),
        { id: "u_unknown", username: "unknown", role: "nonsense", assignedJobIds: ["job-x"] },
      ],
    });
    blob.set(`users/u_unknown/time-entries/${TODAY}.json`, {
      ...validEntry(),
      id: "e_unknown",
      userId: "u_unknown",
      userName: "unknown",
      userRole: "nonsense",
      status: "submitted",
    });
    const res = await call({
      method: "PATCH",
      userId: "u_office",
      role: "office",
      query: { date: TODAY, userId: "u_unknown" },
      body: validEntry({ notes: "Should not persist" }),
    });
    expect(res.statusCode).toBe(400);
    expect((blob.get(`users/u_unknown/time-entries/${TODAY}.json`) as { notes?: string }).notes).toBeUndefined();
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

  it("denies unknown and client roles from logging their own hours", async () => {
    for (const [userId, role] of [
      ["u_unknown", "nonsense"],
      ["u_client", "client"],
    ] as const) {
      blob.set("users.json", {
        users: [
          ...((blob.get("users.json") as { users: unknown[] }).users || []),
          { id: userId, username: role, role, assignedJobIds: ["job-x"] },
        ],
      });
      const res = await call({ method: "POST", userId, role, body: validEntry() });
      expect(res.statusCode).toBe(403);
    }
  });

  it("allows field and LH-alias users to log their own hours", async () => {
    for (const [userId, role] of [
      ["u_field2", "tradie"],
      ["u_lh", "lh"],
    ] as const) {
      const res = await call({ method: "POST", userId, role, body: validEntry() });
      expect(res.statusCode).toBe(201);
      expect((res.body as { entry: { userId: string } }).entry.userId).toBe(userId);
      blob.delete(`users/${userId}/time-entries/${TODAY}.json`);
    }
  });
});

// #130: the office + Phil screens render the entry's STORED ordinaryHours /
// overtimeHours split. These document the CURRENT write-time policy that
// produces those stored fields: the server ACCEPTS the split AS SENT (the
// client computes it via autoSplitOT before POST), and only VALIDATES that
// ordinary + overtime == total (validateEntryShape). It does NOT recompute
// the split from totalHours on write. Server-side recompute-on-write is a
// separate hardening issue — these tests pin today's behaviour so the
// presentation-only #130 work rests on a documented contract.
describe("#130 — server stores the ordinary/overtime split as sent (accept-as-sent)", () => {
  it("persists the client-sent split verbatim on a long day", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      body: validEntry({
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 2,
        allocations: [{ jobId: "job-x", hours: 10 }],
        status: "submitted",
      }),
    });
    expect(res.statusCode).toBe(201);
    const entry = (res.body as { entry: { ordinaryHours: number; overtimeHours: number; totalHours: number } }).entry;
    expect(entry.totalHours).toBe(10);
    expect(entry.ordinaryHours).toBe(8);
    expect(entry.overtimeHours).toBe(2);
    // The stored blob carries the same split the read endpoints will serve.
    const stored = blob.get(`users/u_field2/time-entries/${TODAY}.json`) as {
      ordinaryHours: number;
      overtimeHours: number;
    };
    expect(stored.ordinaryHours).toBe(8);
    expect(stored.overtimeHours).toBe(2);
    blob.delete(`users/u_field2/time-entries/${TODAY}.json`);
  });

  it("validates ordinary + overtime == total — rejects an inconsistent split (400)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      body: validEntry({
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 1, // 8 + 1 != 10
        allocations: [{ jobId: "job-x", hours: 10 }],
        status: "submitted",
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("does NOT recompute the split: an unusual-but-consistent split is stored as sent", async () => {
    // A 10h day sent as 10 ordinary / 0 OT (consistent) is accepted unchanged —
    // the server does not impose autoSplitOT's 8h boundary on write.
    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      body: validEntry({
        totalHours: 10,
        ordinaryHours: 10,
        overtimeHours: 0,
        allocations: [{ jobId: "job-x", hours: 10 }],
        status: "submitted",
      }),
    });
    expect(res.statusCode).toBe(201);
    const entry = (res.body as { entry: { ordinaryHours: number; overtimeHours: number } }).entry;
    expect(entry.ordinaryHours).toBe(10);
    expect(entry.overtimeHours).toBe(0);
    blob.delete(`users/u_field2/time-entries/${TODAY}.json`);
  });
});

// #390: worker submit / resubmit must land in the canonical audit journal
// (api/_lib/audit-log.js → audit/<yyyy-mm>.json) so the cross-job activity feed
// (#220) + per-job history show the submissions, not just the approvals pass
// (which shipped in PR #556). These assert the FULL chain end-to-end — handler →
// builder → append → blob — which also guards the silent-drop gap where a verb
// missing from audit-log.js's VALID_ACTIONS set would write nothing.
describe("#390 — worker submit/resubmit writes the canonical audit journal", () => {
  it("a create-as-submitted writes one hours.submitted (best-effort, after the save)", async () => {
    // u_field2 has no entry for TODAY (only u_field is seeded), so this creates.
    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      body: validEntry({ status: "submitted" }),
    });
    expect(res.statusCode).toBe(201);
    const submits = auditEntries().filter((e) => e.action === "hours.submitted");
    expect(submits).toHaveLength(1);
    const submit = submits[0] as Record<string, unknown>;
    expect(submit).toMatchObject({ action: "hours.submitted", actorId: "u_field2", targetType: "time_entry" });
    expect((submit.metadata as { status: string; userId: string }).status).toBe("submitted");
    expect((submit.metadata as { userId: string }).userId).toBe("u_field2");
    // privacy line: never a dollar amount / rate.
    expect(JSON.stringify(submit)).not.toMatch(/amount|payRate|rate|dollar|\$/i);
  });

  it("a plain draft create writes NO hours.* audit entry", async () => {
    const res = await call({ method: "POST", userId: "u_field2", role: "tradie", body: validEntry() });
    expect(res.statusCode).toBe(201);
    expect(hoursActions()).toEqual([]);
  });

  it("a draft → submitted PATCH writes hours.submitted (first submit)", async () => {
    blob.set(`users/u_field2/time-entries/${TODAY}.json`, {
      id: "e_draft",
      userId: "u_field2",
      userName: "mate",
      userRole: "tradie",
      date: TODAY,
      totalHours: 8,
      ordinaryHours: 8,
      overtimeHours: 0,
      status: "draft",
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      allocations: [{ jobId: "job-x", hours: 8, notes: null, sortOrder: 0 }],
      createdAt: `${TODAY}T07:00:00.000Z`,
      updatedAt: `${TODAY}T07:00:00.000Z`,
    });
    const res = await call({
      method: "PATCH",
      userId: "u_field2",
      role: "tradie",
      query: { date: TODAY },
      body: validEntry({ status: "submitted" }),
    });
    expect(res.statusCode).toBe(200);
    expect(hoursActions()).toEqual(["hours.submitted"]);
  });

  it("a rejected → submitted PATCH writes hours.resubmitted (correction)", async () => {
    const key = `users/u_field/time-entries/${TODAY}.json`;
    blob.set(key, {
      ...(blob.get(key) as Record<string, unknown>),
      status: "rejected",
      rejectedReason: "missing site",
    });
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: validEntry({ status: "submitted", notes: "Corrected" }),
    });
    expect(res.statusCode).toBe(200);
    expect(hoursActions()).toEqual(["hours.resubmitted"]);
  });

  it("a notes-only edit of a SUBMITTED entry journals hours.edited_while_submitted — never a fake re-submission", async () => {
    // The seeded u_field entry is already 'submitted'; a self notes edit keeps
    // it submitted (no transition) so it must not re-log a submission — but,
    // 2026-07-26 owner-directed, it DOES journal the edit-while-undecided.
    const res = await call({
      method: "PATCH",
      userId: "u_field",
      role: "electrician",
      query: { date: TODAY },
      body: { notes: "tweak" },
    });
    expect(res.statusCode).toBe(200);
    expect(hoursActions()).toEqual(["hours.edited_while_submitted"]);
    expect(
      (res.body as { entry: { editedWhileSubmittedAt?: string } }).entry.editedWhileSubmittedAt,
    ).toBeTruthy();
  });

  it("a content edit of a DRAFT entry (no transition) still writes NO hours.* entry", async () => {
    blob.set(`users/u_field2/time-entries/${TODAY}.json`, {
      id: "e_draft2",
      userId: "u_field2",
      userName: "mate",
      userRole: "tradie",
      date: TODAY,
      totalHours: 8,
      ordinaryHours: 8,
      overtimeHours: 0,
      status: "draft",
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      allocations: [{ jobId: "job-x", hours: 8, notes: null, sortOrder: 0 }],
      createdAt: `${TODAY}T07:00:00.000Z`,
      updatedAt: `${TODAY}T07:00:00.000Z`,
    });
    const res = await call({
      method: "PATCH",
      userId: "u_field2",
      role: "tradie",
      query: { date: TODAY },
      body: { notes: "draft tweak" },
    });
    expect(res.statusCode).toBe(200);
    expect(hoursActions()).toEqual([]);
    expect(
      (res.body as { entry: { editedWhileSubmittedAt?: string | null } }).entry
        .editedWhileSubmittedAt,
    ).toBeFalsy();
  });
});

describe("GET /api/time-entries — read-your-writes overlay (2026-07-28)", () => {
  // Blob's list() is eventually consistent: a day file written moments ago can
  // be missing from the listing, so the worker watched a just-logged day
  // vanish on the next render. The list stub above returns NOTHING — the
  // seeded TODAY entry must still come back via the readBlob overlay.
  it("returns a just-written day even when the blob listing hasn't caught up", async () => {
    const res = await call({
      method: "GET",
      userId: "u_field",
      role: "electrician",
      query: { fromDate: TODAY, toDate: TODAY },
    });
    expect(res.statusCode).toBe(200);
    const entries = (res.body as { entries: Array<{ id: string; date: string }> }).entries;
    expect(entries.map((e) => e.id)).toContain("e_field");
  });

  it("still hides days that genuinely don't exist (no phantom rows)", async () => {
    const res = await call({
      method: "GET",
      userId: "u_field2",
      role: "tradie",
      query: { fromDate: TODAY, toDate: TODAY },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toEqual([]);
  });
});

describe("listUserEntries — the PG rung gets the read-your-writes overlay too (2026-08-06)", () => {
  // The #152 read-cutover used to return PG results WITHOUT the overlay. The
  // PG mirror is best-effort, so a mirror miss on the just-logged day made
  // that day vanish from a PG-served list exactly like the listing lag did.
  type EntryLike = { id: string; date: string; status: string; updatedAt: string };
  type ListUserEntries = (
    userId: string,
    opts: { fromDate?: string; toDate?: string; status?: string },
    deps: { listPg: () => Promise<{ pg: boolean; entries?: EntryLike[] }> }
  ) => Promise<EntryLike[]>;
  const lib = () => requireFromHere(teLibPath) as { listUserEntries: ListUserEntries };

  it("overlays the just-written Blob day over a PG list that missed it", async () => {
    const got = await lib().listUserEntries(
      "u_field",
      { fromDate: TODAY, toDate: TODAY },
      { listPg: async () => ({ pg: true, entries: [] }) }
    );
    expect(got.map((e) => e.id)).toEqual(["e_field"]);
  });

  it("keeps a strictly newer PG copy over the overlay's Blob read", async () => {
    const pgCopy = {
      id: "e_pg_newer",
      userId: "u_field",
      date: TODAY,
      totalHours: 8,
      ordinaryHours: 8,
      overtimeHours: 0,
      status: "approved",
      allocations: [{ jobId: "job-x", hours: 8 }],
      createdAt: `${TODAY}T07:00:00.000Z`,
      updatedAt: `${TODAY}T09:00:00.000Z`, // newer than the seeded Blob day (T08)
    };
    const got = await lib().listUserEntries(
      "u_field",
      { fromDate: TODAY, toDate: TODAY },
      { listPg: async () => ({ pg: true, entries: [pgCopy] }) }
    );
    expect(got.map((e) => e.id)).toEqual(["e_pg_newer"]);
  });

  it("still applies the caller's status filter to overlaid days", async () => {
    const got = await lib().listUserEntries(
      "u_field",
      { fromDate: TODAY, toDate: TODAY, status: "approved" },
      { listPg: async () => ({ pg: true, entries: [] }) }
    );
    expect(got).toEqual([]); // the seeded Blob day is 'submitted'
  });
});
