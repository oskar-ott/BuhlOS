import { describe, expect, it } from "vitest";
import { areaTargets, levelTargets } from "./attach-targets";
import type { Job } from "@/domains/jobs/types";

/**
 * Reverse-of-resolveScopeName guard (#387): the ids the attach modal offers
 * are exactly the ids itp-scope.ts resolves back to names (level → group.id,
 * area → area.id), with archived structure excluded.
 */

const job = {
  areaGroups: [
    {
      id: "g1",
      name: "Ground floor",
      areas: [
        { id: "a1", name: "Unit 1" },
        { id: "a2", name: "Unit 2", archived: true },
      ],
    },
    { id: "g2", name: "Old wing", archived: true, areas: [{ id: "a3", name: "Unit 3" }] },
    { id: "g3", name: "Level 1", areas: [] },
  ],
} as unknown as Pick<Job, "areaGroups">;

describe("attach targets", () => {
  it("levelTargets = non-archived area groups, scopeId = group.id", () => {
    expect(levelTargets(job)).toEqual([
      { id: "g1", label: "Ground floor" },
      { id: "g3", label: "Level 1" },
    ]);
  });

  it("areaTargets = non-archived areas in non-archived groups, labelled by group", () => {
    expect(areaTargets(job)).toEqual([{ id: "a1", label: "Ground floor · Unit 1" }]);
  });

  it("empty structure yields empty lists, never throws", () => {
    expect(levelTargets({ areaGroups: undefined } as Pick<Job, "areaGroups">)).toEqual([]);
    expect(areaTargets({ areaGroups: [] } as unknown as Pick<Job, "areaGroups">)).toEqual([]);
  });
});
