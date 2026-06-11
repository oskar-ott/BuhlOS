import { describe, expect, it } from "vitest";
import { autoNumberedNames, instantiatePreset } from "./structure-presets";

const PRESET = {
  group: {
    name: "Townhouse unit",
    areas: [
      {
        name: "Kitchen",
        spaceType: "wet area",
        roughInTasks: [{ name: "Island feed" }],
      },
      { name: "Garage" },
    ],
  },
};

describe("autoNumberedNames (#192)", () => {
  it("starts above the highest existing number — an existing 'Unit 7' never collides", () => {
    expect(autoNumberedNames("Unit", 3, ["Unit 7", "Ground", "Unit 2"])).toEqual([
      "Unit 8",
      "Unit 9",
      "Unit 10",
    ]);
  });

  it("a single insert keeps the bare name when free, numbers it when taken", () => {
    expect(autoNumberedNames("Roof", 1, ["Ground"])).toEqual(["Roof"]);
    expect(autoNumberedNames("Roof", 1, ["Roof"])).toEqual(["Roof 1"]);
  });

  it("skips explicit collisions inside the run and escapes regex-special bases", () => {
    expect(autoNumberedNames("Unit", 2, ["Unit 1", "Unit 3"])).toEqual(["Unit 4", "Unit 5"]);
    expect(autoNumberedNames("Block (A)", 2, ["Block (A) 5"])).toEqual([
      "Block (A) 6",
      "Block (A) 7",
    ]);
  });
});

describe("instantiatePreset (#192)", () => {
  it("creates one id-less group per name with deep-copied areas and overrides", () => {
    const groups = instantiatePreset(PRESET, ["Unit 8", "Unit 9"]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.name).toBe("Unit 8");
    expect(groups[0]!.areas.map((a) => a.name)).toEqual(["Kitchen", "Garage"]);
    expect(groups[0]!.areas[0]!.spaceType).toBe("wet area");
    expect(groups[0]!.areas[0]!.roughInTasks).toEqual([{ name: "Island feed" }]);
    expect("id" in groups[0]!).toBe(false);
    expect("id" in groups[0]!.areas[0]!).toBe(false);
    // copies are independent — mutating one never bleeds into its sibling
    groups[0]!.areas[0]!.name = "Mutated";
    expect(groups[1]!.areas[0]!.name).toBe("Kitchen");
  });
});
