import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * In-process Phil page loaders (api/_lib/phil-page-data.js) — the twins of
 * the HTTP self-fetches /phil/my-day and /phil/hours used to make. The parity
 * that matters:
 *   - unauthenticated → ok:false (entries: status 401, matching the old
 *     "API returned 401" copy) and NEVER a storage read;
 *   - entries go through entryView (idempotency internals stripped);
 *   - field/LH jobs come from the jobs-summary minus draft/archived/complete,
 *     a summary failure falls back to the full jobs.json read (same recovery
 *     as api/jobs.js), and non-field roles read jobs.json directly.
 * Deps are injected — no Blob/PG in this test.
 */
const requireFromHere = createRequire(import.meta.url);
const {
  loadCurrentUserInProcess,
  loadWorkerEntriesInProcess,
  loadFieldJobsInProcess,
  loadFieldJobInProcess,
  loadFieldJobsByIdInProcess,
  loadIsApprenticeInProcess,
} = requireFromHere(requireFromHere.resolve("../../../api/_lib/phil-page-data.js")) as {
  loadFieldJobInProcess: (cookie: string | undefined, jobId: string, deps?: unknown) => Promise<Record<string, unknown> | null>;
  loadFieldJobsByIdInProcess: (cookie: string | undefined, ids: string[], deps?: unknown) => Promise<Array<{ id: string }>>;
  loadCurrentUserInProcess: (cookie: string | undefined, deps?: unknown) => Promise<unknown>;
  loadWorkerEntriesInProcess: (
    cookie: string | undefined,
    opts?: { fromDate?: string; toDate?: string },
    deps?: unknown
  ) => Promise<{ ok: boolean; status: number; entries: unknown[] }>;
  loadFieldJobsInProcess: (
    cookie: string | undefined,
    deps?: unknown
  ) => Promise<{ ok: boolean; jobs: unknown[] }>;
  loadIsApprenticeInProcess: (cookie: string | undefined, deps?: unknown) => Promise<boolean>;
};

const fieldUser = { id: "u1", role: "electrician", name: "Oskar" };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentUser: vi.fn(async () => fieldUser),
    isFieldRole: (r: string) => r === "electrician",
    isLeadingHandRole: (r: string) => r === "leadinghand",
    listUserEntries: vi.fn(async () => []),
    entryView: (e: Record<string, unknown>) => {
      const rest = { ...e };
      delete rest.__idempotency;
      return rest;
    },
    readJobsSummary: vi.fn(async () => ({ records: [] })),
    readBlob: vi.fn(async () => ({ jobs: [] })),
    ...overrides,
  };
}

describe("loadCurrentUserInProcess", () => {
  it("hands getCurrentUser a request shaped from the raw cookie value", async () => {
    const d = deps();
    await loadCurrentUserInProcess("abc123", d);
    const req = (d.getCurrentUser as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      headers: { cookie: string };
    };
    expect(req.headers.cookie).toBe("buhl_session=abc123");
  });
});

describe("loadWorkerEntriesInProcess", () => {
  it("returns status 401 without touching storage when unauthenticated", async () => {
    const d = deps({ getCurrentUser: vi.fn(async () => null) });
    const res = await loadWorkerEntriesInProcess(undefined, {}, d);
    expect(res).toEqual({ ok: false, status: 401, entries: [] });
    expect(d.listUserEntries).not.toHaveBeenCalled();
  });

  it("lists the AUTHENTICATED user's entries with the caller's window, entryView-projected", async () => {
    const d = deps({
      listUserEntries: vi.fn(async () => [
        { id: "e1", date: "2026-08-01", __idempotency: { key: "secret" } },
      ]),
    });
    const res = await loadWorkerEntriesInProcess("c", { fromDate: "2026-07-27", toDate: "2026-08-03" }, d);
    expect(res.ok).toBe(true);
    expect(d.listUserEntries).toHaveBeenCalledWith("u1", {
      fromDate: "2026-07-27",
      toDate: "2026-08-03",
    });
    expect(res.entries).toEqual([{ id: "e1", date: "2026-08-01" }]); // internals stripped
  });
});

describe("loadFieldJobsInProcess", () => {
  it("returns ok:false without touching storage when unauthenticated", async () => {
    const d = deps({ getCurrentUser: vi.fn(async () => null) });
    const res = await loadFieldJobsInProcess(undefined, d);
    expect(res).toEqual({ ok: false, jobs: [] });
    expect(d.readJobsSummary).not.toHaveBeenCalled();
    expect(d.readBlob).not.toHaveBeenCalled();
  });

  it("field role: serves the summary minus draft/archived/complete (#349)", async () => {
    const d = deps({
      readJobsSummary: vi.fn(async () => ({
        records: [
          { id: "j1", name: "Active", status: "active" },
          { id: "j2", name: "Draft", status: "draft" },
          { id: "j3", name: "Archived", status: "archived" },
          { id: "j4", name: "Done", status: "complete" },
        ],
      })),
    });
    const res = await loadFieldJobsInProcess("c", d);
    expect(res.ok).toBe(true);
    expect(res.jobs).toEqual([{ id: "j1", name: "Active", status: "active" }]);
    expect(d.readBlob).not.toHaveBeenCalled(); // no monolith read on the field path
  });

  it("field role: a summary failure falls back to the full jobs.json read (same recovery as api/jobs.js)", async () => {
    const d = deps({
      readJobsSummary: vi.fn(async () => {
        throw new Error("summary unavailable");
      }),
      readBlob: vi.fn(async () => ({ jobs: [{ id: "j1", name: "Active", status: "active" }] })),
    });
    const res = await loadFieldJobsInProcess("c", d);
    expect(res.ok).toBe(true);
    expect(res.jobs).toEqual([{ id: "j1", name: "Active", status: "active" }]);
    expect(d.readBlob).toHaveBeenCalledWith("jobs.json", { jobs: [] });
  });

  it("non-field role reads the full jobs.json through the same lifecycle rule (draft/closed never reach a log sheet)", async () => {
    const d = deps({
      getCurrentUser: vi.fn(async () => ({ id: "a1", role: "admin" })),
      readBlob: vi.fn(async () => ({
        jobs: [
          { id: "j9", name: "Any", status: "draft" },
          { id: "j8", name: "Live", status: "active" },
          { id: "j7", name: "Old", status: "complete" },
        ],
      })),
    });
    const res = await loadFieldJobsInProcess("c", d);
    expect(res.ok).toBe(true);
    expect(res.jobs).toEqual([{ id: "j8", name: "Live", status: "active" }]);
    expect(d.readJobsSummary).not.toHaveBeenCalled();
  });
});

/**
 * Apprentice lookup for the TAFE-day option (2026-08-10). FAIL-CLOSED: every
 * miss — no session, no linked employee record, a storage error — is `false`,
 * so a non-apprentice can never see the option by accident.
 */
describe("loadIsApprenticeInProcess", () => {
  it("true for a worker whose linked employee record is role: apprentice", async () => {
    const d = deps({
      readBlob: vi.fn(async () => ({
        employees: [{ id: "emp1", userId: "u1", role: "apprentice", apprenticeYear: 2 }],
      })),
    });
    expect(await loadIsApprenticeInProcess("c", d)).toBe(true);
  });

  it("false for any other employee role, and false with no linked record", async () => {
    const d = deps({
      readBlob: vi.fn(async () => ({
        employees: [{ id: "emp1", userId: "u1", role: "electrician" }],
      })),
    });
    expect(await loadIsApprenticeInProcess("c", d)).toBe(false);
    const none = deps({ readBlob: vi.fn(async () => ({ employees: [] })) });
    expect(await loadIsApprenticeInProcess("c", none)).toBe(false);
  });

  it("false (never a throw) when unauthenticated or when the read fails", async () => {
    const anon = deps({ getCurrentUser: vi.fn(async () => null) });
    expect(await loadIsApprenticeInProcess(undefined, anon)).toBe(false);
    const broken = deps({
      readBlob: vi.fn(async () => {
        throw new Error("storage down");
      }),
    });
    expect(await loadIsApprenticeInProcess("c", broken)).toBe(false);
  });
});

/**
 * Jobs a Phil page must name that are no longer in the default set
 * (docs/job-lifecycle.md): the `?job=` a callback arrives with and the closed
 * jobs a worker's own hours reference. Only openable jobs come back.
 */
describe("loadFieldJobsByIdInProcess / loadFieldJobInProcess", () => {
  const records = [
    { id: "live", name: "Live", status: "active" },
    { id: "closed", name: "Old Depot", status: "complete", completedAt: "2025-11-02T00:00:00.000Z" },
    { id: "archived", name: "Gone", status: "archived" },
    { id: "draft", name: "Unpublished", status: "draft" },
  ];

  it("returns the openable jobs among the ids — closed yes, archived/draft never", async () => {
    const d = deps({
      getCurrentUser: vi.fn(async () => ({ id: "u1", role: "tradie" })),
      readJobsSummary: vi.fn(async () => ({ records })),
    });
    const found = await loadFieldJobsByIdInProcess("c", ["closed", "archived", "draft", "nope"], d);
    expect(found.map((j) => j.id)).toEqual(["closed"]);
    expect(await loadFieldJobInProcess("c", "closed", d)).toMatchObject({ id: "closed" });
    expect(await loadFieldJobInProcess("c", "archived", d)).toBeNull();
    expect(await loadFieldJobInProcess("c", "nope", d)).toBeNull();
  });

  it("falls back to jobs.json when the summary read fails; empty ids read nothing", async () => {
    const d = deps({
      getCurrentUser: vi.fn(async () => ({ id: "u1", role: "tradie" })),
      readJobsSummary: vi.fn(async () => { throw new Error("summary down"); }),
      readBlob: vi.fn(async () => ({ jobs: records })),
    });
    expect((await loadFieldJobsByIdInProcess("c", ["closed"], d)).map((j) => j.id)).toEqual(["closed"]);
    expect(await loadFieldJobsByIdInProcess("c", [], d)).toEqual([]);
    expect(d.readBlob).toHaveBeenCalledTimes(1);
  });

  it("no session → nothing, never a throw", async () => {
    const d = deps({ getCurrentUser: vi.fn(async () => null) });
    expect(await loadFieldJobsByIdInProcess("c", ["closed"], d)).toEqual([]);
  });
});
