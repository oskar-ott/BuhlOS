import type { JobStage } from "@/domains/jobs/types";

/**
 * Phil — resume where you left off on a job (#425).
 *
 * Constitution: P8 (the app survives interruption — resume by place) and P14
 * (Phil remembers so the worker doesn't). After a smoko / boss call / forklift,
 * re-opening the job should land back on the area + stage the worker was in,
 * not the top of the list.
 *
 * Pure + injectable: storage is a parameter (defaults to window.localStorage)
 * so this is unit-testable in the node test env and SSR-safe (no window → no-op).
 * Best-effort by design — private mode / quota / bad JSON never throw into render.
 */

export type JobResume = { areaId: string; stage: JobStage };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const KEY_PREFIX = "phil-job-resume:";
const STAGES: ReadonlySet<string> = new Set<JobStage>(["roughIn", "fitOff"]);

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The area + stage the worker last viewed on this job, or null if none/invalid. */
export function readJobResume(
  jobId: string,
  storage: StorageLike | null = defaultStorage(),
): JobResume | null {
  if (!storage || !jobId) return null;
  try {
    const raw = storage.getItem(KEY_PREFIX + jobId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const areaId = (parsed as { areaId?: unknown }).areaId;
    const stage = (parsed as { stage?: unknown }).stage;
    if (typeof areaId !== "string" || !areaId) return null;
    if (typeof stage !== "string" || !STAGES.has(stage)) return null;
    return { areaId, stage: stage as JobStage };
  } catch {
    return null;
  }
}

/** Remember the area + stage for this job. Silent on any storage failure. */
export function writeJobResume(
  jobId: string,
  resume: JobResume,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !jobId || !resume || !resume.areaId) return;
  try {
    storage.setItem(
      KEY_PREFIX + jobId,
      JSON.stringify({ areaId: resume.areaId, stage: resume.stage }),
    );
  } catch {
    /* private mode / quota — resume is best-effort, never throws into render */
  }
}
