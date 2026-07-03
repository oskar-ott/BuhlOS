import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #170 — api/ai-assistant.js, the assistant foundation's first consumer
 * (the #173 job-summary backend). Real handler + real auth/flag/audit libs,
 * stubbed blob store, MOCKED ai gateway (the real API is never called).
 * Covers: 401 anon, flag-dark 404, tier gates, honest 503 when AI is
 * unconfigured, 502 provider failure, the happy path (summary + toolData +
 * audit entry), and the admin-only tools listing.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const toolsPath = requireFromHere.resolve("../../../api/_lib/ai-tools.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const dayPulsePath = requireFromHere.resolve("../../../api/_lib/day-pulse.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/ai-assistant.js");

class FakeAiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

let store: Map<string, unknown>;
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function createRes() {
  return {
    statusCode: 200,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response body asserted per test
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
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}
const summarise = (over: Partial<Parameters<typeof call>[0]> = {}) =>
  call({ method: "POST", query: { action: "summarise-job", jobId: "job-1" }, ...over });

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_ASSISTANT = "1";
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => ({
    text: "Riverside Units is active with one open snag.",
    usage: { inputTokens: 500, outputTokens: 40 },
    model: "claude-sonnet-4-6",
  }));

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "lh", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_lh2", username: "lh2", role: "leadingHand", assignedJobIds: ["job-9"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-1",
            name: "Riverside Units",
            status: "active",
            roughInTasks: [{ id: "t1" }],
            fitOffTasks: [],
            areaGroups: [{ id: "g1", areas: [{ id: "a1", name: "Unit 1" }] }],
          },
        ],
      },
    ],
    [
      "jobs/job-1/data.json",
      {
        dwellings: { a1: { roughIn: { tasks: { t1: "complete" } } } },
        snags: [{ id: "s1", desc: "Missing GPO", status: "Open", priority: "High" }],
        evidence: [{ id: "e1" }],
        notes: [],
      },
    ],
    ["observations.json", { observations: [] }],
  ]);

  for (const p of [authPath, ffPath, auditPath, dayPulsePath, toolsPath, handlerPath]) {
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
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[timeEntriesPath] = {
    id: timeEntriesPath,
    filename: timeEntriesPath,
    loaded: true,
    exports: {
      listAllEntriesForApprovers: vi.fn(async () => [
        { id: "te1", userId: "u_field", date: "2026-06-30", status: "approved", allocations: [{ jobId: "job-1", hours: 6 }] },
      ]),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })) },
  } as NodeJS.Module;
  requireFromHere.cache[aiPath] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: {
      AiError: FakeAiError,
      isAiConfigured: () => aiConfigured,
      aiComplete: (...args: unknown[]) => aiCompleteMock(...args),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  for (const p of [blobPath, timeEntriesPath, vercelBlobPath, aiPath, authPath, ffPath, auditPath, dayPulsePath, toolsPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  delete process.env.FLAG_AI_ASSISTANT;
  vi.restoreAllMocks();
});

describe("gates", () => {
  it("401 for an anonymous caller", async () => {
    const res = await summarise({ anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("404 when the ai_assistant flag is dark (default off)", async () => {
    process.env.FLAG_AI_ASSISTANT = "0";
    const res = await summarise();
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("403 for a field user — even on their assigned job", async () => {
    const res = await summarise({ userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(403);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("403 for a leading hand on an UNASSIGNED job, 200 on an assigned one", async () => {
    const denied = await summarise({ userId: "u_lh2", role: "leadingHand" });
    expect(denied.statusCode).toBe(403);
    const ok = await summarise({ userId: "u_lh", role: "leadingHand" });
    expect(ok.statusCode).toBe(200);
  });

  it("405 for a GET summarise-job; 400 for an unknown action; 400 without jobId", async () => {
    expect((await call({ method: "GET", query: { action: "summarise-job", jobId: "job-1" } })).statusCode).toBe(405);
    expect((await call({ method: "POST", query: { action: "make-it-up" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { action: "summarise-job" } })).statusCode).toBe(400);
  });
});

describe("summarise-job", () => {
  it("503 honestly when AI is unconfigured — no fake summary, no store reads", async () => {
    aiConfigured = false;
    const res = await summarise();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("UNCONFIGURED");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("502 when the provider fails mid-call", async () => {
    aiCompleteMock.mockRejectedValueOnce(new FakeAiError("PROVIDER_FAILED", "Anthropic request failed: overloaded"));
    const res = await summarise();
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe("PROVIDER_FAILED");
  });

  it("404 for a job that does not exist", async () => {
    const res = await summarise({ query: { action: "summarise-job", jobId: "job-nope" } });
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("happy path: grounded summary + verbatim toolData + audit entry", async () => {
    const res = await summarise();
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe("Riverside Units is active with one open snag.");
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // toolData carries the REAL numbers so the caller can render them next to the prose.
    expect(res.body.toolData.overview.job.name).toBe("Riverside Units");
    expect(res.body.toolData.overview.openSnagCount).toBe(1);
    expect(res.body.toolData.hours.approved).toEqual({ entryCount: 1, hours: 6 });
    expect(res.body.toolData.openItems.openObservations).toEqual([]);

    // The prompt forbids invention and instructs "no data" for empty sections.
    const promptArgs = aiCompleteMock.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
    expect(promptArgs.system).toContain("Never invent");
    expect(promptArgs.system).toContain('say "no data"');
    expect(promptArgs.messages[0]!.content).toContain('"openSnagCount": 1');

    // Best-effort audit entry landed in the monthly journal.
    const yyyymm = new Date().toISOString().slice(0, 7);
    const month = store.get(`audit/${yyyymm}.json`) as { entries: Array<Record<string, unknown>> };
    expect(month).toBeTruthy();
    expect(month.entries).toHaveLength(1);
    expect(month.entries[0]).toMatchObject({
      action: "ai.job_summarised",
      actorId: "u_boss",
      jobId: "job-1",
      targetType: "job",
      targetId: "job-1",
    });
  });
});

describe("tools listing", () => {
  it("GET action=tools lists names + descriptions for the admin tier", async () => {
    const res = await call({ method: "GET", query: { action: "tools" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "company_day_pulse",
      "drawing_extractions",
      "job_hours",
      "job_open_items",
      "job_overview",
    ]);
  });

  it("403 for a leading hand; 405 for POST", async () => {
    expect((await call({ method: "GET", query: { action: "tools" }, userId: "u_lh", role: "leadingHand" })).statusCode).toBe(403);
    expect((await call({ method: "POST", query: { action: "tools" } })).statusCode).toBe(405);
  });
});
