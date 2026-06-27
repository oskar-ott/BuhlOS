import { describe, expect, it } from "vitest";
import { resolveSubmissionKey, defaultMintKey, type SubmissionKeyState } from "./useSubmissionKey";

/**
 * The #497 client correctness trap: a retry must reuse the SAME idempotency key
 * (so the server replays the original), but a changed submission must mint a
 * FRESH one (so a real edit isn't swallowed as a replay). resolveSubmissionKey
 * is the pure core the useSubmissionKey hook wraps.
 */
describe("resolveSubmissionKey — stable key across retries (#497)", () => {
  // Deterministic mint so reuse vs fresh is observable.
  function counter() {
    let n = 0;
    return () => `k${++n}`;
  }

  it("mints a key on first use", () => {
    const { key, next } = resolveSubmissionKey(null, "sigA", counter());
    expect(key).toBe("k1");
    expect(next).toEqual({ sig: "sigA", key: "k1" });
  });

  it("reuses the held key when the signature is unchanged (a retry)", () => {
    const mint = counter();
    const first = resolveSubmissionKey(null, "sigA", mint);
    const retry = resolveSubmissionKey(first.next, "sigA", mint);
    expect(retry.key).toBe(first.key); // SAME key → server replays
    expect(retry.next).toBe(first.next); // state unchanged
  });

  it("mints a fresh key when the signature changes (a new submission)", () => {
    const mint = counter();
    const first = resolveSubmissionKey(null, "sigA", mint);
    const changed = resolveSubmissionKey(first.next, "sigB", mint);
    expect(changed.key).not.toBe(first.key);
    expect(changed.next).toEqual({ sig: "sigB", key: "k2" });
  });

  it("after a clear (state=null), an identical signature mints a fresh key", () => {
    const mint = counter();
    const first = resolveSubmissionKey(null, "sigA", mint);
    // clear() sets the ref back to null; the next submit of the SAME values is
    // genuinely new and must NOT replay the earlier (now-committed) write.
    const afterClear: SubmissionKeyState = null;
    const again = resolveSubmissionKey(afterClear, "sigA", mint);
    expect(again.key).not.toBe(first.key);
  });
});

describe("defaultMintKey", () => {
  it("returns a non-empty, unique-ish string", () => {
    const a = defaultMintKey();
    const b = defaultMintKey();
    expect(a).toBeTruthy();
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });
});
