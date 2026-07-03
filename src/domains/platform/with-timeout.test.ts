import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Shared mirror timeout race + budget (#152, DWD-02/DWD-03).
 *   - withTimeout rejects when the work outlives the bound, resolves otherwise.
 *   - MIRROR_TIMEOUT_MS is coupled to supabase-db.js's connect_timeout: it MUST
 *     stay strictly greater, so a cold pooler connect (up to connect_timeout
 *     seconds) is not guaranteed to be aborted before it can complete.
 */
const requireFromHere = createRequire(import.meta.url);
const { withTimeout, MIRROR_TIMEOUT_MS } = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/with-timeout.js"),
) as { withTimeout: <T>(p: Promise<T>, ms: number, label: string) => Promise<T>; MIRROR_TIMEOUT_MS: number };
const { POOL_OPTIONS } = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/supabase-db.js"),
) as { POOL_OPTIONS: { connect_timeout: number } };

describe("withTimeout", () => {
  it("rejects when the work exceeds the timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "mirror")).rejects.toThrow(/timed out after 20ms/);
  });
  it("resolves with the value when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "mirror")).resolves.toBe("ok");
  });
});

describe("DWD-03 — the mirror budget sits above the pooler connect timeout", () => {
  it("MIRROR_TIMEOUT_MS (ms) is strictly greater than connect_timeout (s), so a cold connect isn't guaranteed to abort", () => {
    // connect_timeout is in SECONDS; MIRROR_TIMEOUT_MS in MILLISECONDS.
    expect(MIRROR_TIMEOUT_MS).toBeGreaterThan(POOL_OPTIONS.connect_timeout * 1000);
  });
});
