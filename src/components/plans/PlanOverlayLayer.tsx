"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/cn";
import { normToPixel, pixelToNorm, type NormPoint, type PageView } from "@/domains/plans/coords";
import { markupNormPoints } from "@/domains/plan-markups/service";
import type { DrawingMarkup, MarkupTone, MarkupType } from "@/domains/plan-markups/types";

/**
 * Presentational SVG overlay layer for the Plan Viewer (Plans Phase 2/3).
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
 * Phase 3 (#651) adds `arrow` (directed segment + arrowhead) and `text`
 * (anchored callout) shapes, plus draggable geometry-edit handles. The handles
 * are gated on `editMode` — a flag the controller ONLY sets in admin mode, so
 * Phil (read-only) never renders a drag handle. This component holds no
 * persistent state and does no fetching — it's driven entirely by props so it
 * server-renders and is trivially testable.
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

/** The text a `text` markup shows: its label, then its note, then a placeholder. */
function textMarkupContent(m: DrawingMarkup): string {
  const label = m.label?.trim();
  if (label) return label;
  const text = m.text?.trim();
  if (text) return text;
  return "Text";
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
  /** First point(s) of an in-progress line/arrow/area, shown as a preview. */
  pendingPoints?: ReadonlyArray<NormPoint>;
  /**
   * ADMIN-ONLY geometry editing. When true AND a markup is selected, drag
   * handles render at each render point (anchor / endpoints / vertices). The
   * controller sets this only in admin mode, so Phil never renders a handle.
   */
  editMode?: boolean;
  /**
   * Drag-end callback: the markup id, the render-point index that moved, and its
   * new normalised position. The controller PATCHes {x,y} or {points} from it.
   */
  onMovePoint?: (id: string, pointIndex: number, p: NormPoint) => void;
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
  editMode = false,
  onMovePoint,
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
        // Drag handles render only when an admin is editing this selected markup.
        const handles =
          editMode && selected && onMovePoint ? (
            <DragHandles markupId={m.id} pixelPoints={pts} view={view} onMovePoint={onMovePoint} />
          ) : null;

        if (m.type === "arrow" && pts.length >= 2) {
          const markerId = `arrowhead-${m.id}`;
          return (
            <g key={m.id} className={cn("pointer-events-auto cursor-pointer", color)} onClick={onClick} data-testid="plan-markup-arrow">
              <defs>
                {/* arrowhead inherits the stroke colour via context-stroke/fill */}
                <marker
                  id={markerId}
                  markerWidth={8}
                  markerHeight={8}
                  refX={6}
                  refY={3}
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
                </marker>
              </defs>
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
                markerEnd={`url(#${markerId})`}
              />
              {handles}
            </g>
          );
        }

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
              {handles}
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
              {handles}
            </g>
          );
        }

        if (m.type === "text") {
          // Anchored callout: a small rounded background + the label/note text.
          const { px, py } = pts[0]!;
          const content = textMarkupContent(m);
          return (
            <g
              key={m.id}
              className={cn("pointer-events-auto cursor-pointer", color)}
              onClick={onClick}
              data-testid="plan-markup-text"
            >
              <rect
                x={px}
                y={py - 14}
                rx={4}
                width={Math.max(28, content.length * 7 + 12)}
                height={20}
                fill="white"
                stroke="currentColor"
                strokeWidth={selected ? 2 : 1.25}
              />
              <text x={px + 6} y={py} fontSize={12} fill="currentColor" className="select-none">
                {content}
              </text>
              {handles}
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
            {handles}
          </g>
        );
      })}

      {/* preview of an in-progress line/arrow/area's already-tapped points */}
      {pendingPoints.map((p, i) => {
        const { px, py } = normToPixel(p, view);
        return <circle key={`pending-${i}`} cx={px} cy={py} r={5} className="text-brand-navy" fill="currentColor" stroke="white" strokeWidth={1.5} />;
      })}
    </svg>
  );
}

/**
 * Admin-only draggable handles for one selected markup. One circle per render
 * point; a native pointer-drag maps the cursor back to a normalised page point
 * (pixelToNorm) and reports it to the controller on release. Rendered inside the
 * markup <g> so it is NEVER emitted in Phil mode (the controller withholds
 * `editMode`/`onMovePoint`). The fill collapses to a small navy ring so the
 * handles read as an edit affordance, not another marker.
 */
function DragHandles({
  markupId,
  pixelPoints,
  view,
  onMovePoint,
}: {
  markupId: string;
  pixelPoints: ReadonlyArray<{ px: number; py: number }>;
  view: PageView;
  onMovePoint: (id: string, pointIndex: number, p: NormPoint) => void;
}) {
  // Track the live drag so onMovePoint fires once, on release, with the final
  // normalised point. The <svg> root is the geometry reference for pixelToNorm.
  const dragging = useRef<{ index: number; px: number; py: number } | null>(null);

  const ownerRect = (el: Element): DOMRect | null => {
    const svg = el.closest("svg");
    return svg ? svg.getBoundingClientRect() : null;
  };

  const onPointerDown = useCallback((e: React.PointerEvent<SVGCircleElement>, index: number) => {
    e.stopPropagation();
    (e.currentTarget as SVGCircleElement).setPointerCapture?.(e.pointerId);
    const rect = ownerRect(e.currentTarget);
    if (!rect) return;
    dragging.current = { index, px: e.clientX - rect.left, py: e.clientY - rect.top };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    const rect = ownerRect(e.currentTarget);
    if (!rect) return;
    dragging.current = { index: dragging.current.index, px: e.clientX - rect.left, py: e.clientY - rect.top };
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      const drag = dragging.current;
      dragging.current = null;
      if (!drag) return;
      const rect = ownerRect(e.currentTarget);
      if (!rect) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      onMovePoint(markupId, drag.index, pixelToNorm({ px, py }, view));
    },
    [markupId, onMovePoint, view],
  );

  return (
    <g data-testid="plan-overlay-edit-handles">
      {pixelPoints.map((p, i) => (
        <circle
          key={`h-${i}`}
          cx={p.px}
          cy={p.py}
          r={7}
          fill="white"
          stroke="currentColor"
          strokeWidth={2}
          className="pointer-events-auto cursor-move text-brand-navy"
          data-testid="plan-overlay-edit-handle"
          onPointerDown={(e) => onPointerDown(e, i)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      ))}
    </g>
  );
}
