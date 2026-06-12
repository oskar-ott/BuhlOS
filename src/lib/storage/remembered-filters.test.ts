import { describe, expect, it } from "vitest";
import {
  clearRememberedFilters,
  readRememberedFilters,
  rememberedFilterQuery,
  sanitizeRememberedFilters,
  writeRememberedFilters,
  type FilterStorage,
  type RememberedFilterSpec,
} from "./remembered-filters";

/**
 * Per-device remembered filters (#216): stored values are validated against
 * the live domain sets on read, storage failures degrade silently to
 * URL-only behaviour, and the mount-time decision (rememberedFilterQuery)
 * applies the remembered set ONLY when the URL carries none of the list's
 * own filter params — the URL always wins.
 */

const SPEC: RememberedFilterSpec = {
  status: (v) => ["submitted", "approved", "rejected"].includes(v),
  person: (v) => v.trim() !== "",
};

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: FilterStorage & { data: Map<string, string> } = {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  return storage;
}

const THROWING: FilterStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("sanitizeRememberedFilters", () => {
  it("rejects non-object payloads outright", () => {
    expect(sanitizeRememberedFilters(null, SPEC)).toEqual({});
    expect(sanitizeRememberedFilters("status=submitted", SPEC)).toEqual({});
    expect(sanitizeRememberedFilters(["submitted"], SPEC)).toEqual({});
    expect(sanitizeRememberedFilters(42, SPEC)).toEqual({});
  });

  it("keeps only known params whose values pass their validator", () => {
    expect(
      sanitizeRememberedFilters(
        {
          status: "submitted",
          person: "u-ben",
          rogue: "x", // unknown param from an older build
          extra: 7,
        },
        SPEC
      )
    ).toEqual({ status: "submitted", person: "u-ben" });
  });

  it("drops invalid values (a status retired from the domain, junk types)", () => {
    expect(
      sanitizeRememberedFilters({ status: "draft", person: 9 }, SPEC)
    ).toEqual({});
    expect(sanitizeRememberedFilters({ status: "approved", person: " " }, SPEC)).toEqual({
      status: "approved",
    });
  });
});

describe("readRememberedFilters", () => {
  it("returns {} when storage is unavailable (SSR / blocked)", () => {
    expect(readRememberedFilters("k", SPEC, null)).toEqual({});
  });

  it("returns {} for a missing key, bad JSON, or a throwing storage", () => {
    expect(readRememberedFilters("k", SPEC, fakeStorage())).toEqual({});
    expect(readRememberedFilters("k", SPEC, fakeStorage({ k: "{not json" }))).toEqual({});
    expect(readRememberedFilters("k", SPEC, THROWING)).toEqual({});
  });

  it("reads and sanitizes a stored set", () => {
    const storage = fakeStorage({
      k: JSON.stringify({ status: "rejected", person: "u-1", rogue: true }),
    });
    expect(readRememberedFilters("k", SPEC, storage)).toEqual({
      status: "rejected",
      person: "u-1",
    });
  });
});

describe("writeRememberedFilters / clearRememberedFilters", () => {
  it("writes the non-empty subset as JSON", () => {
    const storage = fakeStorage();
    writeRememberedFilters("k", { status: "submitted", person: null, q: "" }, storage);
    expect(JSON.parse(storage.data.get("k")!)).toEqual({ status: "submitted" });
  });

  it("removes the key when the whole set is empty (same as a reset)", () => {
    const storage = fakeStorage({ k: '{"status":"approved"}' });
    writeRememberedFilters("k", { status: null, person: undefined }, storage);
    expect(storage.data.has("k")).toBe(false);
  });

  it("clears on demand and never throws on hostile storage", () => {
    const storage = fakeStorage({ k: "x" });
    clearRememberedFilters("k", storage);
    expect(storage.data.has("k")).toBe(false);

    expect(() => writeRememberedFilters("k", { status: "approved" }, THROWING)).not.toThrow();
    expect(() => clearRememberedFilters("k", THROWING)).not.toThrow();
    expect(() => writeRememberedFilters("k", { status: "approved" }, null)).not.toThrow();
    expect(() => clearRememberedFilters("k", null)).not.toThrow();
  });
});

describe("rememberedFilterQuery — the URL-always-wins mount decision", () => {
  const OWN = ["status", "person"];

  it("applies the stored set when the URL carries no filter params, preserving foreign params", () => {
    const query = rememberedFilterQuery(
      new URLSearchParams("week=2026-06-08"),
      OWN,
      { status: "submitted", person: "u-ben" }
    );
    const parsed = new URLSearchParams(query!);
    expect(parsed.get("week")).toBe("2026-06-08");
    expect(parsed.get("status")).toBe("submitted");
    expect(parsed.get("person")).toBe("u-ben");
  });

  it("does nothing when the URL already carries ANY of the list's own params", () => {
    expect(
      rememberedFilterQuery(new URLSearchParams("status=approved"), OWN, {
        status: "submitted",
        person: "u-ben",
      })
    ).toBeNull();
    expect(
      rememberedFilterQuery(new URLSearchParams("person=u-x"), OWN, {
        status: "submitted",
      })
    ).toBeNull();
  });

  it("does nothing when nothing valid is remembered", () => {
    expect(rememberedFilterQuery(new URLSearchParams(""), OWN, {})).toBeNull();
    expect(
      rememberedFilterQuery(new URLSearchParams("week=2026-06-08"), OWN, { status: "" })
    ).toBeNull();
  });
});
