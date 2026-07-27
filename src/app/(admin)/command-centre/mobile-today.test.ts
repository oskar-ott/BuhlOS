import { describe, expect, it } from "vitest";
import type { ExceptionItem } from "@/domains/exceptions/types";
import { rankNeedsYou } from "./mobile-today";

function ex(id: string, severity: ExceptionItem["severity"], createdAt?: string): ExceptionItem {
  return {
    id,
    source: "hours",
    sourceId: id,
    title: `item ${id}`,
    severity,
    actionState: "available",
    createdAt,
  };
}

describe("rankNeedsYou", () => {
  it("ranks critical → warning → info, then oldest first, and keeps the full list", () => {
    const items = [
      ex("a", "info", "2026-06-26T00:00:00Z"),
      ex("b", "critical", "2026-06-26T00:00:00Z"),
      ex("c", "warning", "2026-06-20T00:00:00Z"),
      ex("d", "critical", "2026-06-25T00:00:00Z"),
    ];
    const { top } = rankNeedsYou(items, 4);
    // Both criticals first (older d before b), then warning, then info.
    expect(top.map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("splits the loudest `limit` and reports the remainder", () => {
    const items = [ex("a", "critical"), ex("b", "warning"), ex("c", "info"), ex("d", "info"), ex("e", "info")];
    const r = rankNeedsYou(items, 4);
    expect(r.top).toHaveLength(4);
    expect(r.remaining).toBe(1);
    expect(r.all).toHaveLength(5);
  });

  it("handles fewer items than the limit (no negative remainder)", () => {
    const r = rankNeedsYou([ex("a", "critical")], 4);
    expect(r.top).toHaveLength(1);
    expect(r.remaining).toBe(0);
  });
});
