import type {
  GearAssetType,
  GearAssetStatus,
  GearAssetCondition,
  GearHistoryKind,
} from "./types";

/**
 * Pure display helpers for the gear domain. Kept separate from service.ts
 * so they can be tree-shaken into client bundles without pulling the
 * derivation logic along.
 */

const TYPE_LABELS: Record<GearAssetType, string> = {
  vehicle: "Vehicle",
  key: "Key",
  tool: "Tool",
  accessory: "Accessory",
  ppe: "PPE",
  other: "Other",
};

export function typeLabel(type: GearAssetType): string {
  return TYPE_LABELS[type];
}

const STATUS_LABELS: Record<GearAssetStatus, string> = {
  available: "Available",
  assigned: "Assigned",
  damaged: "Damaged",
  missing: "Missing",
  retired: "Retired",
};

export function statusLabel(status: GearAssetStatus): string {
  return STATUS_LABELS[status];
}

const CONDITION_LABELS: Record<GearAssetCondition, string> = {
  good: "Good",
  damaged: "Damaged",
  missing: "Missing",
};

export function conditionLabel(condition: GearAssetCondition | undefined): string {
  if (!condition) return CONDITION_LABELS.good;
  return CONDITION_LABELS[condition];
}

const HISTORY_LABELS: Record<GearHistoryKind, string> = {
  transfer: "Transferred",
  check: "Checked",
  report_damaged: "Reported damaged",
  report_missing: "Reported missing",
  admin_updated: "Admin updated",
};

export function historyKindLabel(kind: GearHistoryKind | undefined): string {
  if (!kind) return HISTORY_LABELS.transfer;
  return HISTORY_LABELS[kind];
}

/**
 * Render an ISO timestamp as a short en-AU label like "12 May, 4:32 pm".
 * Returns null when the input is missing or unparseable so callers can
 * render an em-dash without a parsing guard.
 */
export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Render a YYYY-MM-DD date as a friendly en-AU label like "Mon 4 May".
 */
export function formatShortDate(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Display name for an asset row — combines the name with the identifier
 * (e.g. serial number, asset code) when present. Falls back to just the
 * name when no identifier is set.
 */
export function assetDisplayName(asset: {
  name: string;
  identifier?: string | null;
}): string {
  const id = (asset.identifier ?? "").trim();
  if (!id) return asset.name;
  return `${asset.name} · ${id}`;
}

/**
 * True if the asset's expected-return date is in the past relative to today.
 * Used by the admin register to surface overdue items.
 */
export function isOverdue(
  asset: { expectedReturn?: string | null; currentHolderId?: string | null },
  today: string
): boolean {
  if (!asset.currentHolderId) return false;
  if (!asset.expectedReturn) return false;
  return asset.expectedReturn < today;
}
