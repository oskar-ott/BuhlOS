import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: quotes are dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_QUOTES = "1";
});
afterAll(() => {
  delete process.env.FLAG_QUOTES;
});

/**
 * #246 — AI quote drafts on api/quotes-v2.js (?action=ai-draft /
 * ai-draft-review), exercised through the REAL handler with blob storage
 * mocked to a Map and the ai gateway MOCKED (the ai-assistant-api.test.ts
 * harness pattern — the real API is never called).
 *
 * What this suite pins:
 *   - flag-dark 404 (ai_quote_drafts defaults off) + honest 503 unconfigured
 *   - a draft run stores envelope suggestions and NEVER touches sections,
 *     totals or updatedAt (the aiDraft field is outside the money math)
 *   - the 12,000-char truncation is RECORDED (truncated + usedChars)
 *   - the stubbed Epic-5 takeoff contract: valid items enter the prompt,
 *     bad shapes 400 before any model call
 *   - non-JSON model reply → 502 and NOTHING stored
 *   - accept writes exactly ONE rate-0 line (source/aiSuggestionId/
 *     needsPricing) atomically with the status flip; edit records the human
 *     correction; reject keeps the record; a second decision 400s (no
 *     duplicate lines); re-runs supersede only still-'suggested' rows
 *   - an ordinary PUT save PRESERVES aiDraft and round-trips the line flags
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");
const aiSuggestionsPath = requireFromHere.resolve("../../../api/_lib/ai-suggestions.js");
const quotesV2Path = requireFromHere.resolve("../../../api/quotes-v2.js");

class FakeAiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
let aiConfigured: boolean;
let aiCompleteMock: ReturnType<typeof vi.fn>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
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

interface CallOpts {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  as?: [string, string] | null;
}

async function call({ method, query = {}, body = {}, as = ["u_est", "estimator"] }: CallOpts) {
  const res = createRes();
  await handler(
    { method, body, query, headers: as ? { cookie: cookieFor(as[0], as[1]) } : {} },
    res
  );
  return res;
}

const SEED_ID = "qv2_seed";
const SEED_UPDATED_AT = "2026-06-12T01:00:00.000Z";

function seedDoc() {
  return {
    id: SEED_ID,
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    status: "draft",
    createdAt: "2026-06-12T00:00:00.000Z",
    createdBy: "estimator",
    updatedAt: SEED_UPDATED_AT,
    sections: [
      {
        id: "qsec_a",
        title: "Switchboard",
        sortOrder: 0,
        lines: [
          { id: "qline_a", kind: "material", description: "DB upgrade", qty: 1, unit: "ea", rate: 1000 },
        ],
      },
    ],
    totals: { subtotalExGst: 1000, gst: 100, totalIncGst: 1100, lineCount: 1 },
    __rev: 3,
  };
}

function docOf(id: string): Record<string, unknown> {
  return clone(blob.get(`quotes-v2/${id}.json`)) as Record<string, unknown>;
}

/** Model reply: one line for the EXISTING "Switchboard" section, two for a
 *  NEW "Lighting" section — one with an explicit qty, one without. */
const MODEL_REPLY = JSON.stringify({
  sections: [
    {
      title: "Switchboard",
      lines: [
        { kind: "labour", description: "Terminate submains", qty: null, unit: null, uncertainty: "cable size not stated" },
      ],
    },
    {
      title: "Lighting",
      lines: [
        { kind: "material", description: "LED downlight", qty: 24, unit: "ea", uncertainty: null },
        { kind: "labour", description: "Install downlights", qty: null, unit: "hrs", uncertainty: null },
      ],
    },
  ],
});

const draft = (body: Record<string, unknown> = { sourceText: "Supply and install 24 LED downlights." }, as?: [string, string] | null) =>
  call({ method: "POST", query: { id: SEED_ID, action: "ai-draft" }, body, ...(as !== undefined ? { as } : {}) });

const review = (body: Record<string, unknown>) =>
  call({ method: "POST", query: { id: SEED_ID, action: "ai-draft-review" }, body });

type Suggestion = {
  id: string;
  status: string;
  model: string;
  promptVersion: string;
  runId: string;
  sectionTitle: string;
  line: { kind: string; description: string; qty: number | null; unit: string | null };
  uncertainty: string | null;
  reviewedById: string | null;
  humanCorrection: unknown;
};

function suggestionsOf(doc: Record<string, unknown>): Suggestion[] {
  const ai = doc.aiDraft as { suggestions: Suggestion[] } | undefined;
  return ai ? ai.suggestions : [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_AI_QUOTE_DRAFTS = "1";
  aiConfigured = true;
  aiCompleteMock = vi.fn(async () => ({
    text: MODEL_REPLY,
    usage: { inputTokens: 900, outputTokens: 200 },
    model: "claude-sonnet-4-6",
  }));

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_est", username: "quinn", role: "estimator", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "tradie", assignedJobIds: [] },
        ],
      },
    ],
    [
      "quotes-v2.json",
      {
        quotes: [
          {
            id: SEED_ID,
            name: "Birdwood St rewire",
            status: "draft",
            updatedAt: SEED_UPDATED_AT,
            totalIncGst: 1100,
            lineCount: 1,
          },
        ],
      },
    ],
    [`quotes-v2/${SEED_ID}.json`, seedDoc()],
  ]);

  for (const modulePath of [blobPath, authPath, ffPath, aiSuggestionsPath, quotesV2Path]) {
    delete requireFromHere.cache[modulePath];
  }
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
  handler = requireFromHere(quotesV2Path);
});

afterEach(() => {
  for (const modulePath of [blobPath, authPath, ffPath, aiPath, aiSuggestionsPath, quotesV2Path]) {
    delete requireFromHere.cache[modulePath];
  }
  delete process.env.FLAG_AI_QUOTE_DRAFTS;
  vi.restoreAllMocks();
});

describe("gates", () => {
  it("404 when the ai_quote_drafts flag is dark (default off) — model never called", async () => {
    process.env.FLAG_AI_QUOTE_DRAFTS = "0";
    expect((await draft()).statusCode).toBe(404);
    expect((await review({ suggestionId: "ais_x", decision: "reject" })).statusCode).toBe(404);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("503 honestly when AI is unconfigured — no fake draft, model never called", async () => {
    aiConfigured = false;
    const res = await draft();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("UNCONFIGURED");
    expect(aiCompleteMock).not.toHaveBeenCalled();
    expect(docOf(SEED_ID).aiDraft).toBeUndefined();
  });

  it("403 for a field role (commercial surface), 401 anonymous, 400 without id or sourceText", async () => {
    expect((await draft(undefined, ["u_field", "tradie"])).statusCode).toBe(403);
    expect((await draft(undefined, null)).statusCode).toBe(401);
    expect(
      (await call({ method: "POST", query: { action: "ai-draft" }, body: { sourceText: "x" } })).statusCode
    ).toBe(400);
    expect((await draft({})).statusCode).toBe(400);
    expect((await draft({ sourceText: "   " })).statusCode).toBe(400);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("400 for an unknown POST action; plain POST still creates", async () => {
    expect((await call({ method: "POST", query: { id: SEED_ID, action: "make-it-up" }, body: {} })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { name: "New quote" } })).statusCode).toBe(201);
  });
});

describe("ai-draft — generate", () => {
  it("stores envelope suggestions + run and NEVER touches sections/totals/updatedAt", async () => {
    const before = docOf(SEED_ID);
    const res = await draft();
    expect(res.statusCode).toBe(201);

    const after = docOf(SEED_ID);
    // The money-bearing document is untouched — aiDraft is additive metadata.
    expect(after.sections).toEqual(before.sections);
    expect(after.totals).toEqual(before.totals);
    expect(after.updatedAt).toBe(SEED_UPDATED_AT);

    const ai = after.aiDraft as { runs: Array<Record<string, unknown>>; suggestions: Suggestion[] };
    expect(ai.runs).toHaveLength(1);
    expect(ai.runs[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      promptVersion: "quote-draft-v1",
      createdById: "u_est",
      truncated: false,
      takeoffProvided: false,
      usage: { inputTokens: 900, outputTokens: 200 },
    });

    expect(ai.suggestions).toHaveLength(3);
    for (const s of ai.suggestions) {
      expect(s.status).toBe("suggested");
      expect(s.model).toBe("claude-sonnet-4-6");
      expect(s.promptVersion).toBe("quote-draft-v1");
      expect(s.runId).toBe((ai.runs[0] as { id: string }).id);
      expect(typeof s.id).toBe("string");
    }
    expect(ai.suggestions[0]).toMatchObject({
      sectionTitle: "Switchboard",
      line: { kind: "labour", description: "Terminate submains", qty: null, unit: null },
      uncertainty: "cable size not stated",
    });
    expect(ai.suggestions[1]!.line.qty).toBe(24);

    // The prompt carries the honesty rules + the scope text.
    const promptArgs = aiCompleteMock.mock.calls[0]![0] as {
      system: string;
      messages: Array<{ content: string }>;
    };
    expect(promptArgs.system).toContain("STRICT JSON");
    expect(promptArgs.system).toContain("qty MUST be null unless");
    expect(promptArgs.system).toContain("NEVER propose a rate");
    expect(promptArgs.messages[0]!.content).toContain("Supply and install 24 LED downlights.");
  });

  it("drops invalid model proposals (bad kind / empty description / string qty) instead of fixing them up", async () => {
    aiCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({
        sections: [
          {
            title: "Lighting",
            lines: [
              { kind: "plumbing", description: "Not our trade", qty: null, unit: null, uncertainty: null },
              { kind: "material", description: "  ", qty: null, unit: null, uncertainty: null },
              { kind: "material", description: "LED batten", qty: "6", unit: "ea", uncertainty: null },
              { kind: "material", description: "LED batten", qty: 6, unit: "ea", uncertainty: null },
            ],
          },
        ],
      }),
      usage: null,
      model: "claude-sonnet-4-6",
    });
    const res = await draft();
    expect(res.statusCode).toBe(201);
    const stored = suggestionsOf(docOf(SEED_ID));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.line).toEqual({ kind: "material", description: "LED batten", qty: 6, unit: "ea" });
  });

  it("records truncation for a >12,000-char paste (truncated + usedChars disclosed)", async () => {
    const res = await draft({ sourceText: "x".repeat(13_000) });
    expect(res.statusCode).toBe(201);
    const run = (docOf(SEED_ID).aiDraft as { runs: Array<Record<string, unknown>> }).runs[0]!;
    expect(run.truncated).toBe(true);
    expect(run.usedChars).toBe(12_000);
    expect((run.sourceTextExcerpt as string).length).toBe(300);
    const promptArgs = aiCompleteMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(promptArgs.messages[0]!.content).not.toContain("x".repeat(12_001));
  });

  it("502 on a non-JSON model reply — NOTHING stored", async () => {
    aiCompleteMock.mockResolvedValueOnce({ text: "Sure! Here are some lines you could use…", usage: null, model: "claude-sonnet-4-6" });
    const res = await draft();
    expect(res.statusCode).toBe(502);
    expect(docOf(SEED_ID).aiDraft).toBeUndefined();
  });

  it("502 when the provider fails mid-call; 503 if the key vanished mid-flight", async () => {
    aiCompleteMock.mockRejectedValueOnce(new FakeAiError("PROVIDER_FAILED", "Anthropic request failed: overloaded"));
    expect((await draft()).statusCode).toBe(502);
    aiCompleteMock.mockRejectedValueOnce(new FakeAiError("UNCONFIGURED", "no key"));
    expect((await draft()).statusCode).toBe(503);
    expect(docOf(SEED_ID).aiDraft).toBeUndefined();
  });

  it("takeoff: valid items enter the prompt and the run records takeoffProvided; bad shapes 400 before any model call", async () => {
    const good = await draft({
      sourceText: "Fit-out per drawings.",
      takeoff: { source: "takeoff", items: [{ description: "Twin GPO", qty: 42, unit: "ea", drawingRef: "E-201" }] },
    });
    expect(good.statusCode).toBe(201);
    const promptArgs = aiCompleteMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(promptArgs.messages[0]!.content).toContain("Twin GPO");
    expect(promptArgs.messages[0]!.content).toContain("42");
    const runs = (docOf(SEED_ID).aiDraft as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs[0]!.takeoffProvided).toBe(true);

    aiCompleteMock.mockClear();
    for (const takeoff of [
      { source: "manual", items: [{ description: "GPO", qty: 1, unit: "ea" }] },
      { source: "takeoff", items: [] },
      { source: "takeoff", items: [{ description: "GPO", qty: "1", unit: "ea" }] },
    ]) {
      expect((await draft({ sourceText: "scope", takeoff })).statusCode).toBe(400);
    }
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("re-run supersedes only still-'suggested' rows — accepted/rejected history is never rewritten", async () => {
    await draft();
    const first = suggestionsOf(docOf(SEED_ID));
    expect(first).toHaveLength(3);

    expect((await review({ suggestionId: first[0]!.id, decision: "accept" })).statusCode).toBe(200);
    expect((await review({ suggestionId: first[1]!.id, decision: "reject" })).statusCode).toBe(200);

    const res = await draft();
    expect(res.statusCode).toBe(201);
    const after = docOf(SEED_ID);
    const byId = new Map(suggestionsOf(after).map((s) => [s.id, s]));
    expect(byId.get(first[0]!.id)!.status).toBe("accepted");
    expect(byId.get(first[1]!.id)!.status).toBe("rejected");
    expect(byId.get(first[2]!.id)!.status).toBe("superseded");
    // New suggestions appended; runs accumulate.
    expect(suggestionsOf(after)).toHaveLength(6);
    expect((after.aiDraft as { runs: unknown[] }).runs).toHaveLength(2);
  });
});

describe("ai-draft-review — accept / edit / reject", () => {
  /** Runs a draft and returns the stored suggestions. */
  async function seedSuggestions(): Promise<Suggestion[]> {
    const res = await draft();
    expect(res.statusCode).toBe(201);
    return suggestionsOf(docOf(SEED_ID));
  }

  it("accept writes exactly ONE rate-0 line into the matching section and flips the suggestion", async () => {
    const [switchboard] = await seedSuggestions();
    const res = await review({ suggestionId: switchboard!.id, decision: "accept" });
    expect(res.statusCode).toBe(200);

    const doc = docOf(SEED_ID);
    const sections = doc.sections as Array<{ id: string; title: string; lines: Array<Record<string, unknown>> }>;
    expect(sections).toHaveLength(1); // existing "Switchboard" reused, no new section
    expect(sections[0]!.lines).toHaveLength(2);
    const line = sections[0]!.lines[1]!;
    expect(line).toMatchObject({
      kind: "labour",
      description: "Terminate submains",
      qty: 0, // qty was null — the honest 0, never an invented count
      unit: "",
      rate: 0, // NEVER an invented price
      source: "ai_suggested",
      aiSuggestionId: switchboard!.id,
      needsPricing: true,
    });

    // Same atomic write: status flipped + reviewer recorded + totals recomputed.
    const stored = suggestionsOf(doc).find((s) => s.id === switchboard!.id)!;
    expect(stored.status).toBe("accepted");
    expect(stored.reviewedById).toBe("u_est");
    expect(doc.totals).toEqual({ subtotalExGst: 1000, gst: 100, totalIncGst: 1100, lineCount: 2 });
    expect(doc.updatedAt).not.toBe(SEED_UPDATED_AT);

    // Registry row follows the lineCount.
    const registry = blob.get("quotes-v2.json") as { quotes: Array<{ id: string; lineCount: number }> };
    expect(registry.quotes.find((q) => q.id === SEED_ID)!.lineCount).toBe(2);
  });

  it("accept creates the proposed section when no title matches", async () => {
    const all = await seedSuggestions();
    const lighting = all.find((s) => s.sectionTitle === "Lighting" && s.line.qty === 24)!;
    const res = await review({ suggestionId: lighting.id, decision: "accept" });
    expect(res.statusCode).toBe(200);

    const sections = docOf(SEED_ID).sections as Array<{ title: string; sortOrder: number; lines: Array<Record<string, unknown>> }>;
    expect(sections).toHaveLength(2);
    expect(sections[1]!.title).toBe("Lighting");
    expect(sections[1]!.sortOrder).toBe(1);
    expect(sections[1]!.lines).toHaveLength(1);
    expect(sections[1]!.lines[0]).toMatchObject({ qty: 24, unit: "ea", rate: 0, needsPricing: true });
  });

  it("edit replaces the proposed content, records the humanCorrection and lands the edited line", async () => {
    const [switchboard] = await seedSuggestions();
    const editedLine = { kind: "labour", description: "Terminate and test submains", qty: 4, unit: "hrs" };
    const res = await review({
      suggestionId: switchboard!.id,
      decision: "edit",
      editedLine,
      reviewNote: "added testing",
    });
    expect(res.statusCode).toBe(200);

    const doc = docOf(SEED_ID);
    const stored = suggestionsOf(doc).find((s) => s.id === switchboard!.id)!;
    expect(stored.status).toBe("edited");
    expect(stored.humanCorrection).toEqual({ line: editedLine });
    const line = (doc.sections as Array<{ lines: Array<Record<string, unknown>> }>)[0]!.lines[1]!;
    expect(line).toMatchObject({ description: "Terminate and test submains", qty: 4, unit: "hrs", rate: 0 });
    // The original AI proposal survives untouched on the suggestion (trail shows both).
    expect(stored.line.description).toBe("Terminate submains");
  });

  it("400s an invalid editedLine (kind off-whitelist) without writing anything", async () => {
    const [switchboard] = await seedSuggestions();
    const res = await review({
      suggestionId: switchboard!.id,
      decision: "edit",
      editedLine: { kind: "plumbing", description: "Nope", qty: null, unit: null },
    });
    expect(res.statusCode).toBe(400);
    const doc = docOf(SEED_ID);
    expect((doc.sections as Array<{ lines: unknown[] }>)[0]!.lines).toHaveLength(1);
    expect(suggestionsOf(doc).find((s) => s.id === switchboard!.id)!.status).toBe("suggested");
  });

  it("reject keeps the record (auditable) and touches neither sections nor updatedAt", async () => {
    const [switchboard] = await seedSuggestions();
    const res = await review({ suggestionId: switchboard!.id, decision: "reject", reviewNote: "already boarded" });
    expect(res.statusCode).toBe(200);

    const doc = docOf(SEED_ID);
    const stored = suggestionsOf(doc).find((s) => s.id === switchboard!.id)!;
    expect(stored.status).toBe("rejected");
    expect(stored.reviewedById).toBe("u_est");
    expect((doc.sections as Array<{ lines: unknown[] }>)[0]!.lines).toHaveLength(1);
    expect(doc.updatedAt).toBe(SEED_UPDATED_AT);
  });

  it("a second decision on the same suggestion 400s — re-accepting can never duplicate lines", async () => {
    const [switchboard] = await seedSuggestions();
    expect((await review({ suggestionId: switchboard!.id, decision: "accept" })).statusCode).toBe(200);

    for (const decision of ["accept", "reject", "edit"]) {
      const res = await review({
        suggestionId: switchboard!.id,
        decision,
        ...(decision === "edit"
          ? { editedLine: { kind: "labour", description: "Again", qty: null, unit: null } }
          : {}),
      });
      expect(res.statusCode).toBe(400);
    }
    const sections = docOf(SEED_ID).sections as Array<{ lines: unknown[] }>;
    expect(sections[0]!.lines).toHaveLength(2); // still exactly one accepted line
  });

  it("400 unknown decision / missing suggestionId; 404 unknown suggestion or quote", async () => {
    await seedSuggestions();
    expect((await review({ suggestionId: "ais_x", decision: "shred" })).statusCode).toBe(400);
    expect((await review({ decision: "accept" })).statusCode).toBe(400);
    expect((await review({ suggestionId: "ais_missing", decision: "accept" })).statusCode).toBe(404);
    expect(
      (await call({ method: "POST", query: { id: "qv2_nope", action: "ai-draft-review" }, body: { suggestionId: "x", decision: "accept" } })).statusCode
    ).toBe(404);
  });

  it("an ordinary PUT save preserves aiDraft and round-trips the AI line flags", async () => {
    const [switchboard] = await seedSuggestions();
    await review({ suggestionId: switchboard!.id, decision: "accept" });
    const doc = docOf(SEED_ID);
    const sections = doc.sections as Array<{ id: string; title: string; lines: Array<Record<string, unknown>> }>;

    const res = await call({
      method: "PUT",
      query: { id: SEED_ID },
      body: {
        name: "Birdwood St rewire",
        sections: sections.map((s) => ({ id: s.id, title: s.title, lines: s.lines })),
        updatedAt: doc.updatedAt,
      },
    });
    expect(res.statusCode).toBe(200);

    const saved = docOf(SEED_ID);
    // The AI trail survived a full-document save…
    expect(suggestionsOf(saved).find((s) => s.id === switchboard!.id)!.status).toBe("accepted");
    // …and so did the provenance flags on the accepted line.
    const line = (saved.sections as Array<{ lines: Array<Record<string, unknown>> }>)[0]!.lines[1]!;
    expect(line).toMatchObject({ source: "ai_suggested", aiSuggestionId: switchboard!.id, needsPricing: true, rate: 0 });
  });
});
