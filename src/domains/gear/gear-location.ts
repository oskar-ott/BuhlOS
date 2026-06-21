import { z } from "zod";
import type { GearAsset } from "./types";

/**
 * Gear locations — vans as locations with their own inventory (#307). Pure
 * model + composition, no I/O, no React.
 *
 * A van IS a gear asset; this adds an optional, additive LOCATION to an asset
 * saying where it lives: general `storage` or inside a `vehicle` (another
 * asset's id). Designed once to also admit `{kind:'store', locationId}` for the
 * warehouse-locations slice (#322) without a reshape. The helpers group the
 * register by location and answer "what's in this van".
 *
 * Additive + decoupled: `location` rides on an asset via passthrough; this
 * module never edits GearAssetSchema. Persistence (making `location` a first-
 * class field) + the register UI are deferred consumers — so this slice touches
 * only NEW files (zero conflict).
 */

export const GEAR_LOCATION_KINDS = ["storage", "vehicle"] as const;

export const GearLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("storage") }).passthrough(),
  z.object({ kind: z.literal("vehicle"), assetId: z.string().min(1) }).passthrough(),
]);
export type GearLocation = z.infer<typeof GearLocationSchema>;

/** An asset that may carry a location (the field is additive / passthrough). */
export type LocatedAsset = GearAsset & { location?: GearLocation | null };

export function isVehicleLocation(
  loc: GearLocation | null | undefined,
): loc is { kind: "vehicle"; assetId: string } {
  return !!loc && loc.kind === "vehicle";
}

/** Stable grouping key: "unassigned" | "storage" | "vehicle:<assetId>". */
export function locationKey(loc: GearLocation | null | undefined): string {
  if (!loc) return "unassigned";
  return isVehicleLocation(loc) ? `vehicle:${loc.assetId}` : loc.kind;
}

/** Human label. `nameOf` resolves a vehicle's asset id to its name. */
export function gearLocationLabel(
  loc: GearLocation | null | undefined,
  nameOf?: (assetId: string) => string | undefined,
): string {
  if (!loc) return "Unassigned";
  if (isVehicleLocation(loc)) {
    const name = nameOf?.(loc.assetId);
    return name ? `Van — ${name}` : "Van — (unknown)";
  }
  return "Storage";
}

/** The assets currently inside a given vehicle (its inventory). */
export function assetsInVehicle<T extends LocatedAsset>(
  assets: ReadonlyArray<T>,
  vehicleAssetId: string,
): T[] {
  return assets.filter((a) => isVehicleLocation(a.location) && a.location.assetId === vehicleAssetId);
}

export interface LocationGroup<T extends LocatedAsset = LocatedAsset> {
  key: string;
  label: string;
  location: GearLocation | null;
  assets: T[];
}

/**
 * Group a register by location (first-seen order). A van's own asset name labels
 * its group; assets with no location fall under "Unassigned".
 */
export function groupAssetsByLocation<T extends LocatedAsset>(
  assets: ReadonlyArray<T>,
): Array<LocationGroup<T>> {
  const nameById = new Map<string, string>();
  for (const a of assets) if (a.name) nameById.set(a.id, a.name);
  const nameOf = (id: string) => nameById.get(id);

  const order: string[] = [];
  const groups = new Map<string, LocationGroup<T>>();
  for (const a of assets) {
    const loc = a.location ?? null;
    const key = locationKey(loc);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: gearLocationLabel(loc, nameOf), location: loc, assets: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.assets.push(a);
  }
  return order.map((k) => groups.get(k)!);
}

/** How many assets live in a given vehicle. */
export function vehicleInventoryCount(assets: ReadonlyArray<LocatedAsset>, vehicleAssetId: string): number {
  return assetsInVehicle(assets, vehicleAssetId).length;
}
