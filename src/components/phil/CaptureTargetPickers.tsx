"use client";

import { effectiveTasks, stageLabel } from "@/domains/jobs/format";
import type { Job, JobArea, JobStage } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface FlatArea {
  id: string;
  name: string;
  groupName: string;
}

interface Props {
  job: Job;
  /** All visible (non-archived) areas across all groups. Parent flattens
   *  them once so this component stays presentational. */
  flatAreas: FlatArea[];
  stage: JobStage | null;
  areaId: string | null;
  taskId: string | null;
  busy: boolean;
  onStageChange: (next: JobStage | null) => void;
  onAreaChange: (next: string | null) => void;
  onTaskChange: (next: string | null) => void;
}

/**
 * Stage + area + task pickers for the D3 capture sheet.
 *
 * All three are optional — capturing without any of them produces a
 * job-level evidence row (accepted server-side per doc 24 §15.0 #5).
 *
 * Hard rules (doc 29 §7.3):
 *   - Stage chooser: two equal-weight pills `Rough-in` / `Fit-off`.
 *   - Area picker: vertical list of visible (non-archived) areas.
 *   - Task picker: only shown when both stage + area are chosen.
 *   - Task list comes from `effectiveTasks(job, area, stage)` — never
 *     from `job.stages.roughIn[]`/`fitOff[]` (legacy strings).
 *   - Tapping a selected pill/row clears it (no separate clear button).
 *
 * Cross-ref:
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §7.3
 *   src/domains/jobs/format.ts — effectiveTasks
 */
export function CaptureTargetPickers({
  job,
  flatAreas,
  stage,
  areaId,
  taskId,
  busy,
  onStageChange,
  onAreaChange,
  onTaskChange,
}: Props) {
  const selectedArea = flatAreas.find((a) => a.id === areaId) ?? null;
  const tasks =
    stage && selectedArea
      ? effectiveTasks(
          job,
          // effectiveTasks reads roughInTasks/fitOffTasks off the area;
          // flatArea is the same object family from visibleAreaGroups
          // upstream, so we look up the original via id.
          findAreaWithTasks(job, areaId),
          stage
        )
      : [];

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="font-display text-sm font-semibold text-text">
          Stage <span className="text-text-muted">(optional)</span>
        </legend>
        <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Stage">
          <StagePill
            label={stageLabel("roughIn")}
            active={stage === "roughIn"}
            disabled={busy}
            onClick={() => onStageChange(stage === "roughIn" ? null : "roughIn")}
          />
          <StagePill
            label={stageLabel("fitOff")}
            active={stage === "fitOff"}
            disabled={busy}
            onClick={() => onStageChange(stage === "fitOff" ? null : "fitOff")}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="font-display text-sm font-semibold text-text">
          Area <span className="text-text-muted">(optional)</span>
        </legend>
        {flatAreas.length === 0 ? (
          <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
            No areas configured for this job. Capture will be job-level.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5" role="radiogroup" aria-label="Area">
            {flatAreas.map((a) => {
              const active = a.id === areaId;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onAreaChange(active ? null : a.id)}
                    disabled={busy}
                    className={cn(
                      "flex min-h-[48px] w-full items-center justify-between gap-3 rounded-card border px-3 py-2 text-left",
                      "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-brand-navy bg-brand-navy text-text-inverse"
                        : "border-border bg-surface hover:bg-surface-subtle"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{a.name}</span>
                      <span
                        className={cn(
                          "block truncate text-xs",
                          active ? "text-text-inverse/80" : "text-text-muted"
                        )}
                      >
                        {a.groupName}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      {stage && selectedArea ? (
        <fieldset>
          <legend className="font-display text-sm font-semibold text-text">
            Task <span className="text-text-muted">(optional)</span>
          </legend>
          {tasks.length === 0 ? (
            <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
              No {stageLabel(stage).toLowerCase()} tasks listed for {selectedArea.name}.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5" role="radiogroup" aria-label="Task">
              {tasks.map((t) => {
                const active = t.id === taskId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onTaskChange(active ? null : t.id)}
                      disabled={busy}
                      className={cn(
                        "flex min-h-[44px] w-full items-center gap-2 rounded-card border px-3 py-2 text-left",
                        "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                        active
                          ? "border-accent-yellow bg-accent-yellow text-brand-navy"
                          : "border-border bg-surface hover:bg-surface-subtle"
                      )}
                    >
                      <span className="text-sm">{t.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : null}
    </div>
  );
}

function StagePill({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "min-h-[48px] rounded-card border px-4 py-3 text-center font-display text-sm font-semibold",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "border-accent-yellow bg-accent-yellow text-brand-navy"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      {label}
    </button>
  );
}

/** Resolve the original area object (with its possible per-area
 *  roughInTasks / fitOffTasks overrides) by id. The flat list parent
 *  passes us is shaped for display; for the task lookup we need the
 *  area shape so per-area overrides can win over the job template. */
function findAreaWithTasks(job: Job, areaId: string | null): JobArea | null {
  if (!areaId) return null;
  for (const g of job.areaGroups ?? []) {
    for (const a of g.areas ?? []) {
      if (a.id === areaId) return a;
    }
  }
  return null;
}
