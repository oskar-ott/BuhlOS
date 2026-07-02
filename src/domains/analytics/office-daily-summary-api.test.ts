import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #171 — api/office-daily-summary.js + the pure api/_lib/office-summary.js
 * stage. Real handler + real flag/audit/cron libs, stubbed blob +
 * time-entries reader, MOCKED ai gateway (the insights-digest harness).
 * Covers: the yesterday window function, aggregator fixtures (incl.
 * partial-failure coverage and job exclusions), flag-dark 404, tier gates,
 * the two-stage happy path (grounded AI narrative → stored summary + audit +
 * push), grounding/provider/unconfigured fallbacks (facts still render),
 * quiet-day persist-without-push, push dedupe on regeneration, dryRun, the
 * cron no-op while dark, and GET of the stored summary.
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
const officeSummaryPath = requireFromHere.resolve("../../../api/_lib/office-summary.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const aiSuggestionsPath = requireFromHere.resolve("../../../api/_lib/ai-suggestions.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/office-daily-summary.js");

// Fixed clock: Wednesday 2026-07-01 (Sydney) → yesterday 2026-06-30.
const TODAY = "2026-07-01";
const YDAY = "2026-06-30";
const KEY = `analytics/office-summaries/${YDAY}.json`;

// ── The pure stage (no mocks needed) ─────────────────────────────────────

describe("office-summary lib (pure)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lib = requireFromHere(officeSummaryPath);

  it("previousCalendarDay steps back over month, year and leap boundaries", () => {
    expect(lib.previousCalendarDay("2026-07-01")).toBe("2026-06-30");
    expect(lib.previousCalendarDay("2026-01-01")).toBe("2025-12-31");
    expect(lib.previousCalendarDay("2024-03-01")).toBe("2024-02-29"); // leap
    expect(lib.previousCalendarDay("2026-03-01")).toBe("2026-02-28");
    // DST transition days (Sydney: 2026-04-05 end, 2026-10-04 start) are
    // plain calendar steps — the function never touches wall-clock time.
    expect(lib.previousCalendarDay("2026-04-06")).toBe("2026-04-05");
    expect(lib.previousCalendarDay("2026-10-05")).toBe("2026-10-04");
    expect(() => lib.previousCalendarDay("yesterday")).toThrow(/invalid date/);
  });

  it("aggregates a day into grounded per-job facts; draft hours and archived jobs excluded", () => {
    const facts = lib.collectOfficeFacts({
      date: YDAY,
      jobs: [
        { id: "job-1", name: "Riverside", status: "active" },
        { id: "job-2", name: "Quiet St", status: "active" },
        { id: "job-3", name: "Old Yard", status: "archived" },
      ],
      users: [
        { id: "u_f1", name: "Sam" },
        { id: "u_f2", username: "dean" },
      ],
      entries: [
        { userId: "u_f1", status: "submitted", allocations: [{ jobId: "job-1", hours: 6 }] },
        {
          userId: "u_f2",
          status: "approved",
          allocations: [
            { jobId: "job-1", hours: 2 },
            { jobId: "job-unknown", hours: 1 },
          ],
        },
        { userId: "u_f1", status: "draft", allocations: [{ jobId: "job-1", hours: 4 }] },
      ],
      observations: [
        { id: "ob1", type: "blocker", jobId: "job-1", jobName: "Riverside", title: "No switchboard access", status: "new", createdAt: `${YDAY}T01:00:00Z` },
        { id: "ob2", type: "blocker", jobId: "job-2", title: "Waiting on the builder", status: "needs_action", createdAt: "2026-06-25T01:00:00Z" },
        { id: "ob3", type: "blocker", status: "resolved", createdAt: "2026-06-20T01:00:00Z", resolvedAt: `${YDAY}T05:00:00Z` },
        { id: "ob4", type: "note", status: "new", createdAt: `${YDAY}T01:00:00Z` },
      ],
      perJobData: [
        {
          jobId: "job-1",
          data: {
            snags: [
              { id: "s1", createdAt: `${YDAY}T02:00:00Z` },
              { id: "s2", createdAt: "2026-06-01T02:00:00Z", closedAt: `${YDAY}T03:00:00Z` },
            ],
            snagsV2: [],
            evidence: [
              { id: "e1", capturedAt: `${YDAY}T04:00:00Z` },
              { id: "e2", capturedAt: `${YDAY}T05:00:00Z` },
              { id: "e3", capturedAt: "2026-06-29T05:00:00Z" },
            ],
          },
        },
        { jobId: "job-2", data: { snags: [], snagsV2: [], evidence: [] } },
      ],
      entriesUnreadable: 1,
    });

    expect(facts.totals).toEqual({
      hoursLogged: 9, // draft never counts
      entryCount: 2,
      pendingCount: 1,
      workerCount: 2,
      snagsOpened: 1,
      snagsClosed: 1,
      evidenceCaptured: 2,
      blockersRaised: 1,
      blockersResolved: 1,
      blockersOutstanding: 2,
      jobsWithActivity: 1,
      activeJobs: 2, // archived job-3 excluded
    });
    expect(facts.jobs).toHaveLength(1);
    expect(facts.jobs[0]).toMatchObject({
      jobId: "job-1",
      jobName: "Riverside",
      ref: { store: "jobs", id: "job-1" },
      hours: 8, // the job-unknown allocation counts in totals, not here
      workerNames: ["Sam", "dean"],
      snagsOpened: 1,
      snagsClosed: 1,
      evidenceCaptured: 2,
      blockersRaised: 1,
    });
    // Active job with zero activity is NAMED, never faked into a line.
    expect(facts.quietJobs).toEqual([{ jobId: "job-2", jobName: "Quiet St" }]);
    // Outstanding blockers: oldest first, per-item record refs, honest age.
    expect(facts.blockersOutstanding.map((b: { id: string; ageDays: number }) => [b.id, b.ageDays])).toEqual([
      ["ob2", 5],
      ["ob1", 0],
    ]);
    expect(facts.blockersOutstanding[0].ref).toEqual({ store: "observations", id: "ob2" });
    expect(facts.quietDay).toBe(false);
    // Partial-failure honesty: gaps are counted, never hidden.
    expect(facts.coverage).toMatchObject({
      scannedJobs: 2,
      totalActiveJobs: 2,
      jobsUnreadable: 0,
      entriesUnreadable: 1,
    });
    expect(facts.coverage.doesNotSee.length).toBeGreaterThan(0);

    const lines = lib.renderDeterministicLines(facts);
    expect(lines[0]).toEqual({ text: "2 workers logged 9h across 1 job.", href: "/hours" });
    expect(lines[1].href).toBe("/v2/jobs/job-1");
    expect(lines[1].text).toContain("Riverside — 8h (Sam, dean)");
    expect(lines.map((l: { href: string }) => l.href)).toContain("/observations");
  });

  it("an unreadable per-job read becomes a coverage gap; a fully quiet day says so", () => {
    const facts = lib.collectOfficeFacts({
      date: YDAY,
      jobs: [{ id: "job-1", name: "Riverside", status: "active" }],
      users: [],
      entries: [],
      observations: [],
      perJobData: [{ jobId: "job-1", data: null }],
      entriesUnreadable: 0,
    });
    expect(facts.coverage.jobsUnreadable).toBe(1);
    expect(facts.quietDay).toBe(true);
    const lines = lib.renderDeterministicLines(facts);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("No activity was recorded on 2026-06-30");
  });
});

// ── The handler ──────────────────────────────────────────────────────────

let store: Map<string, unknown>;
let writes: string[];
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
let pushMock: ReturnType<typeof vi.fn>;
let entriesFixture: { entries: Array<Record<string, unknown>>; unreadable: number };
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
  userId?: string; // must exist in the users.json fixture (role comes from the store)
  role?: string;
  anon?: boolean;
  headers?: Record<string, string>;
}) {
  const res = createRes();
  await handler(
    {
      method: opts.method,
      query: opts.query || {},
      headers: {
        ...(opts.anon || opts.headers
          ? {}
          : {
              cookie: `buhl_session=${auth.signSession({
                userId: opts.userId || "u_boss",
                role: opts.role || "boss",
                exp: Date.now() + 60_000,
              })}`,
            }),
        ...(opts.headers || {}),
      },
    },
    res
  );
  return res;
}
const generate = (query: Record<string, string> = {}) =>
  call({ method: "POST", query: { action: "generate", ...query } });

// A grounded AI reply — every numeral (2, 9, 8, 1, 5) appears in the facts
// the default fixture produces.
function groundedReply() {
  return {
    text: JSON.stringify({
      summary:
        "2 workers logged 9h, most of it on Riverside (8h). 1 snag opened, 2 photos captured and 1 blocker raised — the oldest open blocker is 5 days old.",
    }),
    usage: { inputTokens: 500, outputTokens: 60 },
    model: "claude-sonnet-4-6",
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_OFFICE_DAILY_SUMMARY = "1";
  delete process.env.CRON_SECRET;
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => groundedReply());
  entriesFixture = {
    entries: [
      { userId: "u_f1", status: "submitted", allocations: [{ jobId: "job-1", hours: 6 }] },
      {
        userId: "u_f2",
        status: "approved",
        allocations: [
          { jobId: "job-1", hours: 2 },
          { jobId: "job-unknown", hours: 1 },
        ],
      },
    ],
    unreadable: 0,
  };

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
          { id: "u_f1", name: "Sam", username: "sam", role: "electrician" },
          { id: "u_f2", name: "Dean", username: "dean", role: "electrician" },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-1", name: "Riverside", status: "active" },
          { id: "job-2", name: "Quiet St", status: "active" },
          { id: "job-3", name: "Old Yard", status: "archived" },
        ],
      },
    ],
    [
      "jobs/job-1/data.json",
      {
        snags: [{ id: "s1", createdAt: `${YDAY}T02:00:00Z` }],
        snagsV2: [],
        evidence: [
          { id: "e1", capturedAt: `${YDAY}T04:00:00Z` },
          { id: "e2", capturedAt: `${YDAY}T05:00:00Z` },
        ],
      },
    ],
    ["jobs/job-2/data.json", { snags: [], snagsV2: [], evidence: [] }],
    [
      "observations.json",
      {
        observations: [
          {
            id: "ob1",
            type: "blocker",
            jobId: "job-1",
            jobName: "Riverside",
            title: "No switchboard access",
            status: "new",
            createdAt: "2026-06-25T01:00:00Z",
          },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, auditPath, cronAuthPath, officeSummaryPath, aiSuggestionsPath, handlerPath]) {
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
    exports: { listEntriesForDate: vi.fn(async () => clone(entriesFixture)) },
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
  delete process.env.FLAG_AI_OFFICE_DAILY_SUMMARY;
  delete process.env.CRON_SECRET;
});

describe("gates", () => {
  it("404s while the flag is dark (default)", async () => {
    delete process.env.FLAG_AI_OFFICE_DAILY_SUMMARY;
    expect((await generate()).statusCode).toBe(404);
    expect((await call({ method: "GET" })).statusCode).toBe(404);
  });

  it("401s anonymous callers; a field user never sees the surface (admin-tier flag → 404)", async () => {
    expect((await call({ method: "POST", query: { action: "generate" }, anon: true })).statusCode).toBe(401);
    expect((await call({ method: "GET", userId: "u_f1", role: "electrician" })).statusCode).toBe(404);
    expect(
      (await call({ method: "POST", query: { action: "generate" }, userId: "u_f1", role: "electrician" }))
        .statusCode
    ).toBe(404);
  });
});

describe("generate — two-stage pipeline", () => {
  it("stores the fact table + grounded AI narrative for yesterday, and audits", async () => {
    const res = await generate();
    expect(res.statusCode).toBe(200);
    const s = res.body.summary;
    expect(s.date).toBe(YDAY);
    expect(s.quietDay).toBe(false);
    expect(s.phrasing).toBe("ai");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.narrative).toContain("2 workers logged 9h");
    // Facts computable with zero AI — asserted off the stored doc.
    expect(s.facts.totals).toMatchObject({
      hoursLogged: 9,
      entryCount: 2,
      workerCount: 2,
      snagsOpened: 1,
      evidenceCaptured: 2,
      blockersOutstanding: 1,
      jobsWithActivity: 1,
      activeJobs: 2,
    });
    expect(s.facts.jobs[0]).toMatchObject({ jobId: "job-1", hours: 8, workerNames: ["Sam", "Dean"] });
    expect(s.facts.quietJobs).toEqual([{ jobId: "job-2", jobName: "Quiet St" }]);
    // Deterministic lines always present, each with an href.
    expect(s.lines[0].text).toBe("2 workers logged 9h across 1 job.");
    expect(s.lines.some((l: { href: string }) => l.href === "/v2/jobs/job-1")).toBe(true);
    // Stored under the date key + audited.
    expect(writes).toContain(KEY);
    expect(writes.some((k) => k.startsWith("audit/"))).toBe(true);
    expect(s.coverage.doesNotSee.length).toBeGreaterThan(0);
  });

  it("falls back to facts-only when the model invents a number — never blocked, never fake", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({ summary: "Roughly 37 workers smashed out 480 hours." }),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const s = (await generate()).body.summary;
    expect(s.phrasing).toBe("deterministic");
    expect(s.narrative).toBeNull();
    expect(s.fallbackReason).toMatch(/not grounded/);
    expect(s.lines.length).toBeGreaterThan(0); // the facts still render
  });

  it("provider failure and prose replies degrade to facts", async () => {
    aiCompleteMock.mockRejectedValueOnce(new Error("provider down"));
    let s = (await generate({ dryRun: "1" })).body.summary;
    expect(s.phrasing).toBe("deterministic");

    aiCompleteMock.mockResolvedValueOnce({ text: "Big day on the tools!", usage: null, model: "m" });
    s = (await generate({ dryRun: "1" })).body.summary;
    expect(s.phrasing).toBe("deterministic");
    expect(s.fallbackReason).toMatch(/not valid JSON/);
  });

  it("unconfigured AI → facts-only summary, no model call", async () => {
    aiConfigured = false;
    const s = (await generate()).body.summary;
    expect(s.phrasing).toBe("deterministic");
    expect(s.fallbackReason).toMatch(/not configured/);
    expect(s.lines.length).toBeGreaterThan(0);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("quiet day stores the honest record, never calls the model, never pushes", async () => {
    entriesFixture = { entries: [], unreadable: 0 };
    store.set("jobs/job-1/data.json", { snags: [], snagsV2: [], evidence: [] });
    store.set("observations.json", { observations: [] });
    const s = (await generate()).body.summary;
    expect(s.quietDay).toBe(true);
    expect(s.phrasing).toBe("none");
    expect(s.lines[0].text).toContain("No activity was recorded");
    expect(aiCompleteMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(writes).toContain(KEY); // audit trail has no gaps
  });

  it("unreadable timesheets surface in coverage — partial data never poses as complete", async () => {
    entriesFixture = { ...entriesFixture, unreadable: 2 };
    const s = (await generate({ dryRun: "1" })).body.summary;
    expect(s.coverage.entriesUnreadable).toBe(2);
  });

  it("dryRun returns the summary without storing, pushing or auditing", async () => {
    const res = await generate({ dryRun: "1" });
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary.facts.totals.hoursLogged).toBe(9);
    expect(writes).toEqual([]);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("delivery — push fan-out + dedupe", () => {
  it("first non-quiet generation pushes to every live admin, deep-linking /reports", async () => {
    const res = await generate();
    expect(res.body.summary.pushedAt).toBeTruthy();
    const pushedTo = pushMock.mock.calls.map((c) => c[0]).sort();
    expect(pushedTo).toEqual(["u_admin2", "u_boss"]); // archived admin + field users excluded
    const payload = pushMock.mock.calls[0]?.[1] as Record<string, string>;
    expect(payload.url).toBe("/reports");
    expect(payload.tag).toBe(`office-summary-${YDAY}`);
    expect(payload.body).toContain("2 workers logged 9h");
  });

  it("regenerating the same date never re-pushes (pushedAt carried forward) — idempotent doc write", async () => {
    await generate();
    const first = (store.get(KEY) as { pushedAt: string }).pushedAt;
    pushMock.mockClear();
    const again = await generate();
    expect(pushMock).not.toHaveBeenCalled();
    expect(again.body.summary.pushedAt).toBe(first);
    // Same-date re-run replaced the one document, no second key.
    expect(writes.filter((k) => k === KEY)).toHaveLength(2);
  });
});

describe("cron", () => {
  const cronHeaders = { "x-cron-secret": "shh" };

  it("no-ops honestly while the flag is dark — safe to ship the schedule dark", async () => {
    process.env.CRON_SECRET = "shh";
    delete process.env.FLAG_AI_OFFICE_DAILY_SUMMARY;
    const res = await call({ method: "POST", query: { action: "generate" }, headers: cronHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ skipped: "flag off" });
    expect(writes).toEqual([]);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("generates yesterday's summary with no session once the flag is on", async () => {
    process.env.CRON_SECRET = "shh";
    const res = await call({ method: "POST", query: { action: "generate" }, headers: cronHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body.summary.date).toBe(YDAY);
    expect(res.body.summary.generatedBy).toBe("cron");
    expect(writes).toContain(KEY);
  });

  it("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = "shh";
    const res = await call({
      method: "POST",
      query: { action: "generate" },
      headers: { "x-cron-secret": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET", () => {
  it("serves the stored summary for yesterday, null when none; ?date= reads a past day", async () => {
    expect((await call({ method: "GET" })).body).toEqual({ date: YDAY, summary: null });
    await generate();
    const res = await call({ method: "GET" });
    expect(res.body.date).toBe(YDAY);
    expect(res.body.summary.facts.totals.hoursLogged).toBe(9);

    // An explicit past date reads that day's doc (none stored → null).
    const past = await call({ method: "GET", query: { date: "2026-06-01" } });
    expect(past.body).toEqual({ date: "2026-06-01", summary: null });
    // A malformed date falls back to yesterday.
    const bad = await call({ method: "GET", query: { date: "junk" } });
    expect(bad.body.date).toBe(YDAY);
  });
});
