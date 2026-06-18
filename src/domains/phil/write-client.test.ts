import { describe, expect, it, vi } from "vitest";

import { philWrite, PHIL_WRITE_TIMEOUT_MS } from "./write-client";

/**
 * Shared Phil field-write client (#139). Fully injectable: every test passes a
 * fake fetch + online predicate, so no real network is touched. The contract:
 * one definite, typed outcome per write — never an infinite hang, never a
 * pretended save.
 */

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

const parseEcho = (raw: unknown) => raw as { ok: true } | null;

describe("philWrite", () => {
  it("returns offline (and never fetches) when the device is offline", async () => {
    const fetchImpl = vi.fn();
    const res = await philWrite("/api/x", { a: 1 }, parseEcho, {
      isOnline: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: { kind: "offline", message: expect.any(String) } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns cancelled (and never fetches) when the caller signal is already aborted", async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const res = await philWrite("/api/x", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts JSON and returns parsed data on a 2xx", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    const res = await philWrite("/api/task-toggle", { taskId: "t1" }, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ taskId: "t1" }));
  });

  it("surfaces a server error message on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Hours already approved." }, { ok: false, status: 409 }));
    const res = await philWrite("/api/time-entries", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "http") {
      expect(res.error.status).toBe(409);
      expect(res.error.message).toBe("Hours already approved.");
    } else {
      throw new Error("expected an http error");
    }
  });

  it("falls back to a default message when the error body has no error string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 500 }));
    const res = await philWrite("/api/x", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (!res.ok && res.error.kind === "http") {
      expect(res.error.message).toMatch(/500/);
    } else {
      throw new Error("expected an http error");
    }
  });

  it("returns network when fetch throws (connection dropped)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await philWrite("/api/x", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("network");
  });

  it("returns timeout when the request outlives the budget", async () => {
    // fetch that never resolves until its signal aborts, then rejects (real fetch behaviour).
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }
        })
    );
    const res = await philWrite("/api/x", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("timeout");
  });

  it("returns parse when the 2xx body is unreadable", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response));
    const res = await philWrite("/api/x", {}, parseEcho, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("parse");
  });

  it("returns parse when the caller's parser rejects the shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    const res = await philWrite("/api/x", {}, () => null, {
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("parse");
  });

  it("defaults to a 15s timeout budget", () => {
    expect(PHIL_WRITE_TIMEOUT_MS).toBe(15000);
  });
});
