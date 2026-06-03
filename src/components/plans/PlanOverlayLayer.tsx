"use client";

import { useCallback } from "react";
import { cn } from "@/lib/cn";
import { normToPixel, pixelToNorm, type NormPoint, type PageView } from "@/domains/plans/coords";
import { markupNormPoints } from "@/domains/plan-markups/service";
import type { DrawingMarkup, MarkupTone, MarkupType } from "@/domains/plan-markups/types";

/**
 * Presentational SVG overlay layer for the Plan Viewer (Plans Phase 2).
 *
 * Renders markups as vectors positioned via the tested coords.ts math
 * (normToPixel) over the raster page. SVG is used deliberately: marker geometry
 * is expressed through ATTRIBUTES (cx/cy/x1/points/…), so it never needs the
 * lint-banned inline `style` prop, and each marker is independently tappable.
 *
 * Pointer model: the root <svg> is pointer-events-none so the page still pans
 * and scrolls underneath; individual markers opt back in (tap to read). In
 * admin add-mode a transparent capture rect maps clicks to normalised page
 * coordinates via pixelToNorm. Read-only (Phil) never renders the capture rect.
 *
 * This component holds NO state and does NO fetching — it's driven entirely by
 * props so it server-renders and is trivially testable.
 */

const TONE_CLASS: Record<MarkupTone, string> = {
  navy: "text-brand-navy",
  yellow: "text-amber-500",
  red: "text-rose-600",
  green: "text-emerald-600",
  grey: "text-slate-500",
};

function toneClass(tone: DrawingMarkup["tone"]): string {
  return TONE_CLASS[(tone ?? "navy") as MarkupTone] ?? TONE_CLASS.navy;
}

interface Props {
  markups: ReadonlyArray<DrawingMarkup>;
  view: PageView;
  boxW: number;
  boxH: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Admin add-mode: when set, the capture rect is active and reports points. */
  addMode?: MarkupType | null;
  onAddPoint?: (p: NormPoint) => void;
  /** First point of an in-progress line, shown as a preview dot. */
  pendingPoints?: ReadonlyArray<NormPoint>;
}

export function PlanOverlayLayer({
  markups,
  view,
  boxW,
  boxH,
  selectedId,
  onSelect,
  addMode = null,
  onAddPoint,
  pendingPoints = [],
}: Props) {
  const handleAddClick = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      if (!addMode || !onAddPoint) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      onAddPoint(pixelToNorm({ px, py }, view));
    },
    [addMode, onAddPoint, view],
  );

  return (
    <svg
      width={boxW}
      height={boxH}
      viewBox={`0 0 ${boxW} ${boxH}`}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      aria-hidden={addMode ? undefined : true}
      data-testid="plan-overlay-layer"
    >
      {addMode ? (
        <rect
          x={0}
          y={0}
          width={boxW}
          height={boxH}
          fill="transparent"
          className="pointer-events-auto cursor-crosshair"
          onClick={handleAddClick}
          data-testid="plan-overlay-add-capture"
        />
      ) : null}

      {markups.map((m) => {
        const pts = markupNormPoints(m).map((p) => normToPixel(p, view));
        if (pts.length === 0) return null;
        const selected = m.id === selectedId;
        const color = toneClass(m.tone);
        const onClick = () => onSelect(m.id);

        if (m.type === "line" && pts.length >= 2) {
          return (
            <g key={m.id} className={cn("pointer-events-auto cursor-pointer", color)} onClick={onClick}>
              {/* fat invisible hit line for easy tapping on mobile */}
              <line x1={pts[0]!.px} y1={pts[0]!.py} x2={pts[1]!.px} y2={pts[1]!.py} stroke="transparent" strokeWidth={16} />
              <line
                x1={pts[0]!.px}
                y1={pts[0]!.py}
                x2={pts[1]!.px}
                y2={pts[1]!.py}
                stroke="currentColor"
                strokeWidth={selected ? 5 : 3}
                strokeLinecap="round"
              />
            </g>
          );
        }

        if (m.type === "area" && pts.length >= 3) {
          const poly = pts.map((p) => `${p.px},${p.py}`).join(" ");
          return (
            <g key={m.id} className={cn("pointer-events-auto cursor-pointer", color)} onClick={onClick}>
              <polygon
                points={poly}
                fill="currentColor"
                fillOpacity={selected ? 0.28 : 0.16}
                stroke="currentColor"
                strokeWidth={selected ? 3 : 2}
              />
            </g>
          );
        }

        // pin or note — single anchor.
        const { px, py } = pts[0]!;
        return (
          <g
            key={m.id}
            className={cn("pointer-events-auto cursor-pointer", color)}
            onClick={onClick}
            data-testid={`plan-markup-${m.type}`}
          >
            {selected ? (
              <circle cx={px} cy={py} r={14} fill="currentColor" fillOpacity={0.18} />
            ) : null}
            {m.type === "note" ? (
              <rect x={px - 8} y={py - 8} width={16} height={16} rx={3} fill="currentColor" stroke="white" strokeWidth={1.5} />
            ) : (
              <circle cx={px} cy={py} r={8} fill="currentColor" stroke="white" strokeWidth={1.5} />
            )}
            {!m.visibleToPhil ? (
              // office-only ring marker (dashed) so admins can see at a glance.
              <circle cx={px} cy={py} r={12} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" />
            ) : null}
          </g>
        );
      })}

      {/* preview of an in-progress line's first point */}
      {pendingPoints.map((p, i) => {
        const { px, py } = normToPixel(p, view);
        return <circle key={`pending-${i}`} cx={px} cy={py} r={5} className="text-brand-navy" fill="currentColor" stroke="white" strokeWidth={1.5} />;
      })}
    </svg>
  );
}
