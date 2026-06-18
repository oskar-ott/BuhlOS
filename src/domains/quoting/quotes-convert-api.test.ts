import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteToJobInput } from "./quote-to-job";

/**
 * Real-handler coverage for api/quotes.js `convert` (#244): a won quote →
 * DRAFT job through the sanctioned creator (api/_lib/job-create.js), with the
 * blob store mocked to a Map (house pattern: quotes-duplicate-api.test.ts).
 *
 * What this suite pins (acceptance criteria #244):
 *   - convert refused for lost / declined / archived and already-converted
 *     quotes (409 + convertedJobId echo on already-converted);
 *   - the job is created via the SANCTIONED path and lands as a DRAFT (not
 *     active), so it carries the modules/customFields shape createJob writes
 *     and the per-job seeds (data.json / tags.json / temps.json) exist;
 *   - structure seeded from quote sections (areas + unioned stage tasks);
 *   - materials carried with quote-only source/confidence stripped, pricing
 *     kept, status normalised;
 *   - two-way trace: quote.convertedJobId + job.fromQuoteId, quote status →
 *     converted_to_job; re-convert blocked;
 *   - PARITY: the converted job's structure/materials match the pure
 *     quoteToJobInput spec (modulo freshly-minted ids) for the same fixture.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const quotesPath = requireFromHere.resolve("../../../api/quotes.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let quotes: Handler;

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

async function convert(id: string, as: [string, string] = ["u_admin", "admin"]) {
  const res = createRes();
  await quotes(
    {
      method: "POST",
      body: {},
      query: { action: "convert", id },
      headers: { cookie: cookieFor(as[0], as[1]) },
    },
    res
  );
  return res;
}

const WON_ID = "q_won";
const sectionKey = (id: string, file: string) => `quotes/${id}/${file}`;

const STRUCTURE = {
  areaGroups: [
    {
      id: "qag_1",
      name: "Ground Floor",
      areas: [
        {
          id: "qar_1",
          name: "Kitchen",
          workPackages: [
            { name: "RI kitchen", stage: "rough-in", tasks: ["Run cable", "Mount boxes"] },
            { name: "FO kitchen", stage: "fit-off", tasks: ["Fit GPOs"] },
          ],
        },
        {
          id: "qar_2",
          name: "Laundry",
          workPackages: [
            { name: "RI laundry", stage: "rough-in", tasks: ["Run cable"] }, // dup
          ],
        },
      ],
    },
  ],
};

const MATERIALS = {
  items: [
    {
      id: "qmat_1",
      description: "2.5mm TPS cable",
      category: "Cable",
      quantity: 100,
      unitCost: 2.5,
      totalCost: 250,
      status: "priced",
      source: "ai-takeoff",
      confidence: 0.82,
    },
    { id: "qmat_2", description: "DB upgrade", totalCost: 1000 }, // no status → draft
  ],
};

const LABOUR = { lines: [{ id: "qlab_1", estimatedHours: 10 }] };
const NOTES = { assumptions: ["existing meter reused"], exclusions: [], risks: [], clarifications: [] };

function wonQuote(extra: Record<string, unknown> = {}) {
  return {
    id: WON_ID,
    name: "Birdwood St Rewire",
    jobType: "",
    siteAddress: "12 Birdwood St",
    status: "won",
    convertedJobId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...extra,
  };
}

function storedQuotes(): { quotes: Array<Record<string, unknown>> } {
  return blob.get("quotes.json") as { quotes: Array<Record<string, unknown>> };
}
function storedJobs(): { jobs: Array<Record<string, unknown>> } {
  return blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
}

function seed(quoteOverride?: Record<string, unknown>) {
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "u_admin", role: "admin", assignedJobIds: [] },
          { id: "u_field", username: "u_field", role: "tradie", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", { jobs: [] }],
    ["quotes.json", { quotes: [wonQuote(quoteOverride)] }],
    [sectionKey(WON_ID, "structure.json"), STRUCTURE],
    [sectionKey(WON_ID, "materials-estimate.json"), MATERIALS],
    [sectionKey(WON_ID, "labour-estimate.json"), LABOUR],
    [sectionKey(WON_ID, "notes.json"), NOTES],
  ]);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  seed();

  for (const modulePath of [blobPath, authPath, quotesPath]) {
    delete requireFromHere.cache[modulePath];
  }
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-create.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-fields.js")];
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
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  quotes = requireFromHere(quotesPath) as Handler;
});

describe("convert guards (#244)", () => {
  it.each(["lost", "declined", "archived"])("refuses convert from status %s (409)", async (status) => {
    seed({ status });
    const res = await convert(WON_ID);
    expect(res.statusCode).toBe(409);
    // no job written
    expect(storedJobs().jobs).toHaveLength(0);
  });

  it("refuses an already-converted quote with 409 + convertedJobId echo", async () => {
    seed({ convertedJobId: "existing-job", status: "converted_to_job" });
    const res = await convert(WON_ID);
    expect(res.statusCode).toBe(409);
    expect((res.body as { convertedJobId: string }).convertedJobId).toBe("existing-job");
  });

  it("blocks re-convert: a second convert of the same quote 409s", async () => {
    const first = await convert(WON_ID);
    expect(first.statusCode).toBe(201);
    const jobId = (first.body as { jobId: string }).jobId;
    const second = await convert(WON_ID);
    expect(second.statusCode).toBe(409);
    expect((second.body as { convertedJobId: string }).convertedJobId).toBe(jobId);
    // still exactly one job
    expect(storedJobs().jobs).toHaveLength(1);
  });

  it("403s a non-admin (field role) — quoting is admin-only", async () => {
    const res = await convert(WON_ID, ["u_field", "tradie"]);
    expect(res.statusCode).toBe(403);
    expect(storedJobs().jobs).toHaveLength(0);
  });
});

describe("convert creates a DRAFT job via the sanctioned path (#244)", () => {
  it("lands the job as a DRAFT (not active) with the sanctioned shape + seeds", async () => {
    const res = await convert(WON_ID);
    expect(res.statusCode).toBe(201);
    const job = (res.body as { job: Record<string, unknown> }).job;
    const jobId = (res.body as { jobId: string }).jobId;

    // DRAFT, not active.
    expect(job.status).toBe("draft");

    // Sanctioned shape: createJob writes modules + customFields + clientUserId.
    expect(job).toHaveProperty("modules");
    expect((job.modules as Record<string, boolean>).areas).toBe(true);
    expect(job.customFields).toEqual([]);
    expect(job.clientUserId).toBeNull();

    // Per-job seeds exist (createJob, not the legacy raw writer).
    expect(blob.get(`jobs/${jobId}/data.json`)).toEqual({ dwellings: {}, snags: [], notes: [] });
    expect(blob.get(`jobs/${jobId}/tags.json`)).toEqual({ tags: [] });
    expect(blob.get(`jobs/${jobId}/temps.json`)).toEqual({ temps: [] });

    // The job is persisted in jobs.json exactly once.
    expect(storedJobs().jobs).toHaveLength(1);
    expect(storedJobs().jobs[0]!.id).toBe(jobId);
  });

  it("seeds structure from quote sections: areas + unioned stage tasks", async () => {
    const res = await convert(WON_ID);
    const job = (res.body as { job: Record<string, unknown> }).job;

    const areaGroups = job.areaGroups as Array<{ name: string; areas: Array<{ name: string }> }>;
    expect(areaGroups).toHaveLength(1);
    expect(areaGroups[0]!.areas.map((a) => a.name)).toEqual(["Kitchen", "Laundry"]);

    const rough = (job.roughInTasks as Array<{ name: string }>).map((t) => t.name);
    const fit = (job.fitOffTasks as Array<{ name: string }>).map((t) => t.name);
    // "Run cable" deduped across two rough-in packages.
    expect(rough.filter((n) => n === "Run cable")).toHaveLength(1);
    expect(rough).toEqual(expect.arrayContaining(["Run cable", "Mount boxes"]));
    expect(fit).toEqual(["Fit GPOs"]);
  });

  it("carries materials with quote-only fields stripped + pricing preserved", async () => {
    const res = await convert(WON_ID);
    const jobId = (res.body as { jobId: string }).jobId;
    const list = blob.get(`jobs/${jobId}/materials-list.json`) as {
      items: Array<Record<string, unknown>>;
      emailRequests: unknown[];
    };
    expect(list.items).toHaveLength(2);
    for (const m of list.items) {
      expect(m).not.toHaveProperty("source");
      expect(m).not.toHaveProperty("confidence");
      expect(m.jobId).toBe(jobId);
      expect(String(m.id)).toMatch(/^mat_/);
    }
    const cable = list.items[0]!;
    expect(cable.totalCost).toBe(250);
    expect(cable.unitCost).toBe(2.5);
    expect(cable.status).toBe("priced");
    // no status on the second item → normalised to draft
    expect(list.items[1]!.status).toBe("draft");
  });

  it("sets the two-way trace and flips the quote to converted_to_job", async () => {
    const res = await convert(WON_ID);
    const jobId = (res.body as { jobId: string }).jobId;
    const job = (res.body as { job: Record<string, unknown> }).job;

    expect(job.fromQuoteId).toBe(WON_ID);
    const q = storedQuotes().quotes.find((x) => x.id === WON_ID)!;
    expect(q.status).toBe("converted_to_job");
    expect(q.convertedJobId).toBe(jobId);
  });

  it("returns a summary that matches the seeded structure", async () => {
    const res = await convert(WON_ID);
    const summary = (res.body as { summary: Record<string, number> }).summary;
    expect(summary.areaGroups).toBe(1);
    expect(summary.areas).toBe(2);
    expect(summary.materials).toBe(2);
    expect(summary.labourLines).toBe(1);
    expect(summary.assumptions).toBe(1);
  });
});

describe("convert handler ↔ pure mapping parity (#244)", () => {
  it("the converted job's structure/materials match quoteToJobInput (ids aside)", async () => {
    const res = await convert(WON_ID);
    const job = (res.body as { job: Record<string, unknown> }).job;
    const jobId = (res.body as { jobId: string }).jobId;

    const expected = quoteToJobInput(wonQuote(), STRUCTURE, MATERIALS);

    // Area-group + area NAMES match (ids differ; no workPackages on either).
    const stripIds = (groups: unknown) =>
      (groups as Array<{ name: string; areas: Array<{ name: string }> }>).map((g) => ({
        name: g.name,
        areas: g.areas.map((a) => ({ name: a.name })),
      }));
    expect(stripIds(job.areaGroups)).toEqual(stripIds(expected.jobInput.areaGroups));

    // Task name sets match.
    expect(new Set((job.roughInTasks as Array<{ name: string }>).map((t) => t.name))).toEqual(
      new Set(expected.jobInput.roughInTasks.map((t) => t.name))
    );
    expect(new Set((job.fitOffTasks as Array<{ name: string }>).map((t) => t.name))).toEqual(
      new Set(expected.jobInput.fitOffTasks.map((t) => t.name))
    );

    // Materials seed (sans ids) match the pure seed. The handler re-mints the
    // material id (mat_*) and stamps jobId; the pure seed keeps the quote's
    // original id. Strip id/jobId from both sides and compare the rest.
    const list = blob.get(`jobs/${jobId}/materials-list.json`) as {
      items: Array<Record<string, unknown>>;
    };
    const stripMatIds = (items: Array<Record<string, unknown>>) =>
      items.map(({ id, jobId: _j, ...rest }) => {
        void id;
        void _j;
        return rest;
      });
    expect(stripMatIds(list.items)).toEqual(stripMatIds(expected.materialsSeed));
  });
});
