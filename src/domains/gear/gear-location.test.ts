import { describe, expect, it } from "vitest";
import {
  GearLocationSchema,
  isVehicleLocation,
  locationKey,
  gearLocationLabel,
  assetsInVehicle,
  groupAssetsByLocation,
  vehicleInventoryCount,
  type GearLocation,
  type LocatedAsset,
} from "./gear-location";

const asset = (id: string, name: string, location?: GearLocation | null): LocatedAsset =>
  ({ id, name, location: location ?? null }) as LocatedAsset;

const VAN = asset("van1", "Ute 1 — ABC123");
const DRILL = asset("d1", "Hilti drill", { kind: "vehicle", assetId: "van1" });
const TESTER = asset("t1", "Fluke tester", { kind: "vehicle", assetId: "van1" });
const LADDER = asset("l1", "Ladder", { kind: "storage" });
const LOOSE = asset("x1", "Unknown item"); // no location

describe("GearLocationSchema", () => {
  it("accepts storage + vehicle, rejects a vehicle with no assetId", () => {
    expect(GearLocationSchema.safeParse({ kind: "storage" }).success).toBe(true);
    expect(GearLocationSchema.safeParse({ kind: "vehicle", assetId: "van1" }).success).toBe(true);
    expect(GearLocationSchema.safeParse({ kind: "vehicle" }).success).toBe(false);
    expect(GearLocationSchema.safeParse({ kind: "spaceship" }).success).toBe(false);
  });
});

describe("location key + label", () => {
  it("isVehicleLocation / locationKey", () => {
    expect(isVehicleLocation({ kind: "vehicle", assetId: "van1" })).toBe(true);
    expect(isVehicleLocation({ kind: "storage" })).toBe(false);
    expect(locationKey(null)).toBe("unassigned");
    expect(locationKey({ kind: "storage" })).toBe("storage");
    expect(locationKey({ kind: "vehicle", assetId: "van1" })).toBe("vehicle:van1");
  });
  it("labels resolve a van's name (and degrade honestly)", () => {
    const nameOf = (id: string) => (id === "van1" ? "Ute 1 — ABC123" : undefined);
    expect(gearLocationLabel(null)).toBe("Unassigned");
    expect(gearLocationLabel({ kind: "storage" })).toBe("Storage");
    expect(gearLocationLabel({ kind: "vehicle", assetId: "van1" }, nameOf)).toBe("Van — Ute 1 — ABC123");
    expect(gearLocationLabel({ kind: "vehicle", assetId: "gone" }, nameOf)).toBe("Van — (unknown)");
  });
});

describe("a van's inventory", () => {
  const ALL = [VAN, DRILL, TESTER, LADDER, LOOSE];
  it("assetsInVehicle / vehicleInventoryCount lists what's in the van", () => {
    expect(assetsInVehicle(ALL, "van1").map((a) => a.id)).toEqual(["d1", "t1"]);
    expect(vehicleInventoryCount(ALL, "van1")).toBe(2);
    expect(vehicleInventoryCount(ALL, "van-none")).toBe(0);
  });
});

describe("groupAssetsByLocation", () => {
  it("groups by location with van names, first-seen order, unassigned bucket", () => {
    const groups = groupAssetsByLocation([VAN, DRILL, LADDER, LOOSE, TESTER]);
    // VAN itself has no location → unassigned; then vehicle:van1; then storage
    expect(groups.map((g) => g.key)).toEqual(["unassigned", "vehicle:van1", "storage"]);
    const vanGroup = groups.find((g) => g.key === "vehicle:van1")!;
    expect(vanGroup.label).toBe("Van — Ute 1 — ABC123");
    expect(vanGroup.assets.map((a) => a.id)).toEqual(["d1", "t1"]);
    expect(groups.find((g) => g.key === "unassigned")!.assets.map((a) => a.id)).toEqual(["van1", "x1"]);
  });
});
