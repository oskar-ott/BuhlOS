import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #267 — api/evidence.js?action=dismiss-defect-suggestion. Real handler +
 * real auth/flag/audit libs, stubbed blob store. Covers: flag-dark 404,
 * admin-tier targeting, the sticky dismissal write (with confidence read from
 * the ROW, never the client), idempotent re-dismiss, and 404 off-job rows.
 *
 * The ACCEPT side of #267 deliberately has NO endpoint here — accepting a
 * suggestion is a plain POST /api/snags create (covered by the existing snag
 * API tests); this file proves the only new write path is the dismissal.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const jobAuditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/evidence.js");

let store: Map<string, unknown>;
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
async function dismiss(evidenceId: string, opts: { role?: string; userId?: string } = {}) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId: "job-1", action: "dismiss-defect-suggestion" },
      body: { evidenceId },
      headers: {
        cookie: `buhl_session=${auth.signSession({
          userId: opts.userId || "u_boss",
          role: opts.role || "boss",
          exp: Date.now() + 60_000,
        })}`,
      },
    },
    res
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_SNAG_SUGGESTIONS = "1";

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "lh", role: "leadingHand", assignedJobIds: ["job-1"] },
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
          {
            id: "ev_1",
            jobId: "job-1",
            kind: "photo",
            photoId: "p1",
            photoUrl: "https://blob.example/p1.jpg",
            capturedById: "u_lh",
            capturedByName: "LH",
            capturedAt: "2026-07-01T00:00:00.000Z",
            status: "submitted",
            source: "phil",
            auditLogIds: [],
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
            labels: [
              {
                label: "possible-defect",
                source: "ai",
                status: "suggested",
                confidence: 0.83,
                modelVersion: "claude-sonnet-4-6",
                promptVersion: "photo-labels-v1",
                at: "2026-07-01T01:00:00.000Z",
              },
            ],
          },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, auditPath, jobAuditPath, handlerPath]) {
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
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })) },
  } as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  auth = requireFromHere(authPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  delete requireFromHere.cache[blobPath];
  delete requireFromHere.cache[vercelBlobPath];
  delete process.env.FLAG_AI_SNAG_SUGGESTIONS;
});

describe("dismiss-defect-suggestion", () => {
  it("404s while the ai_snag_suggestions flag is dark (default)", async () => {
    delete process.env.FLAG_AI_SNAG_SUGGESTIONS;
    expect((await dismiss("ev_1")).statusCode).toBe(404);
  });

  it("is invisible to non-admin tiers (admin-tier targeting → 404)", async () => {
    expect((await dismiss("ev_1", { role: "leadingHand", userId: "u_lh" })).statusCode).toBe(404);
  });

  it("stamps the sticky dismissal with the ROW's confidence, and audits", async () => {
    const res = await dismiss("ev_1");
    expect(res.statusCode).toBe(200);
    expect(res.body.evidenceItem.defectSuggestionDismissed).toMatchObject({
      byId: "u_boss",
      label: "possible-defect",
      confidence: 0.83, // read from the row, not the request
      modelVersion: "claude-sonnet-4-6",
    });
    expect(res.body.evidenceItem.auditLogIds.length).toBeGreaterThan(0);
  });

  it("re-dismissing is an idempotent no-op", async () => {
    await dismiss("ev_1");
    const again = await dismiss("ev_1");
    expect(again.statusCode).toBe(200);
    expect(again.body.idempotentNoop).toBe(true);
  });

  it("404s for a row that is not on the job", async () => {
    expect((await dismiss("ev_nope")).statusCode).toBe(404);
  });
});
