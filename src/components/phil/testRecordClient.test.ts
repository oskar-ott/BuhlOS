import { describe, expect, it, vi } from "vitest";
import { submitTestRecord } from "./testRecordClient";
import type { TestRecordInput } from "@/domains/test-records/schema";

// Minimal valid input — the client posts it verbatim; the server re-derives
// pass/fail, so the test only needs a shape the route would accept.
const INPUT = {
  jobId: "job_1",
  reportType: "circuit_test",
  tester: { name: "Sam", licenceNo: "E123" },
  testedAt: "2026-07-03",
  rows: [],
} as unknown as TestRecordInput;

function fakeFetch(status: number, body: unknown): typeof fetch {
  const ok = status >= 200 && status < 300;
  return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("submitTestRecord failure honesty (#139)", () => {
  it("maps a 2xx with a minted evidence id to ok", async () => {
    const r = await submitTestRecord(
      INPUT,
      fakeFetch(200, { ok: true, evidenceId: "ev_9", record: null }),
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.evidenceId).toBe("ev_9");
  });

  it("maps a thrown fetch (network) to error with honest worker copy", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const r = await submitTestRecord(INPUT, throwingFetch);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/couldn't reach the office/i);
      expect(r.message).not.toMatch(/failed to fetch/i);
    }
  });

  it("times out honestly on a hung request — 'may not have sent', never a definite failure (P7)", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ) as unknown as typeof fetch;
      const pending = submitTestRecord(INPUT, hanging);
      await vi.advanceTimersByTimeAsync(15_001);
      const r = await pending;
      expect(r.kind).toBe("error");
      if (r.kind === "error") expect(r.message).toMatch(/may not have sent/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps 401/403 to unauthorized (auth failures stay distinct — never 'didn't send')", async () => {
    expect((await submitTestRecord(INPUT, fakeFetch(401, {}))).kind).toBe("unauthorized");
    expect((await submitTestRecord(INPUT, fakeFetch(403, {}))).kind).toBe("unauthorized");
  });
});
