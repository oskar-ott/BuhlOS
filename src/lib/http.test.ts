import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { httpGet, httpPost } from "./http";

/**
 * Bounded-timeout behaviour of the shared fetch wrapper (#139). The global
 * fetch is stubbed; no real network is touched. Backward-compat: with no
 * timeoutMs, behaviour is unchanged (no abort signal, no timer).
 */

const schema = z.object({ ok: z.boolean() });

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http timeout", () => {
  it("returns a timeout error (kind=timeout) when the request outlives the budget", async () => {
    // fetch that only settles when its signal aborts (real fetch behaviour).
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchImpl);

    const res = await httpPost("/api/x", { a: 1 }, { schema, timeoutMs: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("timeout");
      expect(res.error.status).toBe(0);
    }
  });

  it("does not abort a fast request and parses normally", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ ok: true })));
    const res = await httpPost("/api/x", {}, { schema, timeoutMs: 5000 });
    expect(res).toEqual({ ok: true, data: { ok: true } });
  });

  it("classifies a thrown fetch (no timeout) as kind=network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const res = await httpGet("/api/x", { schema });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("network");
      expect(res.error.status).toBe(0);
      // Unbounded (admin/read) callers keep the raw error message.
      expect(res.error.message).toBe("Failed to fetch");
    }
  });

  it("gives a bounded (field-write) network failure honest worker copy, not browser internals (#139)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const res = await httpPost("/api/x", {}, { schema, timeoutMs: 5000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("network");
      expect(res.error.message).toMatch(/couldn't reach the office/i);
      expect(res.error.message).not.toMatch(/failed to fetch/i);
    }
  });

  it("timeout copy says 'may not have sent' — never a definite failure claim (#139, P7)", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchImpl);
    const res = await httpPost("/api/x", {}, { schema, timeoutMs: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/may not have sent/i);
  });

  it("does not attach a signal when no timeout is set (unchanged behaviour)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchImpl);
    await httpGet("/api/x", { schema });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.signal).toBeUndefined();
  });
});
