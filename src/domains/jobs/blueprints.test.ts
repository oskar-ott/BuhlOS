import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  blueprintSummaryLine,
  instantiateBlueprint,
  type JobBlueprint,
} from "./blueprints";

/**
 * #191 mappers. The CAPTURE strip-matrix is a server pure function
 * (api/_lib/job-duplicate.js, shared with #190/#192) — exercised here
 * directly via require so the "never captures site/state" promise is pinned
 * where it lives. The INSTANTIATE mapper (client) is pinned for the
 * fresh-ids-by-construction + draft + structure-only shape.
 */

const requireFromHere = createRequire(import.meta.url);
const dup = requireFromHere("../../../api/_lib/job-duplicate.js") as {
  captureBlueprintStructure: (source: Record<string, unknown>) => Record<string, unknown>;
  blueprintSummary: (structure: Record<string, unknown>) => {
    groupCount: number;
    areaCount: number;
    taskCount: number;
  };
};

const sourceJob = {
  id: "job-1",
  name: "Magill Rd Unit 4",
  status: "active",
  // Site / client / dates / money — a blueprint must NEVER capture these.
  siteAddress: "12 Magill Rd",
  accessNotes: "Key under mat",
  siteContactName: "Bob",
  clientUserId: "u_client",
  contractValue: 120000,
  startDate: "2026-07-01",
  type: "townhouse",
  ref: "BW-1",
  modules: { snags: true, itps: false },
  customFields: [{ id: "cf1", label: "Switchboard", value: "DB-1" }],
  roughInTasks: [
    { id: "t1", name: "Rough in power" },
    { id: "t2", name: "Old retired task", archived: true },
  ],
  fitOffTasks: [{ id: "t3", name: "Fit GPOs" }],
  areaGroups: [
    {
      id: "g1",
      name: "Level 1",
      order: 0,
      areas: [
        {
          id: "a1",
          name: "Unit 1",
          spaceType: "dwelling",
          roughInTasks: [{ id: "ta1", name: "Area rough" }],
          fitOffTasks: [{ id: "ta2", name: "Area fit", archived: true }],
        },
        { id: "a2", name: "Old unit", archived: true, areas: [] },
      ],
    },
    { id: "g2", name: "Archived group", archived: true, areas: [] },
  ],
};

describe("captureBlueprintStructure — strip matrix (#191)", () => {
  const captured = dup.captureBlueprintStructure(sourceJob);

  it("captures modules, custom fields and job-level task lists", () => {
    expect(captured.modules).toEqual({ snags: true, itps: false });
    expect(captured.customFields).toHaveLength(1);
    expect(captured.roughInTasks).toEqual([{ name: "Rough in power" }]); // archived dropped
    expect(captured.fitOffTasks).toEqual([{ name: "Fit GPOs" }]);
  });

  it("NEVER captures site / client / dates / money / type / ref / state", () => {
    const keys = Object.keys(captured);
    for (const banned of [
      "siteAddress",
      "accessNotes",
      "siteContactName",
      "clientUserId",
      "contractValue",
      "startDate",
      "type",
      "ref",
      "status",
      "id",
    ]) {
      expect(keys, banned).not.toContain(banned);
    }
  });

  it("strips ids and archived groups/areas/tasks", () => {
    const groups = captured.areaGroups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1); // archived group dropped
    expect(groups[0]!.name).toBe("Level 1");
    expect(groups[0]).not.toHaveProperty("id");
    const areas = groups[0]!.areas as Array<Record<string, unknown>>;
    expect(areas).toHaveLength(1); // archived area dropped
    expect(areas[0]).not.toHaveProperty("id");
    expect(areas[0]!.roughInTasks).toEqual([{ name: "Area rough" }]);
    expect(areas[0]).not.toHaveProperty("fitOffTasks"); // its only fit task was archived
  });

  it("summary counts groups, areas and all tasks", () => {
    expect(dup.blueprintSummary(captured)).toEqual({
      groupCount: 1,
      areaCount: 1,
      taskCount: 3, // 2 job-level (power + GPOs) + 1 area (area rough)
    });
  });
});

describe("instantiateBlueprint — client mapper", () => {
  const blueprint = {
    structure: dup.captureBlueprintStructure(sourceJob),
  } as unknown as Pick<JobBlueprint, "structure">;

  it("produces a draft CREATE payload with structure, no ids", () => {
    const payload = instantiateBlueprint(blueprint, "New Estate Unit 1");
    expect(payload.name).toBe("New Estate Unit 1");
    expect(payload.status).toBe("draft");
    const groups = (payload as Record<string, unknown>).areaGroups as Array<Record<string, unknown>>;
    expect(groups[0]!.name).toBe("Level 1");
    // Fresh STRUCTURE ids by construction: no group/area/task carries an id,
    // so the new job can never share a structure id with its source. (Custom
    // field ids are per-job local keys — the duplicate mapper keeps them too.)
    expect(groups[0]).not.toHaveProperty("id");
    const areas = groups[0]!.areas as Array<Record<string, unknown>>;
    expect(areas).toHaveLength(1);
    for (const area of areas) {
      expect(area).not.toHaveProperty("id");
      for (const t of [...((area.roughInTasks as unknown[]) ?? []), ...((area.fitOffTasks as unknown[]) ?? [])]) {
        expect(t).not.toHaveProperty("id");
      }
    }
    for (const t of [
      ...(((payload as Record<string, unknown>).roughInTasks as unknown[]) ?? []),
      ...(((payload as Record<string, unknown>).fitOffTasks as unknown[]) ?? []),
    ]) {
      expect(t).not.toHaveProperty("id");
    }
    expect((payload as Record<string, unknown>).modules).toEqual({ snags: true, itps: false });
  });

  it("carries no site/client/type — those stay for the builder", () => {
    const payload = instantiateBlueprint(blueprint, "X") as Record<string, unknown>;
    for (const banned of ["siteAddress", "clientUserId", "type", "contractValue"]) {
      expect(payload).not.toHaveProperty(banned);
    }
  });
});

describe("blueprintSummaryLine", () => {
  it("pluralises a one-line summary", () => {
    expect(
      blueprintSummaryLine({ summary: { groupCount: 1, areaCount: 1, taskCount: 1 } })
    ).toBe("1 group · 1 area · 1 task");
    expect(
      blueprintSummaryLine({ summary: { groupCount: 3, areaCount: 12, taskCount: 40 } })
    ).toBe("3 groups · 12 areas · 40 tasks");
  });
});
