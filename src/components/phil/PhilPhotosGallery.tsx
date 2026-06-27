"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import { Pill } from "@/components/ui/Pill";
import {
  EMPTY_GALLERY_FILTER,
  buildGalleryPhotos,
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
import { cn } from "@/lib/cn";

interface Props {
  /** Evidence-pipeline photos + notes (server-scoped: a tradie sees own captures). */
  evidence: ReadonlyArray<EvidenceItem>;
  /** Snag + dwelling/ITP catalog entries. Empty for a tradie (the catalog is
   *  leading-hand+; `catalogAvailable` says whether that's a gate or a failure). */
  catalog: ReadonlyArray<PhotoCatalogEntry>;
  /** id→name for the job's areas, for the evidence provenance line. */
  areaNameById: Record<string, string>;
  /** True when the catalog (snag / ITP / dwelling) source loaded for this
   *  viewer. False for a tradie (catalog is LH+) — shown as an honest note,
   *  NOT an error. */
  catalogAvailable: boolean;
  /** A genuine catalog FETCH failure (distinct from the role gate). Shown as an
   *  error notice. Null when there was no failure. */
  catalogError: string | null;
  /** A genuine evidence fetch failure. Null when it loaded. */
  evidenceError: string | null;
}

const SOURCE_TONE: Record<GallerySourceKind, "info" | "warning" | "neutral"> = {
  evidence: "info",
  snag: "warning",
  itp: "neutral",
};

/**
 * Phil read-only job photo gallery (#242, AC4 — the field's "Job Bible").
 *
 * Principle served (Phil constitution): the field can FIND a job's photos —
 * reference, not capture. UI slot: a read-only gallery in the job's reference
 * zone, linked from the job home (P10 — an existing reference slot, no new nav
 * paradigm). P7: counts are real, gaps are honest (a tradie is TOLD the snag /
 * ITP photos are office-side, never shown a fake-empty or a broken tile).
 *
 * Reuses the SAME gated endpoints + gallery model as BuhlOS — no role redaction
 * is bypassed. A tradie sees their own evidence; the catalog is leading-hand+,
 * so a tradie sees an honest "snag & ITP photos are office-side" note rather
 * than a silent gap.
 *
 * Tapping any photo opens a plain full-size view (read-only). No capture, no
 * tagging, no review (Epic 10 boundary; capture stays on the job home).
 */
export function PhilPhotosGallery({
  evidence,
  catalog,
  areaNameById,
  catalogAvailable,
  catalogError,
  evidenceError,
}: Props) {
  const allPhotos = useMemo(
    () => buildGalleryPhotos({ evidence, catalog, areaNameById }),
    [evidence, catalog, areaNameById],
  );

  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_GALLERY_FILTER);
  const [lightbox, setLightbox] = useState<GalleryPhoto | null>(null);

  const visible = useMemo(
    () => allPhotos.filter((p) => matchesGalleryFilter(p, filter)),
    [allPhotos, filter],
  );
  const groups = useMemo(() => groupPhotosByDay(visible), [visible]);
  const uploaders = useMemo(() => galleryUploaders(allPhotos), [allPhotos]);

  const isDefault =
    filter.fromDate === null &&
    filter.toDate === null &&
    filter.uploaderKey === null &&
    filter.sourceKind === null;

  return (
    <div className="space-y-4">
      {evidenceError ? (
        <PhilNotice tone="warning" title="Couldn’t load your captures" role="alert">
          {evidenceError}. Some photos may be missing — pull to refresh.
        </PhilNotice>
      ) : null}

      {catalogError ? (
        <PhilNotice tone="warning" title="Couldn’t load snag & ITP photos" role="alert">
          {catalogError}. They’re missing from the gallery — pull to refresh.
        </PhilNotice>
      ) : !catalogAvailable ? (
        <PhilNotice tone="info" title="Snag & ITP photos are office-side" role="status">
          This gallery shows the photos you’ve captured. Snag and ITP / dwelling
          photos are viewed by your leading hand or the office.
        </PhilNotice>
      ) : null}

      <PhilGalleryFilterBar
        value={filter}
        onChange={setFilter}
        uploaders={uploaders}
        totalCount={allPhotos.length}
        visibleCount={visible.length}
        isDefault={isDefault}
      />

      {visible.length === 0 ? (
        <PhilNotice tone="neutral" title={allPhotos.length === 0 ? "No photos yet" : "Nothing matches"}>
          {allPhotos.length === 0
            ? "Photos on this job will show up here as they’re taken."
            : "Adjust the filters above or clear them to see everything."}
        </PhilNotice>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.day || "undated"} aria-label={dayHeading(group.day)}>
              <h2 className="mb-2 font-display text-sm font-semibold text-text-muted">
                {dayHeading(group.day)}
                <span className="ml-2 font-normal text-text-muted/80">
                  {group.photos.length}
                  {group.photos.length === 1 ? " photo" : " photos"}
                </span>
              </h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {group.photos.map((photo) => (
                  <li key={photo.id}>
                    <PhilPhotoTile photo={photo} onOpen={() => setLightbox(photo)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {lightbox ? (
        <PhilLightbox photo={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

function PhilPhotoTile({
  photo,
  onOpen,
}: {
  photo: GalleryPhoto;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col overflow-hidden rounded-card border border-border bg-surface text-left",
        "focus:outline-none focus:ring-2 focus:ring-brand-navy",
      )}
      aria-label={`${sourceKindLabel(photo.sourceKind)} — ${photo.provenance}`}
    >
      <span className="relative block aspect-square w-full overflow-hidden bg-surface-subtle">
        {photo.isNote ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-text-muted">
            <FileText aria-hidden="true" className="h-6 w-6" />
            <span className="text-center text-xs">Note</span>
          </span>
        ) : photo.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.thumbnailUrl ?? photo.url}
            alt={photo.provenance}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-text-muted">
            <ImageIcon aria-hidden="true" className="h-6 w-6" />
          </span>
        )}
        <span className="absolute left-1.5 top-1.5">
          <Pill tone={SOURCE_TONE[photo.sourceKind]} className="text-xs">
            {sourceKindLabel(photo.sourceKind)}
          </Pill>
        </span>
      </span>
      <span className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-xs font-medium text-text">{photo.provenance}</span>
        <span className="truncate text-xs text-text-muted">
          {photo.uploader}
          {photo.capturedAt ? ` · ${formatTime(photo.capturedAt)}` : ""}
        </span>
      </span>
    </button>
  );
}

function PhilLightbox({
  photo,
  onClose,
}: {
  photo: GalleryPhoto;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo detail"
      className="fixed inset-0 z-40 flex flex-col bg-accent-ink/80 pb-[env(safe-area-inset-bottom)]"
      onClick={onClose}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 text-text-inverse">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{photo.provenance}</p>
          <p className="truncate text-xs opacity-80">
            {sourceKindLabel(photo.sourceKind)} · {photo.uploader}
            {photo.capturedAt ? ` · ${formatTime(photo.capturedAt)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card text-text-inverse hover:bg-white/10"
        >
          <X aria-hidden="true" className="h-6 w-6" />
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center overflow-hidden px-2 pb-4">
        {photo.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.url}
            alt={photo.provenance}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="text-center text-sm text-text-inverse opacity-90">
            This is a note — it has no image.
          </p>
        )}
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
}

function PhilGalleryFilterBar({
  value,
  onChange,
  uploaders,
  totalCount,
  visibleCount,
  isDefault,
}: FilterBarProps) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
            From
          </span>
          <input
            type="date"
            value={value.fromDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, fromDate: e.target.value === "" ? null : e.target.value })
            }
            className="mt-1 block h-11 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
            To
          </span>
          <input
            type="date"
            value={value.toDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, toDate: e.target.value === "" ? null : e.target.value })
            }
            className="mt-1 block h-11 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
            Uploaded by
          </span>
          <select
            value={value.uploaderKey ?? ""}
            onChange={(e) =>
              onChange({ ...value, uploaderKey: e.target.value === "" ? null : e.target.value })
            }
            disabled={uploaders.length === 0}
            className="mt-1 block h-11 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          >
            <option value="">Anyone</option>
            {uploaders.map((u) => (
              <option key={u.key} value={u.key}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
            Category
          </span>
          <select
            value={value.sourceKind ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                sourceKind:
                  e.target.value === "" ? null : (e.target.value as GallerySourceKind),
              })
            }
            className="mt-1 block h-11 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="">All</option>
            <option value="evidence">Evidence</option>
            <option value="snag">Snag</option>
            <option value="itp">ITP / dwelling</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          Showing <Pill tone="neutral">{visibleCount}</Pill> of {totalCount}{" "}
          {totalCount === 1 ? "photo" : "photos"}.
        </p>
        {!isDefault ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_GALLERY_FILTER)}
            className="inline-flex h-9 items-center gap-1 rounded-card px-2 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            <X aria-hidden="true" className="h-4 w-4" />
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** "Wed 3 June 2026" heading, or "No date recorded" for the undated bucket. */
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
