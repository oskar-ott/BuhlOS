import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/** Unit tests for the shared sliding-window rate limiter (#514). `now` is
 *  injected so the window behaviour is deterministic without fake timers. */
const requireFromHere = createRequire(import.meta.url);
const { createRateLimiter } = requireFromHere("../../../api/_lib/rate-limit.js") as {
  createRateLimiter: (o: { windowMs: number; max: number }) => {
    isLimited: (k: string, now?: number) => boolean;
    record: (k: string, now?: number) => void;
    retryAfterSec: (k: string, now?: number) => number;
    clear: (k: string) => void;
    _size: () => number;
  };
};

describe("createRateLimiter (#514)", () => {
  it("allows up to max attempts then limits, with a positive retry-after", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 3 });
    expect(rl.isLimited("a", 0)).toBe(false);
    rl.record("a", 0);
    rl.record("a", 0);
    rl.record("a", 0);
    expect(rl.isLimited("a", 0)).toBe(true);
    expect(rl.retryAfterSec("a", 0)).toBeGreaterThan(0);
  });

  it("is per-key — limiting one username never limits another (shared-site IP safe)", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    rl.record("alice", 0);
    rl.record("alice", 0);
    expect(rl.isLimited("alice", 0)).toBe(true);
    expect(rl.isLimited("bob", 0)).toBe(false);
  });

  it("expires attempts that fall outside the window", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    rl.record("a", 0);
    rl.record("a", 500);
    expect(rl.isLimited("a", 500)).toBe(true);
    expect(rl.isLimited("a", 1600)).toBe(false); // both hits aged out
    expect(rl._size()).toBe(0); // pruned
  });

  it("clear() forgets a key (a good login resets it)", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.record("a", 0);
    expect(rl.isLimited("a", 0)).toBe(true);
    rl.clear("a");
    expect(rl.isLimited("a", 0)).toBe(false);
  });

  it("an empty key is never limited and records nothing", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.record("", 0);
    expect(rl.isLimited("", 0)).toBe(false);
    expect(rl._size()).toBe(0);
  });
});
