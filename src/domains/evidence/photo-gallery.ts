import { z } from "zod";
import type { EvidenceItem } from "./types";

/**
 * Read-only photo gallery model (#242 — "Job Bible" photos view).
 *
 * A job's photos already exist across three shipped pipelines but can't be
 * BROWSED in one place:
 *   1. Evidence-pipeline photos — captured in Phil, reviewed in BuhlOS
 *      (`api/evidence.js` → EvidenceItem with kind=photo).
 *   2. Snag photos — attached to a defect (`api/photos-catalog.js` source
 *      `snag`).
 *   3. Dwelling / ITP photos — stage photos indexed per dwelling
 *      (`api/photos-catalog.js` source `dwelling`).
 *
 * This module is a PURE READ PROJECTION: it merges those sources into one
 * `GalleryPhoto[]` model, plus a date-grouping helper and a filter predicate.
 * It writes nothing, fetches nothing, and invents no data — every field is
 * carried from a real record. Counts derive from the real list.
 *
 * Scope boundary (issue #242 / Epic 10): NO capture, NO AI tagging. This is a
 * gallery + filtering only.
 *
 * UNUNIFIED SOURCES — named, never silently dropped:
 *   - The `api/photos-catalog.js` `dwelling` source covers BOTH dwelling stage
 *     photos AND the ITP/dwelling indexed photos (one `photos-index.json` store);
 *     it does not distinguish them, so the gallery labels these "ITP / dwelling".
 *   - Evidence-pipeline NOTE captures (kind=note) carry no image; they appear
 *     as `isNote` entries so a date group is honest about what was captured,
 *     never shown as a broken thumbnail.
 *   - Catalog-only photos (snag / ITP / dwelling) have no EvidenceDrawer — the
 *     UI links them to their source surface (the snag) or shows the full image;
 *     it must never fabricate an evidence detail for them.
 *
 * Cross-ref:
 *   api/photos-catalog.js — the snag + dwelling/ITP catalog (read-only, gated)
 *   src/domains/evidence/schema.ts — the evidence list endpoint shape
 *   docs/architecture/proof-review-model.md — proof granularity (not per-task)
 */

/** Source pipeline a gallery photo came from. */
export const GALLERY_SOURCE_KINDS = ["evidence", "snag", "itp"] as const;
export type GallerySourceKind = (typeof GALLERY_SOURCE_KINDS)[number];

/**
 * Wire schema for a single `api/photos-catalog.js` photo entry. Mirrors the
 * documented JSON shape (snag + dwelling/ITP rows). `.passthrough()` so future
 * catalog fields don't break parsing here (same convention as the evidence
 * schema).
 */
export const PhotoCatalogEntrySchema = z
  .object({
    source: z.enum(["snag", "dwelling"]),
    id: z.string(),
    url: z.string(),
    addedBy: z.string().optional().default(""),
    addedAt: z.string().optional().default(""),
    // Snag context (present when source === 'snag').
    snagId: z.string().optional(),
    snagDesc: z.string().optional(),
    snagPriority: z.string().optional(),
    snagStatus: z.string().optional(),
    // Dwelling / ITP context.
    dwellingId: z.string().optional(),
    dwellingName: z.string().optional(),
    stage: z.string().optional(),
  })
  .passthrough();
export type PhotoCatalogEntry = z.infer<typeof PhotoCatalogEntrySchema>;

/** GET /api/photos-catalog?jobId=X response. */
export const PhotoCatalogResponseSchema = z.object({
  jobId: z.string(),
  jobName: z.string().optional().default(""),
  counts: z
    .object({
      total: z.number(),
      snag: z.number(),
      dwelling: z.number(),
    })
    .optional(),
  photos: z.array(PhotoCatalogEntrySchema),
});
export type PhotoCatalogResponse = z.infer<typeof PhotoCatalogResponseSchema>;

/**
 * Unified, read-only gallery photo. Every field comes from a real record.
 * `evidenceItem` is carried ONLY for `sourceKind === 'evidence'` so the UI can
 * open the existing EvidenceDrawer without a duplicate detail UI; catalog-only
 * photos leave it null and link to their source surface instead.
 */
export interface GalleryPhoto {
  /** Stable id, namespaced by source so an evidence id and a snag id can't
   *  collide as React keys. */
  id: string;
  /** Full-size image URL (existing Blob URL). Empty for an evidence NOTE. */
  url: string;
  /** Optional smaller thumbnail (evidence only today). */
  thumbnailUrl: string | null;
  /** ISO capture time; "" when the source recorded none (sorted last). */
  capturedAt: string;
  /** Who uploaded it — display name, falling back to the raw id. */
  uploader: string;
  /** Stable uploader key for the filter dropdown (id, else the name). */
  uploaderKey: string;
  /** Human provenance line: "Meter-box snag on Lot 4", "Rough-in · Unit 2". */
  provenance: string;
  /** Which pipeline this came from. */
  sourceKind: GallerySourceKind;
  /** True for an evidence NOTE (no image) — rendered as a note card, never a
   *  broken thumbnail. */
  isNote: boolean;
  /** Field vs office provenance. Evidence carries source phil/admin/system;
   *  catalog photos are field-captured by construction. */
  provenanceSide: "field" | "office";
  /** #233 — true when the originating evidence row is flagged `asBuilt`. Only
   *  evidence photos can carry the flag today; catalog (snag / ITP) photos are
   *  always false (absence = not-as-built, never inferred). */
  asBuilt: boolean;
  /** The originating evidence row, for opening EvidenceDrawer. Null for
   *  catalog-only photos (snag / ITP / dwelling). */
  evidenceItem: EvidenceItem | null;
  /** The snag id, for catalog snag photos — lets the UI deep-link to the snag
   *  surface. Null otherwise. */
  snagId: string | null;
}

/** Title-case a stage token ("roughIn" → "Rough-in", "fitOff" → "Fit-off"). */
function stageLabelFromToken(stage: string): string {
  const map: Record<string, string> = {
    roughIn: "Rough-in",
    fitOff: "Fit-off",
  };
  return map[stage] ?? stage;
}

/** Build the human provenance line for an evidence photo/note. */
function evidenceProvenance(
  item: EvidenceItem,
  areaNameById: Record<string, string>,
): string {
  const parts: string[] = [];
  if (item.stage) parts.push(stageLabelFromToken(item.stage));
  if (item.areaId) parts.push(areaNameById[item.areaId] ?? item.areaId);
  if (parts.length === 0) {
    return item.kind === "note" ? "Note · unattached" : "Captured in the field";
  }
  return parts.join(" · ");
}

/**
 * Project the evidence list (photos AND notes) into gallery photos. Only
 * server-persisted statuses are kept (submitted / reviewed / rejected); the
 * client-only `uploading` / `pending_sync` states never reach a read endpoint,
 * but we guard anyway so a stray one is dropped rather than shown.
 */
function fromEvidence(
  evidence: ReadonlyArray<EvidenceItem>,
  areaNameById: Record<string, string>,
): GalleryPhoto[] {
  const out: GalleryPhoto[] = [];
  for (const item of evidence) {
    if (item.status === "uploading" || item.status === "pending_sync") continue;
    const isNote = item.kind === "note";
    // A photo with no URL is unusable — skip it rather than render a broken
    // tile. A note legitimately has no URL.
    if (!isNote && !item.photoUrl) continue;
    out.push({
      id: `evidence:${item.id}`,
      url: isNote ? "" : item.photoUrl ?? "",
      thumbnailUrl: item.thumbnailUrl ?? null,
      capturedAt: item.capturedAt ?? "",
      uploader: item.capturedByName || item.capturedById || "Unknown",
      uploaderKey: item.capturedById || item.capturedByName || "unknown",
      provenance: evidenceProvenance(item, areaNameById),
      sourceKind: "evidence",
      isNote,
      // Evidence carries an explicit source; admin/system reads as office.
      provenanceSide: item.source === "phil" ? "field" : "office",
      // #233 — read straight off the row; absence is not-as-built.
      asBuilt: item.asBuilt === true,
      evidenceItem: item,
      snagId: null,
    });
  }
  return out;
}

/**
 * Project the photos-catalog entries (snag + dwelling/ITP) into gallery photos.
 * Catalog `dwelling` rows cover both dwelling stage photos and ITP/dwelling
 * indexed photos in one store, so they map to `sourceKind: 'itp'` and a
 * "ITP / dwelling" provenance — the source we do not (yet) split is NAMED, not
 * silently merged into evidence.
 */
function fromCatalog(entries: ReadonlyArray<PhotoCatalogEntry>): GalleryPhoto[] {
  const out: GalleryPhoto[] = [];
  for (const e of entries) {
    if (!e.url) continue;
    const uploader = e.addedBy || "Unknown";
    if (e.source === "snag") {
      const subject = e.snagDesc?.trim();
      const dwelling = e.dwellingName?.trim();
      const provenance = subject
        ? dwelling
          ? `Snag: ${subject} · ${dwelling}`
          : `Snag: ${subject}`
        : dwelling
          ? `Snag · ${dwelling}`
          : "Snag photo";
      out.push({
        id: `snag:${e.id || `${e.snagId ?? ""}-${e.url}`}`,
        url: e.url,
        thumbnailUrl: null,
        capturedAt: e.addedAt || "",
        uploader,
        uploaderKey: uploader,
        provenance,
        sourceKind: "snag",
        isNote: false,
        provenanceSide: "field",
        // #233 — only evidence carries the as-built flag; catalog is never it.
        asBuilt: false,
        evidenceItem: null,
        snagId: e.snagId || null,
      });
    } else {
      // source === 'dwelling' — dwelling stage + ITP/dwelling photos (one
      // unsplit store). Named as "ITP / dwelling" rather than guessed.
      const dwelling = e.dwellingName?.trim();
      const stage = e.stage?.trim();
      const provenance = [
        "ITP / dwelling",
        stage ? stageLabelFromToken(stage) : null,
        dwelling || null,
      ]
        .filter(Boolean)
        .join(" · ");
      out.push({
        id: `itp:${e.id || `${e.dwellingId ?? ""}-${e.stage ?? ""}-${e.url}`}`,
        url: e.url,
        thumbnailUrl: null,
        capturedAt: e.addedAt || "",
        uploader,
        uploaderKey: uploader,
        provenance: provenance || "ITP / dwelling photo",
        sourceKind: "itp",
        isNote: false,
        provenanceSide: "field",
        // #233 — only evidence carries the as-built flag; catalog is never it.
        asBuilt: false,
        evidenceItem: null,
        snagId: null,
      });
    }
  }
  return out;
}

/**
 * Merge the evidence list + catalog entries into ONE read-only gallery model,
 * newest first. `areaNameById` resolves evidence area ids to names for the
 * provenance line (the catalog already carries dwelling names).
 *
 * Pure: same inputs → same output, no IO. A failed source is simply absent
 * from its argument (the caller passes [] and surfaces an honest note).
 */
export function buildGalleryPhotos(input: {
  evidence: ReadonlyArray<EvidenceItem>;
  catalog: ReadonlyArray<PhotoCatalogEntry>;
  areaNameById?: Record<string, string>;
}): GalleryPhoto[] {
  const areaNameById = input.areaNameById ?? {};
  const merged = [
    ...fromEvidence(input.evidence, areaNameById),
    ...fromCatalog(input.catalog),
  ];
  // Newest first; entries with no timestamp sort last (stable-ish via id).
  merged.sort((a, b) => {
    if (a.capturedAt && b.capturedAt) return b.capturedAt.localeCompare(a.capturedAt);
    if (a.capturedAt) return -1;
    if (b.capturedAt) return 1;
    return a.id.localeCompare(b.id);
  });
  return merged;
}

/** A date bucket of gallery photos (newest day first; photos within newest
 *  first, inheriting the merge order). */
export interface GalleryDateGroup {
  /** ISO day key, "YYYY-MM-DD", or "" for photos with no timestamp. */
  day: string;
  photos: GalleryPhoto[];
}

/**
 * Group gallery photos by capture day, newest day first. Photos with no
 * timestamp collect under the "" day key, which sorts last — honest about the
 * fact that the source recorded no time, rather than guessing "today".
 */
export function groupPhotosByDay(
  photos: ReadonlyArray<GalleryPhoto>,
): GalleryDateGroup[] {
  const byDay = new Map<string, GalleryPhoto[]>();
  for (const p of photos) {
    const day = p.capturedAt ? p.capturedAt.slice(0, 10) : "";
    const list = byDay.get(day);
    if (list) list.push(p);
    else byDay.set(day, [p]);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => {
      if (a && b) return b.localeCompare(a);
      if (a) return -1;
      if (b) return 1;
      return 0;
    })
    .map(([day, list]) => ({ day, photos: list }));
}

/** Filter for the gallery grid (date range, uploader, provenance side,
 *  photo/note). All-null = show everything. */
export interface GalleryFilter {
  fromDate: string | null; // YYYY-MM-DD inclusive
  toDate: string | null; // YYYY-MM-DD inclusive
  uploaderKey: string | null;
  /** "field" | "office" | null (either). */
  side: "field" | "office" | null;
  /** "photo" | "note" | null (either). */
  kind: "photo" | "note" | null;
  /** Restrict to one source pipeline, or null for all. */
  sourceKind: GallerySourceKind | null;
  /** #233 — true = only as-built-flagged captures; null = all. There is no
   *  `false` mode: the chip is a "show me the as-builts" toggle, and absence
   *  of the flag is not a thing the office filters FOR. */
  asBuilt: true | null;
}

export const EMPTY_GALLERY_FILTER: GalleryFilter = {
  fromDate: null,
  toDate: null,
  uploaderKey: null,
  side: null,
  kind: null,
  sourceKind: null,
  asBuilt: null,
};

/**
 * Pure filter predicate. Exported so tests can verify the matrix without
 * rendering. Date comparison uses the ISO YYYY-MM-DD prefix of `capturedAt`;
 * a photo with no timestamp is excluded the moment ANY date bound is set
 * (you can't place an undated photo in a range honestly).
 */
export function matchesGalleryFilter(
  photo: GalleryPhoto,
  filter: GalleryFilter,
): boolean {
  if (filter.fromDate || filter.toDate) {
    const day = photo.capturedAt ? photo.capturedAt.slice(0, 10) : "";
    if (!day) return false;
    if (filter.fromDate && day < filter.fromDate) return false;
    if (filter.toDate && day > filter.toDate) return false;
  }
  if (filter.uploaderKey && photo.uploaderKey !== filter.uploaderKey) return false;
  if (filter.side && photo.provenanceSide !== filter.side) return false;
  if (filter.kind) {
    if (filter.kind === "photo" && photo.isNote) return false;
    if (filter.kind === "note" && !photo.isNote) return false;
  }
  if (filter.sourceKind && photo.sourceKind !== filter.sourceKind) return false;
  // #233 — when on, keep only as-built-flagged captures.
  if (filter.asBuilt === true && !photo.asBuilt) return false;
  return true;
}

/** Count of as-built-flagged photos — drives the hidden-when-empty chip. */
export function galleryAsBuiltCount(
  photos: ReadonlyArray<GalleryPhoto>,
): number {
  let n = 0;
  for (const p of photos) if (p.asBuilt) n += 1;
  return n;
}

/** Distinct uploaders present in a gallery, for the filter dropdown. */
export function galleryUploaders(
  photos: ReadonlyArray<GalleryPhoto>,
): Array<{ key: string; name: string }> {
  const map = new Map<string, string>();
  for (const p of photos) {
    if (!map.has(p.uploaderKey)) map.set(p.uploaderKey, p.uploader);
  }
  return Array.from(map.entries())
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Human label for a source kind, used in chips + the filter. */
export function sourceKindLabel(kind: GallerySourceKind): string {
  switch (kind) {
    case "evidence":
      return "Evidence";
    case "snag":
      return "Snag";
    case "itp":
      return "ITP / dwelling";
  }
}
