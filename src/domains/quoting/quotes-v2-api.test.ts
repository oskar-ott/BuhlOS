import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: quotes are dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_QUOTES = "1";
});
afterAll(() => {
  delete process.env.FLAG_QUOTES;
});

/**
 * Harness coverage for api/quotes-v2.js (#183) — the v2 quote builder
 * foundation endpoint, exercised through the real handler with blob storage
 * mocked to a Map (house pattern: quotes-duplicate-api.test.ts).
 *
 * What this suite pins:
 *   - tier-aware auth: an `estimator` (admin TIER, not literal 'admin') is
 *     accepted; field roles 403; no session 401 (the #123/#156 bug class)
 *   - CRUD round-trip: create → list → get → save → archive
 *   - server validation mirrors src/domains/quoting/schema.ts (caps + shapes)
 *   - the 409 stale-save contract (updatedAt echo + the guard-race mapping)
 *   - DELETE is an archive status FLIP, never destructive
 *   - registry row and document stay consistent after every write
 *   - GOLDEN totals mirror: the CJS computeQuoteTotals must produce the same
 *     numbers as src/domains/quoting/totals.ts. The fixture below is
 *     DUPLICATED BY VALUE from totals.test.ts on purpose (the CJS server
 *     cannot import the TS module) — if a number changes here, change it
 *     there in the same commit.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const quotesV2Path = requireFromHere.resolve("../../../api/quotes-v2.js");

type Res = ReturnType<typeof createRes>;
type Handler = ((req: Record<string, unknown>, res: Res) => Promise<unknown>) & {
  computeQuoteTotals: (
    sections: Array<{ lines: Array<{ qty: number; rate: number }> }>
  ) => Record<string, number>;
  QUOTE_LIMITS: Record<string, number>;
};

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
/** When set, the NEXT writeBlob to this key throws the given error once. */
let failNextWrite: { key: string; error: Error } | null;

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
    send(body: unknown) {
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

interface CallOpts {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  as?: [string, string] | null;
}

async function call({ method, query = {}, body = {}, as = ["u_est", "estimator"] }: CallOpts) {
  const res = createRes();
  await handler(
    {
      method,
      body,
      query,
      headers: as ? { cookie: cookieFor(as[0], as[1]) } : {},
    },
    res
  );
  return res;
}

// ── GOLDEN totals fixture — duplicated by value from totals.test.ts ──────
const GOLDEN_LINES_A = [
  { kind: "material", description: "Twin GPO", qty: 3, unit: "ea", rate: 99.95 }, // 299.85
  { kind: "labour", description: "Rough-in", qty: 0.5, unit: "hrs", rate: 150 }, // 75.00
];
const GOLDEN_LINES_B = [
  { kind: "other", description: "Cable ties", qty: 10, unit: "ea", rate: 0.333 }, // 3.33 — rounded AT THE LINE
];
const GOLDEN = { subtotalExGst: 378.18, gst: 37.82, totalIncGst: 416.0, lineCount: 3 };

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

function registryOf(): { quotes: Array<Record<string, unknown>> } {
  return blob.get("quotes-v2.json") as { quotes: Array<Record<string, unknown>> };
}
function docOf(id: string): Record<string, unknown> {
  return blob.get(`quotes-v2/${id}.json`) as Record<string, unknown>;
}

function saveBody(over: Record<string, unknown> = {}) {
  return {
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    sections: [
      {
        id: "qsec_a",
        title: "Switchboard",
        lines: [
          { id: "qline_a", kind: "material", description: "DB upgrade", qty: 1, unit: "ea", rate: 1000 },
        ],
      },
    ],
    updatedAt: SEED_UPDATED_AT,
    ...over,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  failNextWrite = null;
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_est", username: "quinn", role: "estimator", assignedJobIds: [] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "tradie", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadinghand", assignedJobIds: [] },
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
          {
            id: "qv2_old",
            name: "Archived shed",
            status: "archived",
            updatedAt: "2026-05-01T00:00:00.000Z",
            totalIncGst: 0,
            lineCount: 0,
          },
        ],
      },
    ],
    [`quotes-v2/${SEED_ID}.json`, seedDoc()],
    [
      "quotes-v2/qv2_old.json",
      {
        id: "qv2_old",
        name: "Archived shed",
        clientName: null,
        status: "archived",
        createdAt: "2026-05-01T00:00:00.000Z",
        createdBy: "estimator",
        updatedAt: "2026-05-01T00:00:00.000Z",
        sections: [],
        totals: { subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 },
      },
    ],
  ]);

  for (const modulePath of [blobPath, authPath, quotesV2Path]) {
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
        if (failNextWrite && failNextWrite.key === key) {
          const err = failNextWrite.error;
          failNextWrite = null;
          throw err;
        }
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(quotesV2Path);
});

describe("auth — tier-aware admin gate (never literal 'admin')", () => {
  it("accepts an estimator (admin tier) across the CRUD surface", async () => {
    expect((await call({ method: "GET" })).statusCode).toBe(200);
    expect((await call({ method: "POST", body: { name: "New quote" } })).statusCode).toBe(201);
  });

  it("accepts a boss (admin tier)", async () => {
    const res = await call({ method: "GET", as: ["u_boss", "boss"] });
    expect(res.statusCode).toBe(200);
  });

  it("403s field and leading-hand roles (quoting is commercial)", async () => {
    for (const as of [
      ["u_field", "tradie"],
      ["u_lh", "leadinghand"],
    ] as Array<[string, string]>) {
      expect((await call({ method: "GET", as })).statusCode).toBe(403);
      expect((await call({ method: "POST", body: { name: "x" }, as })).statusCode).toBe(403);
    }
  });

  it("401s without a session", async () => {
    expect((await call({ method: "GET", as: null })).statusCode).toBe(401);
  });
});

describe("GET — list and single document", () => {
  it("lists summary rows newest-first and hides archived by default", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(200);
    const rows = (res.body as { quotes: Array<Record<string, unknown>> }).quotes;
    expect(rows.map((r) => r.id)).toEqual([SEED_ID]);
    expect(rows[0]).toMatchObject({
      name: "Birdwood St rewire",
      status: "draft",
      totalIncGst: 1100,
      lineCount: 1,
    });
  });

  it("includes archived rows with ?includeArchived=1", async () => {
    const res = await call({ method: "GET", query: { includeArchived: "1" } });
    const rows = (res.body as { quotes: Array<{ id: string }> }).quotes;
    expect(rows.map((r) => r.id)).toEqual([SEED_ID, "qv2_old"]);
  });

  it("returns the full document for ?id and 404s an unknown id", async () => {
    const res = await call({ method: "GET", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(200);
    const quote = (res.body as { quote: Record<string, unknown> }).quote;
    expect(quote.id).toBe(SEED_ID);
    expect((quote.sections as unknown[]).length).toBe(1);
    expect("__rev" in quote).toBe(false); // storage stamps never reach the wire

    expect((await call({ method: "GET", query: { id: "qv2_nope" } })).statusCode).toBe(404);
  });
});

describe("POST — create", () => {
  it("creates an empty draft, writes the document AND the registry row", async () => {
    const res = await call({ method: "POST", body: { name: "  Shed fitout  ", clientName: "P. Sherman" } });
    expect(res.statusCode).toBe(201);
    const quote = (res.body as { quote: Record<string, unknown> }).quote;
    expect(quote.name).toBe("Shed fitout"); // trimmed
    expect(quote.status).toBe("draft");
    expect(quote.createdBy).toBe("quinn");
    expect(quote.sections).toEqual([]);
    expect(quote.totals).toEqual({ subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 });

    expect(docOf(quote.id as string)).toMatchObject({ name: "Shed fitout" });
    const row = registryOf().quotes.find((q) => q.id === quote.id);
    expect(row).toMatchObject({ name: "Shed fitout", status: "draft", totalIncGst: 0, lineCount: 0 });
  });

  it("rejects a missing/blank/over-cap name", async () => {
    expect((await call({ method: "POST", body: {} })).statusCode).toBe(400);
    expect((await call({ method: "POST", body: { name: "   " } })).statusCode).toBe(400);
    expect(
      (await call({ method: "POST", body: { name: "x".repeat(121) } })).statusCode
    ).toBe(400);
  });
});

describe("PUT — full-document save", () => {
  it("saves sections, recomputes totals server-side, keeps registry and doc consistent", async () => {
    const res = await call({
      method: "PUT",
      query: { id: SEED_ID },
      body: saveBody({
        name: "Birdwood St rewire — rev",
        sections: [
          { id: "qsec_a", title: "Power", lines: GOLDEN_LINES_A.map((l) => ({ ...l })) },
          { title: "Sundries", lines: GOLDEN_LINES_B.map((l) => ({ ...l })) },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    const quote = (res.body as { quote: Record<string, unknown> }).quote as {
      sections: Array<{ id: string; sortOrder: number; lines: Array<{ id: string }> }>;
      totals: Record<string, number>;
      updatedAt: string;
    };

    // GOLDEN mirror — the CJS math must equal totals.ts exactly.
    expect(quote.totals).toEqual(GOLDEN);

    // Existing ids round-trip; new entries get server-minted ids; order is
    // the array order with sortOrder rewritten.
    expect(quote.sections[0]!.id).toBe("qsec_a");
    expect(quote.sections[1]!.id).toMatch(/^qsec_/);
    expect(quote.sections.map((s) => s.sortOrder)).toEqual([0, 1]);
    expect(quote.sections[0]!.lines[0]!.id).toMatch(/^qline_/);
    expect(quote.updatedAt).not.toBe(SEED_UPDATED_AT);

    // Registry row reflects the saved document — list and builder agree.
    const row = registryOf().quotes.find((q) => q.id === SEED_ID)!;
    expect(row).toMatchObject({
      name: "Birdwood St rewire — rev",
      status: "draft",
      updatedAt: quote.updatedAt,
      totalIncGst: GOLDEN.totalIncGst,
      lineCount: GOLDEN.lineCount,
    });
    expect(docOf(SEED_ID).updatedAt).toBe(quote.updatedAt);
  });

  it("the exported computeQuoteTotals matches the golden fixture directly", () => {
    expect(
      handler.computeQuoteTotals([
        { lines: [{ qty: 3, rate: 99.95 }, { qty: 0.5, rate: 150 }] },
        { lines: [{ qty: 10, rate: 0.333 }] },
      ])
    ).toEqual(GOLDEN);
    // Round at the line THEN sum — three half-cents make 0.03, not 0.02.
    expect(
      handler.computeQuoteTotals([
        { lines: [{ qty: 1, rate: 0.005 }, { qty: 1, rate: 0.005 }, { qty: 1, rate: 0.005 }] },
      ]).subtotalExGst
    ).toBe(0.03);
  });

  it("409s a stale save (updatedAt echo mismatch) and returns the CURRENT server doc", async () => {
    const res = await call({
      method: "PUT",
      query: { id: SEED_ID },
      body: saveBody({ updatedAt: "2026-06-11T09:00:00.000Z", name: "Loser tab edit" }),
    });
    expect(res.statusCode).toBe(409);
    const body = res.body as { error: string; quote: Record<string, unknown> };
    expect(body.error).toContain("changed since you loaded it");
    expect(body.quote.name).toBe("Birdwood St rewire"); // server copy rides along
    // Nothing moved.
    expect(docOf(SEED_ID).name).toBe("Birdwood St rewire");
    expect(registryOf().quotes.find((q) => q.id === SEED_ID)!.name).toBe("Birdwood St rewire");
  });

  it("maps a guard-level stale_write race to the same 409 contract", async () => {
    const err = Object.assign(new Error("stale write"), { code: "stale_write" });
    failNextWrite = { key: `quotes-v2/${SEED_ID}.json`, error: err };
    const res = await call({ method: "PUT", query: { id: SEED_ID }, body: saveBody() });
    expect(res.statusCode).toBe(409);
    expect((res.body as { quote: { id: string } }).quote.id).toBe(SEED_ID);
  });

  it("rejects payloads violating the schema mirror (caps, kinds, numbers, precondition)", async () => {
    const put = async (body: Record<string, unknown>) =>
      (await call({ method: "PUT", query: { id: SEED_ID }, body })).statusCode;

    expect(await put(saveBody({ name: "" }))).toBe(400);
    expect(await put(saveBody({ updatedAt: undefined }))).toBe(400);
    expect(await put(saveBody({ status: "estimating" }))).toBe(400); // unknown status
    expect(
      await put(
        saveBody({
          sections: Array.from({ length: 51 }, (_, i) => ({ title: `S${i}`, lines: [] })),
        })
      )
    ).toBe(400);
    expect(
      await put(
        saveBody({
          sections: [
            {
              title: "S",
              lines: Array.from({ length: 201 }, () => ({
                kind: "other",
                description: "",
                qty: 1,
                unit: "",
                rate: 0,
              })),
            },
          ],
        })
      )
    ).toBe(400);
    expect(
      await put(saveBody({ sections: [{ title: "x".repeat(81), lines: [] }] }))
    ).toBe(400);
    expect(
      await put(
        saveBody({
          sections: [
            { title: "S", lines: [{ kind: "material", description: "", qty: Number.NaN, unit: "", rate: 1 }] },
          ],
        })
      )
    ).toBe(400);
    expect(
      await put(
        saveBody({
          sections: [
            { title: "S", lines: [{ kind: "voodoo", description: "", qty: 1, unit: "", rate: 1 }] },
          ],
        })
      )
    ).toBe(400);
    // None of the rejects touched storage.
    expect(docOf(SEED_ID).updatedAt).toBe(SEED_UPDATED_AT);
  });

  it("404s an unknown quote and 400s a missing id", async () => {
    expect(
      (await call({ method: "PUT", query: { id: "qv2_nope" }, body: saveBody() })).statusCode
    ).toBe(404);
    expect((await call({ method: "PUT", body: saveBody() })).statusCode).toBe(400);
  });
});

describe("DELETE — archive flip, never destructive", () => {
  it("flips status to archived in BOTH stores and keeps the document", async () => {
    const res = await call({ method: "DELETE", query: { id: SEED_ID } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { quote: { status: string } }).quote.status).toBe("archived");

    // Document still exists — sections intact, only status/updatedAt moved.
    const doc = docOf(SEED_ID);
    expect(doc.status).toBe("archived");
    expect((doc.sections as unknown[]).length).toBe(1);
    // Registry row flipped, not removed.
    const row = registryOf().quotes.find((q) => q.id === SEED_ID)!;
    expect(row.status).toBe("archived");
    // Default list now hides it.
    const list = await call({ method: "GET" });
    expect((list.body as { quotes: unknown[] }).quotes).toEqual([]);
  });

  it("is idempotent on an already-archived quote", async () => {
    await call({ method: "DELETE", query: { id: SEED_ID } });
    const again = await call({ method: "DELETE", query: { id: SEED_ID } });
    expect(again.statusCode).toBe(200);
    expect((again.body as { quote: { status: string } }).quote.status).toBe("archived");
  });

  it("404s an unknown id and 400s a missing id", async () => {
    expect((await call({ method: "DELETE", query: { id: "qv2_nope" } })).statusCode).toBe(404);
    expect((await call({ method: "DELETE" })).statusCode).toBe(400);
  });
});

describe("router", () => {
  it("405s unsupported methods", async () => {
    expect((await call({ method: "PATCH", query: { id: SEED_ID } })).statusCode).toBe(405);
  });
});
