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
 * api/quotes-v2.js — #214/#193 INTERNAL cost-field persistence.
 *
 * validateSave rebuilds each line from a known allowlist (passthrough does NOT
 * survive a save), so the cost fields must be explicitly persisted. Pins:
 *   - material unitCost + category and labour preset stamps round-trip on save;
 *   - sell-side totals are UNCHANGED (cost never affects subtotal/GST);
 *   - an absent unitCost is omitted (the line stays uncosted, not $0);
 *   - an invalid / out-of-range unitCost is a hard 400 (never silent).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const quotesV2Path = requireFromHere.resolve("../../../api/quotes-v2.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;

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

async function save(body: unknown): Promise<Res> {
  const res = createRes();
  await handler(
    { method: "PUT", query: { id: SEED_ID }, body, headers: { cookie: cookieFor("u_est", "estimator") } },
    res
  );
  return res;
}

const SEED_ID = "qv2_seed";
const SEED_UPDATED_AT = "2026-06-12T01:00:00.000Z";

type Line = { sections: Array<{ lines: Array<Record<string, unknown>> }> };
const savedLines = (res: Res): Array<Record<string, unknown>> =>
  ((res.body as { quote: Line }).quote.sections[0]!.lines);
const savedTotals = (res: Res): Record<string, number> =>
  (res.body as { quote: { totals: Record<string, number> } }).quote.totals;

function saveBody(lines: Array<Record<string, unknown>>) {
  return {
    name: "Birdwood St rewire",
    sections: [{ id: "qsec_a", title: "Switchboard", lines }],
    updatedAt: SEED_UPDATED_AT,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    ["users.json", { users: [{ id: "u_est", username: "quinn", role: "estimator", assignedJobIds: [] }] }],
    ["quotes-v2.json", { quotes: [{ id: SEED_ID, name: "Birdwood St rewire", status: "draft", updatedAt: SEED_UPDATED_AT, totalIncGst: 0, lineCount: 0 }] }],
    [
      `quotes-v2/${SEED_ID}.json`,
      {
        id: SEED_ID,
        name: "Birdwood St rewire",
        clientName: null,
        status: "draft",
        createdAt: "2026-06-12T00:00:00.000Z",
        createdBy: "estimator",
        updatedAt: SEED_UPDATED_AT,
        sections: [],
        totals: { subtotalExGst: 0, gst: 0, totalIncGst: 0, lineCount: 0 },
        __rev: 1,
      },
    ],
  ]);

  for (const p of [blobPath, authPath, quotesV2Path]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(quotesV2Path);
});

describe("quotes-v2 — internal cost field persistence (#214/#193)", () => {
  it("round-trips material unitCost + category and labour preset stamps", async () => {
    const res = await save(
      saveBody([
        { id: "l_mat", kind: "material", description: "Cable", qty: 2, unit: "m", rate: 100, unitCost: 60, category: "Cable" },
        {
          id: "l_lab",
          kind: "labour",
          description: "Install",
          qty: 5,
          unit: "hr",
          rate: 95,
          unitCost: 55,
          ratePresetId: "qrp_x",
          ratePresetName: "Electrician",
        },
      ])
    );
    expect(res.statusCode).toBe(200);
    const [mat, lab] = savedLines(res);
    expect(mat).toMatchObject({ unitCost: 60, category: "Cable" });
    expect(lab).toMatchObject({ unitCost: 55, ratePresetId: "qrp_x", ratePresetName: "Electrician" });
  });

  it("keeps totals SELL-SIDE — cost never affects subtotal/GST", async () => {
    const res = await save(
      saveBody([
        { id: "l_mat", kind: "material", description: "Cable", qty: 2, unit: "m", rate: 100, unitCost: 60 },
        { id: "l_lab", kind: "labour", description: "Install", qty: 5, unit: "hr", rate: 95, unitCost: 55 },
      ])
    );
    // 2×100 + 5×95 = 675 sell — unitCost (60/55) is irrelevant to the client totals.
    expect(savedTotals(res)).toMatchObject({ subtotalExGst: 675, gst: 67.5, totalIncGst: 742.5, lineCount: 2 });
  });

  it("omits unitCost when absent — the line stays uncosted (not $0)", async () => {
    const res = await save(saveBody([{ id: "l1", kind: "other", description: "Misc", qty: 1, unit: "ea", rate: 10 }]));
    expect(res.statusCode).toBe(200);
    expect("unitCost" in savedLines(res)[0]!).toBe(false);
  });

  it("rejects a non-finite or out-of-range unitCost with a hard 400", async () => {
    const bad = await save(saveBody([{ id: "l1", kind: "material", description: "x", qty: 1, unit: "ea", rate: 10, unitCost: "nope" }]));
    expect(bad.statusCode).toBe(400);
    const huge = await save(saveBody([{ id: "l1", kind: "material", description: "x", qty: 1, unit: "ea", rate: 10, unitCost: 9_999_999 }]));
    expect(huge.statusCode).toBe(400);
  });
});
