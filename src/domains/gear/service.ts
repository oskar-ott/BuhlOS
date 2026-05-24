import type {
  GearAsset,
  GearAssetStatus,
  GearAssetCondition,
  GearHistoryEntry,
  GearHistoryKind,
  ReportKind,
} from "./types";

/**
 * Pure helpers for the gear domain. No I/O, no React, no globals —
 * everything here is unit-testable in isolation.
 *
 * Cross-ref:
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 *   docs/rebuild-audit/13-ui-information-architecture.md §Section Gear
 */

/**
 * Derive the audit-spec status enum from the legacy storage fields.
 *
 * Precedence: `archived` beats condition beats holder presence — an archived
 * asset is `retired` regardless of who last held it, and a damaged item
 * stays `damaged` whether or not it has a current holder (the damage
 * report itself is what the admin queue needs to see).
 */
export function deriveStatus(asset: GearAsset): GearAssetStatus {
  if (asset.archived === true) return "retired";
  if (asset.condition === "damaged") return "damaged";
  if (asset.condition === "missing") return "missing";
  if (asset.currentHolderId) return "assigned";
  return "available";
}

/**
 * Whether `next` is a legal status transition from `current`.
 *
 * Transitions:
 *   available  → assigned | damaged | missing | retired
 *   assigned   → available | damaged | missing | retired
 *   damaged    → available (admin marks repaired) | retired
 *   missing    → available (recovered) | retired
 *   retired    → (terminal — must restore via admin)
 *
 * Invalid transitions return false; callers should surface a clear error
 * rather than silently no-op.
 */
export function canTransition(current: GearAssetStatus, next: GearAssetStatus): boolean {
  if (current === next) return false;
  if (current === "retired") return false;
  switch (current) {
    case "available":
      return next === "assigned" || next === "damaged" || next === "missing" || next === "retired";
    case "assigned":
      return next === "available" || next === "damaged" || next === "missing" || next === "retired";
    case "damaged":
      return next === "available" || next === "retired";
    case "missing":
      return next === "available" || next === "retired";
  }
}

/**
 * True if the supplied user is allowed to act on the supplied asset from
 * Phil. Tradies / LH / apprentices / labourers / electricians may only act
 * on gear currently held by them. Admin sees all and bypasses this check.
 */
export function canWorkerActOnAsset(
  asset: Pick<GearAsset, "currentHolderId">,
  userId: string,
  role: string
): boolean {
  if (role === "admin") return true;
  return asset.currentHolderId === userId;
}

/**
 * The action the Phil "Return" button performs is `transfer to null` — the
 * legacy server treats `toUserId === null` as "return to depot/storage".
 * This helper keeps callers honest about that semantic.
 */
export function buildReturnToDepotPayload(asset: Pick<GearAsset, "id">): {
  assetId: string;
  toUserId: null;
  expectedReturn: null;
  note: string;
} {
  return {
    assetId: asset.id,
    toUserId: null,
    expectedReturn: null,
    note: "Returned to depot",
  };
}

/**
 * Map a Phil report action ("damaged" / "missing" / "check") onto the
 * history entry kind that gets persisted. Used by the report endpoint and
 * the history-rendering UI.
 */
export function historyKindForReport(kind: ReportKind): GearHistoryKind {
  switch (kind) {
    case "check":
      return "check";
    case "damaged":
      return "report_damaged";
    case "missing":
      return "report_missing";
  }
}

/**
 * Effective condition after applying a report kind. `check` does not
 * change condition (the asset stays whatever it was). `damaged` /
 * `missing` set the named condition.
 */
export function applyReportCondition(
  current: GearAssetCondition | undefined,
  kind: ReportKind
): GearAssetCondition {
  if (kind === "damaged") return "damaged";
  if (kind === "missing") return "missing";
  return current ?? "good";
}

/**
 * Slice a history log into discrete `GearAssignment` periods — each
 * assignment begins with a transfer to a non-null holder and ends at the
 * next transfer event (whether to another worker or back to storage).
 *
 * Phil and admin both surface "who has held this when" via this slice.
 * The slice is derived, not stored — there is no `GearAssignment` blob in
 * Vercel Blob.
 */
export interface GearAssignmentSlice {
  workerId: string;
  workerName: string | null;
  startedAt: string;
  endedAt: string | null;
  assignedBy: string | null;
  assignedByName: string | null;
  endNote: string | null;
}

export function assignmentsFromHistory(
  history: ReadonlyArray<GearHistoryEntry>
): ReadonlyArray<GearAssignmentSlice> {
  // History is returned newest-first by the server. Reverse to process
  // chronologically so we can pair "transfer in" with the next "transfer out".
  const chronological = [...history].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const slices: GearAssignmentSlice[] = [];
  let open: GearAssignmentSlice | null = null;
  for (const entry of chronological) {
    const kind = entry.kind ?? "transfer";
    if (kind !== "transfer") continue;
    // Close any open slice at this transfer point.
    if (open && entry.from && open.workerId === entry.from) {
      open.endedAt = entry.at;
      open.endNote = entry.note ?? null;
      slices.push(open);
      open = null;
    } else if (open) {
      // Defensive: transfer doesn't line up with the open slice (data drift).
      open.endedAt = entry.at;
      slices.push(open);
      open = null;
    }
    if (entry.to) {
      open = {
        workerId: entry.to,
        workerName: entry.toName ?? null,
        startedAt: entry.at,
        endedAt: null,
        assignedBy: entry.byUserId ?? null,
        assignedByName: entry.byName ?? null,
        endNote: null,
      };
    }
  }
  if (open) slices.push(open);
  // Return newest-first to match the rest of the UI.
  return slices.reverse();
}

/**
 * The status pill colour for an asset. Pure mapping so the Pill component
 * stays in `src/components/ui` and isn't coupled to the gear domain.
 */
export function statusTone(status: GearAssetStatus): "success" | "info" | "danger" | "warning" | "neutral" {
  switch (status) {
    case "available":
      return "success";
    case "assigned":
      return "info";
    case "damaged":
      return "danger";
    case "missing":
      return "warning";
    case "retired":
      return "neutral";
  }
}
