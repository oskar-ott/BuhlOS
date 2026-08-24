"use client";

import { useMemo, useState } from "react";
import { FileText, Image as ImageIcon, Stamp, X } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import {
  EMPTY_GALLERY_FILTER,
  buildGalleryPhotos,
  galleryAsBuiltCount,
  galleryUploaders,
  groupPhotosByDay,
  matchesGalleryFilter,
  sourceKindLabel,
  type GalleryFilter,
  type GalleryPhoto,
  type GallerySourceKind,
  type PhotoCatalogEntry,
} from "@/domains/evidence/photo-gallery";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job } from "@/domains/jobs/types";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { cn } from "@/lib/cn";

/** A source we tried to load and failed — surfaced as an honest note, never a
 *  silent gap (AC2). */
export interface SourceLoadError {
  /** "evidence" | "snag & ITP / dwelling" */
  label: string;
  message: string;
}

interface Props {
  job: Job;
  /** Evidence-pipeline photos + notes (already role-scoped server-side). */
  evidence: ReadonlyArray<EvidenceItem>;
  /** Snag + dwelling/ITP catalog entries (already role-scoped server-side). */
  catalog: ReadonlyArray<PhotoCatalogEntry>;
  /** Per-source load failures — each becomes an honest banner. */
  sourceErrors: ReadonlyArray<SourceLoadError>;
  /** id→name for this job's areas, so an evidence area id resolves to a name. */
  areaNameById: Record<string, string>;
}

const SOURCE_TONE: Record<GallerySourceKind, "info" | "warning" | "neutral"> = {
  evidence: "info",
  snag: "warning",
  itp: "neutral",
};

/**
 * Read-only job photo gallery (#242 — "Job Bible").
 *
 * Pure READ projection over shipped data: evidence-pipeline photos +
 * snag/ITP/dwelling catalog photos, merged by `buildGalleryPhotos`, grouped by
 * day, filterable by date range / uploader / field-vs-office / photo-vs-note /
 * source. Counts are derived from real records.
 *
 * Tapping an EVIDENCE photo opens the existing EvidenceDrawer (reuse — no
 * second detail UI). A catalog-only photo (snag / ITP / dwelling) has no
 * evidence drawer: it opens a plain full-size lightbox. (The old "open the
 * snag" deep-link is gone — the snags surface was deleted in the 2026-07-27
 * gut.) NO capture / tagging controls (Epic 10 boundary).
 */
export function PhotosGallery({ job, evidence, catalog, sourceErrors, areaNameById }: Props) {
  const allPhotos = useMemo(
    () => buildGalleryPhotos({ evidence, catalog, areaNameById }),
    [evidence, catalog, areaNameById]
  );

  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_GALLERY_FILTER);
  const [drawerItem, setDrawerItem] = useState<EvidenceItem | null>(null);
  const [lightbox, setLightbox] = useState<GalleryPhoto | null>(null);

  const visible = useMemo(
    () => allPhotos.filter((p) => matchesGalleryFilter(p, filter)),
    [allPhotos, filter]
  );
  const groups = useMemo(() => groupPhotosByDay(visible), [visible]);
  const uploaders = useMemo(() => galleryUploaders(allPhotos), [allPhotos]);
  // #233 — drives the hidden-when-empty as-built filter chip.
  const asBuiltCount = useMemo(() => galleryAsBuiltCount(allPhotos), [allPhotos]);

  const isDefault =
    filter.fromDate === null &&
    filter.toDate === null &&
    filter.uploaderKey === null &&
    filter.side === null &&
    filter.kind === null &&
    filter.sourceKind === null &&
    filter.asBuilt === null;

  const sourceCounts = useMemo(() => {
    const c = { evidence: 0, snag: 0, itp: 0 };
    for (const p of allPhotos) c[p.sourceKind] += 1;
    return c;
  }, [allPhotos]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle>Photos · {job.name}</CardTitle>
            <CardDescription className="mt-1">
              Every photo on this job in one place — field captures, snag photos and ITP / dwelling
              photos. Read-only; open a capture to review it.
            </CardDescription>
          </div>
          <Pill tone="neutral">Read-only</Pill>
        </div>
        {allPhotos.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Pill tone="info">{sourceCounts.evidence} evidence</Pill>
            <Pill tone="warning">{sourceCounts.snag} snag</Pill>
            <Pill tone="neutral">{sourceCounts.itp} ITP / dwelling</Pill>
          </div>
        ) : null}
      </Card>

      {sourceErrors.map((e) => (
        <Card key={e.label} className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load {e.label} photos</CardTitle>
          <CardDescription className="text-amber-900">
            {e.message}. These photos are missing from the gallery below — refresh to try again.
          </CardDescription>
        </Card>
      ))}

      <GalleryFilterBar
        value={filter}
        onChange={setFilter}
        uploaders={uploaders}
        totalCount={allPhotos.length}
        visibleCount={visible.length}
        isDefault={isDefault}
        asBuiltCount={asBuiltCount}
      />

      {visible.length === 0 ? (
        <EmptyState
          title={
            allPhotos.length === 0 ? "No photos on this job yet." : "No photos match these filters."
          }
          description={
            allPhotos.length === 0
              ? "Field captures, snag photos and ITP / dwelling photos will appear here as they're added."
              : "Adjust the filters above or clear them to see everything."
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.day || "undated"} aria-label={dayHeading(group.day)}>
              <h3 className="mb-2 font-display text-sm font-semibold text-text-muted">
                {dayHeading(group.day)}
                <span className="ml-2 font-normal text-text-muted/80">
                  {group.photos.length}
                  {group.photos.length === 1 ? " photo" : " photos"}
                </span>
              </h3>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {group.photos.map((photo) => (
                  <li key={photo.id}>
                    <PhotoTile
                      photo={photo}
                      onOpen={() => {
                        if (photo.evidenceItem) setDrawerItem(photo.evidenceItem);
                        else setLightbox(photo);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Evidence photos reuse the existing drawer — read-only (no review
          actions): isAdmin=false so the footer shows the read-only note and no
          mutation buttons render. This is a BROWSE surface, not a review queue. */}
      <EvidenceDrawer
        item={drawerItem}
        job={job}
        open={drawerItem !== null}
        isAdmin={false}
        busy={false}
        onClose={() => setDrawerItem(null)}
        onMarkReviewed={() => {}}
        onOpenReject={() => {}}
      />

      {/* Catalog-only photos (snag / ITP / dwelling) have no evidence drawer —
          a plain full-size lightbox only (the snag deep-link died with the
          snags surface in the gut). Never a bespoke second detail panel. */}
      {lightbox ? <Lightbox photo={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}

function PhotoTile({ photo, onOpen }: { photo: GalleryPhoto; onOpen: () => void }) {
  const tone = SOURCE_TONE[photo.sourceKind];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col overflow-hidden rounded-card border border-border bg-surface text-left",
        "transition-colors hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy"
      )}
      aria-label={`${sourceKindLabel(photo.sourceKind)} — ${photo.provenance}`}
    >
      <span className="relative block aspect-square w-full overflow-hidden bg-surface-subtle">
        {photo.isNote ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-text-muted">
            <FileText aria-hidden="true" className="h-6 w-6" />
            <span className="line-clamp-3 text-center text-xs">Note</span>
          </span>
        ) : photo.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.thumbnailUrl ?? photo.url}
            alt={photo.provenance}
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-text-muted">
            <ImageIcon aria-hidden="true" className="h-6 w-6" />
          </span>
        )}
        <span className="absolute left-1.5 top-1.5">
          <Pill tone={tone} className="text-[10px]">
            {sourceKindLabel(photo.sourceKind)}
          </Pill>
        </span>
        {/* #233 — as-built chip on the flagged tile (hidden otherwise). */}
        {photo.asBuilt ? (
          <span className="absolute right-1.5 top-1.5">
            <Pill tone="warning" className="text-[10px]">
              As-built
            </Pill>
          </span>
        ) : null}
      </span>
      <span className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-xs font-medium text-text">{photo.provenance}</span>
        <span className="truncate text-[11px] text-text-muted">
          {photo.uploader}
          {photo.capturedAt ? ` · ${formatTime(photo.capturedAt)}` : ""}
        </span>
      </span>
    </button>
  );
}

function Lightbox({ photo, onClose }: { photo: GalleryPhoto; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo detail"
      className="fixed inset-0 z-40 flex items-center justify-center bg-accent-ink/70 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface-raised shadow-raised"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-base font-semibold text-text">
              {photo.provenance}
            </h2>
            <p className="truncate text-xs text-text-muted">
              {sourceKindLabel(photo.sourceKind)} · {photo.uploader}
              {photo.capturedAt ? ` · ${formatTime(photo.capturedAt)}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto bg-surface-subtle">
          {photo.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.url}
              alt={photo.provenance}
              className="mx-auto block max-h-[70vh] w-full object-contain"
            />
          ) : (
            <p className="p-8 text-center text-sm text-text-muted">This entry has no image.</p>
          )}
        </div>
        {/* 2026-08-24 market-readiness: the "Open the snag" link pointed at
            /v2/jobs/[id]/snags, a route deleted in the 2026-07-27 gut — a 404
            on any legacy evidence still carrying snagId. Removed (snags are a
            dark feature; nothing writes snagId now). */}
      </div>
    </div>
  );
}

interface FilterBarProps {
  value: GalleryFilter;
  onChange: (next: GalleryFilter) => void;
  uploaders: ReadonlyArray<{ key: string; name: string }>;
  totalCount: number;
  visibleCount: number;
  isDefault: boolean;
  /** #233 — number of as-built-flagged photos; the chip hides when 0 (P7 —
   *  no dead control when nothing is flagged). */
  asBuiltCount: number;
}

function GalleryFilterBar({
  value,
  onChange,
  uploaders,
  totalCount,
  visibleCount,
  isDefault,
  asBuiltCount,
}: FilterBarProps) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-3 shadow-card">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label="From">
          <input
            type="date"
            value={value.fromDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, fromDate: e.target.value === "" ? null : e.target.value })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </FilterField>
        <FilterField label="To">
          <input
            type="date"
            value={value.toDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, toDate: e.target.value === "" ? null : e.target.value })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </FilterField>
        <FilterField label="Uploaded by">
          <select
            value={value.uploaderKey ?? ""}
            onChange={(e) =>
              onChange({ ...value, uploaderKey: e.target.value === "" ? null : e.target.value })
            }
            disabled={uploaders.length === 0}
            className="block h-10 min-w-0 max-w-[11rem] rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60 sm:min-w-[10rem]"
          >
            <option value="">Anyone</option>
            {uploaders.map((u) => (
              <option key={u.key} value={u.key}>
                {u.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Source">
          <select
            value={value.side ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                side: e.target.value === "" ? null : (e.target.value as "field" | "office"),
              })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="">Field & office</option>
            <option value="field">Field</option>
            <option value="office">Office</option>
          </select>
        </FilterField>
        <FilterField label="Type">
          <select
            value={value.kind ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                kind: e.target.value === "" ? null : (e.target.value as "photo" | "note"),
              })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="">Photos & notes</option>
            <option value="photo">Photos</option>
            <option value="note">Notes</option>
          </select>
        </FilterField>
        <FilterField label="Category">
          <select
            value={value.sourceKind ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                sourceKind: e.target.value === "" ? null : (e.target.value as GallerySourceKind),
              })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="">All sources</option>
            <option value="evidence">Evidence</option>
            <option value="snag">Snag</option>
            <option value="itp">ITP / dwelling</option>
          </select>
        </FilterField>

        {/* #233 — as-built chip. HIDDEN when nothing on the job is flagged
            (no dead control); a toggle, not a select. */}
        {asBuiltCount > 0 ? (
          <FilterField label="Handover">
            <button
              type="button"
              onClick={() => onChange({ ...value, asBuilt: value.asBuilt === true ? null : true })}
              aria-pressed={value.asBuilt === true}
              data-testid="gallery-asbuilt-chip"
              className={cn(
                "inline-flex h-10 items-center gap-1 rounded-card border px-3 text-sm font-medium",
                value.asBuilt === true
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-border bg-surface text-text hover:bg-surface-subtle"
              )}
            >
              <Stamp aria-hidden="true" className="h-4 w-4" />
              As-built
              <span className="text-xs text-text-muted">({asBuiltCount})</span>
            </button>
          </FilterField>
        ) : null}

        {!isDefault ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_GALLERY_FILTER)}
            className={cn(
              "inline-flex h-10 items-center gap-1 rounded-card px-3 text-sm font-medium",
              "text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2",
              "hover:bg-surface-subtle"
            )}
          >
            <X aria-hidden="true" className="h-4 w-4" />
            Clear filters
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-xs text-text-muted">
        Showing <Pill tone="neutral">{visibleCount}</Pill> of {totalCount}{" "}
        {totalCount === 1 ? "photo" : "photos"} on this job.
      </p>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/** "3 June 2026" heading, or "No date recorded" for the undated bucket. */
function dayHeading(day: string): string {
  if (!day) return "No date recorded";
  try {
    const d = new Date(`${day}T00:00:00`);
    if (Number.isNaN(d.getTime())) return day;
    return d.toLocaleDateString("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return day;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
