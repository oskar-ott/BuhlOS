// Epic 5 (#199) — the searchable sheet registry, as pure projection logic.
//
// Turns the #197 effective sheets (override > AI, needs-review derived
// server-side) + the job's plan documents into flat registry rows, then
// search/filter over them. Read-only by design: corrections happen in the
// foundation's review flow (#197), never here.

import type { EffectiveSheet, SheetType } from "./schema";

/** What the registry needs to know about a source plan document. */
export interface RegistrySourcePlan {
  id: string;
  label: string;
  status: string;
  pages: ReadonlyArray<{ pageIndex: number; pngUrl: string }>;
}

export interface RegistryRow {
  planId: string;
  pageIndex: number;
  /** Deep link to the rendered page image; null if the page is no longer registered. */
  pngUrl: string | null;
  docLabel: string;
  docStatus: string;
  sheetType: string | null;
  sheetNumber: string | null;
  sheetTitle: string | null;
  revision: string | null;
  scale: string | null;
  needsReview: boolean;
  /** At least one field carries a human correction. */
  corrected: boolean;
}

/** Numeric-aware compare so E-2 sorts before E-10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildRegistryRows(
  sheets: ReadonlyArray<EffectiveSheet>,
  plans: ReadonlyArray<RegistrySourcePlan>,
): RegistryRow[] {
  const planById = new Map(plans.map((p) => [p.id, p]));
  const rows = sheets.map((s): RegistryRow => {
    const plan = planById.get(s.planId);
    const pngUrl =
      plan?.pages.find((pg) => pg.pageIndex === s.pageIndex)?.pngUrl ?? null;
    const fields = [
      s.fields.sheetType,
      s.fields.sheetNumber,
      s.fields.sheetTitle,
      s.fields.revision,
      s.fields.scale,
    ];
    return {
      planId: s.planId,
      pageIndex: s.pageIndex,
      pngUrl,
      // An unknown plan id (document deleted after extraction) is labelled
      // honestly rather than invented (P7).
      docLabel: plan?.label ?? "(document no longer on this job)",
      docStatus: plan?.status ?? "unknown",
      sheetType: s.fields.sheetType.effective,
      sheetNumber: s.fields.sheetNumber.effective,
      sheetTitle: s.fields.sheetTitle.effective,
      revision: s.fields.revision.effective,
      scale: s.fields.scale.effective,
      needsReview: s.needsReview,
      corrected: fields.some((f) => f.override !== null),
    };
  });
  // Sheet number is the primary key of the register mental model — numbered
  // sheets first in natural order, unnumbered ones after (grouped by doc).
  rows.sort((a, b) => {
    if (a.sheetNumber !== null && b.sheetNumber !== null) {
      const byNumber = naturalCompare(a.sheetNumber, b.sheetNumber);
      if (byNumber !== 0) return byNumber;
    } else if (a.sheetNumber !== null) {
      return -1;
    } else if (b.sheetNumber !== null) {
      return 1;
    }
    const byDoc = naturalCompare(a.docLabel, b.docLabel);
    if (byDoc !== 0) return byDoc;
    return a.pageIndex - b.pageIndex;
  });
  return rows;
}

export function filterRegistryRows(
  rows: ReadonlyArray<RegistryRow>,
  query: string,
  type: SheetType | "all",
): RegistryRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (type !== "all" && r.sheetType !== type) return false;
    if (!q) return true;
    return (
      (r.sheetNumber ?? "").toLowerCase().includes(q) ||
      (r.sheetTitle ?? "").toLowerCase().includes(q) ||
      r.docLabel.toLowerCase().includes(q)
    );
  });
}
