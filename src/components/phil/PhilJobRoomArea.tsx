"use client";

import {
  AlertOctagon,
  Camera,
  CheckCircle2,
  ChevronLeft,
  Circle,
  CircleDot,
  ExternalLink,
  FileText,
  Loader2,
  PenLine,
  Undo2,
} from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { PhilStatusBadge } from "./ui/PhilStatusBadge";
import { Bar } from "@/components/ui/Bar";
import {
  clauseLabel,
  displayTitle as docDisplayTitle,
} from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";
import { stageLabel } from "@/domains/jobs/format";
import type { JobStage } from "@/domains/jobs/types";
import {
  isComplete,
  nextToggleState,
  stageProgress,
  type TaskState,
  type WorkerTask,
} from "@/domains/jobs/taskState";
import { hasAnyStage, soleStage, type AreaStageAvailability } from "./philJobWorkTree";
import { PhilTaskScopeContext } from "./PhilTaskScopeContext";
import type { ProofActionStatus } from "./jobControlEvidenceLinkClient";
import {
  proofReviewStatusLabel,
  proofSubmitMessage,
  type ProofSubmitStatus,
} from "./jobControlProofReviewClient";
import {
  summarisePhilTaskProof,
  type PhilTaskContext,
  type TaskContextEvidenceReq,
} from "@/domains/job-control/task-context";
import { taskRefKey } from "@/domains/job-control/spine";
import type { ProofReview, TaskRef } from "@/domains/job-control/types";
import type { PhilTaskReadiness } from "@/domains/jobs/phil-task-projection";
import type { OwedProofItem } from "./philJobRooms";
import { cn } from "@/lib/cn";

interface Props {
  jobId: string;
  areaId: string;
  areaName: string;
  spaceType?: string | null;
  /** Which stages have a task plan for this area. */
  stages: AreaStageAvailability;
  /** Currently-viewed stage (parent-resolved, sole-stage aware). */
  stage: JobStage;
  onStageChange: (stage: JobStage) => void;
  /** Worker-visible tasks for the viewed stage, real runtime state merged. */
  tasks: ReadonlyArray<WorkerTask>;
  /** #196 specs governing this area (current-filtered by the parent). */
  areaSpecs?: ReadonlyArray<Document>;
  /** Streaming/error state of the task-state read — the same honesty gates the
   *  flag-off drill-in applies (never a false "to do" while streaming). */
  taskStatePending: boolean;
  taskStateError: string | null;
  /** Last failed toggle message (parent state). */
  taskError: string | null;
  pendingTaskIds?: ReadonlySet<string>;
  onToggleTask?: (taskId: string, next: TaskState) => void;
  taskContextById?: ReadonlyMap<string, PhilTaskContext>;
  readinessByTaskId?: ReadonlyMap<string, PhilTaskReadiness>;
  onCaptureProof?: (target: {
    workPackageId: string;
    requiredEvidenceId: string;
    kind: TaskContextEvidenceReq["kind"];
    taskId: string;
    taskRef?: TaskRef;
  }) => void;
  onFlagVariation?: (trigger: { warningId: string; taskRef?: TaskRef }) => void;
  proofActionState?: Readonly<Record<string, ProofActionStatus>>;
  canCaptureProof?: boolean;
  proofReviews?: ReadonlyArray<ProofReview>;
  onSubmitForReview?: (taskRef: TaskRef) => void;
  proofSubmitStatus?: Readonly<Record<string, ProofSubmitStatus>>;
  canSubmitForReview?: boolean;
  /** Whole-job owed proof (authored granularity); filtered to this area here. */
  owedProof: ReadonlyArray<OwedProofItem>;
  onBack: () => void;
  /** Sticky capture bar — all three ride the EXISTING capture paths. */
  onCapturePhoto: () => void;
  onCaptureNote: () => void;
  onCaptureIssue: () => void;
}

/**
 * Area view inside the four-rooms flow (phil_job_rooms — #133; prompt §2.4).
 *
 * A RE-SKIN of the area experience — same domain logic as the flag-off
 * drill-in (PhilJobAreaDetail): stage semantics via the parent's stage state,
 * task rows from the canonical projection with NON-OPTIMISTIC toggles
 * (onToggleTask → philWrite, state advances only on a confirmed reply),
 * blockers from the real observation-derived readiness, proof at its authored
 * granularity via the compiled task context. New chrome only: phase pills
 * (current filled navy), "Needs you here", a blocked banner, and a sticky
 * Photo · Note · Issue capture bar (existing capture launcher paths).
 */
export function PhilJobRoomArea({
  jobId,
  areaId,
  areaName,
  spaceType,
  stages,
  stage,
  onStageChange,
  tasks,
  areaSpecs,
  taskStatePending,
  taskStateError,
  taskError,
  pendingTaskIds,
  onToggleTask,
  taskContextById,
  readinessByTaskId,
  onCaptureProof,
  onFlagVariation,
  proofActionState,
  canCaptureProof,
  proofReviews,
  onSubmitForReview,
  proofSubmitStatus,
  canSubmitForReview,
  owedProof,
  onBack,
  onCapturePhoto,
  onCaptureNote,
  onCaptureIssue,
}: Props) {
  const sole = soleStage(stages);
  const showSelector = hasAnyStage(stages) && sole === null;
  const viewedStage: JobStage = sole ?? stage;
  const progress = stageProgress(tasks);
  const left = progress.total - progress.complete;

  // Real area-scoped signals only. Blocked rows come from the readiness map
  // (observation-derived); owed proof from the compiled requirements that
  // touch this area. Nothing qualifying ⇒ the sections are ABSENT (never an
  // empty "all clear" card).
  const blockedRows = taskStatePending
    ? []
    : tasks
        .map((t) => ({ task: t, readiness: readinessByTaskId?.get(t.id) }))
        .filter((r) => r.readiness?.readiness === "blocked");
  const areaOwedProof = owedProof.filter((item) => item.areaIds.includes(areaId));

  return (
    <div className="space-y-4" data-testid="phil-room-area">
      <button
        type="button"
        onClick={onBack}
        data-testid="phil-room-area-back"
        className="inline-flex min-h-[44px] items-center gap-1 rounded-card px-2 text-sm font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
      >
        <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        Whole job
      </button>

      <header>
        <h2 className="break-words font-display text-[21px] font-extrabold tracking-[-0.02em] text-text">
          {areaName}
        </h2>
        {spaceType ? <p className="mt-0.5 text-[13px] text-text-muted">{spaceType}</p> : null}
        {hasAnyStage(stages) && !taskStatePending && progress.total > 0 ? (
          <p className="mt-1 text-[13px] text-text-muted">
            {left === 0
              ? "All done here"
              : `${left} left in ${stageLabel(viewedStage).toLowerCase()}`}
          </p>
        ) : null}
      </header>

      {/* Phase pills — the existing stage-chooser semantics; current = filled
          navy (§2.4). Only when the area really has both stage plans. */}
      {showSelector ? (
        <div className="flex gap-2" role="tablist" aria-label="Stage">
          <PhasePill
            label={stageLabel("roughIn")}
            active={viewedStage === "roughIn"}
            onClick={() => onStageChange("roughIn")}
          />
          <PhasePill
            label={stageLabel("fitOff")}
            active={viewedStage === "fitOff"}
            onClick={() => onStageChange("fitOff")}
          />
        </div>
      ) : hasAnyStage(stages) ? (
        <p className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
          {stageLabel(viewedStage)}
        </p>
      ) : null}

      {/* n/m progress — real loaded counts only (skeleton while streaming). */}
      {hasAnyStage(stages) ? (
        taskStatePending ? (
          <PhilSkeleton className="h-2.5 w-full" />
        ) : progress.total > 0 ? (
          <div>
            <Bar
              pct={(progress.complete / progress.total) * 100}
              tone="success"
              className="h-2.5"
              aria-label={`${progress.complete} of ${progress.total} tasks done`}
            />
            <p className="mt-1 text-[12px] text-text-muted">
              {`${progress.complete}/${progress.total} done`}
            </p>
          </div>
        ) : null
      ) : null}

      {/* Needs you here — real owed proof touching this area. Absent otherwise. */}
      {areaOwedProof.length > 0 ? (
        <section
          aria-label="Needs you here"
          className="rounded-card border border-border border-l-[5px] border-l-accent-yellow bg-surface-raised p-3.5 shadow-card"
        >
          <h3 className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            Needs you here
          </h3>
          <ul className="mt-2 space-y-2">
            {areaOwedProof.map((item) => (
              <li
                key={`${item.workPackageId}:${item.requirement.id}`}
                className="flex min-h-[44px] items-center gap-2.5"
              >
                <Camera aria-hidden="true" className="h-4 w-4 shrink-0 text-state-warning" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-semibold text-text">
                    {item.requirement.label}
                  </span>
                  <span className="block truncate text-[12px] text-text-muted">
                    {item.workPackageTitle}
                  </span>
                </span>
                <PhilStatusBadge label="Needs photo" className="shrink-0" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Blocked banner — real observation-derived blockers only. */}
      {blockedRows.length > 0 ? (
        <PhilNotice tone="danger" title="Blocked" role="status">
          <ul className="space-y-1">
            {blockedRows.map(({ task, readiness }) => (
              <li key={task.id} className="break-words">
                <span className="font-semibold">{task.name}</span>
                {readiness?.blockedReason ? <> — {readiness.blockedReason}</> : null}
              </li>
            ))}
          </ul>
        </PhilNotice>
      ) : null}

      {taskError ? (
        <PhilNotice tone="danger" title="Couldn’t update task" role="alert">
          {taskError}
        </PhilNotice>
      ) : null}
      {taskStateError ? (
        <PhilNotice tone="warning" title="Couldn’t load task progress" role="status">
          Task rows may show as to do until you refresh. Saved changes will
          still update after the server confirms them.
        </PhilNotice>
      ) : null}

      {/* Tasks — the checklist. Skeleton while the task state streams so a
          done task is never briefly shown as "to do" (P7). */}
      {hasAnyStage(stages) ? (
        <section aria-label={`Tasks — ${stageLabel(viewedStage).toLowerCase()}`}>
          <h3 className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            {`Tasks · ${stageLabel(viewedStage).toLowerCase()}`}
          </h3>
          {taskStatePending ? (
            <div
              className="mt-2 space-y-2"
              aria-busy="true"
              aria-label="Loading task progress"
            >
              {[0, 1, 2, 3].map((i) => (
                <PhilSkeleton key={i} className="h-[52px] w-full" />
              ))}
            </div>
          ) : tasks.length > 0 ? (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
              {tasks.map((t) => {
                const tref: TaskRef = { areaId, stage: viewedStage, taskId: t.id };
                const rk = taskRefKey(tref);
                const review =
                  proofReviews?.find((r) => taskRefKey(r.taskRef) === rk) ?? null;
                return (
                  <RoomTaskRow
                    key={t.id}
                    jobId={jobId}
                    task={t}
                    pending={pendingTaskIds?.has(t.id) ?? false}
                    context={taskContextById?.get(t.id)}
                    readiness={readinessByTaskId?.get(t.id)}
                    onToggle={
                      onToggleTask
                        ? () => onToggleTask(t.id, nextToggleState(t.state))
                        : undefined
                    }
                    onCaptureProof={onCaptureProof}
                    onFlagVariation={
                      onFlagVariation
                        ? (trigger) => onFlagVariation({ ...trigger, taskRef: tref })
                        : undefined
                    }
                    proofActionState={proofActionState}
                    canCaptureProof={canCaptureProof}
                    review={review}
                    onSubmitForReview={
                      onSubmitForReview ? () => onSubmitForReview(tref) : undefined
                    }
                    submitStatus={proofSubmitStatus?.[rk]}
                    canSubmitForReview={canSubmitForReview}
                  />
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
              {`Nothing listed in ${stageLabel(viewedStage).toLowerCase()} for this area yet.`}
            </p>
          )}
        </section>
      ) : (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
          No task plan for this area yet. Your PM sets these up in the office app.
        </p>
      )}

      {/* #196 specs governing this area — read-only, hidden-when-empty. */}
      {areaSpecs && areaSpecs.length > 0 ? (
        <section aria-label="Specs for this area">
          <h3 className="px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            Specs for this area
          </h3>
          <ul className="mt-2 space-y-2">
            {areaSpecs.map((spec) => (
              <li key={spec.id}>
                <a
                  href={spec.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[56px] items-center gap-3 rounded-card border border-border bg-surface-raised px-3.5 py-2.5 transition-colors hover:bg-surface-subtle"
                  aria-label={`Open ${docDisplayTitle(spec)} (opens in a new tab)`}
                >
                  <FileText aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm font-semibold text-text">
                      {docDisplayTitle(spec)}
                    </span>
                    {clauseLabel(spec) ? (
                      <span className="mt-0.5 block truncate text-[12px] text-text-muted">
                        {clauseLabel(spec)}
                      </span>
                    ) : null}
                  </span>
                  <ExternalLink aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Sticky capture bar (§2.4) — always thumb-reachable; all three ride
          the EXISTING capture paths (job CaptureSheet / launcher presets). */}
      <div
        data-testid="phil-room-area-capture-bar"
        className="sticky bottom-2 z-10 flex gap-2 rounded-card border border-border bg-surface-raised p-2 shadow-raised"
      >
        <CaptureBarButton icon={Camera} label="Photo" onClick={onCapturePhoto} />
        <CaptureBarButton icon={PenLine} label="Note" onClick={onCaptureNote} />
        <CaptureBarButton icon={AlertOctagon} label="Issue" onClick={onCaptureIssue} />
      </div>
    </div>
  );
}

function PhasePill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "min-h-[44px] flex-1 rounded-pill border px-4 font-display text-sm font-semibold transition-colors",
        active
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface-raised text-text hover:bg-surface-subtle",
      )}
    >
      {label}
    </button>
  );
}

function CaptureBarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Camera;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-card border border-border bg-surface font-display text-sm font-semibold text-brand-navy transition-colors hover:bg-surface-subtle active:scale-[0.99]"
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}

/** Leading state box — a visual echo of the real state, never its source. */
function StateGlyph({ state }: { state: TaskState }) {
  if (state === "complete") {
    return <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-state-success" />;
  }
  if (state === "in_progress") {
    return <CircleDot aria-hidden="true" className="h-5 w-5 shrink-0 text-state-info" />;
  }
  return <Circle aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/50" />;
}

/**
 * One checklist row — the flag-off TaskRow's behaviour (non-optimistic toggle,
 * blocked reason, authored-granularity proof summary, per-task review + the
 * compiled scope context) in the sharpened row language. Prototype voice on
 * state: a "Going" chip marks in-progress; done shows the tick + strike.
 */
function RoomTaskRow({
  jobId,
  task,
  pending,
  onToggle,
  context,
  readiness,
  onCaptureProof,
  onFlagVariation,
  proofActionState,
  canCaptureProof,
  review,
  onSubmitForReview,
  submitStatus,
  canSubmitForReview,
}: {
  jobId?: string;
  task: WorkerTask;
  pending: boolean;
  onToggle?: () => void;
  context?: PhilTaskContext;
  readiness?: PhilTaskReadiness;
  onCaptureProof?: (target: {
    workPackageId: string;
    requiredEvidenceId: string;
    kind: TaskContextEvidenceReq["kind"];
    taskId: string;
    taskRef?: TaskRef;
  }) => void;
  onFlagVariation?: (trigger: { warningId: string; taskRef?: TaskRef }) => void;
  proofActionState?: Readonly<Record<string, ProofActionStatus>>;
  canCaptureProof?: boolean;
  review?: ProofReview | null;
  onSubmitForReview?: () => void;
  submitStatus?: ProofSubmitStatus;
  canSubmitForReview?: boolean;
}) {
  const done = isComplete(task.state);
  const blocked = readiness?.readiness === "blocked";
  const proof = context ? summarisePhilTaskProof(context) : null;
  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex min-h-[52px] items-center gap-3">
        <StateGlyph state={task.state} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block break-words",
              done ? "text-text-muted line-through" : "font-medium text-text",
            )}
          >
            {task.name}
          </span>
          {task.state === "in_progress" ? (
            <PhilStatusBadge label="Going" tone="info" className="mt-1" />
          ) : null}
          {blocked ? <PhilStatusBadge label="Blocked" className="mt-1" /> : null}
        </span>
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            disabled={pending}
            aria-label={done ? `Mark ${task.name} not done` : `Mark ${task.name} done`}
            className={cn(
              "inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface px-4 font-display text-xs font-semibold text-text transition-colors",
              "hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-text-muted" />
            ) : done ? (
              <Undo2 aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-state-success" />
            )}
            {pending ? "Saving…" : done ? "Undo" : "Mark done"}
          </button>
        ) : null}
      </div>
      {blocked && readiness?.blockedReason ? (
        <p className="mt-1.5 break-words text-xs font-medium text-state-danger">
          {readiness.blockedReason}
        </p>
      ) : null}
      {proof ? (
        proof.eligibleForReview ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-state-success">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-display font-semibold">Proof</span> — all captured ·
              ready for review
            </span>
          </p>
        ) : (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-state-warning">
            <Camera aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-display font-semibold">Proof</span>
              {` — ${proof.metCount}/${proof.requiredCount} captured`}
            </span>
          </p>
        )
      ) : null}
      {review ? (
        <p
          className={cn(
            "mt-1.5 text-xs",
            review.status === "approved"
              ? "text-state-success"
              : review.status === "rejected"
                ? "text-state-warning"
                : "text-text-muted",
          )}
        >
          <span className="font-display font-semibold">Review</span> —{" "}
          {proofReviewStatusLabel(review)}
        </p>
      ) : null}
      {onSubmitForReview &&
      canSubmitForReview &&
      proof?.eligibleForReview &&
      review?.status !== "submitted" &&
      review?.status !== "approved" ? (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={onSubmitForReview}
            disabled={submitStatus === "submitting"}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-border bg-surface px-3 font-display text-xs font-semibold text-text",
              "hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {submitStatus === "submitting"
              ? "Submitting…"
              : review?.status === "rejected"
                ? "Resubmit for review"
                : "Submit for review"}
          </button>
          {submitStatus && submitStatus !== "submitting" ? (
            <span className="mt-1 block text-xs text-state-warning">
              {proofSubmitMessage(submitStatus)}
            </span>
          ) : null}
        </div>
      ) : null}
      {context ? (
        <PhilTaskScopeContext
          context={context}
          jobId={jobId}
          onCaptureProof={
            onCaptureProof ? (t) => onCaptureProof({ ...t, taskId: task.id }) : undefined
          }
          onFlagVariation={onFlagVariation}
          proofActionState={proofActionState}
          canCaptureProof={canCaptureProof}
        />
      ) : null}
    </li>
  );
}
