"use client";

import { useCallback, useMemo, useState } from "react";
import { Camera, Check, CircleDot, Send, Stamp, X } from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import type { Route } from "next";
import { Bar } from "@/components/ui/Bar";
import {
  formatProgress,
  scopeContextLine,
  valuePassFail,
} from "@/domains/itp/format";
import { canSubmitForReview } from "@/domains/itp/service";
import { submitItpForReview } from "@/domains/itp/client";
import type {
  ITPInstance,
  ITPStatus,
  ITPTemplatePoint,
} from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";
import { ITPPointCard } from "./ITPPointCard";
import { ReportSnagSheet } from "./ReportSnagSheet";
import { resolveScopeName } from "./itp-scope";
import { PhilNotice } from "./ui/PhilNotice";
import {
  PhilStatusBadge,
  type PhilStatusTone,
} from "./ui/PhilStatusBadge";
import {
  itpApplicablePoints,
  itpOwedLine,
  itpProofSummary,
  itpStations,
  type ItpStation,
} from "./itpSharpened";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
  instance: ITPInstance;
  viewer: { id: string; role: string };
  /** Point ids on THIS instance that already have a snag raised from them
   *  (real #520 origin links loaded by the page). Never fabricated — when
   *  the snags read fails the page passes [] and the tag simply doesn't
   *  render. */
  initialSnagPointIds: ReadonlyArray<string>;
}

type Banner =
  | { kind: "info"; message: string }
  | { kind: "danger"; message: string; status: number; needsReload?: boolean }
  | null;

/**
 * Phil — sharpened Checks/ITP detail (phil_sharpened, dark; Wave 4a of the
 * field-surface redesign; prompt §2.8 "site work, not paperwork").
 *
 * Rendered ONLY when the server-resolved flag is on (the page branches;
 * flag off = ITPRecording, byte-identical). A re-skinned orchestration of
 * the SAME machinery — behaviour preserved, not rebuilt:
 *
 *   - Title block: real template name, the job's real code/ref + resolved
 *     scope, the status badge, a real n/m progress bar (formatProgress —
 *     the one done/total rule the server shares).
 *   - Sign-off chain: the three REAL stations of the instance machine
 *     (recorded → submitted → office sign-off). No "Witness Dave" station —
 *     witnessing is a per-point witnessRole, which the point cards gate
 *     (see itpSharpened.ts).
 *   - Required proof: the snapshot's real proof kinds — value readings
 *     (recorded value + unit, mono) and photo-bearing points (real
 *     attached count, amber when short). Absent when the template has
 *     neither (no fabricated taxonomy).
 *   - Points: the EXISTING ITPPointCard per point — same record / photo /
 *     witness-gate / fail-verdict / Report-defect behaviour, same testids,
 *     same non-optimistic writes. A "Snag raised" tag renders under a
 *     point only when a real snag carries its #520 origin link.
 *   - Sticky primary: the real next action — "Send to the office" via the
 *     existing submit-for-review flow (shared canSubmitForReview gate, so
 *     the button never offers what the server would 409) + an owed line
 *     computed from the real remaining points/proof.
 */
export function PhilItpSharpened({
  job,
  instance: initial,
  viewer,
  initialSnagPointIds,
}: Props) {
  const [instance, setInstance] = useState<ITPInstance>(initial);
  const [banner, setBanner] = useState<Banner>(null);
  const [submitting, setSubmitting] = useState(false);
  const [defectPrefill, setDefectPrefill] = useState<{
    pointId: string;
    title: string;
    description: string;
  } | null>(null);
  // Real ITP→snag links only: seeded from the page's snags read, grown when
  // the worker raises a defect from a point in this session.
  const [snagPointIds, setSnagPointIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSnagPointIds),
  );

  // Same filter + order as ITPRecording.visiblePoints (#293: non-applicable
  // conditional points are simply absent) — one source in the helper.
  const points = useMemo<ITPTemplatePoint[]>(
    () => itpApplicablePoints(instance),
    [instance],
  );

  const progress = formatProgress(instance);
  const stations = itpStations(instance);
  const proof = itpProofSummary(instance);
  const scopeName = resolveScopeName(job, instance);
  const scopeLine = scopeContextLine(instance.scope, scopeName);
  const templateName =
    instance.templateSnapshot?.name?.trim() || "Untitled ITP";
  const jobRef = job.code ?? job.ref ?? null;
  const refLine = [jobRef, scopeLine].filter(Boolean).join(" · ");

  const handleSaved = useCallback((next: ITPInstance) => {
    setInstance(next);
    setBanner((curr) => (curr && curr.kind === "danger" ? null : curr));
  }, []);

  const handleError = useCallback((message: string, status: number) => {
    setBanner({ kind: "danger", message, status, needsReload: status === 409 });
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleReportDefect = useCallback(
    (prefill: { pointId: string; title: string; description: string }) => {
      setDefectPrefill(prefill);
    },
    [],
  );

  const lockedReason = lockedReasonFor(instance);

  const decision = canSubmitForReview(instance, {
    userId: viewer.id,
    role: viewer.role,
  });
  const showSubmit =
    !instance.archived &&
    (instance.status === "pending" || instance.status === "in-progress") &&
    // Wrong-role shouldn't happen on this surface; if it does, no dead button.
    !(decision.ok === false && decision.reason === "wrong-role");
  const submitDisabled = submitting || decision.ok === false;
  const owedLine = itpOwedLine(instance);
  const readyToSend = decision.ok === true;

  async function handleSubmit() {
    setSubmitting(true);
    const r = await submitItpForReview(job.id, { instanceId: instance.id });
    setSubmitting(false);
    if (r.ok) {
      handleSaved(r.data.instance);
      return;
    }
    handleError(
      r.error.status === 409
        ? "Couldn't send it — finish the required points, or reload if it changed."
        : r.error.status === 403
          ? "You can't submit this check."
          : r.error.kind
            ? r.error.message
            : "Couldn't send it to the office. Try again.",
      r.error.status,
    );
  }

  return (
    <div className="space-y-4 pb-2" data-testid="phil-itp-sharpened">
      <div className="-mt-1">
        <PhilOfflineLink
          href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
          className="inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Back to job
        </PhilOfflineLink>
      </div>

      {/* Title block — real name, real ref/scope, real n/m. */}
      <header>
        {refLine ? (
          <p className="font-mono text-[12px] font-semibold text-text-muted [font-variant-numeric:tabular-nums]">
            {refLine}
          </p>
        ) : null}
        <div className="mt-1 flex items-start justify-between gap-3">
          <h1 className="min-w-0 break-words font-display text-2xl font-extrabold leading-tight tracking-[-0.02em] text-text">
            {templateName}
          </h1>
          <StatusBadgeFor status={instance.status} />
        </div>
        {progress.total > 0 ? (
          <div className="mt-2.5 flex items-center gap-2.5">
            <Bar
              pct={progress.percent}
              tone="success"
              className="h-2 flex-1"
              aria-label={`${progress.done} of ${progress.total} points recorded`}
            />
            <span className="shrink-0 font-mono text-[13px] font-semibold text-text [font-variant-numeric:tabular-nums]">
              {`${progress.done}/${progress.total}`}
            </span>
          </div>
        ) : null}
      </header>

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

      {/* Sign-off chain — the real stations, real states. */}
      <section
        aria-label="Sign-off"
        data-testid="phil-itp-signoff-chain"
        className="rounded-card border border-border bg-surface-raised p-4 shadow-card"
      >
        <h2 className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
          Sign-off
        </h2>
        <div className="mt-3 flex items-start">
          {stations.map((station, i) => (
            <StationNode key={station.key} station={station} first={i === 0} />
          ))}
        </div>
      </section>

      {/* Required proof — only when the template really has proof-kind
          points (readings / photos); otherwise the points list is the
          whole story. */}
      {proof ? (
        <section
          aria-label="Required proof"
          data-testid="phil-itp-required-proof"
          className="space-y-1.5"
        >
          <h2 className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            Required proof
          </h2>
          <div className="divide-y divide-border rounded-card border border-border bg-surface-raised px-3.5 shadow-card">
            {proof.readings.map((point) => (
              <ReadingRow key={point.id} instance={instance} point={point} />
            ))}
            {proof.photos ? (
              <PhotosRow attached={proof.photos.attached} total={proof.photos.total} />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Points — the existing recording cards (same behaviour + testids). */}
      {points.length === 0 ? (
        <div className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted">
          No points on this ITP yet. Ask your PM if the template is complete.
        </div>
      ) : (
        <section aria-label={`Points · ${points.length}`} className="space-y-1.5">
          <h2 className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            {`Points · ${points.length}`}
          </h2>
          <ul className="space-y-3">
            {points.map((point) => (
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
                {snagPointIds.has(point.id) ? (
                  <div
                    className="mt-1.5 flex items-center gap-2 px-1"
                    data-testid={`phil-itp-snag-raised-${point.id}`}
                  >
                    <PhilStatusBadge label="Snag raised" tone="danger" />
                    <span className="text-[12px] text-text-muted">
                      on this job&rsquo;s snag list
                    </span>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The office owns it now — calm, non-sticky. */}
      {instance.status === "witnessed" ? (
        <PhilNotice tone="info" role="status">
          Submitted for review — waiting on the office to sign off.
        </PhilNotice>
      ) : null}

      {/* Sticky primary — the real next action + the honest owed line. */}
      {showSubmit ? (
        <div
          data-testid="phil-itp-sharpened-submit"
          className="sticky bottom-2 z-10 rounded-card border border-border bg-surface-raised p-3 shadow-raised"
        >
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitDisabled}
            aria-disabled={submitDisabled}
            className={cn(
              "inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-card",
              "bg-brand-navy font-display text-base font-bold text-text-inverse",
              "transition hover:brightness-110 active:scale-[0.99]",
              "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
            )}
          >
            <Send aria-hidden="true" className="h-[18px] w-[18px]" />
            {submitting ? "Sending…" : "Send to the office"}
          </button>
          <p
            className={cn(
              "mt-2 text-center text-[12px]",
              readyToSend ? "text-text-muted" : "font-medium text-state-warning",
            )}
          >
            {owedLine}
          </p>
        </div>
      ) : null}

      {/* #520: the EXISTING Report snag sheet, pre-filled from the failed
          point — same wiring as the flag-off screen. */}
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
        onCreated={(snag) => {
          // The created snag carries its real origin link — grow the tag set
          // from it, never from assumption.
          if (snag.itpPointId) {
            setSnagPointIds((curr) => new Set([...curr, snag.itpPointId!]));
          }
          setDefectPrefill(null);
          setBanner({
            kind: "info",
            message: "Snag raised. It's on this job's snag list.",
          });
        }}
        onFailed={() => {
          /* the sheet surfaces its own inline error */
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------
 * Pieces
 * -------------------------------------------------------------------*/

const SHARP_STATUS: Record<
  ITPStatus,
  { label: string; tone: PhilStatusTone }
> = {
  // The sharpened badge vocabulary, honestly mapped onto the real machine:
  // 'pending' = attached with nothing recorded yet.
  pending: { label: "Not started", tone: "neutral" },
  "in-progress": { label: "In progress", tone: "info" },
  // 'witnessed' IS the submitted-for-review state (see service.ts).
  witnessed: { label: "Submitted", tone: "info" },
  "signed-off": { label: "Signed off", tone: "success" },
};

function StatusBadgeFor({ status }: { status: ITPStatus }) {
  const s = SHARP_STATUS[status];
  return <PhilStatusBadge label={s.label} tone={s.tone} className="mt-1 shrink-0" />;
}

function StationNode({ station, first }: { station: ItpStation; first: boolean }) {
  const circle =
    station.state === "done"
      ? "bg-state-success text-white"
      : station.state === "current"
        ? "border border-state-info-subtle-border bg-state-info-subtle-bg text-state-info-subtle-text"
        : "border border-border bg-surface-subtle text-text-muted";
  const Icon =
    station.state === "done"
      ? Check
      : station.key === "signoff"
        ? Stamp
        : CircleDot;
  return (
    <>
      {first ? null : (
        <span
          aria-hidden="true"
          className="mt-[16px] h-0.5 w-6 shrink-0 bg-border"
        />
      )}
      <div className="flex flex-1 flex-col items-center gap-1.5 text-center">
        <span
          className={cn(
            "inline-flex h-[34px] w-[34px] items-center justify-center rounded-pill",
            circle,
          )}
        >
          <Icon aria-hidden="true" className="h-[17px] w-[17px]" />
        </span>
        <span
          className={cn(
            "text-[12px] font-semibold leading-tight",
            station.state === "pending" ? "text-text-muted" : "text-text",
          )}
        >
          {station.label}
          <span className="block break-words font-normal text-text-muted">
            {station.sub}
          </span>
        </span>
        <span className="sr-only">
          {station.state === "done"
            ? " — done"
            : station.state === "current"
              ? " — up next"
              : " — waiting"}
        </span>
      </div>
    </>
  );
}

/** One reading (value point): recorded value + unit in mono, verdict glyph. */
function ReadingRow({
  instance,
  point,
}: {
  instance: ITPInstance;
  point: ITPTemplatePoint;
}) {
  const result = instance.results?.[point.id];
  const recorded = Boolean(result?.at);
  const verdict = valuePassFail(point, result);
  const value =
    recorded &&
    (typeof result?.value === "number" ||
      (typeof result?.value === "string" && result.value.trim() !== ""))
      ? `${result.value}${point.unit ? ` ${point.unit}` : ""}`
      : null;
  return (
    <div className="flex min-h-[52px] items-center gap-3 py-2.5">
      <span
        className={cn(
          "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-pill",
          verdict === "fail"
            ? "border border-state-danger-subtle-border bg-state-danger-subtle-bg text-state-danger-subtle-text"
            : recorded
              ? "bg-state-success text-white"
              : "border border-border bg-surface-subtle text-text-muted",
        )}
      >
        {verdict === "fail" ? (
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        ) : recorded ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <CircleDot aria-hidden="true" className="h-3 w-3" />
        )}
      </span>
      <span className="min-w-0 flex-1 break-words text-[15px] font-medium text-text">
        {point.label}
      </span>
      {value ? (
        <span
          className={cn(
            "shrink-0 font-mono text-[12px] font-semibold [font-variant-numeric:tabular-nums]",
            verdict === "fail" ? "text-state-danger" : "text-state-success",
          )}
        >
          {value}
        </span>
      ) : recorded ? (
        // Stamped but value-less (a note-only record): the glyph says
        // recorded — the text must agree with it, not claim "not recorded".
        // Matches formatProgress, which counts any stamped point as done.
        <span className="shrink-0 text-[12px] text-text-muted">
          recorded · no reading value
        </span>
      ) : (
        <span className="shrink-0 text-[12px] text-text-muted">
          not recorded
        </span>
      )}
    </div>
  );
}

/** Photo-bearing points, aggregated: real attached count, amber when short. */
function PhotosRow({ attached, total }: { attached: number; total: number }) {
  const short = attached < total;
  return (
    <div className="flex min-h-[52px] items-center gap-3 py-2.5">
      <span
        className={cn(
          "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-pill",
          short
            ? "border border-state-warning-subtle-border bg-state-warning-subtle-bg text-state-warning-subtle-text"
            : "bg-state-success text-white",
        )}
      >
        <Camera aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 text-[15px] font-medium text-text">Photos</span>
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-pill border px-2 py-0.5",
          "font-mono text-[12px] font-semibold [font-variant-numeric:tabular-nums]",
          short
            ? "border-state-warning-subtle-border bg-state-warning-subtle-bg text-state-warning-subtle-text"
            : "border-state-success-subtle-border bg-state-success-subtle-bg text-state-success-subtle-text",
        )}
      >
        {`${attached}/${total}`}
      </span>
    </div>
  );
}

function lockedReasonFor(instance: ITPInstance): string | null {
  // Same honesty as the flag-off screen (ITPRecording.lockedReasonFor).
  if (instance.archived) {
    return "This ITP has been archived. Recording is locked. Ask your PM if you need it reopened.";
  }
  if (instance.status === "signed-off") {
    return "Admin has signed off this ITP. Recording is locked; ask your PM to reopen if a point needs changing.";
  }
  return null;
}
