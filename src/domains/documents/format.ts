import { DOCUMENT_CATEGORIES } from "./schema";
import type {
  Document,
  DocumentCategory,
  DocumentStage,
  DocumentStatus,
} from "./types";

/**
 * Pure display helpers for the documents domain.
 *
 * No fetch, no React, no Zod runtime in scope — server + client
 * components import freely. Same shape as src/domains/itp/format.ts.
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §6.2 (palette)
 *   docs/rebuild-audit/36-documents-specs-readiness-note.md
 */

/* ---------------------------------------------------------------------
 * Status labels + tones
 * -------------------------------------------------------------------*/

const STATUS_LABELS: Record<DocumentStatus, string> = {
  current: "Current",
  superseded: "Superseded",
  archived: "Archived",
};

export function statusLabel(status: DocumentStatus | null | undefined): string {
  // Legacy rows pre-status-field default to 'current' (matches the
  // api/plans.js upload writer behaviour).
  if (!status) return STATUS_LABELS.current;
  return STATUS_LABELS[status];
}

export type DocumentStatusTone = "success" | "info" | "neutral";

export function statusTone(
  status: DocumentStatus | null | undefined,
): DocumentStatusTone {
  switch (status) {
    case "current":
    case undefined:
    case null:
      return "success";
    case "superseded":
      return "info";
    case "archived":
      return "neutral";
  }
}

/* ---------------------------------------------------------------------
 * Category labels (closed-set + 'other' fallback)
 * -------------------------------------------------------------------*/

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  plan: "Plan",
  spec: "Spec",
  schedule: "Schedule",
  photo: "Photo",
  certificate: "Certificate",
  contract: "Contract / SOW",
  other: "Other",
};

const CATEGORY_SET: ReadonlySet<string> = new Set(DOCUMENT_CATEGORIES);

/**
 * Returns the human label for a category. Empty / unknown values map
 * to "Other" so the viewer never shows a blank chip — matches the
 * `(p.category || 'other')` fallback in public/admin/plans.html.
 */
export function categoryLabel(category: string | null | undefined): string {
  const key = String(category ?? "").trim().toLowerCase();
  if (CATEGORY_SET.has(key)) {
    return CATEGORY_LABELS[key as DocumentCategory];
  }
  return CATEGORY_LABELS.other;
}

/**
 * Returns the canonical category enum value for a raw input. Unknown
 * → 'other'. Used by the admin filter chips so each plan maps to one
 * of the six known buckets.
 */
export function normaliseCategory(
  category: string | null | undefined,
): DocumentCategory {
  const key = String(category ?? "").trim().toLowerCase();
  if (CATEGORY_SET.has(key)) return key as DocumentCategory;
  return "other";
}

/* ---------------------------------------------------------------------
 * MIME type labels
 * -------------------------------------------------------------------*/

export function mimeTypeLabel(mime: string | null | undefined): string {
  const m = String(mime ?? "").toLowerCase();
  if (m === "application/pdf") return "PDF";
  if (m === "image/png") return "PNG";
  if (m === "image/jpeg" || m === "image/jpg") return "JPG";
  if (m === "image/webp") return "WebP";
  if (m === "image/heic") return "HEIC";
  if (m.startsWith("image/")) return "Image";
  return "File";
}

/* ---------------------------------------------------------------------
 * Size formatting
 * -------------------------------------------------------------------*/

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------------
 * Title + identity helpers
 * -------------------------------------------------------------------*/

/**
 * The single most informative one-liner for a row. Prefers the
 * admin-entered title, falls back to drawing number, then file name,
 * then "(untitled document)" so the viewer always has something to
 * show.
 */
export function displayTitle(doc: Document): string {
  const t = String(doc.title ?? "").trim();
  if (t) return t;
  const dn = String(doc.drawingNumber ?? "").trim();
  if (dn) return dn;
  const fn = String(doc.fileName ?? "").trim();
  if (fn) return fn;
  return "(untitled document)";
}

/**
 * Drawing identity line: "E-200 · Rev C · Level 1". Pieces omitted
 * when empty so we never render "· ·" stutter.
 */
export function drawingContextLine(doc: Document): string {
  const parts: string[] = [];
  const dn = String(doc.drawingNumber ?? "").trim();
  if (dn) parts.push(dn);
  const rev = String(doc.revision ?? "").trim();
  if (rev) parts.push(`Rev ${rev}`);
  const lvl = String(doc.level ?? "").trim();
  if (lvl) parts.push(lvl);
  return parts.join(" · ");
}

/* ---------------------------------------------------------------------
 * Lifecycle predicates
 * -------------------------------------------------------------------*/

export function isCurrent(doc: Pick<Document, "status">): boolean {
  // Legacy rows without a status field default to 'current' on the
  // writer side; mirror that here so the viewer doesn't drop them.
  return !doc.status || doc.status === "current";
}

export function isSuperseded(doc: Pick<Document, "status">): boolean {
  return doc.status === "superseded";
}

export function isArchived(doc: Pick<Document, "status">): boolean {
  return doc.status === "archived";
}

/* ---------------------------------------------------------------------
 * Sort + grouping
 * -------------------------------------------------------------------*/

/**
 * Stable sort comparator for the queue: current first, then
 * superseded, then archived. Within the same status, newest
 * uploadedAt first.
 */
export function compareForQueue(
  a: Pick<Document, "status" | "uploadedAt">,
  b: Pick<Document, "status" | "uploadedAt">,
): number {
  const so = (s: DocumentStatus | undefined | null): number => {
    if (!s || s === "current") return 0;
    if (s === "superseded") return 1;
    return 2;
  };
  const sa = so(a.status);
  const sb = so(b.status);
  if (sa !== sb) return sa - sb;
  return String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? ""));
}

/**
 * Group by `drawingNumber` (or null when missing), preserving the
 * input order of distinct drawing numbers. Within each group, sort
 * newest revision first by uploadedAt so the current revision lands
 * at the top of its lineage.
 *
 * Used by the admin queue's revision-lineage view: each group renders
 * as a header (drawing number + current revision) and the rest of the
 * group as a "Previous revisions" expander.
 */
export interface DocumentGroup {
  drawingNumber: string | null;
  documents: ReadonlyArray<Document>;
}

export function groupByDrawing(
  docs: ReadonlyArray<Document>,
): ReadonlyArray<DocumentGroup> {
  const order: string[] = [];
  const buckets = new Map<string, Document[]>();
  const NULL_KEY = "__no_drawing__";
  for (const d of docs) {
    const raw = String(d.drawingNumber ?? "").trim();
    const key = raw || NULL_KEY;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(d);
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!.slice();
    bucket.sort((a, b) =>
      String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")),
    );
    return {
      drawingNumber: key === NULL_KEY ? null : key,
      documents: bucket,
    };
  });
}

/** #194: display label for a drawing discipline; undefined/legacy → Other. */
export function disciplineLabel(discipline: string | undefined | null): string {
  switch (discipline) {
    case "architectural": return "Architectural";
    case "electrical": return "Electrical";
    case "services": return "Services";
    case "structural": return "Structural";
    default: return "Other";
  }
}

/** Stable section order for the grouped register view. */
export const DISCIPLINE_ORDER = [
  "electrical",
  "architectural",
  "services",
  "structural",
  "other",
] as const;

/* ---------------------------------------------------------------------
 * #196 — specifications: identity, area linkage, clause label
 *
 * A spec is just a document whose category normalises to 'spec'. Specs
 * carry no drawingNumber, so they group under the null-drawing bucket in
 * the drawings register — this layer surfaces them as a first-class
 * Specifications section instead. Area linkage is additive metadata
 * (`areaIds` / `areaLinks` / `stage`); these helpers are pure so both
 * surfaces (admin chips + Phil area block) read them the same way.
 * -------------------------------------------------------------------*/

/** True when a document's category normalises to 'spec'. */
export function isSpec(doc: Pick<Document, "category">): boolean {
  return normaliseCategory(doc.category) === "spec";
}

/** Stage label for a spec link. roughIn → "Rough-in", fitOff → "Fit-off".
 *  Reuses no jobs-domain import so the documents domain stays standalone;
 *  the two strings match src/domains/jobs/format.ts#stageLabel. */
export function specStageLabel(stage: DocumentStage | null | undefined): string {
  if (stage === "roughIn") return "Rough-in";
  if (stage === "fitOff") return "Fit-off";
  return "";
}

/**
 * The clause / section label for a spec, drawn from the row's `level`
 * field (the upload form's "Section / clause" input writes there for
 * specs — specs have no drawing level). Empty when not set, so the
 * caller can omit the line rather than render a blank.
 */
export function clauseLabel(doc: Pick<Document, "level">): string {
  return String(doc.level ?? "").trim();
}

/**
 * The specs that govern a given area, optionally narrowed to a stage.
 *
 * A spec governs an area when its `areaIds` includes that area's id. When
 * `stage` is passed, a spec matches if it has NO stage (governs both) or
 * its stage equals the requested one — so a stage filter never hides an
 * unstaged, area-linked spec. Pure + allocation-light; both Phil's
 * area block and the admin per-area view share it.
 */
export function filterSpecsByArea<T extends Pick<Document, "category" | "areaIds" | "stage">>(
  docs: ReadonlyArray<T>,
  areaId: string,
  stage?: DocumentStage,
): ReadonlyArray<T> {
  return docs.filter((d) => {
    if (!isSpec(d)) return false;
    const ids = Array.isArray(d.areaIds) ? d.areaIds : [];
    if (!ids.includes(areaId)) return false;
    if (stage && d.stage && d.stage !== stage) return false;
    return true;
  });
}

/** A resolved area-link chip for the admin register. `live` is true when
 *  the areaId still exists on the job (name taken from the live job tree);
 *  false marks a dangling link — the area was removed after linking, so
 *  we render an honest "linked area no longer on this job" instead of a
 *  fabricated name (P7). */
export interface ResolvedAreaLink {
  areaId: string;
  /** Display name. For a live link, the current job-tree name (preferred
   *  over the possibly-stale denormalised name); for a dangling link, the
   *  honest placeholder. */
  name: string;
  live: boolean;
}

/** Honest label for a link whose area is no longer on the job. */
export const DANGLING_AREA_LABEL = "linked area no longer on this job";

/**
 * Resolve a spec's `areaIds` to display chips against the live job area
 * map (`areaId → name`). A linked area still on the job renders with its
 * CURRENT name (the live map wins over the denormalised `areaLinks` cache,
 * so a rename shows through). A linked area no longer on the job renders
 * as a dangling link — never silently dropped, never a fabricated name.
 *
 * `areaLinks` (the denormalised name cache) is only used as a last-ditch
 * fallback when the live map is absent for that id AND the link still
 * isn't dangling — which can't happen here, so dangling always wins the
 * honest label. Order follows `areaIds`.
 */
export function resolveAreaLinks(
  doc: {
    areaIds?: ReadonlyArray<string>;
    areaLinks?: ReadonlyArray<{ areaId: string; areaName: string }>;
  },
  liveAreaNames: ReadonlyMap<string, string>,
): ReadonlyArray<ResolvedAreaLink> {
  const ids = Array.isArray(doc.areaIds) ? doc.areaIds : [];
  return ids.map((areaId) => {
    const liveName = liveAreaNames.get(areaId);
    if (liveName != null) {
      return { areaId, name: liveName, live: true };
    }
    return { areaId, name: DANGLING_AREA_LABEL, live: false };
  });
}

/**
 * Pull the spec rows out of a document list, newest first. Used by the
 * admin Specifications section and (current-filtered) by Phil. Pure;
 * does not mutate the input.
 */
export function groupSpecs(
  docs: ReadonlyArray<Document>,
): ReadonlyArray<Document> {
  return docs
    .filter(isSpec)
    .slice()
    .sort((a, b) =>
      String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")),
    );
}
