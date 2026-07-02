import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeOfWorkItem } from "@/domains/jobs/types";
import { boqLineRefKey } from "@/domains/job-control/spine";

/**
 * #366 AC6 — the 100 Arthur St fixture walk to GREEN, end to end through the
 * REAL pipeline (no hand-built quote, no synthetic link):
 *
 *   1. The COMMITTED workbook fixture (job-doc-import/fixtures/100-arthur-boq.xlsx)
 *      is attached through the real api/job-doc-import.js handler (#365): parse,
 *      health-check findings, base-line materialisation into a real quotes-v2
 *      document.
 *   2. create-job with that quoteId writes the LIVE job↔quote link
 *      (job.fromQuoteId ↔ quote.linkedJobId) — the gate that kept the quote half
 *      of #366 dark until #828.
 *   3. The office authors the 100-Arthur-shaped scope clauses (#200) on the job.
 *   4. The REAL reconciliation producer (blobReconciliationDeps → loadScope
 *      follows fromQuoteId → QuoteSchema) seeds one BOQ classification per
 *      imported line and NAMES every unattributed line.
 *   5. The office classifies every clause (linking the priced clauses to the
 *      imported lines by ref) and accepts the one engine-named red conflict with
 *      a reason — and the persisted reconciliation rolls up GREEN.
 *
 * Both storage layers (the JS api/_lib/blob.js the import handler uses, and the
 * TS @vercel/blob helper the producer uses) are backed by ONE in-memory store,
 * so what the import writes is exactly what the reconciliation reads.
 */

// ── One store, two mocked layers ─────────────────────────────────────────────

const store = new Map<string, unknown>();

vi.mock("@vercel/blob", () => ({
  list: async ({ prefix }: { prefix: string }) => ({
    blobs: [...store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ pathname: k, url: `https://blob.test/${k}` })),
  }),
  put: async (key: string, body: string) => {
    store.set(key, JSON.parse(body));
    return {};
  },
}));

import {
  blobReconciliationDeps,
  runReconciliationConfirm,
  runReconciliationPreview,
  scopeReconciliationKey,
  type PersistedScopeReconciliation,
} from "./reconciliation-producer";

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const ffPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");
const quotesV2Path = requireFromHere.resolve("../../../api/quotes-v2.js");
const handlerPath = requireFromHere.resolve("../../../api/job-doc-import.js");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FIXTURE = readFileSync(
  join(__dirname, "../../domains/job-doc-import/fixtures", "100-arthur-boq.xlsx"),
);
const FIXTURE_DATA_URL = `data:${XLSX_MIME};base64,${FIXTURE.toString("base64")}`;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
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

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

async function call(opts: { method: string; body?: unknown; query?: Record<string, string> }) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: {
      cookie: `buhl_session=${auth.signSession({ userId: "u_boss", role: "boss", exp: Date.now() + 60_000 })}`,
    },
  };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_JOB_DOC_IMPORT = "1";
  store.clear();
  store.set("users.json", {
    users: [{ id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] }],
  });
  store.set("jobs.json", { jobs: [] });

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[ffPath];
  delete requireFromHere.cache[quotesV2Path];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);

  // The TS blob helper fetches a listed blob's URL — serve it from the store.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url).replace("https://blob.test/", "");
      const value = store.get(key);
      return { ok: value !== undefined, json: async () => clone(value) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLAG_JOB_DOC_IMPORT;
});

// ── The 100-Arthur-shaped scope (#200 authoring) ─────────────────────────────

const ARTHUR_SCOPE: ScopeOfWorkItem[] = [
  { id: "sw_zip", title: "Dedicated 20A ZIP circuit, East Gym", detail: "New circuit + isolator", order: 0 },
  { id: "sw_fitout", title: "Electrical fit-out per BOQ", detail: "East Gym + Upper Ground", order: 1 },
  { id: "sw_av", title: "A/V hardware, Reception", detail: "supplied by others", order: 2 },
  { id: "sw_sensors", title: "Upper Ground sensors", detail: "reuse existing", order: 3 },
  { id: "sw_disposal", title: "Strip-out & disposal, East Gym", detail: "make safe first", order: 4 },
  { id: "sw_asbuilt", title: "CAD as-built drawings", detail: "closeout paperwork", order: 5 },
];

const AT = "2026-07-03T10:00:00.000Z";

describe("100 Arthur St fixture walk — imported quote → linked job → reconciliation → GREEN", () => {
  it("walks the committed workbook through import, link, forced classification and resolution to green", async () => {
    // 1. Attach the workbook to a NEW quote through the real #365 handler.
    const attach = await call({
      method: "POST",
      query: { action: "attach-to-quote" },
      body: {
        fileName: "100-arthur.xlsx",
        mimeType: XLSX_MIME,
        dataUrl: FIXTURE_DATA_URL,
        quoteName: "100 Arthur St",
      },
    });
    expect(attach.statusCode).toBe(200);
    const { quoteId } = attach.body as { quoteId: string };
    expect(quoteId).toBeTruthy();

    // 2. create-job with the quoteId — the LIVE job↔quote link (#828).
    const create = await call({
      method: "POST",
      query: { action: "create-job" },
      body: {
        fileName: "100-arthur.xlsx",
        mimeType: XLSX_MIME,
        dataUrl: FIXTURE_DATA_URL,
        name: "100 Arthur St fit-out",
        quoteId,
      },
    });
    expect(create.statusCode).toBe(201);
    const { jobId } = create.body as { jobId: string };
    const jobs = store.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
    const job = jobs.jobs.find((j) => j.id === jobId)!;
    expect(job.fromQuoteId).toBe(quoteId);
    const quoteDoc = store.get(`quotes-v2/${quoteId}.json`) as {
      linkedJobId?: string;
      sections: Array<{ id: string; lines: Array<{ id: string; description: string }> }>;
    };
    expect(quoteDoc.linkedJobId).toBe(jobId);

    // 3. The office authors the 100-Arthur scope clauses on the job (#200).
    job.scopeOfWork = ARTHUR_SCOPE;
    store.set("jobs.json", jobs);

    // 4. The REAL producer reads the link end to end: one BOQ classification per
    //    materialised line, every line NAMED as unattributed (no silent gaps).
    const deps = blobReconciliationDeps();
    const preview = await runReconciliationPreview(deps, { jobId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.reconciliation.quoteId).toBe(quoteId);
    const importedLines = quoteDoc.sections.flatMap((s) =>
      s.lines.map((l) => ({ ref: { quoteId, sectionId: s.id, lineId: l.id }, description: l.description })),
    );
    expect(importedLines.length).toBeGreaterThan(0); // base lines materialised by the import
    expect(preview.reconciliation.boqClassifications).toHaveLength(importedLines.length);
    for (const line of importedLines) {
      expect(
        preview.warnings.some((w) => w.key === `priced_line_no_clause:${boqLineRefKey(line.ref)}`),
      ).toBe(true);
    }
    expect(preview.status).toBe("amber"); // named gaps, honestly not green

    // 5. Forced classification of EVERY clause; the priced clauses take the
    //    imported lines by ref (ZIP line → the ZIP clause, the rest → fit-out).
    const zipLines = importedLines.filter((l) => /ZIP circuit/i.test(l.description));
    const otherLines = importedLines.filter((l) => !/ZIP circuit/i.test(l.description));
    expect(zipLines.length).toBeGreaterThan(0);
    const confirm1 = await runReconciliationConfirm(deps, {
      jobId,
      classifications: {
        sw_zip: { classification: "priced", boqLineRefs: zipLines.map((l) => l.ref) },
        sw_fitout: { classification: "priced", boqLineRefs: otherLines.map((l) => l.ref) },
        sw_av: { classification: "by_others", warningText: "Cabling only — the AV mob supply the hardware" },
        sw_sensors: { classification: "reuse_existing", warningText: "Test the existing sensors, don't replace" },
        sw_disposal: { classification: "excluded", note: "Excluded on price but must still make safe" },
        sw_asbuilt: "admin_only",
      },
      confirmedBy: "boss",
      at: AT,
    });
    expect(confirm1.ok).toBe(true);
    if (!confirm1.ok) return;
    expect(confirm1.unknownBoqLineKeys).toEqual([]); // every stored link is a real imported line

    // Every line is now clause-owned; ONE engine-named red conflict remains —
    // the excluded-but-obligated disposal clause.
    const mid = store.get(scopeReconciliationKey(jobId)) as PersistedScopeReconciliation;
    expect(mid.status).toBe("red");
    expect(mid.warnings).toHaveLength(1);
    expect(mid.warnings[0]!.key).toBe("excluded_with_obligation:sw_disposal");
    expect(
      mid.reconciliation.boqClassifications.every((b) => b.owningClauseId !== null),
    ).toBe(true);

    // 6. Resolve-or-accept-with-reason on the named conflict → GREEN.
    const confirm2 = await runReconciliationConfirm(deps, {
      jobId,
      resolutions: [
        {
          findingKey: "excluded_with_obligation:sw_disposal",
          action: "accepted",
          reason: "Builder holds the make-safe obligation in writing — ours is disposal only",
        },
      ],
      confirmedBy: "boss",
      at: "2026-07-03T10:05:00.000Z",
    });
    expect(confirm2.ok).toBe(true);
    if (!confirm2.ok) return;
    expect(confirm2.saved.status).toBe("green");

    const final = store.get(scopeReconciliationKey(jobId)) as PersistedScopeReconciliation;
    expect(final.status).toBe("green");
    expect(final.warnings).toEqual([]);
    // The accepted decision is recorded with who/when/why (AC2/AC5)…
    expect(final.reconciliation.resolutions).toHaveLength(1);
    expect(final.reconciliation.resolutions[0]).toMatchObject({
      findingKey: "excluded_with_obligation:sw_disposal",
      action: "accepted",
      by: "boss",
    });
    // …the BOQ links survived the re-confirm…
    const zipClause = final.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_zip");
    expect(zipClause?.boqLineRefs.length).toBe(zipLines.length);
    // …and the worker-facing warnings are stored on the warning-bearing clauses
    // (the same field #367 compiles onto the delivering packages).
    const avClause = final.reconciliation.clauseClassifications.find((c) => c.clauseId === "sw_av");
    expect(avClause?.warningText).toBe("Cabling only — the AV mob supply the hardware");
  });
});
