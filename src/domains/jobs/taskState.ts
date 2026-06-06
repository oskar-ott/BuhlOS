import { z } from "zod";
import { effectiveTasks } from "./format";
import type { Job, JobArea, JobStage } from "./types";

/**
 * Worker-visible task STATE — the runtime "is this done?" layer that sits on
 * top of the read-only task plan.
 *
 * Two separate sources of truth, deliberately kept apart:
 *
 *   - The task PLAN (what tasks exist) lives in jobs.json: an area's
 *     `roughInTasks` / `fitOffTasks` override, else the job-level template.
 *     Resolved by `effectiveTasks` (archived templates filtered out).
 *   - The task STATE (what's done) lives in the per-job data blob
 *     `jobs/<jobId>/data.json` under
 *     `dwellings[areaId][stage].tasks[taskId]` ∈ not_started | in_progress |
 *     complete. Read via GET /api/data; written via POST /api/task-toggle.
 *
 * This module parses that free-form data blob down to a normalised, typed,
 * serialisable subset (only the rough-in / fit-off task maps — never snags,
 * notes, materials or audit fields) and exposes pure helpers to merge plan +
 * state into the rows the Phil area drill-in renders.
 *
 * Honesty rules baked in here:
 *   - A task's state is ONLY ever a real value read back from the data blob.
 *     Anything missing or unrecognised reads as `not_started` — never a
 *     guessed "in progress" or "done".
 *   - `buildWorkerTasks` derives its rows from `effectiveTasks`, so an
 *     archived (retired) task is never shown and never toggleable — matching
 *     the api/task-toggle.js server guard exactly.
 *
 * Cross-ref:
 *   api/task-toggle.js — the matching server mutation + guards
 *   api/data.js — GET returns the { dwellings, snags, notes } blob
 *   src/domains/jobs/format.ts#effectiveTasks — the plan resolver
 */

export const TASK_STATES = ["not_started", "in_progress", "complete"] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TASK_STATE_SET: ReadonlySet<string> = new Set(TASK_STATES);

/** Normalised per-area task state: stage → taskId → state. */
export interface StageTaskState {
  roughIn: Record<string, TaskState>;
  fitOff: Record<string, TaskState>;
}

/** Normalised job task state: areaId → stage maps. */
export type JobTaskState = Record<string, StageTaskState>;

/**
 * Lenient parser for the data.json blob. The dwellings bag is free-form
 * (api/data.js documents task maps alongside materials + audit fields), so we
 * pull ONLY the two task maps per area and coerce each value: a recognised
 * three-state string is kept; anything else is dropped (reads back as
 * not_started). Never throws — a malformed blob yields an empty map, and the
 * UI falls back to "nothing done yet" rather than a crash.
 */
const RawDataBlobSchema = z
  .object({
    dwellings: z
      .record(
        z.string(),
        z
          .object({
            roughIn: z
              .object({ tasks: z.record(z.string(), z.unknown()).optional() })
              .passthrough()
              .optional(),
            fitOff: z
              .object({ tasks: z.record(z.string(), z.unknown()).optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function coerceTaskMap(raw: Record<string, unknown> | undefined): Record<string, TaskState> {
  const out: Record<string, TaskState> = {};
  if (!raw) return out;
  for (const [taskId, value] of Object.entries(raw)) {
    if (typeof value === "string" && TASK_STATE_SET.has(value)) {
      out[taskId] = value as TaskState;
    }
  }
  return out;
}

export function parseJobTaskState(data: unknown): JobTaskState {
  const parsed = RawDataBlobSchema.safeParse(data);
  if (!parsed.success || !parsed.data.dwellings) return {};
  const out: JobTaskState = {};
  for (const [areaId, dw] of Object.entries(parsed.data.dwellings)) {
    out[areaId] = {
      roughIn: coerceTaskMap(dw.roughIn?.tasks as Record<string, unknown> | undefined),
      fitOff: coerceTaskMap(dw.fitOff?.tasks as Record<string, unknown> | undefined),
    };
  }
  return out;
}

/** Read a single task's state, defaulting to not_started when unrecorded. */
export function readTaskState(
  state: JobTaskState,
  areaId: string,
  stage: JobStage,
  taskId: string,
): TaskState {
  return state[areaId]?.[stage]?.[taskId] ?? "not_started";
}

/**
 * Apply a confirmed (server-acknowledged) toggle result to the state map,
 * returning a NEW map. Used by the client after a 200 from /api/task-toggle —
 * state only ever moves on a real server confirmation, never optimistically.
 */
export function applyTaskState(
  state: JobTaskState,
  areaId: string,
  stage: JobStage,
  taskId: string,
  next: TaskState,
): JobTaskState {
  const prevArea = state[areaId] ?? { roughIn: {}, fitOff: {} };
  return {
    ...state,
    [areaId]: {
      ...prevArea,
      [stage]: { ...prevArea[stage], [taskId]: next },
    },
  };
}

/** A field-visible task row: the plan entry merged with its real state. */
export interface WorkerTask {
  id: string;
  name: string;
  state: TaskState;
}

/**
 * Merge the field-visible task plan for an area + stage with its runtime
 * state. Rows come from `effectiveTasks` (archived already filtered), so this
 * never surfaces a retired task and never invents a row.
 */
export function buildWorkerTasks(
  job: Pick<Job, "roughInTasks" | "fitOffTasks">,
  area: Pick<JobArea, "id" | "roughInTasks" | "fitOffTasks">,
  stage: JobStage,
  state: JobTaskState,
): WorkerTask[] {
  return effectiveTasks(job, area, stage).map((t) => ({
    id: t.id,
    name: t.name,
    state: readTaskState(state, area.id, stage, t.id),
  }));
}

/** Real completion progress for a stage's tasks — honest counts, no %. */
export interface TaskProgress {
  total: number;
  complete: number;
}

export function stageProgress(tasks: ReadonlyArray<WorkerTask>): TaskProgress {
  let complete = 0;
  for (const t of tasks) if (t.state === "complete") complete += 1;
  return { total: tasks.length, complete };
}

/**
 * The state to write when a worker taps the primary control. v1 is binary:
 * a not-done task (not_started OR a pre-existing in_progress) becomes
 * `complete`; a done task is undone back to `not_started`. We never WRITE
 * in_progress in Phil v1 — but we faithfully DISPLAY it when the office app
 * or legacy data set it (see taskStateLabel).
 */
export function nextToggleState(current: TaskState): TaskState {
  return current === "complete" ? "not_started" : "complete";
}

export function isComplete(state: TaskState): boolean {
  return state === "complete";
}

const TASK_STATE_LABELS: Record<TaskState, string> = {
  not_started: "To do",
  in_progress: "In progress",
  complete: "Done",
};

export function taskStateLabel(state: TaskState): string {
  return TASK_STATE_LABELS[state];
}

export type TaskStateTone = "neutral" | "info" | "success";

export function taskStateTone(state: TaskState): TaskStateTone {
  switch (state) {
    case "complete":
      return "success";
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}
