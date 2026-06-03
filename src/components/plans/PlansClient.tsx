"use client";

import { useMemo, useState } from "react";
import { ImageOff, Layers } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  compareForQueue,
  displayTitle,
  drawingContextLine,
  statusLabel,
  statusTone,
} from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";
import {
  currentPlans,
  hasRaster,
  pageCount,
  toPlan,
  viewablePlans,
} from "@/domains/plans/format";
import { PlanViewer } from "./PlanViewer";
import { PlanOverlayController } from "./PlanOverlayController";

/**
 * Read-only Plans surface (Phase 1) shared by the admin and Phil routes.
 *
 * `mode` is the only behavioural switch:
 *   - "phil"  → field workers see CURRENT revisions only (superseded and
 *               archived are filtered out entirely).
 *   - "admin" → admins/LH see current + superseded (never archived);
 *               opening a superseded revision shows the loud guard in
 *               PlanViewer.
 *
 * Selection lives here; the heavy raster display lives in PlanViewer.
 */

interface PlansClientProps {
  mode: "admin" | "phil";
  initialDocuments: ReadonlyArray<Document>;
  fetchError?: string | null;
  /**
   * Plans Phase 2: when provided, the viewer gains the markup overlay layer
   * (admin can add/edit/toggle/archive; Phil reads visibleToPhil overlays).
   * Omitted → pure Phase 1 read-only viewer (unchanged).
   */
  jobId?: string;
}

export function PlansClient({
  mode,
  initialDocuments,
  fetchError = null,
  jobId,
}: PlansClientProps) {
  const visible = useMemo(() => {
    const set = mode === "phil" ? currentPlans(initialDocuments) : viewablePlans(initialDocuments);
    return [...set].sort(compareForQueue);
  }, [mode, initialDocuments]);

  const [selectedId, setSelectedId] = useState<string | null>(
    () => visible[0]?.id ?? null,
  );

  const selected = useMemo(
    () => visible.find((d) => d.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

  if (fetchError) {
    return (
      <EmptyState
        title="Couldn't load plans"
        description={fetchError}
      />
    );
  }

  if (visible.length === 0 || !selected) {
    return (
      <EmptyState
        title={mode === "phil" ? "No plans for this job yet" : "No plans uploaded yet"}
        description={
          mode === "phil"
            ? "When the office publishes drawings for this job, they'll appear here."
            : "Upload drawings from the Plans admin to make them available here."
        }
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* Plan list */}
      <div className="flex max-h-[80vh] flex-col gap-2 overflow-y-auto rounded-card border border-border bg-surface p-2">
        {visible.map((doc) => {
          const active = doc.id === selected.id;
          const rastered = hasRaster(doc);
          const context = drawingContextLine(doc);
          return (
            <button
              key={doc.id}
              type="button"
              onClick={() => setSelectedId(doc.id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "w-full rounded-card border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-brand-navy bg-surface-subtle"
                  : "border-transparent hover:border-border hover:bg-surface-subtle",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-text">
                  {displayTitle(doc)}
                </span>
                {mode === "admin" ? (
                  <Pill tone={statusTone(doc.status)} className="shrink-0">
                    {statusLabel(doc.status)}
                  </Pill>
                ) : null}
              </div>
              {context ? (
                <p className="mt-0.5 truncate text-xs text-text-muted">{context}</p>
              ) : null}
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted">
                {rastered ? (
                  <>
                    <Layers className="h-3 w-3" aria-hidden />
                    {`${pageCount(doc)} page${pageCount(doc) === 1 ? "" : "s"}`}
                  </>
                ) : (
                  <>
                    <ImageOff className="h-3 w-3" aria-hidden />
                    Original PDF only
                  </>
                )}
              </p>
            </button>
          );
        })}
      </div>

      {/* Viewer */}
      <div className="min-w-0 rounded-card border border-border bg-surface-raised p-5 shadow-card">
        {jobId ? (
          <PlanOverlayController jobId={jobId} plan={toPlan(selected)} mode={mode} />
        ) : (
          <PlanViewer plan={toPlan(selected)} />
        )}
      </div>
    </div>
  );
}
