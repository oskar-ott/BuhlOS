import { afterEach, describe, expect, it, vi } from "vitest";
import { AiDrawingsError, fetchSheets } from "./client";

/**
 * The client's error classification — the piece that decides what a failed AI
 * call TELLS the admin. The regression this pins: every 503 used to read as
 * "store unavailable", so a missing/misnamed ANTHROPIC_API_KEY (a real field
 * incident — the key was saved as "Antropic") sent people debugging Supabase
 * instead of the env var. The server sends distinguishable bodies; the client
 * must keep them distinguishable.
 */

const realFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

async function errorFrom(status: number, body: unknown): Promise<AiDrawingsError> {
  mockFetchOnce(status, body);
  try {
    await fetchSheets("job-1");
  } catch (err) {
    if (err instanceof AiDrawingsError) return err;
    throw err;
  }
  throw new Error("expected fetchSheets to throw");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("AiDrawingsError classification", () => {
  it("503 'AI is not configured' → UNCONFIGURED with the set-the-key sentence", async () => {
    const err = await errorFrom(503, { error: "AI is not configured in this environment" });
    expect(err.code).toBe("UNCONFIGURED");
    // The message must name the exact env var — that's the fix instruction.
    expect(err.message).toContain("ANTHROPIC_API_KEY");
    // …and reassure that non-AI work is unaffected (uploads are never lost).
    expect(err.message).toContain("still work");
  });

  it("503 'extraction store unavailable' → STORE_UNAVAILABLE with the server's message", async () => {
    const err = await errorFrom(503, {
      error: "extraction store unavailable in this environment",
    });
    expect(err.code).toBe("STORE_UNAVAILABLE");
    expect(err.message).toContain("extraction store unavailable");
  });

  it("402 → CAP_REACHED (per-job AI budget spent)", async () => {
    const err = await errorFrom(402, { error: "cost cap reached for this job" });
    expect(err.code).toBe("CAP_REACHED");
  });

  it("other non-2xx → HTTP with the server's message; bodyless → status fallback", async () => {
    const withBody = await errorFrom(500, { error: "boom" });
    expect(withBody.code).toBe("HTTP");
    expect(withBody.message).toBe("boom");

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("no body");
      },
    })) as unknown as typeof fetch;
    try {
      await fetchSheets("job-1");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiDrawingsError);
      expect((err as AiDrawingsError).message).toContain("500");
    }
  });
});
