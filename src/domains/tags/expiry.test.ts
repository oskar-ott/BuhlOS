import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  countTagRegister,
  parseTagDate,
  sortTagsForRegister,
  tagDisplayName,
  tagExpiryState,
} from "./expiry";
import type { TagItem } from "./schema";

const requireFromHere = createRequire(import.meta.url);

// Fixed clock: 12 June 2026 mid-morning.
const NOW = new Date(2026, 5, 12, 9, 0);

function tag(id: string, expiryDate?: string, extra: Partial<TagItem> = {}): TagItem {
  return { id, applianceType: `Item ${id}`, expiryDate, ...extra } as TagItem;
}

describe("parseTagDate", () => {
  it("parses dd/mm/yyyy as local midnight and ISO as fallback", () => {
    expect(parseTagDate("12/06/2026")).toBe(new Date(2026, 5, 12).getTime());
    expect(parseTagDate("2026-06-12")).toBe(new Date(2026, 5, 12).getTime());
  });
  it("returns NaN on garbage", () => {
    expect(Number.isNaN(parseTagDate(""))).toBe(true);
    expect(Number.isNaN(parseTagDate("soon"))).toBe(true);
    expect(Number.isNaN(parseTagDate(undefined))).toBe(true);
  });
});

describe("tagExpiryState", () => {
  it("classifies expired / expiring / ok / none with signed days", () => {
    expect(tagExpiryState("10/06/2026", NOW)).toEqual({ status: "expired", daysToExpiry: -2 });
    expect(tagExpiryState("12/06/2026", NOW)).toEqual({ status: "expiring", daysToExpiry: 0 });
    expect(tagExpiryState("26/06/2026", NOW)).toEqual({ status: "expiring", daysToExpiry: 14 });
    expect(tagExpiryState("27/06/2026", NOW)).toEqual({ status: "ok", daysToExpiry: 15 });
    expect(tagExpiryState("", NOW)).toEqual({ status: "none", daysToExpiry: null });
  });

  it("MATCHES the CJS compliance lib's window semantics (#305 parity)", () => {
    // The single source the daily alerts + /gear board use.
    const lib = requireFromHere("../../../api/_lib/tag-compliance.js") as {
      expiringTagRows: (
        jobs: unknown[],
        byJob: Record<string, unknown[]>,
        opts: { withinDays: number; now: Date },
      ) => Array<{ id: string; daysToExpiry: number; status: string }>;
    };
    const rows = lib.expiringTagRows(
      [{ id: "j1", name: "J" }],
      { j1: [tag("a", "10/06/2026"), tag("b", "26/06/2026"), tag("c", "27/06/2026")] },
      { withinDays: 14, now: NOW },
    );
    // lib keeps a (expired) + b (expiring), drops c — and we agree on each:
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    for (const row of rows) {
      const ours = tagExpiryState(
        row.id === "a" ? "10/06/2026" : "26/06/2026",
        NOW,
      );
      expect(ours.status).toBe(row.status);
      expect(ours.daysToExpiry).toBe(row.daysToExpiry);
    }
    expect(tagExpiryState("27/06/2026", NOW).status).toBe("ok");
  });
});

describe("countTagRegister / sortTagsForRegister", () => {
  const tags = [
    tag("ok", "01/12/2026"),
    tag("exp2", "01/06/2026"),
    tag("soon", "20/06/2026"),
    tag("none"),
    tag("exp1", "11/06/2026"),
  ];

  it("counts expired and expiring within the 14-day window", () => {
    expect(countTagRegister(tags, NOW)).toEqual({ total: 5, expired: 2, expiring: 1 });
  });

  it("orders: most-overdue first, then soonest-due, then ok, then dateless", () => {
    expect(sortTagsForRegister(tags, NOW).map((t) => t.id)).toEqual([
      "exp2",
      "exp1",
      "soon",
      "ok",
      "none",
    ]);
  });
});

describe("tagDisplayName", () => {
  it("prefers applianceType, falls back to legacy name then tagNumber", () => {
    expect(tagDisplayName({ applianceType: "Drill" })).toBe("Drill");
    expect(tagDisplayName({ applianceType: "", name: "Old drill" })).toBe("Old drill");
    expect(tagDisplayName({ tagNumber: "T-9" })).toBe("T-9");
    expect(tagDisplayName({})).toBe("Untagged item");
  });
});
