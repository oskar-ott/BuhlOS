import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #347 — api/insights-digest.js. Real handler + real flag/audit/anomalies
 * libs, stubbed blob + time-entries readers, MOCKED ai gateway. Covers:
 * flag-dark 404, admin gate, the two-stage happy path (AI phrasing grounded →
 * stored digest + audit), the grounding-validation fallback (one invented
 * number → deterministic bullets), provider-failure fallback, quiet-week
 * record, dryRun (no store, no audit), and GET of the stored digest.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const dayPulsePath = requireFromHere.resolve("../../../api/_lib/day-pulse.js");
const cronAuthPath = requireFromHere.resolve("../../../api/_lib/cron-auth.js");
const anomaliesPath = requireFromHere.resolve("../../../api/_lib/insights-anomalies.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const aiSuggestionsPath = requireFromHere.resolve("../../../api/_lib/ai-suggestions.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/insights-digest.js");

// Fixed clock: Wednesday 2026-07-01 (Sydney) → weekStart 2026-06-29.
const TODAY = "2026-07-01";
const WEEK = "2026-06-29";

let store: Map<string, unknown>;
let writes: string[];
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
let pushMock: ReturnType<typeof vi.fn>;
let entriesFixture: Array<Record<string, unknown>>;
let auth: { signSession: (p: Record<string, unknown>) => string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler res asserted per test
let handler: (req: Record<string, unknown>, res: any) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- asserted per test
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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
async function call(opts: {
  method: string;
  query?: Record<string, string>;
  role?: string;
  anon?: boolean;
  headers?: Record<string, string>;
}) {
  const res = createRes();
  await handler(
    {
      method: opts.method,
      query: opts.query || {},
      headers: opts.anon
        ? { ...(opts.headers || {}) }
        : {
            cookie: `buhl_session=${auth.signSession({
              userId: "u_boss",
              role: opts.role || "boss",
              exp: Date.now() + 60_000,
            })}`,
            ...(opts.headers || {}),
          },
    },
    res
  );
  return res;
}
const generate = (query: Record<string, string> = {}) =>
  call({ method: "POST", query: { action: "generate", ...query } });

// A grounded AI reply for the single approvals-waiting finding the default
// fixture produces (facts: count 1, totalHours 3, oldestDays 5).
function groundedReply() {
  return {
    text: JSON.stringify({
      bullets: [{ index: 0, text: "1 timesheet with 3h has sat unapproved for 5 days." }],
    }),
    usage: { inputTokens: 400, outputTokens: 40 },
    model: "claude-sonnet-4-6",
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_INSIGHTS_DIGEST = "1";
  delete process.env.CRON_SECRET;
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => groundedReply());
  // One submitted entry 5 days old (3h, last week) + one approved 4h this
  // week: the approvals rule fires; the week-over-week swing (4h vs 3h) stays
  // under the 5h floor → exactly ONE deterministic finding.
  entriesFixture = [
    {
      id: "te1",
      userId: "u_field",
      date: "2026-06-26",
      status: "submitted",
      allocations: [{ jobId: "job-1", hours: 3 }],
    },
    {
      id: "te2",
      userId: "u_field",
      date: "2026-06-30",
      status: "approved",
      allocations: [{ jobId: "job-1", hours: 4 }],
    },
  ];

  writes = [];
  pushMock = vi.fn(async () => ({ sent: 1, pruned: 0, skipped: null }));
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss" },
          { id: "u_admin2", username: "office", role: "admin" },
          { id: "u_gone", username: "old", role: "admin", archived: true },
          { id: "u_field", username: "sparky", role: "electrician" },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Riverside", status: "active" }] }],
    ["jobs/job-1/data.json", { snags: [], snagsV2: [], evidence: [], dwellings: {}, notes: [] }],
  ]);

  for (const p of [authPath, ffPath, auditPath, cronAuthPath, anomaliesPath, aiSuggestionsPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        writes.push(key);
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })) },
  } as NodeJS.Module;
  requireFromHere.cache[timeEntriesPath] = {
    id: timeEntriesPath,
    filename: timeEntriesPath,
    loaded: true,
    exports: { listAllEntriesForApprovers: vi.fn(async () => clone(entriesFixture)) },
  } as NodeJS.Module;
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { sendPushToUserId: (...args: unknown[]) => pushMock(...args) },
  } as NodeJS.Module;
  requireFromHere.cache[dayPulsePath] = {
    id: dayPulsePath,
    filename: dayPulsePath,
    loaded: true,
    exports: { sydneyToday: () => TODAY, computeDayPulse: vi.fn() },
  } as NodeJS.Module;
  requireFromHere.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
      isAiConfigured: () => aiConfigured,
      aiComplete: (...args: unknown[]) => aiCompleteMock(...args),
      AiError: class extends Error {
        code: string;
        constructor(code: string, message: string) {
          super(message);
          this.code = code;
        }
      },
    },
  } as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  auth = requireFromHere(authPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  for (const p of [blobPath, vercelBlobPath, timeEntriesPath, dayPulsePath, aiPath, pushPath]) {
    delete requireFromHere.cache[p];
  }
  delete process.env.FLAG_AI_INSIGHTS_DIGEST;
});

describe("gates", () => {
  it("404s while the flag is dark (default)", async () => {
    delete process.env.FLAG_AI_INSIGHTS_DIGEST;
    expect((await generate()).statusCode).toBe(404);
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });

  it("401s anonymous callers, admin-tier only", async () => {
    expect((await call({ method: "POST", query: { action: "generate" }, anon: true })).statusCode).toBe(401);
  });
});

describe("cron caller — enablement-only flag check", () => {
  const SECRET = "cron-secret-long-enough";
  const cronHeaders = { "x-cron-secret": SECRET };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("generates with the flag on and NO viewer — an admin-targeted flag must not dead-end the cron", async () => {
    const res = await call({ method: "POST", query: { action: "generate" }, anon: true, headers: cronHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body.digest).toBeTruthy();
    expect(writes).toContain(`analytics/digests/${WEEK}.json`);
  });

  it("no-ops honestly while the flag is dark", async () => {
    delete process.env.FLAG_AI_INSIGHTS_DIGEST;
    const res = await call({ method: "POST", query: { action: "generate" }, anon: true, headers: cronHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skipped: "flag off" });
  });
});

describe("generate — two-stage pipeline", () => {
  it("stores the findings + AI bullets when every numeral grounds, and audits", async () => {
    const res = await generate();
    expect(res.statusCode).toBe(200);
    const d = res.body.digest;
    expect(d.weekStart).toBe(WEEK);
    expect(d.quietWeek).toBe(false);
    expect(d.findings).toHaveLength(1);
    expect(d.phrasing).toBe("ai");
    expect(d.model).toBe("claude-sonnet-4-6");
    expect(d.bullets).toEqual([
      {
        text: "1 timesheet with 3h has sat unapproved for 5 days.",
        href: "/hours/approvals",
        findingKey: "hours.approvals_waiting",
      },
    ]);
    // Stored under the week key + audited.
    expect(writes).toContain(`analytics/digests/${WEEK}.json`);
    expect(writes.some((k) => k.startsWith("audit/"))).toBe(true);
    // Coverage footer states what the system does not see.
    expect(d.coverage.doesNotSee.length).toBeGreaterThan(0);
  });

  it("falls back to deterministic bullets when the model invents a number", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({
        // 12 and 9 appear nowhere in the finding (note: numerals inside date
        // strings DO ground — pick invented numbers outside those).
        bullets: [{ index: 0, text: "Roughly 12 timesheets are stuck — about 9 weeks of delay." }],
      }),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await generate();
    const d = res.body.digest;
    expect(d.phrasing).toBe("deterministic");
    expect(d.fallbackReason).toMatch(/not grounded/);
    // Deterministic text comes straight from the finding — always grounded.
    expect(d.bullets[0].text).toBe(d.findings[0].text);
  });

  it("falls back when the provider fails or replies with prose — never blocked", async () => {
    aiCompleteMock.mockRejectedValueOnce(new Error("provider down"));
    let d = (await generate()).body.digest;
    expect(d.phrasing).toBe("deterministic");

    aiCompleteMock.mockResolvedValueOnce({ text: "Here are your insights!", usage: null, model: "m" });
    d = (await generate({ dryRun: "1" })).body.digest;
    expect(d.phrasing).toBe("deterministic");
  });

  it("unconfigured AI → deterministic digest, no model call", async () => {
    aiConfigured = false;
    const d = (await generate()).body.digest;
    expect(d.phrasing).toBe("deterministic");
    expect(d.fallbackReason).toMatch(/not configured/);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("quiet week stores a no-findings record and never calls the model", async () => {
    entriesFixture = [];
    const res = await generate();
    const d = res.body.digest;
    expect(d.quietWeek).toBe(true);
    expect(d.findings).toEqual([]);
    expect(d.bullets).toEqual([]);
    expect(aiCompleteMock).not.toHaveBeenCalled();
    expect(writes).toContain(`analytics/digests/${WEEK}.json`); // audit trail has no gaps
  });

  it("dryRun returns the digest without storing or auditing", async () => {
    const res = await generate({ dryRun: "1" });
    expect(res.body.dryRun).toBe(true);
    expect(res.body.digest.findings).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

describe("delivery — push fan-out (#347 weekly delivery AC)", () => {
  it("first non-quiet generation pushes to every live admin, deep-linking /reports", async () => {
    const res = await generate();
    expect(res.body.digest.pushedAt).toBeTruthy();
    const pushedTo = pushMock.mock.calls.map((c) => c[0]).sort();
    expect(pushedTo).toEqual(["u_admin2", "u_boss"]); // archived admin + field user excluded
    const payload = pushMock.mock.calls[0]?.[1] as Record<string, string>;
    expect(payload.url).toBe("/reports");
    expect(payload.tag).toBe(`insights-digest-${WEEK}`);
    expect(payload.body).toContain("1 thing changed this week");
  });

  it("regenerating the same week never re-pushes (pushedAt carried forward)", async () => {
    await generate();
    const firstPushedAt = (store.get(`analytics/digests/${WEEK}.json`) as { pushedAt: string })
      .pushedAt;
    pushMock.mockClear();
    const again = await generate();
    expect(pushMock).not.toHaveBeenCalled();
    expect(again.body.digest.pushedAt).toBe(firstPushedAt);
  });

  it("a quiet week sends nothing", async () => {
    entriesFixture = [];
    await generate();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("dryRun never pushes", async () => {
    await generate({ dryRun: "1" });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("serves the stored digest for the current week, null when none", async () => {
    expect((await call({ method: "GET" })).body).toEqual({ weekStart: WEEK, digest: null });
    await generate();
    const res = await call({ method: "GET" });
    expect(res.body.weekStart).toBe(WEEK);
    expect(res.body.digest.findings).toHaveLength(1);
  });
});
