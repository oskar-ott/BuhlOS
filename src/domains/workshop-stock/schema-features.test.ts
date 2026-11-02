import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * The capability check (which later migrations this database has) runs ONCE
 * per instance even when several callers ask at the same moment (2026-11-02:
 * a cold instance's list fired three identical information_schema queries down
 * its one pooled connection together with the item list, and hung).
 */
const requireFromHere = createRequire(import.meta.url);
const storePath = requireFromHere.resolve("../../../api/_lib/workshop-stock/store.js");

describe("schema capability check — one query, shared", () => {
  it("three concurrent callers share one information_schema query", async () => {
    delete requireFromHere.cache[storePath];
    const store = requireFromHere(storePath) as {
      hasLocationPhoto: (sql: unknown) => Promise<boolean>;
      hasTypes: (sql: unknown) => Promise<boolean>;
      hasLists: (sql: unknown) => Promise<boolean>;
    };
    const rows = [
      { table_name: "workshop_stock_items", column_name: "location_photo_id" },
      { table_name: "workshop_stock_items", column_name: "category" },
      { table_name: "workshop_stock_items", column_name: "specs" },
      { table_name: "workshop_stock_lists", column_name: "id" },
      { table_name: "workshop_stock_list_lines", column_name: "id" },
    ];
    const sql = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return rows; });
    const got = await Promise.all([store.hasLocationPhoto(sql), store.hasTypes(sql), store.hasLists(sql)]);
    expect(got).toEqual([true, true, true]);
    expect(sql).toHaveBeenCalledTimes(1);
    // and once everything is there, it is never asked again on this instance
    await store.hasTypes(sql);
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
