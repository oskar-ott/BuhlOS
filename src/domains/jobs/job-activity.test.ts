import { describe, expect, it } from "vitest";
import { selectRecentActivity } from "./job-activity";
import type { AuditLogEntry } from "@/domains/audit-log/types";

function act(over: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "a1",
    ts: "2026-06-01T10:00:00Z",
    action: "evidence.captured",
    actorId: "u1",
    actorName: "Jack",
    actorRole: "tradie",
    jobId: "job-1",
    targetType: "evidence",
    targetId: "ev1",
    summary: "Captured a photo",
    ...over,
  } as unknown as AuditLogEntry;
}

describe("selectRecentActivity", () => {
  it("returns an empty selection for no entries", () => {
    expect(selectRecentActivity([])).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("sorts newest-first regardless of input order", () => {
    const sel = selectRecentActivity([
      act({ id: "old", ts: "2026-06-01T08:00:00Z" }),
      act({ id: "new", ts: "2026-06-05T08:00:00Z" }),
      act({ id: "mid", ts: "2026-06-03T08:00:00Z" }),
    ]);
    expect(sel.items.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("limits to the requested count and reports hasMore + true total", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      act({ id: `e${i}`, ts: `2026-06-0${i + 1}T08:00:00Z` }),
    );
    const sel = selectRecentActivity(entries, 5);
    expect(sel.items).toHaveLength(5);
    expect(sel.total).toBe(8);
    expect(sel.hasMore).toBe(true);
    // newest five (e7..e3)
    expect(sel.items[0]?.id).toBe("e7");
  });

  it("does not report hasMore when the list fits", () => {
    const sel = selectRecentActivity([act({ id: "a" }), act({ id: "b" })], 5);
    expect(sel.hasMore).toBe(false);
    expect(sel.total).toBe(2);
  });

  it("falls back to the default limit for an invalid limit", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      act({ id: `e${i}`, ts: `2026-06-0${i + 1}T08:00:00Z` }),
    );
    expect(selectRecentActivity(entries, 0).items).toHaveLength(5);
    expect(selectRecentActivity(entries, -3).items).toHaveLength(5);
    expect(selectRecentActivity(entries, Number.NaN).items).toHaveLength(5);
  });

  it("handles missing timestamps without throwing", () => {
    const sel = selectRecentActivity([
      act({ id: "no-ts", ts: undefined as unknown as string }),
      act({ id: "has-ts", ts: "2026-06-05T08:00:00Z" }),
    ]);
    expect(sel.items.map((e) => e.id)).toEqual(["has-ts", "no-ts"]);
  });
});
