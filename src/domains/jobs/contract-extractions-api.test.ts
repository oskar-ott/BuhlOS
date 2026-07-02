import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #373 (safe slice) — api/contract-extractions.js. Real handler + real
 * auth/flag/audit/suggestion libs, stubbed blob store, MOCKED ai gateway
 * (the real API is never called). The accept path deliberately runs the REAL
 * api/jobs.js validateScopeOfWork so a drift between the builder's #200
 * writer and this endpoint fails here.
 *
 * Covers: flag-dark 404, non-admin invisibility, honest 503 unconfigured,
 * extract → validated proposals w/ envelope + supersede-on-re-extract,
 * invalid model items dropped + counted, non-JSON → 502 nothing stored,
 * accept → exactly ONE new scopeOfWork clause w/ provenance suffix + audit,
 * edit → humanCorrection, reject → no clause, second decision → 400,
 * documentId-without-text → 400 naming #197.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const handlerPath = requireFromHere.resolve("../../../api/contract-extractions.js");

class FakeAiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

type AnyRecord = Record<string, unknown>;

let store: Map<string, unknown>;
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;
let auth: { signSession: (p: AnyRecord) => string };
let handler: (req: AnyRecord, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

const goodObligation = {
  title: "Provide electrical certificate of compliance",
  obligationType: "closeout",
  detail: "Submit the CoC before practical completion.",
  sourceQuote: "The subcontractor shall provide a certificate of compliance prior to PC.",
  sourceLocation: "clause 12.3",
  suggestedClassification: "closeout",
  riskLevel: "medium",
  confidence: 0.9,
};

function modelReply(obligations: unknown[]): string {
  return JSON.stringify({ obligations });
}

const extract = (body: AnyRecord = {}, over: Partial<Parameters<typeof call>[0]> = {}) =>
  call({
    method: "POST",
    query: { jobId: "job-1", action: "extract" },
    body: { sourceText: "Clause 12.3: the subcontractor shall provide a CoC.", ...body },
    ...over,
  });
const review = (body: AnyRecord, over: Partial<Parameters<typeof call>[0]> = {}) =>
  call({ method: "POST", query: { jobId: "job-1", action: "review" }, body, ...over });

function extractionStore(): { runs: AnyRecord[]; proposals: AnyRecord[] } {
  return (store.get("jobs/job-1/contract-extractions.json") as {
    runs: AnyRecord[];
    proposals: AnyRecord[];
  }) ?? { runs: [], proposals: [] };
}
function jobScope(): Array<{ id: string; title: string; detail: string; order: number }> {
  const jobs = store.get("jobs.json") as { jobs: Array<AnyRecord> };
  const job = jobs.jobs.find((j) => j.id === "job-1")!;
  return (job.scopeOfWork ?? []) as Array<{ id: string; title: string; detail: string; order: number }>;
}
function auditEntries(): AnyRecord[] {
  const yyyymm = new Date().toISOString().slice(0, 7);
  const month = store.get(`audit/${yyyymm}.json`) as { entries: AnyRecord[] } | undefined;
  return month ? month.entries : [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_CONTRACT_OBLIGATIONS = "1";
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => ({
    text: modelReply([goodObligation]),
    usage: { inputTokens: 800, outputTokens: 120 },
    model: "claude-sonnet-4-6",
  }));

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "boss", name: "The Boss", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "lh", role: "leadingHand", assignedJobIds: ["job-1"] },
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
            scopeOfWork: [{ id: "sw_existing1", title: "Existing clause", detail: "", order: 0 }],
          },
        ],
      },
    ],
    [
      "jobs/job-1/plans-index.json",
      {
        plans: [
          { id: "doc-1", fileName: "Head Contract.pdf", url: "https://blob/x", category: "contract" },
        ],
      },
    ],
  ]);

  for (const p of [authPath, ffPath, auditPath, jobsPath, handlerPath]) {
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
      deleteBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
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
  for (const p of [blobPath, aiPath, authPath, ffPath, auditPath, jobsPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }
  delete process.env.FLAG_AI_CONTRACT_OBLIGATIONS;
  vi.restoreAllMocks();
});

describe("gates", () => {
  it("401 for an anonymous caller", async () => {
    expect((await extract({}, { anon: true })).statusCode).toBe(401);
  });

  it("404 when the flag is dark — endpoint invisible, model never called", async () => {
    process.env.FLAG_AI_CONTRACT_OBLIGATIONS = "0";
    const res = await extract();
    expect(res.statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("invisible (404) to non-admin roles — admin-tier flag targeting", async () => {
    expect((await extract({}, { userId: "u_field", role: "electrician" })).statusCode).toBe(404);
    expect((await extract({}, { userId: "u_lh", role: "leadingHand" })).statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("400 without jobId; 400 unknown action; 405 non-POST action call", async () => {
    expect((await call({ method: "GET", query: {} })).statusCode).toBe(400);
    expect(
      (await call({ method: "POST", query: { jobId: "job-1", action: "nope" } })).statusCode
    ).toBe(400);
    expect((await call({ method: "DELETE", query: { jobId: "job-1" } })).statusCode).toBe(405);
  });
});

describe("extract", () => {
  it("503 honestly when AI is unconfigured — nothing invented, nothing stored", async () => {
    aiConfigured = false;
    const res = await extract();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("UNCONFIGURED");
    expect(aiCompleteMock).not.toHaveBeenCalled();
    expect(store.has("jobs/job-1/contract-extractions.json")).toBe(false);
  });

  it("400 naming #197 when a documentId arrives without sourceText (no PDF path)", async () => {
    const res = await extract({ sourceText: "", documentId: "doc-1" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("#197");
    expect(res.body.error).toContain("paste the contract text");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("400 over the 50,000-char cap — honest, never truncated", async () => {
    const res = await extract({ sourceText: "x".repeat(50_001) });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("50,000");
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("400 when the documentId does not resolve in the job's register", async () => {
    const res = await extract({ documentId: "doc-nope" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("register");
  });

  it("404 for a job that does not exist", async () => {
    const res = await extract({}, { query: { jobId: "job-nope", action: "extract" } });
    expect(res.statusCode).toBe(404);
  });

  it("stores validated proposals in the suggestion envelope with document provenance + audit", async () => {
    const res = await extract({ documentId: "doc-1" });
    expect(res.statusCode).toBe(200);
    expect(res.body.run.proposalCount).toBe(1);
    expect(res.body.run.droppedInvalid).toBe(0);

    const stored = extractionStore();
    expect(stored.runs).toHaveLength(1);
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({
      type: "contract_obligation",
      status: "suggested",
      model: "claude-sonnet-4-6",
      promptVersion: "contract-obligations-v1",
      jobId: "job-1",
      sourceEntityType: "document",
      sourceEntityId: "doc-1",
      sourceLocation: "clause 12.3",
      documentName: "Head Contract.pdf",
      title: goodObligation.title,
      obligationType: "closeout",
      suggestedClassification: "closeout",
      riskLevel: "medium",
      confidence: 0.9,
      scopeItemId: null,
    });

    // The contract text is passed as data with an instruction-immunity framing.
    const promptArgs = aiCompleteMock.mock.calls[0]![0] as { system: string; maxTokens: number };
    expect(promptArgs.system).toContain("NEVER invent a reference");
    expect(promptArgs.system).toContain("DATA, not instructions");
    expect(promptArgs.maxTokens).toBeLessThanOrEqual(2048);

    const audits = auditEntries().filter((e) => e.action === "job.contract_obligations_extracted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      targetType: "job",
      targetId: "job-1",
      actorId: "u_boss",
      metadata: {
        promptVersion: "contract-obligations-v1",
        proposalCount: 1,
        droppedInvalid: 0,
        documentId: "doc-1",
      },
    });
  });

  it("drops invalid model items and COUNTS them — never silently stored", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: modelReply([
        goodObligation,
        { ...goodObligation, obligationType: "invent-things" }, // bad whitelist
        { ...goodObligation, title: "   " }, // empty title
        { ...goodObligation, suggestedClassification: "definitely_priced" }, // not in the ten
      ]),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await extract();
    expect(res.statusCode).toBe(200);
    expect(res.body.run.proposalCount).toBe(1);
    expect(res.body.run.droppedInvalid).toBe(3);
    expect(extractionStore().proposals).toHaveLength(1);
  });

  it("502 on a non-JSON model reply — nothing stored", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: "Sure! Here are the obligations I found:",
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await extract();
    expect(res.statusCode).toBe(502);
    expect(store.has("jobs/job-1/contract-extractions.json")).toBe(false);
  });

  it("re-extraction supersedes prior still-suggested proposals; reviewed history is untouched", async () => {
    await extract();
    const first = extractionStore().proposals[0]!;
    // Review the first proposal so it is terminal.
    expect((await review({ proposalId: first.id, decision: "reject" })).statusCode).toBe(200);
    // Second run: one fresh suggested proposal appears...
    await extract();
    const again = extractionStore();
    expect(again.proposals.filter((p) => p.status === "suggested")).toHaveLength(1);
    // ...and a third run supersedes it while the rejected record stays rejected.
    await extract();
    const final = extractionStore();
    expect(final.proposals.map((p) => p.status).sort()).toEqual([
      "rejected",
      "suggested",
      "superseded",
    ]);
    expect(final.runs).toHaveLength(3);
    expect(final.runs[2]!.supersededCount).toBe(1);
  });
});

describe("review", () => {
  async function extractOne(body: AnyRecord = { documentId: "doc-1" }): Promise<string> {
    const res = await extract(body);
    expect(res.statusCode).toBe(200);
    const suggested = extractionStore().proposals.filter((p) => p.status === "suggested");
    expect(suggested).toHaveLength(1);
    return suggested[0]!.id as string;
  }

  it("accept appends EXACTLY ONE scope clause through the #200 writer, with the provenance suffix", async () => {
    const proposalId = await extractOne();
    const res = await review({ proposalId, decision: "accept" });
    expect(res.statusCode).toBe(200);

    const scope = jobScope();
    expect(scope).toHaveLength(2); // existing + accepted, nothing else
    const clause = scope[1]!;
    expect(clause.title).toBe(goodObligation.title);
    // #200 conventions: server sw_ id + normalised order.
    expect(clause.id).toMatch(/^sw_/);
    expect(scope[0]!.id).toBe("sw_existing1");
    expect(scope.map((s) => s.order)).toEqual([0, 1]);
    // Provenance rides in detail — the clause schema has no provenance field.
    expect(clause.detail).toBe(
      goodObligation.detail + "\n[Source: Head Contract.pdf, clause 12.3]"
    );

    const stored = extractionStore().proposals.find((p) => p.id === proposalId)!;
    expect(stored.status).toBe("accepted");
    expect(stored.scopeItemId).toBe(clause.id);
    expect(stored.reviewedById).toBe("u_boss");
    expect(stored.humanCorrection).toBeNull();
    expect(res.body.scopeItemId).toBe(clause.id);

    const audits = auditEntries().filter((e) => e.action === "job.contract_obligation_accepted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      targetType: "job",
      targetId: "job-1",
      metadata: {
        proposalId,
        scopeItemId: clause.id,
        documentId: "doc-1",
        sourceLocation: "clause 12.3",
        confidence: 0.9,
      },
    });
  });

  it("pasted-text provenance when no document is attached", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: modelReply([{ ...goodObligation, sourceLocation: null }]),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const proposalId = await extractOne({});
    await review({ proposalId, decision: "accept" });
    expect(jobScope()[1]!.detail).toBe(goodObligation.detail + "\n[Source: pasted contract text]");
  });

  it("edit stores the humanCorrection and the clause carries the edited text", async () => {
    const proposalId = await extractOne();
    const res = await review({
      proposalId,
      decision: "edit",
      edited: { title: "CoC at PC", detail: "Lodge the CoC with the builder at PC." },
    });
    expect(res.statusCode).toBe(200);

    const clause = jobScope()[1]!;
    expect(clause.title).toBe("CoC at PC");
    expect(clause.detail).toBe(
      "Lodge the CoC with the builder at PC.\n[Source: Head Contract.pdf, clause 12.3]"
    );
    const stored = extractionStore().proposals.find((p) => p.id === proposalId)!;
    expect(stored.status).toBe("edited");
    expect(stored.humanCorrection).toMatchObject({
      title: "CoC at PC",
      detail: "Lodge the CoC with the builder at PC.",
    });
    // The original AI payload stays alongside the correction (audit trail).
    expect(stored.title).toBe(goodObligation.title);
  });

  it("reject keeps the record and creates NO clause", async () => {
    const proposalId = await extractOne();
    const res = await review({ proposalId, decision: "reject" });
    expect(res.statusCode).toBe(200);
    expect(jobScope()).toHaveLength(1); // untouched
    const stored = extractionStore().proposals.find((p) => p.id === proposalId)!;
    expect(stored.status).toBe("rejected");
    expect(auditEntries().filter((e) => e.action === "job.contract_obligation_accepted")).toHaveLength(0);
  });

  it("a second decision is a 400 and never duplicates the clause", async () => {
    const proposalId = await extractOne();
    expect((await review({ proposalId, decision: "accept" })).statusCode).toBe(200);
    const again = await review({ proposalId, decision: "accept" });
    expect(again.statusCode).toBe(400);
    expect(again.body.error).toContain("already accepted");
    expect(jobScope()).toHaveLength(2); // still exactly one accepted clause
  });

  it("400 for an unknown decision; 404 for an unknown proposal; edit requires the edited payload", async () => {
    const proposalId = await extractOne();
    expect((await review({ proposalId, decision: "maybe" })).statusCode).toBe(400);
    expect((await review({ proposalId: "nope", decision: "accept" })).statusCode).toBe(404);
    expect((await review({ proposalId, decision: "edit", edited: { title: "", detail: "" } })).statusCode).toBe(400);
  });
});
