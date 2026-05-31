"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  displayTitle,
  drawingContextLine,
  formatFileSize,
  isSuperseded,
  mimeTypeLabel,
  statusLabel,
  statusTone,
} from "@/domains/documents/format";
import { fitZoom, type Rotation } from "@/domains/plans/coords";
import type { Plan } from "@/domains/plans/types";

/**
 * Phase 1 Plan Viewer — read-only raster display.
 *
 * Renders the per-page PNGs the register already stores (api/plans.js
 * `set-pages`); when a plan has no raster it falls back honestly to a
 * "open the original PDF" link rather than pretending to render it.
 * Zoom / rotate / fit-to-width / page selection only — NO markup, NO
 * measurement UI (that is Phase 2, on the tested coords + scale math).
 *
 * Inline `style` is banned by lint, and dynamic zoom/rotate transforms
 * can't be expressed in Tailwind, so the page geometry is applied
 * imperatively through refs (the stage box + the <img>) in an effect.
 * Pan is native scroll: the stage box is sized to the rotated, scaled
 * page so the scroll container has something real to scroll over.
 */

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const STAGE_PAD = 24;

function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return MIN_ZOOM;
  return z < MIN_ZOOM ? MIN_ZOOM : z > MAX_ZOOM ? MAX_ZOOM : z;
}

export function PlanViewer({ plan }: { plan: Plan }) {
  const pages = plan.pages;
  const superseded = isSuperseded(plan);
  const title = displayTitle(plan);
  const context = drawingContextLine(plan);
  const fileSize = formatFileSize(plan.sizeBytes);
  const fileKind = mimeTypeLabel(plan.mimeType);

  const [pageIndex, setPageIndex] = useState<number>(() => pages[0]?.pageIndex ?? 0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const fitPending = useRef(true);

  const page = useMemo(
    () => pages.find((p) => p.pageIndex === pageIndex) ?? pages[0],
    [pages, pageIndex],
  );

  // A new page means a new raster: re-measure, and re-fit on first load.
  useEffect(() => {
    fitPending.current = true;
    if (page && typeof page.width === "number" && typeof page.height === "number") {
      setNatural({ w: page.width, h: page.height });
    } else {
      setNatural(null);
    }
  }, [page]);

  const applyFit = useCallback(
    (mode: "width" | "page") => {
      const scroll = scrollRef.current;
      if (!scroll || !natural) return;
      const z = fitZoom(
        {
          width: scroll.clientWidth - STAGE_PAD * 2,
          height: scroll.clientHeight - STAGE_PAD * 2,
        },
        { width: natural.w, height: natural.h },
        rotation,
        mode,
      );
      setZoom(clampZoom(z));
    },
    [natural, rotation],
  );

  // First time a page's intrinsic size is known, fit it to the width.
  useEffect(() => {
    if (!natural || !fitPending.current) return;
    applyFit("width");
    fitPending.current = false;
  }, [natural, applyFit]);

  // Apply the geometry imperatively (lint bans the JSX `style` prop).
  useEffect(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !natural) return;
    const sW = natural.w * zoom;
    const sH = natural.h * zoom;
    const rotated = rotation === 90 || rotation === 270;
    const boxW = rotated ? sH : sW;
    const boxH = rotated ? sW : sH;
    stage.style.width = `${boxW}px`;
    stage.style.height = `${boxH}px`;
    img.style.width = `${sW}px`;
    img.style.height = `${sH}px`;
    img.style.left = `${(boxW - sW) / 2}px`;
    img.style.top = `${(boxH - sH) / 2}px`;
    img.style.transform = `rotate(${rotation}deg)`;
    img.style.transformOrigin = "center center";
  }, [natural, zoom, rotation]);

  const onImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
      setNatural({ w: el.naturalWidth, h: el.naturalHeight });
    }
  }, []);

  const openOriginal = (
    <a
      href={plan.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium",
        "bg-surface text-text border border-border hover:border-border-strong hover:bg-surface-subtle",
      )}
    >
      <ExternalLink className="h-4 w-4" aria-hidden />
      {`Open original ${fileKind}`}
    </a>
  );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-lg text-text">{title}</h2>
        {context ? (
          <p className="mt-0.5 text-sm text-text-muted">{context}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={statusTone(plan.status)}>{statusLabel(plan.status)}</Pill>
        {fileSize ? (
          <span className="text-xs text-text-muted">{fileSize}</span>
        ) : null}
      </div>
    </div>
  );

  const supersededBanner = superseded ? (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-card border-2 px-4 py-3",
        "border-amber-400 bg-amber-50 text-amber-900",
      )}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="text-sm">
        <p className="font-semibold">Superseded revision — not for construction.</p>
        <p className="mt-0.5 text-amber-800">
          A newer revision of this drawing has replaced it. Confirm the current
          revision before working from this plan.
        </p>
      </div>
    </div>
  ) : null;

  // No raster: honest fallback, never a fake render.
  if (pages.length === 0) {
    return (
      <section className="space-y-4">
        {header}
        {supersededBanner}
        <div
          className={cn(
            "flex flex-col items-center justify-center text-center",
            "rounded-card border border-dashed border-border bg-surface-subtle p-10",
          )}
        >
          <FileText className="h-8 w-8 text-text-muted" aria-hidden />
          <h3 className="mt-3 font-display text-base text-text">
            Not available in the in-app viewer
          </h3>
          <p className="mt-2 max-w-md text-sm text-text-muted">
            {`This plan hasn't been rasterised into page images yet, so it can't be shown here. Open the original ${fileKind} to view it.`}
          </p>
          <div className="mt-4">{openOriginal}</div>
        </div>
      </section>
    );
  }

  const multiPage = pages.length > 1;
  const currentOrdinal = pages.findIndex((p) => p.pageIndex === pageIndex) + 1;

  return (
    <section className="space-y-4">
      {header}
      {supersededBanner}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-card border border-border bg-surface p-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" aria-hidden />
          </Button>
          <span className="min-w-[3.5rem] text-center text-sm tabular-nums text-text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <Button variant="secondary" size="sm" onClick={() => applyFit("width")}>
          <Maximize2 className="h-4 w-4" aria-hidden />
          Fit width
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setRotation((r) => (((r + 90) % 360) as Rotation))}
          aria-label="Rotate 90 degrees"
        >
          <RotateCw className="h-4 w-4" aria-hidden />
          Rotate
        </Button>
        <div className="ml-auto flex items-center gap-3">
          {multiPage ? (
            <span className="text-xs text-text-muted">
              {`Page ${currentOrdinal} of ${pages.length}`}
            </span>
          ) : null}
          {openOriginal}
        </div>
      </div>

      <div className={cn("flex gap-3", multiPage ? "items-stretch" : "")}>
        {/* Page rail */}
        {multiPage ? (
          <div className="flex w-20 shrink-0 flex-col gap-2 overflow-y-auto rounded-card border border-border bg-surface-subtle p-2">
            {pages.map((p, i) => {
              const active = p.pageIndex === pageIndex;
              return (
                <button
                  key={p.pageIndex}
                  type="button"
                  onClick={() => setPageIndex(p.pageIndex)}
                  aria-label={`Go to page ${i + 1}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "overflow-hidden rounded border bg-surface transition-colors",
                    active
                      ? "border-brand-navy ring-2 ring-accent-yellow"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.pngUrl}
                    alt={`Page ${i + 1} thumbnail`}
                    loading="lazy"
                    className="block h-auto w-full"
                  />
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Stage */}
        <div
          ref={scrollRef}
          className="relative h-[62vh] min-h-[20rem] flex-1 overflow-auto rounded-card border border-border bg-surface-subtle p-6"
        >
          <div ref={stageRef} className="relative mx-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={page!.pngUrl}
              alt={`${title} — page ${currentOrdinal}`}
              onLoad={onImgLoad}
              className="absolute select-none"
              draggable={false}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
