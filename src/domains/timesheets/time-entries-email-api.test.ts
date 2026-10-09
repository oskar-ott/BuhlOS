import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: /api/time-entries-email — the send-to-accounts export
 * (owner pull 2026-08-15; recipients moved into Settings 2026-08-16).
 *
 * POST emails the approved period as the SAME PDF the Download PDF button
 * serves, from timesheets@buhlos.com, to the STORED recipient list
 * (timesheet-email-settings.json — managed on /settings via GET/PUT here).
 * The list is the switch: empty → honest 503, and the UI hides its buttons
 * off the same store.
 *
 * Pins:
 * - admin-only; POST needs an EXPLICIT range (an email must never guess its
 *   period the way the row engine's current-week default would);
 * - GET returns the stored list + provenance; PUT validates (named refusal on
 *   a malformed address, trims/lowercases/dedupes, caps), persists, and
 *   journals hours.timesheets_recipients_updated with the previous list;
 * - an empty period is a 422, never an empty email;
 * - the Resend payload: default timesheets@buhlos.com sender (env-overridable),
 *   EVERY stored recipient on the one message, and a real PDF attachment
 *   (base64 "%PDF-" magic);
 * - a provider failure is an honest 502 — the endpoint never fakes a send;
 * - a send lands in the canonical audit journal as hours.timesheets_emailed.
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
const recipientsPath = requireFromHere.resolve("../../../api/_lib/timesheet-email-settings.js");
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

const RECIPIENTS_KEY = "timesheet-email-settings.json";

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

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(
  viewerId: string,
  viewerRole: string,
  method: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {}
) {
  const res = createRes();
  await handler(
    { method, query, body, headers: { cookie: cookieFor(viewerId, viewerRole) } },
    res
  );
  return res;
}

function seedRecipients(recipients: string[]) {
  blob.set(RECIPIENTS_KEY, {
    recipients,
    updatedAt: "2026-08-16T00:00:00.000Z",
    updatedBy: "oskar",
  });
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

/** Every audit-journal document (audit/<yyyy-mm>.json) serialized. */
function journalText(): string {
  return [...blob.entries()]
    .filter(([key]) => key.startsWith("audit"))
    .map(([, value]) => JSON.stringify(value))
    .join("\n");
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "BuhlOS <onboarding@buhlos.com>";
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
    recipientsPath,
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
  delete process.env.TIMESHEETS_EMAIL_FROM;
  delete process.env.TIMESHEETS_EMAIL_REPLY_TO;
  delete process.env.RESEND_API_KEY;
});

describe("recipient list (GET/PUT /api/time-entries-email)", () => {
  it("GET returns the stored list with provenance; admin only", async () => {
    seedRecipients(["tia@example.com"]);
    const res = await call("u_admin", "admin", "GET");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      recipients: ["tia@example.com"],
      updatedBy: "oskar",
    });

    const denied = await call("u_mick", "electrician", "GET");
    expect(denied.statusCode).toBe(403);
  });

  it("GET on an empty store is an empty list, not an error", async () => {
    const res = await call("u_admin", "admin", "GET");
    expect(res.statusCode).toBe(200);
    expect((res.body as { recipients: string[] }).recipients).toEqual([]);
  });

  it("PUT trims, lowercases and dedupes; persists; journals old → new", async () => {
    seedRecipients(["old@example.com"]);
    const res = await call("u_admin", "admin", "PUT", {
      recipients: [" Tia@Example.com ", "tia@example.com", "backup@example.com"],
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { recipients: string[] }).recipients).toEqual([
      "tia@example.com",
      "backup@example.com",
    ]);

    const stored = blob.get(RECIPIENTS_KEY) as { recipients: string[]; updatedBy: string };
    expect(stored.recipients).toEqual(["tia@example.com", "backup@example.com"]);
    expect(stored.updatedBy).toBe("oskar");

    const journal = journalText();
    expect(journal).toContain("hours.timesheets_recipients_updated");
    expect(journal).toContain("old@example.com"); // the previous list is on the record
  });

  it("PUT refuses a malformed address BY NAME and leaves the store unchanged", async () => {
    seedRecipients(["tia@example.com"]);
    const res = await call("u_admin", "admin", "PUT", {
      recipients: ["tia@example.com", "not-an-email"],
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("not-an-email");
    expect((blob.get(RECIPIENTS_KEY) as { recipients: string[] }).recipients).toEqual([
      "tia@example.com",
    ]);
  });

  it("PUT refuses a non-array body", async () => {
    const res = await call("u_admin", "admin", "PUT", {
      recipients: "tia@example.com" as unknown as string[],
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT [] switches the process off — the next send 503s", async () => {
    seedRecipients(["tia@example.com"]);
    const cleared = await call("u_admin", "admin", "PUT", { recipients: [] });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.body as { recipients: string[] }).recipients).toEqual([]);

    seedEntry("u_mick", FROM);
    const send = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(send.statusCode).toBe(503);
    expect((send.body as { code: string }).code).toBe("not_configured");
    expect(resendCalls).toHaveLength(0);
  });
});

describe("GET ?fromDate&toDate — was this period already emailed?", () => {
  it("answers null before any send, then the journalled send (who, when, to whom)", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);

    const before = await call("u_admin", "admin", "GET", {}, { fromDate: FROM, toDate: TO });
    expect(before.statusCode).toBe(200);
    expect(before.body).toMatchObject({ recipients: ["tia@example.com"], lastSent: null });

    const sent = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(sent.statusCode).toBe(200);

    const after = await call("u_admin", "admin", "GET", {}, { fromDate: FROM, toDate: TO });
    const lastSent = (after.body as { lastSent: Record<string, unknown> | null }).lastSent;
    expect(lastSent).toMatchObject({
      byName: "oskar",
      recipients: ["tia@example.com"],
      workerCount: 1,
      totalHours: 7.6,
    });
    expect(typeof lastSent!.at).toBe("string");
  });

  it("is scoped to the exact period — another week's send doesn't count", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });

    const other = await call(
      "u_admin",
      "admin",
      "GET",
      {},
      { fromDate: "2026-08-10", toDate: "2026-08-16" }
    );
    expect((other.body as { lastSent: unknown }).lastSent).toBeNull();
  });

  it("without a range stays the plain recipient read (the /settings contract)", async () => {
    seedRecipients(["tia@example.com"]);
    const res = await call("u_admin", "admin", "GET");
    expect(res.body).not.toHaveProperty("lastSent");
  });
});

describe("POST /api/time-entries-email (send)", () => {
  it("rejects unknown methods with 405 (nothing sent)", async () => {
    const res = await call("u_admin", "admin", "DELETE");
    expect(res.statusCode).toBe(405);
    expect(resendCalls).toHaveLength(0);
  });

  it("is admin-only — a field role gets 403 and no email goes out", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const res = await call("u_mick", "electrician", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(403);
    expect(resendCalls).toHaveLength(0);
  });

  it("requires an EXPLICIT date range — never the row engine's current-week default", async () => {
    seedRecipients(["tia@example.com"]);
    const res = await call("u_admin", "admin", "POST", {});
    expect(res.statusCode).toBe(400);
    expect(resendCalls).toHaveLength(0);
  });

  it("honest 503 when the recipient list is empty — the switch is off", async () => {
    seedEntry("u_mick", FROM);
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe("not_configured");
    expect((res.body as { error: string }).error).toContain("Settings");
    expect(resendCalls).toHaveLength(0);
  });

  it("422 on a period with no approved hours — never an empty email", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM, { status: "submitted" }); // undecided, not approved
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(422);
    expect((res.body as { code: string }).code).toBe("empty_period");
    expect(resendCalls).toHaveLength(0);
  });

  it("emails EVERY stored recipient the period PDF from timesheets@buhlos.com and journals it", async () => {
    seedRecipients(["tia@example.com", "backup@example.com"]);
    seedEntry("u_mick", FROM, { totalHours: 9.6, ordinaryHours: 7.6, overtimeHours: 2 });
    seedEntry("u_mick", "2026-08-04");
    seedEntry("u_mick", TO, { status: "submitted" }); // stays out — approved only

    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sent: true,
      recipients: ["tia@example.com", "backup@example.com"],
      fromDate: FROM,
      toDate: TO,
      workerCount: 1,
      totalHours: 17.2,
      overtimeHours: 2,
      rowCount: 2,
    });

    expect(resendCalls).toHaveLength(1); // ONE message to all of them
    const sent = resendCalls[0]!;
    expect(sent.from).toBe("BuhlOS Timesheets <timesheets@buhlos.com>");
    expect(sent.to).toEqual(["tia@example.com", "backup@example.com"]);
    // Mon + Tue approved; Sun still waiting; Wed–Fri never logged — the sheet
    // says so in its subject line, so accounts sees it before opening it.
    expect(sent.subject).toBe("Timesheets 3 – 9 Aug 2026 · 1 worker · 17.2h · 4 days not on the sheet");
    expect(sent.reply_to).toBeUndefined();
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe(`buhlos-hours-${FROM}-to-${TO}.pdf`);
    // Base64 of "%PDF-" — a real composed PDF, not a placeholder.
    expect(sent.attachments![0]!.content.startsWith("JVBER")).toBe(true);

    expect(journalText()).toContain("hours.timesheets_emailed");
  });

  it("NOT ON THIS SHEET: the email names every worker-day it doesn't carry, and why — and the receipt carries the same list", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM, { totalHours: 9.6, ordinaryHours: 7.6, overtimeHours: 2 });
    seedEntry("u_mick", "2026-08-04");
    seedEntry("u_mick", TO, { status: "submitted" });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      notOnSheet: { dayCount: number; lines: Array<{ workerName: string; reason: string; days: string }> };
    };
    expect(body.notOnSheet.dayCount).toBe(4);
    expect(body.notOnSheet.lines).toEqual([
      { workerName: "Mick Doran", reason: "waiting for approval", kind: "submitted", days: "Sun 9 Aug (7.6h)" },
      { workerName: "Mick Doran", reason: "nothing logged", kind: "missing", days: "Wed 5 Aug, Thu 6 Aug, Fri 7 Aug" },
    ]);
    const sent = resendCalls[0]! as ResendCall & { html?: string; text?: string };
    expect(sent.html).toContain("Not on this sheet — 4 days");
    expect(sent.html).toContain("nothing logged: Wed 5 Aug, Thu 6 Aug, Fri 7 Aug");
    expect(sent.text).toContain("Mick Doran — waiting for approval: Sun 9 Aug (7.6h)");
    expect(journalText()).toContain('"notOnSheetDays":4');
  });

  it("a complete week says so — 'Nothing left off' only when the period is over and every weekday is approved", async () => {
    seedRecipients(["tia@example.com"]);
    for (const d of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]) seedEntry("u_mick", d);
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    const sent = resendCalls[0]! as ResendCall & { html?: string };
    expect(sent.subject).toBe("Timesheets 3 – 9 Aug 2026 · 1 worker · 38h");
    expect(sent.html).toContain("Nothing left off");
    expect((res.body as { notOnSheet: { dayCount: number } }).notOnSheet.dayCount).toBe(0);
  });

  it("honours the FROM / REPLY_TO env overrides", async () => {
    process.env.TIMESHEETS_EMAIL_FROM = "Pay Office <pay@buhlos.com>";
    process.env.TIMESHEETS_EMAIL_REPLY_TO = "office@buhlos.com";
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(resendCalls[0]!.from).toBe("Pay Office <pay@buhlos.com>");
    expect(resendCalls[0]!.reply_to).toBe("office@buhlos.com");
  });

  it("a provider failure is an honest 502 — never a fake sent", async () => {
    resendFails = true;
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(502);
    expect((res.body as { code: string }).code).toBe("provider_error");
    expect((res.body as { error: string }).error).toContain("nothing reached accounts");
  });
});

// ── 2026-10-05: approve, then send inside the CDN window ─────────────────────
// The boss approved the week on the phone and tapped Send to Tia ten seconds
// later: the just-approved days still read as "submitted", so the payroll read
// refused (correctly — never a short sheet). A second tap 40s later was still
// inside the window; the week never went. The sheet is now only read from a
// period whose hours have stopped changing (quiet mode), every read is held
// against the listing's byte size + PUT time, and every refusal SAYS when it
// clears so the send surfaces wait it out and re-send by themselves.
describe("POST — the sheet is only read once the period's hours have stopped changing", () => {
  function listWithMeta(
    meta: Record<string, { uploadedAt?: string; size?: number }>,
    extraPaths: string[] = [],
  ) {
    const sdk = requireFromHere(blobSdkPath) as { list: ReturnType<typeof vi.fn> };
    sdk.list.mockImplementation(async () => ({
      blobs: [...new Set([...blob.keys(), ...extraPaths])]
        .filter((key) => key.includes("/time-entries/"))
        .map((pathname) => ({
          pathname,
          url: `https://blob.test/${encodeURIComponent(pathname)}`,
          ...(meta[pathname] ?? {}),
        })),
    }));
  }
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const keyOf = (date: string) => `users/u_mick/time-entries/${date}.json`;
  /** Byte length of the stored document exactly as the store would hold it. */
  const storedBytes = (key: string) => Buffer.byteLength(JSON.stringify(blob.get(key)), "utf8");

  /** Serve blob bodies through text() as well, so the byte-size check runs. */
  function serveWithText(override?: (pathname: string) => unknown) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: { body?: string }) => {
        if (String(url).includes("api.resend.com")) {
          if (init?.body) resendCalls.push(JSON.parse(init.body) as ResendCall);
          return { ok: true, status: 200, json: async () => ({ id: "em_test" }) };
        }
        const pathname = decodeURIComponent(new URL(String(url)).pathname.slice(1));
        const value = override ? override(pathname) : blob.get(pathname);
        const body = value === undefined ? "" : JSON.stringify(value);
        return { ok: value !== undefined, text: async () => body, json: async () => clone(value) };
      },
    );
  }

  beforeEach(() => {
    // One instant in-request retry, so refusals resolve without sleeping.
    (
      requireFromHere(payrollInputsPath) as {
        __setFreshnessRetryDelaysForTests: (d: number[]) => void;
      }
    ).__setFreshnessRetryDelaysForTests([0]);
  });

  it("the 5 Oct case: a day approved 10s ago → 503 'settling' BEFORE any day is read, naming it, with retryAfterMs + Retry-After; nothing sent", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    listWithMeta({ [keyOf(FROM)]: { uploadedAt: iso(10_000) } });
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();

    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    const body = res.body as { error: string; code?: string; retryAfterMs?: number };
    expect(body.code).toBe("settling");
    // Settles 70s after its PUT → ~60s from now.
    expect(body.retryAfterMs).toBeGreaterThan(50_000);
    expect(body.retryAfterMs).toBeLessThanOrEqual(70_000);
    expect(Number(res.headers["Retry-After"])).toBe(Math.ceil(body.retryAfterMs! / 1000));
    expect(body.error).toContain("changed in the last minute");
    expect(body.error).toContain("Mick Doran 2026-08-03");
    // Held before a single day-file was fetched — a fast, cheap refusal.
    const blobFetches = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("https://blob.test/"));
    expect(blobFetches).toHaveLength(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("approvals still being written (a batch mid-way) hold the send — the days not yet approved can never be silently left off", async () => {
    seedRecipients(["tia@example.com"]);
    // Mid-batch: Mon was just approved (written 3s ago); Tue is still
    // "submitted" because the batch hasn't reached it yet. Tue reads PERFECTLY
    // fresh — no stale-read check can see a write that hasn't happened — so
    // only the quiet rule stands between this and a sheet short of Tuesday.
    seedEntry("u_mick", "2026-08-03");
    seedEntry("u_mick", "2026-08-04", { status: "submitted" });
    listWithMeta({
      [keyOf("2026-08-03")]: { uploadedAt: iso(3_000) },
      [keyOf("2026-08-04")]: { uploadedAt: iso(3 * 60 * 60_000) },
    });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    expect((res.body as { code?: string }).code).toBe("settling");
    expect(resendCalls).toHaveLength(0);
  });

  it("waits for the NEWEST of several recent changes", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", "2026-08-03");
    seedEntry("u_mick", "2026-08-04");
    listWithMeta({
      [keyOf("2026-08-03")]: { uploadedAt: iso(30_000) },
      [keyOf("2026-08-04")]: { uploadedAt: iso(2_000) },
    });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    expect((res.body as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(60_000);
  });

  it("a change OUTSIDE the period never holds it", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    seedEntry("u_mick", "2026-08-12"); // next week, written seconds ago
    listWithMeta({ [keyOf("2026-08-12")]: { uploadedAt: iso(2_000) } });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(resendCalls).toHaveLength(1);
  });

  it("once the period has been quiet for the window, the same send goes through", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const entry = blob.get(keyOf(FROM)) as Record<string, unknown>;
    entry.__updatedAt = iso(76_000);
    serveWithText();
    listWithMeta({ [keyOf(FROM)]: { uploadedAt: iso(75_000), size: storedBytes(keyOf(FROM)) } });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(resendCalls).toHaveLength(1);
  });

  it("BYTE SIZE: a quiet period whose day still reads as an older, different-length version is refused — even when its stamp looks close", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM); // the CURRENT stored version (approved)
    const key = keyOf(FROM);
    const current = blob.get(key) as Record<string, unknown>;
    current.__updatedAt = iso(91_000);
    const currentSize = storedBytes(key);
    // The CDN still serves the previous version: "submitted", no approval
    // fields, stamped only 8s before the current one — inside the 15s skew,
    // so the stamp alone would have waved it through.
    const previous = { ...current, status: "submitted", __updatedAt: iso(99_000) };
    serveWithText((p) => (p === key ? previous : blob.get(p)));
    listWithMeta({ [key]: { uploadedAt: iso(90_000), size: currentSize } });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    const body = res.body as { error: string; code?: string; retryAfterMs?: number };
    expect(body.error).toContain("Mick Doran 2026-08-03 (just changed)");
    expect(body.code).toBe("settling");
    expect(body.retryAfterMs).toBe(10_000); // past the window → backs off, never hammers
    expect(resendCalls).toHaveLength(0);
  });

  it("BYTE SIZE never blocks pay forever: a mismatch on a blob settled for >5 minutes can't be a CDN-stale read, so it is accepted (and logged)", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const key = keyOf(FROM);
    (blob.get(key) as Record<string, unknown>).__updatedAt = iso(10 * 60_000 + 1_000);
    serveWithText();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listWithMeta({ [key]: { uploadedAt: iso(10 * 60_000), size: storedBytes(key) + 7 } });
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(200);
    expect(warn.mock.calls.some(([m]) => String(m).includes("byte size"))).toBe(true);
    warn.mockRestore();
  });

  it("an OLD day-file that can't be read is not a settling race — no retryAfterMs, a person looks", async () => {
    seedRecipients(["tia@example.com"]);
    seedEntry("u_mick", FROM);
    const missing = "users/u_mick/time-entries/2026-08-05.json";
    listWithMeta({ [missing]: { uploadedAt: iso(3 * 60 * 60_000) } }, [missing]);
    const res = await call("u_admin", "admin", "POST", { fromDate: FROM, toDate: TO });
    expect(res.statusCode).toBe(503);
    const body = res.body as { error: string; code?: string; retryAfterMs?: number };
    expect(body.error).toContain("(unreadable)");
    expect(body.code).toBeUndefined();
    expect(body.retryAfterMs).toBeUndefined();
    expect(res.headers["Retry-After"]).toBeUndefined();
    expect(resendCalls).toHaveLength(0);
  });
});
