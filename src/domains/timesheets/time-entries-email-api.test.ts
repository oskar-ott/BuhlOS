import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: POST /api/time-entries-email — the send-to-accounts export
 * (owner pull 2026-08-15). While the Xero push is out of action, the approved
 * pay period leaves as an email: the SAME PDF the Download PDF button serves,
 * attached and sent from timesheets@buhlos.com to TIMESHEETS_EMAIL_TO.
 *
 * Pins:
 * - admin-only, POST-only, EXPLICIT date range (an email must never guess its
 *   period the way the row engine's current-week default would);
 * - TIMESHEETS_EMAIL_TO is the switch — unset → honest 503, nothing sent;
 * - an empty period is a 422, never an empty email;
 * - the Resend payload: default timesheets@buhlos.com sender (env-overridable),
 *   the recipient, and a real PDF attachment (base64 "%PDF-" magic);
 * - a provider failure is an honest 502 — the endpoint never fakes a send;
 * - the send lands in the canonical audit journal as hours.timesheets_emailed.
 *
 * Harness mirrors time-entries-overview-api.test.ts: real auth + handler via
 * require-cache injection, in-memory blob Map, @vercel/blob list mock; global
 * fetch serves blob URLs AND captures the Resend POST.
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const payrollInputsPath = requireFromHere.resolve("../../../api/_lib/payroll-inputs.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const emailPath = requireFromHere.resolve("../../../api/_lib/email.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries-email.js");

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

type ResendCall = {
  from: string;
  to: string[];
  subject: string;
  reply_to?: string;
  attachments?: Array<{ filename: string; content: string }>;
};

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
let resendCalls: ResendCall[];
let resendFails: boolean;

// A fixed, past Mon–Sun week — the endpoint takes explicit dates, so nothing
// here depends on "today".
const FROM = "2026-08-03";
const TO = "2026-08-09";

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
  viewerId: string,
  viewerRole: string,
  body: Record<string, unknown>,
  method = "POST"
) {
  const res = createRes();
  await handler(
    { method, query: {}, body, headers: { cookie: cookieFor(viewerId, viewerRole) } },
    res
  );
  return res;
}

function seedEntry(
  userId: string,
  date: string,
  over: Partial<{ status: string; totalHours: number; ordinaryHours: number; overtimeHours: number }> = {}
) {
  const totalHours = over.totalHours ?? 7.6;
  blob.set(`users/${userId}/time-entries/${date}.json`, {
    id: `te_${userId}_${date}`,
    userId,
    userName: "Mick Doran",
    userRole: "electrician",
    date,
    totalHours,
    ordinaryHours: over.ordinaryHours ?? totalHours,
    overtimeHours: over.overtimeHours ?? 0,
    status: over.status ?? "approved",
    submittedAt: `${date}T08:00:00.000Z`,
    allocations: [{ jobId: "job-x", hours: totalHours, notes: null, sortOrder: 0 }],
    createdAt: `${date}T07:00:00.000Z`,
    updatedAt: `${date}T08:00:00.000Z`,
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "BuhlOS <onboarding@buhlos.com>";
  process.env.TIMESHEETS_EMAIL_TO = "tia@example.com";
  delete process.env.TIMESHEETS_EMAIL_FROM;
  delete process.env.TIMESHEETS_EMAIL_REPLY_TO;
  delete process.env.TIMESHEETS_EMAIL_TO_NAME;

  resendCalls = [];
  resendFails = false;

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "oskar", role: "admin", assignedJobIds: [] },
          {
            id: "u_mick",
            username: "mick",
            name: "Mick Doran",
            role: "electrician",
            hourlyRate: 50,
            assignedJobIds: ["job-x"],
          },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-x", name: "Job X", status: "active" }] }],
  ]);

  for (const modulePath of [
    blobSdkPath,
    blobPath,
    authPath,
    payrollInputsPath,
    auditLogPath,
    emailPath,
    handlerPath,
  ]) {
    delete requireFromHere.cache[modulePath];
  }

  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({
        blobs: [...blob.keys()]
          .filter((key) => key.includes("/time-entries/"))
          .map((pathname) => ({
            pathname,
            url: `https://blob.test/${encodeURIComponent(pathname)}`,
          })),
      })),
      put: vi.fn(),
      del: vi.fn(),
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

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes("api.resend.com")) {
        if (init?.body) resendCalls.push(JSON.parse(init.body) as ResendCall);
        if (resendFails) {
          return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: "em_test" }) };
      }
      const pathname = decodeURIComponent(new URL(String(url)).pathname.slice(1));
      const value = blob.get(pathname);
      return { ok: value !== undefined, json: async () => clone(value) };
    })
  );

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TIMESHEETS_EMAIL_TO;
  delete process.env.TIMESHEETS_EMAIL_FROM;
  delete process.env.TIMESHEETS_EMAIL_REPLY_TO;
  delete process.env.RESEND_API_KEY;
});

describe("POST /api/time-entries-email", () => {
  it("rejects non-POST with 405 (nothing sent)", async () => {
    const res = await post("u_admin", "admin", {}, "GET");
    expect(res.statusCode).toBe(405);
    expect(resendCalls).toHaveLength(0);
  });

  it("is admin-only — a field role gets 403 and no email goes out", async () => {
    seedEntry("u_mick", FROM);
    const res = await post("u_mick", "electrician", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(403);
    expect(resendCalls).toHaveLength(0);
  });

  it("requires an EXPLICIT date range — never the row engine's current-week default", async () => {
    const res = await post("u_admin", "admin", {});
    expect(res.statusCode).toBe(400);
    expect(resendCalls).toHaveLength(0);
  });

  it("honest 503 when TIMESHEETS_EMAIL_TO is unset — the switch is off", async () => {
    delete process.env.TIMESHEETS_EMAIL_TO;
    seedEntry("u_mick", FROM);
    const res = await post("u_admin", "admin", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe("not_configured");
    expect(resendCalls).toHaveLength(0);
  });

  it("422 on a period with no approved hours — never an empty email", async () => {
    seedEntry("u_mick", FROM, { status: "submitted" }); // undecided, not approved
    const res = await post("u_admin", "admin", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(422);
    expect((res.body as { code: string }).code).toBe("empty_period");
    expect(resendCalls).toHaveLength(0);
  });

  it("sends the period PDF to accounts from timesheets@buhlos.com and journals it", async () => {
    seedEntry("u_mick", FROM, { totalHours: 9.6, ordinaryHours: 7.6, overtimeHours: 2 });
    seedEntry("u_mick", "2026-08-04");
    seedEntry("u_mick", TO, { status: "submitted" }); // stays out — approved only

    const res = await post("u_admin", "admin", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sent: true,
      to: "tia@example.com",
      fromDate: FROM,
      toDate: TO,
      workerCount: 1,
      totalHours: 17.2,
      overtimeHours: 2,
      rowCount: 2,
    });

    expect(resendCalls).toHaveLength(1);
    const call = resendCalls[0]!;
    expect(call.from).toBe("BuhlOS Timesheets <timesheets@buhlos.com>");
    expect(call.to).toEqual(["tia@example.com"]);
    expect(call.subject).toBe("Timesheets 3 – 9 Aug 2026 · 1 worker · 17.2h");
    expect(call.reply_to).toBeUndefined();
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments![0]!.filename).toBe(`buhlos-hours-${FROM}-to-${TO}.pdf`);
    // Base64 of "%PDF-" — a real composed PDF, not a placeholder.
    expect(call.attachments![0]!.content.startsWith("JVBER")).toBe(true);

    // The send is in the canonical audit journal.
    const journalled = [...blob.entries()].some(
      ([key, value]) =>
        key !== "users.json" && JSON.stringify(value).includes("hours.timesheets_emailed")
    );
    expect(journalled).toBe(true);
  });

  it("honours the FROM / REPLY_TO env overrides", async () => {
    process.env.TIMESHEETS_EMAIL_FROM = "Pay Office <pay@buhlos.com>";
    process.env.TIMESHEETS_EMAIL_REPLY_TO = "office@buhlos.com";
    seedEntry("u_mick", FROM);
    const res = await post("u_admin", "admin", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(resendCalls[0]!.from).toBe("Pay Office <pay@buhlos.com>");
    expect(resendCalls[0]!.reply_to).toBe("office@buhlos.com");
  });

  it("a provider failure is an honest 502 — never a fake sent", async () => {
    resendFails = true;
    seedEntry("u_mick", FROM);
    const res = await post("u_admin", "admin", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(502);
    expect((res.body as { code: string }).code).toBe("provider_error");
    expect((res.body as { error: string }).error).toContain("nothing reached accounts");
  });
});
