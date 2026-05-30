import type { StatusTone } from "@/components/ui/StatusChip";
import type { MaterialRequestStatus, MaterialRequestUrgency } from "./types";

const STATUS_LABELS: Record<MaterialRequestStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  ordered: "Ordered",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function statusLabel(status: MaterialRequestStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const STATUS_TONES: Record<MaterialRequestStatus, StatusTone> = {
  requested: "warning",
  approved: "info",
  ordered: "navy",
  delivered: "success",
  cancelled: "neutral",
};

export function statusTone(status: MaterialRequestStatus): StatusTone {
  return STATUS_TONES[status] ?? "neutral";
}

const URGENCY_LABELS: Record<MaterialRequestUrgency, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function urgencyLabel(urgency: MaterialRequestUrgency): string {
  return URGENCY_LABELS[urgency] ?? urgency;
}

const URGENCY_TONES: Record<MaterialRequestUrgency, StatusTone> = {
  urgent: "danger",
  high: "warning",
  normal: "neutral",
  low: "neutral",
};

export function urgencyTone(urgency: MaterialRequestUrgency): StatusTone {
  return URGENCY_TONES[urgency] ?? "neutral";
}

/**
 * Render the qty + unit succinctly: "20 m", "1 box", "1.5 kg".
 * Drops the leading-zero decimal for integer qtys and trims trailing
 * zeroes from fractional ones.
 */
export function formatQuantity(quantity: number, unit: string): string {
  const qty = Number.isFinite(quantity) ? quantity : 0;
  const formatted = Number.isInteger(qty)
    ? String(qty)
    : qty.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted} ${unit || ""}`.trim();
}
