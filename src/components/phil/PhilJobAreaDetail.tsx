"use client";

import {
  AlertOctagon,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  ClipboardCheck,
  Loader2,
  Undo2,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { stageLabel } from "@/domains/jobs/format";
import type { JobStage } from "@/domains/jobs/types";
import {
  isComplete,
  nextToggleState,
  stageProgress,
  taskStateLabel,
  taskStateTone,
  type TaskState,
  type WorkerTask,
} from "@/domains/jobs/taskState";
import {
  areaQuickLinks,
  hasAnyStage,
  soleStage,
  type AreaCounts,
  type AreaQuickLink,
  type AreaStageAvailability,
} from "./philJobWorkTree";
import { PhilTaskScopeContext } from "./PhilTaskScopeContext";
import type { ProofActionStatus } from "./jobControlEvidenceLinkClient";
import { summarisePhilTaskProof, type PhilTaskContext } from "@/domains/job-control/task-context";
import type { TaskRef } from "@/domains/job-control/types";
import type { PhilTaskReadiness } from "@/domains/jobs/phil-task-projection";
import { cn } from "@/lib/cn";

const LINK_ICON = {
  snags: AlertOctagon,
  itps: ClipboardCheck,
  photos: Camera,
} as const;

interface Props {
  areaName: string;
  spaceType?: string | null;
  /** Which stages have a task plan for this area. */
  stages: AreaStageAvailability;
  /** Currently-viewed stage (parent state). */
  stage: JobStage;
  /** Worker-visible tasks for the viewed stage, each merged with its real
   *  runtime state (already resolved by the parent). */
  tasks: ReadonlyArray<WorkerTask>;
  /** Real, area-linked counts for this area. */
  counts: AreaCounts;
  onStageChange: (stage: JobStage) => void;
  /** Toggle a task's done state. When omitted the task list renders
   *  read-only (state pills, no controls) — so the action only appears when
   *  the parent has wired a safe, server-backed mutation. */
  onToggleTask?: (taskId: string, next: TaskState) => void;
  /** Task ids with a toggle in flight — the row shows a saving state and
   *  disables its control until the server confirms. */
  pendingTaskIds?: ReadonlySet<string>;
  /** Per-task compiled scope context (#368), keyed by task id. Built by the
   *  parent via the job-control model (`buildAreaTaskContext`). A task with no
   *  entry renders exactly as today — the map only carries non-empty contexts,
   *  and the Phil job fetch carries none until the compile→Phil plumbing lands,
   *  so this is `undefined` in production right now (zero regression). */
  taskContextById?: ReadonlyMap<string, PhilTaskContext>;
  /** Per-task readiness (#482 model), keyed by task id — same key as
   *  `taskContextById`. The row shows a "Blocked — <reason>" line ONLY when a
   *  task's readiness is `blocked`; `ready` / `complete` render exactly as today.
   *  With no real blocker/dependency source yet, no entry is `blocked` in
   *  production, so this is visually inert until that data flows (zero
   *  regression). */
  readinessByTaskId?: ReadonlyMap<string, PhilTaskReadiness>;
  /** Capture proof for a specific unmet requirement on a task. The parent fills
   *  the area/stage coordinate; the row adds `taskId`. Omitted ⇒ no affordance. */
  onCaptureProof?: (target: { workPackageId: string; requiredEvidenceId: string; taskId: string; taskRef?: TaskRef }) => void;
  /** Per-requirement (requiredEvidenceId → status) capture/link feedback. */
  proofActionState?: Readonly<Record<string, ProofActionStatus>>;
  /** Whether a capture+link can run now (a job-control revision is available). */
  canCaptureProof?: boolean;
}

/**
 * Phil — Job area drill-in.
 *
 * The detail surface shown once a worker taps an area card, per the
 * Phil Job Interface Bible §09 ("an area is a small job inside the
 * job"). Replaces the bare "{stage} · {area}" task-list card with a
 * proper drill-in:
 *
 *   1. Area header (name + space type).
 *   2. "In this area" quick links — one chip per real, area-linked
 *      count (snags · area ITPs · photos). Each scrolls to the matching
 *      job section. Hidden entirely when nothing is outstanding.
 *   3. Stage selector — only when the area has BOTH a rough-in and a
 *      fit-off plan. With a single stage there's nothing to choose, so
 *      we show a static stage label instead (the parent has already
 *      synced `stage` to the sole stage on select).
 *   4. Task list for the viewed stage — each row shows its real runtime
 *      state and, when `onToggleTask` is wired, a Mark done / Undo
 *      control backed by POST /api/task-toggle. State only moves on a
 *      confirmed server response (no optimistic flips), so a failed
 *      write never shows a task as done. Without `onToggleTask` the list
 *      is read-only (state pills only).
 *
 * No new data: counts come from the maps the page already built; stage
 * availability from the task plan; task state from the data blob the
 * parent loaded. Documents / materials are deliberately absent — not
 * area-linked real data.
 *
 * Cross-ref:
 *   src/components/phil/philJobWorkTree.ts — soleStage / areaQuickLinks
 *   src/domains/jobs/taskState.ts — WorkerTask + toggle helpers
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §09
 */
export function PhilJobAreaDetail({
  areaName,
  spaceType,
  stages,
  stage,
  tasks,
  counts,
  onStageChange,
  onToggleTask,
  pendingTaskIds,
  taskContextById,
  readinessByTaskId,
  onCaptureProof,
  proofActionState,
  canCaptureProof,
}: Props) {
  const links = areaQuickLinks(counts);
  const sole = soleStage(stages);
  const showSelector = hasAnyStage(stages) && sole === null;
  // When the area has a single stage, that's what's shown; otherwise the
  // parent-controlled `stage` drives the list.
  const viewedStage: JobStage = sole ?? stage;
  // Honest completion count for the viewed stage — derived purely from the
  // real task states, never a fabricated percentage. stageProgress IS the
  // canonical stage-level counter: src/domains/jobs/progress.ts (#198)
  // builds the office's area/job numbers on the same complete-only,
  // archived-excluded semantics, so field and office can never disagree.
  const progress = stageProgress(tasks);

  return (
    <Card aria-label={`${areaName} detail`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="break-words">{areaName}</CardTitle>
          {spaceType ? (
            <CardDescription className="mt-1">{spaceType}</CardDescription>
          ) : null}
        </div>
      </div>

      {links.length > 0 ? (
        <div className="mt-3">
          <p className="font-display text-[12px] uppercase tracking-wider text-text-muted">
            In this area
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {links.map((link) => (
              <li key={link.key}>
                <QuickLink link={link} />
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-text-muted/80">
            Counts are for this area. Tap to open the job-wide list.
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        {showSelector ? (
          <>
            <p className="font-display text-[12px] uppercase tracking-wider text-text-muted">
              Stage
            </p>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="tablist"
              aria-label="Stage"
            >
              <StageButton
                label={stageLabel("roughIn")}
                active={viewedStage === "roughIn"}
                onClick={() => onStageChange("roughIn")}
              />
              <StageButton
                label={stageLabel("fitOff")}
                active={viewedStage === "fitOff"}
                onClick={() => onStageChange("fitOff")}
              />
            </div>
          </>
        ) : hasAnyStage(stages) ? (
          <p className="font-display text-[12px] uppercase tracking-wider text-text-muted">
            {stageLabel(viewedStage)} tasks
          </p>
        ) : null}

        {hasAnyStage(stages) && tasks.length > 0 ? (
          <p className="mt-2 text-xs text-text-muted">
            {progress.complete === progress.total
              ? `All ${progress.total} done`
              : `${progress.complete} of ${progress.total} done`}
          </p>
        ) : null}

        {hasAnyStage(stages) ? (
          tasks.length > 0 ? (
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
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
                  proofActionState={proofActionState}
                  canCaptureProof={canCaptureProof}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
              No {stageLabel(viewedStage).toLowerCase()} tasks listed for this
              area yet.
            </p>
          )
        ) : (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
            No task plan for this area yet. Your PM sets these up in the office
            app.
          </p>
        )}
      </div>
    </Card>
  );
}

function QuickLink({ link }: { link: AreaQuickLink }) {
  const Icon = LINK_ICON[link.key];
  return (
    <a
      href={link.anchor}
      className={cn(
        "inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-2 text-sm",
        "transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
      )}
      aria-label={`${link.label} in this area — open the list`}
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="font-display font-medium text-text">{link.label}</span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted/60" />
    </a>
  );
}

function StageButton({
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
        "rounded-card border px-4 py-3 text-center font-display text-sm font-semibold transition-colors",
        active
          ? "border-accent-yellow bg-accent-yellow text-brand-navy"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
      )}
    >
      {label}
    </button>
  );
}

/** Leading status glyph for a task row — purely a visual echo of the real
 *  state pill / control, never the source of truth. */
function TaskStateIcon({ state }: { state: TaskState }) {
  if (state === "complete") {
    return (
      <CheckCircle2
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-state-success"
      />
    );
  }
  if (state === "in_progress") {
    return (
      <CircleDot aria-hidden="true" className="h-5 w-5 shrink-0 text-state-info" />
    );
  }
  return <Circle aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/50" />;
}

/**
 * A single worker-visible task row. Shows the real state (icon + done
 * styling) and, when `onToggle` is wired, a Mark done / Undo control that
 * disables while a write is in flight. With no `onToggle` it renders a
 * read-only state Pill — so the toggle affordance only appears when the
 * parent has a safe server-backed mutation to run.
 */
function TaskRow({
  task,
  pending,
  onToggle,
  context,
  readiness,
  onCaptureProof,
  proofActionState,
  canCaptureProof,
}: {
  task: WorkerTask;
  pending: boolean;
  onToggle?: () => void;
  context?: PhilTaskContext;
  readiness?: PhilTaskReadiness;
  onCaptureProof?: (target: { workPackageId: string; requiredEvidenceId: string; taskId: string; taskRef?: TaskRef }) => void;
  proofActionState?: Readonly<Record<string, ProofActionStatus>>;
  canCaptureProof?: boolean;
}) {
  const done = isComplete(task.state);
  const blocked = readiness?.readiness === "blocked";
  // At-a-glance required-proof status, read straight off the office-compiled
  // context (#368) via the shared summary — null when there's no required proof
  // (un-compiled ⇒ renders nothing). Surfaces the count WITHOUT making the worker
  // expand the collapsible "Task context". NB: required proof is authored on the
  // AREA work package today, so this reflects the area's compiled proof and reads
  // the same on every task the package delivers (per-task-instance proof is later
  // work) — consistent with the "Proof needed" list already in PhilTaskScopeContext.
  const proof = context ? summarisePhilTaskProof(context) : null;
  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex min-h-[52px] items-center gap-3">
        <TaskStateIcon state={task.state} />
        <span
          className={cn(
            "flex-1 break-words",
            done ? "text-text-muted line-through" : "text-text",
          )}
        >
          {task.name}
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
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 shrink-0 animate-spin text-text-muted"
              />
            ) : done ? (
              <Undo2 aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <CheckCircle2
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-state-success"
              />
            )}
            {pending ? "Saving…" : done ? "Undo" : "Mark done"}
          </button>
        ) : (
          <Pill tone={taskStateTone(task.state)}>{taskStateLabel(task.state)}</Pill>
        )}
      </div>
      {blocked ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-state-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-display font-semibold">Blocked</span>
            {readiness?.blockedReason ? <> — {readiness.blockedReason}</> : null}
          </span>
        </p>
      ) : null}
      {proof ? (
        proof.eligibleForReview ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-state-success">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-display font-semibold">Proof</span> — all captured · ready for
              review
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
      {context ? (
        <PhilTaskScopeContext
          context={context}
          onCaptureProof={
            onCaptureProof
              ? (t) => onCaptureProof({ ...t, taskId: task.id })
              : undefined
          }
          proofActionState={proofActionState}
          canCaptureProof={canCaptureProof}
        />
      ) : null}
    </li>
  );
}
