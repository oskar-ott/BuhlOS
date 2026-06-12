import type { QuoteStatus } from "./schema";

/**
 * Display vocabulary for quote statuses (#183) — one place, so the list,
 * the builder and any future pipeline widget print the same words and the
 * same doc 27 §6.1 tones (the DefectsRegister "no parallel vocabulary" rule).
 */

const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  won: "Won",
  lost: "Lost",
  archived: "Archived",
};

export function quoteStatusLabel(status: QuoteStatus): string {
  return STATUS_LABELS[status];
}

export type QuoteStatusTone = "neutral" | "info" | "success" | "danger";

export function quoteStatusTone(status: QuoteStatus): QuoteStatusTone {
  switch (status) {
    case "submitted":
      return "info";
    case "won":
      return "success";
    case "lost":
      return "danger";
    case "draft":
    case "archived":
      return "neutral";
  }
}
