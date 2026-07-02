import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #262 — api/evidence.js?action=classify / ?action=labels. Real handler +
 * real auth/flag/audit/photo-labels libs, stubbed blob store, MOCKED ai
 * gateway (the real API is never called) and a stubbed global fetch for the
 * image bytes. Covers: flag-dark 404, admin gate, honest 503 unconfigured,
 * happy-path classification (one write per batch + run markers + audit),
 * idempotent re-runs, honest failure (no run marker), taxonomy rejection,
 * and the human correction path (accept / sticky reject / add).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const jobAuditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const photoLabelsPath = requireFromHere.resolve("../../../api/_lib/photo-labels.js");
const aiSuggestionsPath = requireFromHere.resolve("../../../api/_lib/ai-suggestions.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/evidence.js");

let store: Map<string, unknown>;
let writes: string[];
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
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
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: {
  action: string;
  body?: Record<string, unknown>;
  role?: string;
  userId?: string;
}) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId: "job-1", action: opts.action },
      body: opts.body || {},
      headers: { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
    },
    res
  );
  return res;
}

const photoRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  jobId: "job-1",
  kind: "photo",
  photoId: `p_${id}`,
  photoUrl: `https://blob.example/jobs/job-1/evidence-photos/${id}.jpg`,
  capturedById: "u_field",
  capturedByName: "Sparky",
  capturedAt: "2026-07-01T00:00:00.000Z",
  status: "submitted",
  source: "phil",
  auditLogIds: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_PHOTO_LABELS = "1";
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.EVIDENCE_AI_MODEL;
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => ({
    text: JSON.stringify({
      labels: [
        { label: "switchboard", confidence: 0.92 },
        { label: "possible-defect", confidence: 0.81 },
      ],
    }),
    usage: { inputTokens: 900, outputTokens: 30 },
    model: "claude-sonnet-4-6",
  }));

  writes = [];
  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "lh", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Riverside", status: "active" }] }],
    [
      "jobs/job-1/data.json",
      {
        dwellings: {},
        snags: [],
        notes: [],
        evidence: [
          photoRow("ev_1"),
          photoRow("ev_2"),
          { ...photoRow("ev_note"), kind: "note", photoId: null, photoUrl: null, note: "hello" },
        ],
      },
    ],
  ]);

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
  );

  for (const p of [authPath, ffPath, auditPath, jobAuditPath, photoLabelsPath, aiSuggestionsPath, handlerPath]) {
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
  vi.unstubAllGlobals();
  delete requireFromHere.cache[blobPath];
  delete requireFromHere.cache[aiPath];
  delete requireFromHere.cache[vercelBlobPath];
  delete process.env.FLAG_AI_PHOTO_LABELS;
  delete process.env.ANTHROPIC_API_KEY;
});

function evidenceRows(): Array<Record<string, unknown>> {
  const data = store.get("jobs/job-1/data.json") as { evidence: Array<Record<string, unknown>> };
  return data.evidence;
}

describe("gates", () => {
  it("404s when the ai_photo_labels flag is dark (default)", async () => {
    delete process.env.FLAG_AI_PHOTO_LABELS;
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("hides both actions from non-admin roles (admin-tier flag targeting → 404)", async () => {
    // The flag targets admin-tier, so for an LH the feature is INVISIBLE
    // (404), not merely forbidden — defence sits in front of the role gate.
    for (const action of ["classify", "labels"]) {
      const res = await call({
        action,
        body: { evidenceIds: ["ev_1"], evidenceId: "ev_1", add: ["outlet"] },
        role: "leadingHand",
        userId: "u_lh",
      });
      expect(res.statusCode).toBe(404);
    }
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("503s honestly when AI is not configured — never a fake label", async () => {
    aiConfigured = false;
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("UNCONFIGURED");
  });
});

describe("classify", () => {
  it("labels photos as suggestions, one blob write per batch, audit appended", async () => {
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1", "ev_2"] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([
      { evidenceId: "ev_1", outcome: "labelled", labelCount: 2 },
      { evidenceId: "ev_2", outcome: "labelled", labelCount: 2 },
    ]);
    // ONE data write for the whole batch (resurrection-hazard rule) + the
    // audit journal's own monthly blob.
    expect(writes.filter((k) => k === "jobs/job-1/data.json")).toHaveLength(1);
    expect(writes.some((k) => k.startsWith("audit/"))).toBe(true);

    const row = evidenceRows().find((e) => e.id === "ev_1") as {
      labels: Array<Record<string, unknown>>;
      aiLabelRuns: Array<Record<string, unknown>>;
    };
    expect(row.labels.map((l) => l.label)).toEqual(["switchboard", "possible-defect"]);
    expect(row.labels.every((l) => l.source === "ai" && l.status === "suggested")).toBe(true);
    expect(row.labels[0]?.modelVersion).toBe("claude-sonnet-4-6");
    expect(row.labels[0]?.promptVersion).toBe("photo-labels-v1");
    expect(row.aiLabelRuns).toHaveLength(1);
  });

  it("is idempotent per modelVersion — a second run skips, no model call", async () => {
    await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    aiCompleteMock.mockClear();
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.body.results[0]).toMatchObject({ outcome: "skipped", reason: "already classified" });
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("skips note rows — photo-only pipeline", async () => {
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_note"] } });
    expect(res.body.results[0]).toMatchObject({ outcome: "skipped", reason: "not a photo" });
  });

  it("a failed model call leaves the row unlabelled and re-attemptable (no run marker)", async () => {
    aiCompleteMock.mockRejectedValueOnce(new Error("provider down"));
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outcome: "failed" });
    const row = evidenceRows().find((e) => e.id === "ev_1") as Record<string, unknown>;
    expect(row.labels).toBeUndefined();
    expect(row.aiLabelRuns).toBeUndefined();
    // …and a retry works.
    const retry = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(retry.body.results[0].outcome).toBe("labelled");
  });

  it("rejects labels outside the taxonomy server-side (closed vocabulary)", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({ labels: [{ label: "vibes", confidence: 0.99 }] }),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.body.results[0]).toMatchObject({ outcome: "no-labels", labelCount: 0 });
    const row = evidenceRows().find((e) => e.id === "ev_1") as {
      labels?: unknown[];
      aiLabelRuns: unknown[];
    };
    expect(row.labels ?? []).toEqual([]);
    expect(row.aiLabelRuns).toHaveLength(1); // marker written — the run happened
  });

  it("a non-JSON model reply is an honest failure, not a partial answer", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: "Sure! This looks like a switchboard.",
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
    expect(res.body.results[0]).toMatchObject({ outcome: "failed" });
  });

  it("caps the batch size", async () => {
    const res = await call({
      action: "classify",
      body: { evidenceIds: Array.from({ length: 9 }, (_, i) => `ev_${i}`) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("labels correction", () => {
  beforeEach(async () => {
    await call({ action: "classify", body: { evidenceIds: ["ev_1"] } });
  });

  it("accept confirms a suggestion; the AI record keeps reviewer + timestamps", async () => {
    const res = await call({
      action: "labels",
      body: { evidenceId: "ev_1", accept: ["switchboard"] },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.body.evidenceItem.labels.find(
      (l: Record<string, unknown>) => l.label === "switchboard"
    );
    expect(entry).toMatchObject({ status: "accepted", reviewedById: "u_boss" });
  });

  it("remove rejects an AI label stickily — it never resurfaces", async () => {
    await call({ action: "labels", body: { evidenceId: "ev_1", remove: ["possible-defect"] } });
    const row = evidenceRows().find((e) => e.id === "ev_1") as {
      labels: Array<Record<string, unknown>>;
    };
    const rejected = row.labels.find((l) => l.label === "possible-defect");
    expect(rejected).toMatchObject({ status: "rejected", reviewedById: "u_boss" });
  });

  it("add stores a human-owned label; unknown labels are rejected", async () => {
    const ok = await call({ action: "labels", body: { evidenceId: "ev_1", add: ["cable-tray"] } });
    expect(ok.statusCode).toBe(200);
    const entry = ok.body.evidenceItem.labels.find(
      (l: Record<string, unknown>) => l.label === "cable-tray"
    );
    expect(entry).toMatchObject({ source: "human", status: "confirmed", byId: "u_boss" });

    const bad = await call({ action: "labels", body: { evidenceId: "ev_1", add: ["nonsense"] } });
    expect(bad.statusCode).toBe(400);
  });

  it("404s for a row that is not on the job", async () => {
    const res = await call({ action: "labels", body: { evidenceId: "ev_missing", add: ["outlet"] } });
    expect(res.statusCode).toBe(404);
  });
});
