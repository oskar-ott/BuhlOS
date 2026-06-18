import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/** Unit tests for the shared Phil-write idempotency helper (#497). */
const requireFromHere = createRequire(import.meta.url);
const { idempotencyKeyFrom, findIdempotent, recordIdempotent } = requireFromHere(
  "../../../api/_lib/idempotency.js",
) as {
  idempotencyKeyFrom: (req: unknown) => string | null;
  findIdempotent: (doc: unknown, key: unknown) => unknown;
  recordIdempotent: (
    doc: Record<string, unknown>,
    key: unknown,
    result: unknown,
    max?: number,
  ) => Record<string, unknown>;
};

describe("idempotencyKeyFrom", () => {
  it("reads the Idempotency-Key header (lower-cased by Node)", () => {
    expect(idempotencyKeyFrom({ headers: { "idempotency-key": "k1" } })).toBe("k1");
  });
  it("falls back to a body idempotencyKey", () => {
    expect(idempotencyKeyFrom({ headers: {}, body: { idempotencyKey: "k2" } })).toBe("k2");
  });
  it("returns null when none supplied or blank", () => {
    expect(idempotencyKeyFrom({ headers: {}, body: {} })).toBeNull();
    expect(idempotencyKeyFrom({ headers: { "idempotency-key": "   " } })).toBeNull();
    expect(idempotencyKeyFrom({})).toBeNull();
  });
});

describe("findIdempotent / recordIdempotent", () => {
  it("returns null for an unseen key, the recorded result for a seen one", () => {
    const doc: Record<string, unknown> = {};
    expect(findIdempotent(doc, "k")).toBeNull();
    recordIdempotent(doc, "k", { id: "x" });
    expect(findIdempotent(doc, "k")).toEqual({ id: "x" });
  });

  it("a null key records nothing and matches nothing", () => {
    const doc: Record<string, unknown> = {};
    recordIdempotent(doc, null, { id: "x" });
    expect(doc.__idempotency).toBeUndefined();
    expect(findIdempotent(doc, null)).toBeNull();
  });

  it("re-recording the same key keeps the original result (the replay is stable)", () => {
    const doc: Record<string, unknown> = {};
    recordIdempotent(doc, "k", { id: "first" });
    recordIdempotent(doc, "k", { id: "second" });
    expect(findIdempotent(doc, "k")).toEqual({ id: "first" });
    expect((doc.__idempotency as unknown[]).length).toBe(1);
  });

  it("bounds the ring — the oldest key is trimmed past the cap", () => {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) recordIdempotent(doc, `k${i}`, i, 3);
    expect((doc.__idempotency as unknown[]).length).toBe(3);
    expect(findIdempotent(doc, "k0")).toBeNull(); // trimmed
    expect(findIdempotent(doc, "k1")).toBeNull(); // trimmed
    expect(findIdempotent(doc, "k4")).toBe(4); // kept
  });
});
