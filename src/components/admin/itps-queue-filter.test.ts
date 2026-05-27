import { describe, expect, it } from "vitest";
import { isActive, isDone } from "@/domains/itp/format";
import { compareForQueue } from "@/domains/itp/service";
import type { ITPInstance } from "@/domains/itp/types";

/**
 * Pure-logic test for the predicates the admin ITPsQueue uses to slice
 * its three filter tabs (Active / Signed off / All). Mirrors the
 * src/components/admin/evidence-filter.test.ts pattern — tests the
 * filtering predicate, not the React component.
 *
 * Active = !archived && (pending | in-progress | witnessed)
 * Signed off = !archived && signed-off
 * All = everything (archived rows brought back into view)
 */

function instance(
  partial: Pick<ITPInstance, "id" | "status" | "archived" | "updatedAt">,
): ITPInstance {
  return {
    id: partial.id,
    templateId: "tmpl_x",
    templateSnapshot: { name: "X", points: [] },
    scope: "job",
    status: partial.status,
    results: {},
    archived: partial.archived,
    createdAt: "2026-05-26T00:00:00Z",
    createdBy: "u",
    updatedAt: partial.updatedAt,
  } as ITPInstance;
}

function filterByMode(
  items: ReadonlyArray<ITPInstance>,
  mode: "active" | "done" | "all",
): ITPInstance[] {
  return items
    .filter((i) => {
      if (mode === "active") return !i.archived && isActive(i.status);
      if (mode === "done") return !i.archived && isDone(i.status);
      return true;
    })
    .slice()
    .sort(compareForQueue);
}

describe("ITPsQueue filter predicate", () => {
  const items: ITPInstance[] = [
    instance({ id: "p1", status: "pending", archived: false, updatedAt: "2026-05-25T10:00:00Z" }),
    instance({ id: "ip1", status: "in-progress", archived: false, updatedAt: "2026-05-25T11:00:00Z" }),
    instance({ id: "w1", status: "witnessed", archived: false, updatedAt: "2026-05-25T12:00:00Z" }),
    instance({ id: "so1", status: "signed-off", archived: false, updatedAt: "2026-05-25T13:00:00Z" }),
    instance({ id: "arch", status: "signed-off", archived: true, updatedAt: "2026-05-24T08:00:00Z" }),
  ];

  it("active mode includes pending/in-progress/witnessed, excludes signed-off and archived", () => {
    const ids = filterByMode(items, "active").map((i) => i.id);
    expect(ids).toEqual(["p1", "ip1", "w1"]);
  });

  it("done mode includes only non-archived signed-off", () => {
    const ids = filterByMode(items, "done").map((i) => i.id);
    expect(ids).toEqual(["so1"]);
  });

  it("all mode includes archived rows too", () => {
    const ids = filterByMode(items, "all").map((i) => i.id);
    // compareForQueue sorts: status order then updatedAt desc
    // pending(0) → in-progress(1) → witnessed(2) → signed-off(3) (newer first within signed-off)
    expect(ids).toEqual(["p1", "ip1", "w1", "so1", "arch"]);
  });

  it("active mode sorts active rows by status then newest-first within status", () => {
    const newer = instance({
      id: "w2",
      status: "witnessed",
      archived: false,
      updatedAt: "2026-05-26T01:00:00Z",
    });
    const both = [...items, newer];
    const ids = filterByMode(both, "active").map((i) => i.id);
    // pending (p1) → in-progress (ip1) → witnessed sorted newest first (w2 before w1)
    expect(ids).toEqual(["p1", "ip1", "w2", "w1"]);
  });

  it("returns empty array for an empty input", () => {
    expect(filterByMode([], "active")).toEqual([]);
    expect(filterByMode([], "done")).toEqual([]);
    expect(filterByMode([], "all")).toEqual([]);
  });
});
