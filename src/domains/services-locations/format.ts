import type { ServiceLocationRecord, ServiceLocationType } from "./types";

/**
 * Pure display helpers for the services-locations domain (#230). Kept
 * separate from the schema + service layers so they can be imported by
 * both server and client components without dragging Zod runtime cost.
 *
 * Site language (P11): "Main switchboard", "Meter", "Temp supply" — what a
 * sparky calls them on the job, not "TempSupply" or an enum string.
 *
 * Cross-ref:
 *   src/domains/snags/format.ts — precedent
 */

const TYPE_LABELS: Record<ServiceLocationType, string> = {
  pit: "Pit",
  switchboard: "Main switchboard",
  meter: "Meter",
  tempSupply: "Temp supply",
  other: "Other service",
};

/** Site-language label for a service type. */
export function typeLabel(type: ServiceLocationType): string {
  return TYPE_LABELS[type] ?? "Service";
}

/** The heading a row should show: the worker's label if they gave one,
 *  else the type label. Never an empty string. */
export function displayHeading(record: {
  type: ServiceLocationType;
  label?: string | null;
}): string {
  const label = (record.label ?? "").trim();
  return label || typeLabel(record.type);
}

/** True when the job has at least one service location. The Phil + admin
 *  surfaces render-null when this is false (P10 — no empty card). */
export function hasServices(
  records: ReadonlyArray<ServiceLocationRecord>,
): boolean {
  return records.length > 0;
}

/** Stable display order: group by type in a sensible site order (board →
 *  meter → pit → temp → other), then newest first within a type. Returns a
 *  NEW array (never mutates the input). */
const TYPE_ORDER: Record<ServiceLocationType, number> = {
  switchboard: 0,
  meter: 1,
  pit: 2,
  tempSupply: 3,
  other: 4,
};

export function sortForDisplay(
  records: ReadonlyArray<ServiceLocationRecord>,
): ServiceLocationRecord[] {
  return records.slice().sort((a, b) => {
    const ta = TYPE_ORDER[a.type] ?? 99;
    const tb = TYPE_ORDER[b.type] ?? 99;
    if (ta !== tb) return ta - tb;
    // Newest first within a type.
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}
