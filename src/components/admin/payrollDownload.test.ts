import { describe, expect, it, vi } from "vitest";
import { downloadPayrollFile, payrollSheetUrl } from "./payrollDownload";

/**
 * Payroll downloads never dead-end (owner pull 2026-10-12): a refused download
 * used to open a page of JSON. These pin the fetch-and-save path.
 */

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    blob: async () => new Blob(["%PDF"]),
  } as unknown as Response;
}

describe("payrollSheetUrl", () => {
  it("is always a dry run (the #895 invariant) — PDF, CSV shapes and a leave-off", () => {
    const urls = [
      payrollSheetUrl({ fromDate: "2026-10-05", toDate: "2026-10-11" }),
      payrollSheetUrl({ fromDate: "2026-10-05", toDate: "2026-10-11", format: "csv", shape: "xero" }),
      payrollSheetUrl({ fromDate: "2026-10-05", toDate: "2026-10-11", skip: ["u1|2026-10-09"] }),
    ];
    for (const u of urls) expect(u).toMatch(/&dryRun=1$/);
    expect(urls[0]).toBe(
      "/api/time-entries-export?status=approved&fromDate=2026-10-05&toDate=2026-10-11&format=pdf&dryRun=1",
    );
    expect(urls[2]).toContain("skip=u1%7C2026-10-09");
  });

  it("a CSV never carries a leave-off — only the PDF names what it leaves off", () => {
    expect(
      payrollSheetUrl({ fromDate: "2026-10-05", toDate: "2026-10-11", format: "csv", skip: ["u1|2026-10-09"] }),
    ).not.toContain("skip=");
  });
});

describe("downloadPayrollFile", () => {
  it("saves the file under the server's own filename", async () => {
    const save = vi.fn();
    const out = await downloadPayrollFile({
      url: "/x",
      fallbackFilename: "fallback.pdf",
      fetchImpl: vi.fn(async () =>
        reply(200, null, { "content-disposition": 'attachment; filename="buhlos-hours-a-to-b.pdf"' }),
      ),
      save,
    });
    expect(out).toEqual({ ok: true, filename: "buhlos-hours-a-to-b.pdf" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("waits out 'still saving' by itself and then downloads — no page of JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(503, { code: "settling", retryAfterMs: 4000 }))
      .mockResolvedValueOnce(reply(200, null));
    const sleep = vi.fn(async () => {});
    const onSettling = vi.fn();
    const save = vi.fn();
    const out = await downloadPayrollFile({ url: "/x", fallbackFilename: "f.pdf", fetchImpl, sleep, onSettling, save });
    expect(out).toEqual({ ok: true, filename: "f.pdf" });
    expect(onSettling).toHaveBeenCalledWith(4000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a day that can't be read comes back named, with the plain-words problem", async () => {
    const out = await downloadPayrollFile({
      url: "/x",
      fallbackFilename: "f.pdf",
      fetchImpl: vi.fn(async () =>
        reply(503, {
          error: "payroll read refused",
          code: "unreadable",
          days: [{ userId: "u1", date: "2026-10-09", workerName: "Dylan Sinclair", problem: "unreadable", canSkip: true }],
        }),
      ),
      save: vi.fn(),
    });
    expect(out).toMatchObject({
      ok: false,
      problem: { title: "A day couldn't be read", caption: "Download didn't start" },
      unreadable: [{ key: "u1|2026-10-09", workerName: "Dylan Sinclair", canSkip: true }],
    });
  });

  it("no connection is a plain-words problem, not a throw", async () => {
    const out = await downloadPayrollFile({
      url: "/x",
      fallbackFilename: "f.pdf",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      save: vi.fn(),
    });
    expect(out).toMatchObject({ ok: false, problem: { title: "No connection", canRetry: true } });
  });

  it("stops without fetching again once the screen is gone", async () => {
    const fetchImpl = vi.fn(async () => reply(503, { code: "settling", retryAfterMs: 1000 }));
    const out = await downloadPayrollFile({
      url: "/x",
      fallbackFilename: "f.pdf",
      fetchImpl,
      sleep: async () => {},
      isActive: () => false,
      save: vi.fn(),
    });
    expect(out).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
