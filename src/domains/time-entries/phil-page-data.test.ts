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
const { loadCurrentUserInProcess, loadWorkerEntriesInProcess, loadFieldJobsInProcess } =
  requireFromHere(requireFromHere.resolve("../../../api/_lib/phil-page-data.js")) as {
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

  it("non-field role reads the full jobs.json (pages still apply isVisibleToField on top)", async () => {
    const d = deps({
      getCurrentUser: vi.fn(async () => ({ id: "a1", role: "admin" })),
      readBlob: vi.fn(async () => ({ jobs: [{ id: "j9", name: "Any", status: "draft" }] })),
    });
    const res = await loadFieldJobsInProcess("c", d);
    expect(res.ok).toBe(true);
    expect(res.jobs).toEqual([{ id: "j9", name: "Any", status: "draft" }]);
    expect(d.readJobsSummary).not.toHaveBeenCalled();
  });
});
