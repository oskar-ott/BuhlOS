import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for /api/expenses (#536) against the REAL handler. Standard
 * harness: signed sessions + in-memory blob, with @vercel/blob `put` stubbed
 * (receipt upload) and push/activity stubbed (best-effort, must never block).
 *
 * Pins:
 *   - clients are denied everything; field/LH submit + see own; admin sees all;
 *   - money is integer cents, validated server-side (no float total, P7);
 *   - a receipt photo is required to submit;
 *   - the status machine: submitted→approved→reimbursed, submitted/approved→
 *     rejected; illegal jumps + same-status + non-admin PATCH are refused;
 *   - idempotency: a replayed key returns the original record, no second row.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const idempotencyPath = requireFromHere.resolve("../../../api/_lib/idempotency.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/expenses.js");

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
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

function call(
  method: string,
  userId: string,
  role: string,
  { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Res> {
  const res = createRes();
  return handler(
    {
      method,
      query,
      body,
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  ).then(() => res);
}

const RECEIPT = { receiptPhotoId: "rcpt_1", receiptPhotoUrl: "https://blob.example/r1.jpg" };
const VALID = { amountCents: 4250, category: "fuel", ...RECEIPT };

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", passwordHash: "$2a$10$x" },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
      { id: "u_field2", username: "appy", role: "tradie", passwordHash: "$2a$10$x" },
      { id: "u_client", username: "client", role: "client", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }] });

  for (const p of [authPath, handlerPath, idempotencyPath, activityPath, pushPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      put: vi.fn(async (path: string) => ({ url: `https://blob.example/${path}` })),
    },
  } as NodeJS.Module;
  requireFromHere.cache[activityPath] = {
    id: activityPath,
    filename: activityPath,
    loaded: true,
    exports: { appendActivity: vi.fn(async () => undefined) },
  } as NodeJS.Module;
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { sendPushToUserId: vi.fn(async () => ({ sent: 0, pruned: 0, skipped: 0 })) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const expensesOf = () => (blob.get("expenses.json") as { expenses?: unknown[] })?.expenses ?? [];

describe("POST /api/expenses — submit (#536)", () => {
  it("a field worker submits a structured expense (status submitted, attributed, cents stored)", async () => {
    const res = await call("POST", "u_field", "electrician", { body: VALID });
    expect(res.statusCode).toBe(201);
    const expense = (res.body as { expense: Record<string, unknown> }).expense;
    expect(expense).toMatchObject({
      amountCents: 4250,
      category: "fuel",
      status: "submitted",
      submittedById: "u_field",
      submittedByName: "sparky",
      receiptPhotoId: "rcpt_1",
      reviewedById: null,
      reimbursedAt: null,
    });
    expect(String(expense.id)).toMatch(/^expn_/);
    expect(expensesOf()).toHaveLength(1);
  });

  it("a client is denied (403) and nothing is written", async () => {
    const res = await call("POST", "u_client", "client", { body: VALID });
    expect(res.statusCode).toBe(403);
    expect(blob.has("expenses.json")).toBe(false);
  });

  it("denormalises the job name when a jobId is attributed", async () => {
    const res = await call("POST", "u_field", "electrician", { body: { ...VALID, jobId: "j1" } });
    expect((res.body as { expense: { jobId: string; jobName: string } }).expense).toMatchObject({
      jobId: "j1",
      jobName: "Riverside",
    });
  });

  it("rejects bad money: non-integer, zero, negative, over-ceiling (400, no write)", async () => {
    for (const amountCents of [42.5, 0, -100, 10_000_001]) {
      const res = await call("POST", "u_field", "electrician", { body: { ...VALID, amountCents } });
      expect(res.statusCode, `amountCents=${amountCents}`).toBe(400);
    }
    expect(blob.has("expenses.json")).toBe(false);
  });

  it("requires a receipt photo and a valid category", async () => {
    const noReceipt = await call("POST", "u_field", "electrician", {
      body: { amountCents: 100, category: "fuel" },
    });
    expect(noReceipt.statusCode).toBe(400);
    const badCat = await call("POST", "u_field", "electrician", {
      body: { ...VALID, category: "bribes" },
    });
    expect(badCat.statusCode).toBe(400);
    const badUrl = await call("POST", "u_field", "electrician", {
      body: { ...VALID, receiptPhotoUrl: "not-a-url" },
    });
    expect(badUrl.statusCode).toBe(400);
  });

  it("is idempotent — a replayed Idempotency-Key returns the original, no second row", async () => {
    const first = await call("POST", "u_field", "electrician", { body: { ...VALID, idempotencyKey: "k1" } });
    const firstId = (first.body as { expense: { id: string } }).expense.id;
    const replay = await call("POST", "u_field", "electrician", { body: { ...VALID, idempotencyKey: "k1" } });
    expect(replay.statusCode).toBe(201);
    expect((replay.body as { expense: { id: string }; idempotentReplay: boolean }).expense.id).toBe(firstId);
    expect((replay.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    expect(expensesOf()).toHaveLength(1);
  });
});

describe("GET /api/expenses — list scoping (#536)", () => {
  beforeEach(async () => {
    await call("POST", "u_field", "electrician", { body: { ...VALID, idempotencyKey: "a" } });
    await call("POST", "u_field2", "tradie", { body: { ...VALID, amountCents: 999, idempotencyKey: "b" } });
  });

  it("admin sees all expenses across workers", async () => {
    const res = await call("GET", "u_admin", "office");
    expect(res.statusCode).toBe(200);
    expect((res.body as { expenses: unknown[] }).expenses).toHaveLength(2);
  });

  it("a field worker sees only their own", async () => {
    const res = await call("GET", "u_field", "electrician");
    const list = (res.body as { expenses: { submittedById: string }[] }).expenses;
    expect(list).toHaveLength(1);
    expect(list[0]!.submittedById).toBe("u_field");
  });

  it("admin can filter by status and userId", async () => {
    const res = await call("GET", "u_admin", "office", { query: { userId: "u_field2" } });
    const list = (res.body as { expenses: { amountCents: number }[] }).expenses;
    expect(list).toHaveLength(1);
    expect(list[0]!.amountCents).toBe(999);

    const none = await call("GET", "u_admin", "office", { query: { status: "reimbursed" } });
    expect((none.body as { expenses: unknown[] }).expenses).toHaveLength(0);
  });

  it("a client is denied (403)", async () => {
    const res = await call("GET", "u_client", "client");
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/expenses — review transitions (#536)", () => {
  async function seed(): Promise<string> {
    const res = await call("POST", "u_field", "electrician", { body: { ...VALID, idempotencyKey: "seed" } });
    return (res.body as { expense: { id: string } }).expense.id;
  }

  it("admin approves then reimburses; stamps reviewer + reimbursedAt", async () => {
    const id = await seed();
    const approved = await call("PATCH", "u_admin", "office", { body: { id, status: "approved" } });
    expect(approved.statusCode).toBe(200);
    expect((approved.body as { expense: Record<string, unknown> }).expense).toMatchObject({
      status: "approved",
      reviewedById: "u_admin",
      reviewedByName: "boss",
    });
    const paid = await call("PATCH", "u_admin", "office", { body: { id, status: "reimbursed" } });
    expect(paid.statusCode).toBe(200);
    const paidExpense = (paid.body as { expense: { reimbursedAt: string | null } }).expense;
    expect(paidExpense.reimbursedAt).toMatch(/^20\d\d-/);
  });

  it("admin rejects with a note", async () => {
    const id = await seed();
    const res = await call("PATCH", "u_admin", "office", {
      body: { id, status: "rejected", reviewNote: "no receipt detail" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { expense: { status: string; reviewNote: string } }).expense).toMatchObject({
      status: "rejected",
      reviewNote: "no receipt detail",
    });
  });

  it("refuses illegal jumps (submitted→reimbursed, reimbursed→approved) and same-status", async () => {
    const id = await seed();
    const skip = await call("PATCH", "u_admin", "office", { body: { id, status: "reimbursed" } });
    expect(skip.statusCode).toBe(409);
    const same = await call("PATCH", "u_admin", "office", { body: { id, status: "submitted" } });
    expect(same.statusCode).toBe(409);

    await call("PATCH", "u_admin", "office", { body: { id, status: "approved" } });
    await call("PATCH", "u_admin", "office", { body: { id, status: "reimbursed" } });
    const reverse = await call("PATCH", "u_admin", "office", { body: { id, status: "approved" } });
    expect(reverse.statusCode).toBe(409);
  });

  it("a field worker cannot transition (403); unknown id is 404", async () => {
    const id = await seed();
    const forbidden = await call("PATCH", "u_field", "electrician", { body: { id, status: "approved" } });
    expect(forbidden.statusCode).toBe(403);
    const missing = await call("PATCH", "u_admin", "office", { body: { id: "nope", status: "approved" } });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/expenses?action=upload-receipt (#536)", () => {
  const dataUrl = "data:image/jpeg;base64," + Buffer.from("a-tiny-fake-jpeg").toString("base64");

  it("uploads a receipt and returns an id + url", async () => {
    const res = await call("POST", "u_field", "electrician", { query: { action: "upload-receipt" }, body: { dataUrl } });
    expect(res.statusCode).toBe(200);
    const out = res.body as { id: string; url: string; capturedAt: string };
    expect(out.id).toMatch(/^rcpt_/);
    expect(out.url).toContain("expense-receipts/");
  });

  it("rejects an over-6MB receipt (413) and a malformed dataUrl (400)", async () => {
    const big = "data:image/jpeg;base64," + "A".repeat(9 * 1024 * 1024);
    const tooBig = await call("POST", "u_field", "electrician", { query: { action: "upload-receipt" }, body: { dataUrl: big } });
    expect(tooBig.statusCode).toBe(413);
    const bad = await call("POST", "u_field", "electrician", { query: { action: "upload-receipt" }, body: { dataUrl: "nope" } });
    expect(bad.statusCode).toBe(400);
  });

  it("a client cannot upload a receipt (403)", async () => {
    const res = await call("POST", "u_client", "client", { query: { action: "upload-receipt" }, body: { dataUrl } });
    expect(res.statusCode).toBe(403);
  });
});
