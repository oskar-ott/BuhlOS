import { DOCUMENT_CATEGORIES } from "./schema";
import type { Document, DocumentCategory, DocumentStatus } from "./types";

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
