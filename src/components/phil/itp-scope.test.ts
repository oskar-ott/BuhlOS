import { describe, expect, it } from "vitest";
import { resolveScopeName } from "./itp-scope";
import type { Job } from "@/domains/jobs/types";
import type { ITPInstance } from "@/domains/itp/types";

const baseJob: Job = {
  id: "j_test",
  name: "Test Job",
  status: "active",
  areaGroups: [
    {
      id: "lvl_g",
      name: "Ground",
      areas: [
        { id: "area_kitchen", name: "Kitchen" },
        { id: "area_lounge", name: "Lounge" },
      ],
    },
    {
      id: "lvl_1",
      name: "Level 1",
      areas: [{ id: "area_master", name: "Master bedroom" }],
    },
  ],
} as unknown as Job;

const baseInstance: Omit<
  ITPInstance,
  "scope" | "scopeId" | "id" | "templateId" | "templateSnapshot" | "status" | "results" | "createdAt" | "createdBy" | "updatedAt"
> = {} as never;

function instance(scope: ITPInstance["scope"], scopeId?: string): ITPInstance {
  return {
    ...baseInstance,
    id: "itp_x",
    templateId: "tmpl_x",
    templateSnapshot: { name: "X", points: [] },
    scope,
    scopeId,
    status: "pending",
    results: {},
    createdAt: "2026-05-26T00:00:00Z",
    createdBy: "u",
    updatedAt: "2026-05-26T00:00:00Z",
  } as ITPInstance;
}

describe("resolveScopeName", () => {
  it("returns null for scope='job' (no scope name needed)", () => {
    expect(resolveScopeName(baseJob, instance("job"))).toBeNull();
  });

  it("returns null when scopeId is missing", () => {
    expect(resolveScopeName(baseJob, instance("level"))).toBeNull();
  });

  it("resolves a level/group id to the group name", () => {
    expect(resolveScopeName(baseJob, instance("level", "lvl_1"))).toBe(
      "Level 1",
    );
  });

  it("falls back to the raw id when the level isn't found", () => {
    expect(resolveScopeName(baseJob, instance("level", "lvl_bogus"))).toBe(
      "lvl_bogus",
    );
  });

  it("resolves an area id to the area name across groups", () => {
    expect(resolveScopeName(baseJob, instance("area", "area_kitchen"))).toBe(
      "Kitchen",
    );
    expect(resolveScopeName(baseJob, instance("area", "area_master"))).toBe(
      "Master bedroom",
    );
  });

  it("falls back to the raw id when the area isn't found", () => {
    expect(resolveScopeName(baseJob, instance("area", "area_bogus"))).toBe(
      "area_bogus",
    );
  });

  it("returns the raw id for switchboard scope (no register on Job)", () => {
    expect(
      resolveScopeName(baseJob, instance("switchboard", "MSB-01")),
    ).toBe("MSB-01");
  });
});
