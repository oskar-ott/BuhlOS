"use client";

import { useCallback, useMemo, useState } from "react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import type { Route } from "next";
import { Pill } from "@/components/ui/Pill";
import {
  formatProgress,
  needsWorkerAttention,
  scopeContextLine,
  statusLabel,
  statusTone,
  type ITPStatusTone,
} from "@/domains/itp/format";
import { isPointApplicable } from "@/domains/itp/applicability";
import type { ITPInstance, ITPTemplatePoint } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";
import { ITPPointCard } from "./ITPPointCard";
import { ITPSubmitForReview } from "./ITPSubmitForReview";
import { ReportSnagSheet } from "./ReportSnagSheet";
import { resolveScopeName } from "./itp-scope";
import { PhilNotice } from "./ui/PhilNotice";

interface Props {
  job: Job;
  instance: ITPInstance;
  viewer: { id: string; role: string };
}

const STATUS_PILL_TONE: Record<
  ITPStatusTone,
  "info" | "success" | "warning" | "neutral"
> = {
  info: "info",
  success: "success",
  warning: "warning",
  neutral: "neutral",
};

type Banner =
  | { kind: "info"; message: string }
  | { kind: "danger"; message: string; status: number; needsReload?: boolean }
  | null;

/**
 * Phil — per-instance ITP recording orchestrator (Phase E1b).
 *
 * Server-component page `/phil/jobs/[jobId]/itps/[instanceId]/page.tsx`
 * hands us the canonical instance + viewer. We render a sticky header,
 * scope context line, banner area, and one ITPPointCard per template
 * point — in template order.
 *
 * State model:
 *   - Holds the canonical instance in local state. Each ITPPointCard
 *     bubbles up the server's response (the next-state ITPInstance)
 *     via onSaved; we replace in-memory so any value-pass-fail labels
 *     and the progress badge update immediately.
 *   - One shared banner above the point list. Children fire onError
 *     with a status code; we map 409 to "needs reload" and show a
 *     reload button.
 *
 * Architecture rule: this file lives under src/components/phil/. Do
 * not co-locate under src/app/phil/jobs/[jobId]/itps/[instanceId]/ —
 * that breaks the Next.js 15.5 RSC client manifest (doc 24 D-26
 * binding rule).
 *
 * Cross-ref:
 *   src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx — server entry
 *   src/components/phil/ITPPointCard.tsx — per-point card
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1b
 *   docs/rebuild-audit/34-phase-e-testing-checklist.md §B
 */
export function ITPRecording({ job, instance: initial, viewer }: Props) {
  const [instance, setInstance] = useState<ITPInstance>(initial);
  const [banner, setBanner] = useState<Banner>(null);
  // #520: defect-from-failure — a failed point's "Report defect" opens the
  // EXISTING Report snag sheet pre-filled with the real reading + criteria
  // and stamped with the itpInstanceId/itpPointId it came from.
  const [defectPrefill, setDefectPrefill] = useState<{
    pointId: string;
    title: string;
    description: string;
  } | null>(null);

  const visiblePoints = useMemo<ITPTemplatePoint[]>(() => {
    const ctx = { scope: instance.scope };
    const points = (instance.templateSnapshot?.points ?? []).filter(
      // #293: drop non-applicable conditional points entirely — they're
      // simply ABSENT, no "condition" copy, no greyed rows (P11). The
      // existing empty-state covers the all-filtered case. Snapshot-driven
      // + fail-open, so a typo never hides a real check.
      (p) => !p.archived && isPointApplicable(p, ctx),
    );
    // Render in (order, label) — legacy templates use an `order` int;
    // a missing order falls back to template position.
    return points
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [instance]);

  const progress = formatProgress(instance);
  const scopeName = resolveScopeName(job, instance);
  const scopeLine = scopeContextLine(instance.scope, scopeName);
  const templateName =
    instance.templateSnapshot?.name?.trim() || "Untitled ITP";

  const handleSaved = useCallback((next: ITPInstance) => {
    setInstance(next);
    // Clear any error banner — the save succeeded after.
    setBanner((curr) =>
      curr && curr.kind === "danger" ? null : curr,
    );
  }, []);

  const handleError = useCallback((message: string, status: number) => {
    setBanner({
      kind: "danger",
      message,
      status,
      needsReload: status === 409,
    });
  }, []);

  const handleReload = useCallback(() => {
    // Server component is responsible for the fresh load; this is the
    // simplest path that survives stale-state without an extra fetch.
    window.location.reload();
  }, []);

  const handleReportDefect = useCallback(
    (prefill: { pointId: string; title: string; description: string }) => {
      setDefectPrefill(prefill);
    },
    [],
  );

  const handleDefectCreated = useCallback(() => {
    setDefectPrefill(null);
    setBanner({ kind: "info", message: "Defect reported. It's on this job's snag list." });
  }, []);

  const lockedReason = lockedReasonFor(instance);

  return (
    <div className="space-y-4 pb-2">
      <div className="-mt-1">
        <PhilOfflineLink
          href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
          className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Back to job
        </PhilOfflineLink>
      </div>

      <section
        aria-label="ITP header"
        className="sticky top-0 z-10 -mx-4 border-b border-border bg-surface px-4 pb-3 pt-2"
      >
        <h1 className="font-display text-lg font-semibold text-text">
          {templateName}
        </h1>
        <p className="text-xs text-text-muted">{scopeLine}</p>
        <div className="mt-2 flex items-center gap-2">
          <Pill tone={STATUS_PILL_TONE[statusTone(instance.status)]}>
            {statusLabel(instance.status)}
          </Pill>
          <span className="text-xs text-text-muted">
            {progress.done} / {progress.total}
            {progress.total > 0 ? " points" : null}
          </span>
        </div>
      </section>

      {lockedReason ? (
        <PhilNotice tone="warning" role="status">
          {lockedReason}
        </PhilNotice>
      ) : null}

      {banner ? (
        <PhilNotice
          tone={banner.kind === "danger" ? "danger" : "info"}
          role={banner.kind === "danger" ? "alert" : "status"}
        >
          <p>{banner.message}</p>
          {banner.kind === "danger" && banner.needsReload ? (
            <button
              type="button"
              onClick={handleReload}
              className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-subtle"
            >
              Reload
            </button>
          ) : null}
        </PhilNotice>
      ) : null}

      {visiblePoints.length === 0 ? (
        <div className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted">
          No points on this ITP yet. Ask your PM if the template is
          complete.
        </div>
      ) : (
        <ul className="space-y-3">
          {visiblePoints.map((point) => (
            <li key={point.id}>
              <ITPPointCard
                jobId={job.id}
                instance={instance}
                point={point}
                viewer={viewer}
                onSaved={handleSaved}
                onError={handleError}
                onReportDefect={handleReportDefect}
              />
            </li>
          ))}
        </ul>
      )}

      {visiblePoints.length > 0 ? (
        <ITPSubmitForReview
          jobId={job.id}
          instance={instance}
          viewer={viewer}
          onSaved={handleSaved}
          onError={handleError}
        />
      ) : null}

      {/* #520: the EXISTING Report snag sheet, pre-filled from the failed
          point. Area context is derivable only for an area-scoped ITP;
          stage isn't on an ITP instance, so it stays unset (no invented
          context). The sheet caps + keeps everything editable. */}
      <ReportSnagSheet
        open={defectPrefill !== null}
        job={job}
        initialContext={{
          stage: null,
          areaId:
            instance.scope === "area" ? (instance.scopeId ?? null) : null,
        }}
        prefill={defectPrefill}
        originRefs={
          defectPrefill
            ? { itpInstanceId: instance.id, itpPointId: defectPrefill.pointId }
            : null
        }
        onClose={() => setDefectPrefill(null)}
        onCreated={handleDefectCreated}
        onFailed={() => {
          /* the sheet surfaces its own inline error */
        }}
      />
    </div>
  );
}

function lockedReasonFor(instance: ITPInstance): string | null {
  if (instance.archived) {
    return "This ITP has been archived. Recording is locked. Ask your PM if you need it reopened.";
  }
  if (instance.status === "signed-off") {
    return "Admin has signed off this ITP. Recording is locked; ask your PM to reopen if a point needs changing.";
  }
  if (instance.status === "witnessed" && !needsWorkerAttention(instance.status)) {
    // Belt-and-braces — needsWorkerAttention currently keeps witnessed
    // in the worker's view, but if that ever changes this guard fires.
    return "All required points have been recorded. Waiting for admin sign-off.";
  }
  return null;
}
