import type { CanonicalTask } from "@/domains/jobs/task-index";
import type { TaskBlocker } from "@/domains/jobs/task-blockers";
import type {
  EvidenceLink,
  RequiredEvidence,
  WorkPackage,
} from "@/domains/job-control/types";
import {
  isRequiredEvidenceMet,
  isRequiredEvidenceMetForTask,
} from "@/domains/job-control/task-context";

/**
 * Pure derivations for the in-job four-rooms navigation (phil_job_rooms — the
 * filed #133 experiment). The rooms are PROJECTIONS over data the job screen
 * already loads: nothing here reads storage, invents a count, or deepens
 * area-owned task arrays — tasks come in as the canonical index (#480),
 * blockers as the real observation-derived list (#504), proof as the compiled
 * work-package requirements + evidence links (the authored granularity).
 *
 * The room-tab badges these feed are the #133 criterion instrumentation
 * ("critical state is never hidden behind navigation"): every number is a real
 * derived count, or absent.
 */

export type PhilJobRoom = "now" | "work" | "proof" | "site";

export const PHIL_JOB_ROOMS: ReadonlyArray<PhilJobRoom> = [
  "now",
  "work",
  "proof",
  "site",
];

export function isPhilJobRoom(value: unknown): value is PhilJobRoom {
  return (
    typeof value === "string" && (PHIL_JOB_ROOMS as ReadonlyArray<string>).includes(value)
  );
}

/** One genuinely blocked task: a not-complete canonical task with ≥1 open blocker. */
export interface BlockedTaskInfo {
  task: CanonicalTask;
  /** Worker-readable blocker titles (observation titles — never raw ids). */
  reasons: string[];
}

/**
 * The tasks that are really blocked right now: canonical tasks that are not
 * complete AND carry at least one open blocker (keyed by `CanonicalTask.id` —
 * the same identity `taskBlockersFromObservations` emits). A job with no
 * qualifying observation yields [] — nothing is blocked (honest empty).
 */
export function blockedTasks(
  tasks: ReadonlyArray<CanonicalTask>,
  blockers: ReadonlyArray<TaskBlocker>,
): BlockedTaskInfo[] {
  if (blockers.length === 0) return [];
  const reasonsByTaskId = new Map<string, string[]>();
  for (const b of blockers) {
    if (b.status !== "open") continue;
    const list = reasonsByTaskId.get(b.taskId);
    if (list) list.push(b.title);
    else reasonsByTaskId.set(b.taskId, [b.title]);
  }
  if (reasonsByTaskId.size === 0) return [];
  const out: BlockedTaskInfo[] = [];
  for (const task of tasks) {
    if (task.state === "complete") continue;
    const reasons = reasonsByTaskId.get(task.id);
    if (reasons) out.push({ task, reasons });
  }
  return out;
}

/** Distinct blocked-task count per areaId — drives the area-card "N blocked" chip. */
export function blockedCountByArea(
  blocked: ReadonlyArray<BlockedTaskInfo>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of blocked) {
    m.set(b.task.areaId, (m.get(b.task.areaId) ?? 0) + 1);
  }
  return m;
}

/**
 * Whole-job work counts for the Work room's segmented bar + chips. Every
 * number is derived from the same canonical instances (#507 parity path):
 *   done    — state === "complete" (the #198 rule, in_progress is NOT done)
 *   blocked — not complete + a real open blocker
 *   going   — in_progress and not blocked
 *   todo    — the remainder
 */
export interface JobWorkCounts {
  total: number;
  done: number;
  going: number;
  blocked: number;
  todo: number;
}

export function jobWorkCounts(
  tasks: ReadonlyArray<CanonicalTask>,
  blocked: ReadonlyArray<BlockedTaskInfo>,
): JobWorkCounts {
  const blockedIds = new Set(blocked.map((b) => b.task.id));
  let done = 0;
  let going = 0;
  let blockedCount = 0;
  for (const t of tasks) {
    if (t.state === "complete") done += 1;
    else if (blockedIds.has(t.id)) blockedCount += 1;
    else if (t.state === "in_progress") going += 1;
  }
  const total = tasks.length;
  return {
    total,
    done,
    going,
    blocked: blockedCount,
    todo: total - done - going - blockedCount,
  };
}

/**
 * One owed proof item, at the granularity it was AUTHORED (proof-review-model:
 * package-granular by default; a per-task-authored requirement stays scoped to
 * its own task instance). "Met" is the engine's own rule — a real EvidenceLink
 * names the requirement — never a photo count.
 */
export interface OwedProofItem {
  workPackageId: string;
  workPackageTitle: string;
  requirement: RequiredEvidence;
  /** Distinct areas the package delivers into (or the authored task's area). */
  areaIds: string[];
}

export function owedProofItems(
  workPackages: ReadonlyArray<WorkPackage>,
  links: ReadonlyArray<EvidenceLink>,
): OwedProofItem[] {
  const out: OwedProofItem[] = [];
  for (const wp of workPackages) {
    const reqs = wp.requiredEvidence ?? [];
    if (reqs.length === 0) continue;
    const packageAreaIds = [...new Set(wp.taskRefs.map((r) => r.areaId))];
    for (const req of reqs) {
      const met = req.taskRef
        ? isRequiredEvidenceMetForTask(links, wp.id, req.id, req.taskRef)
        : isRequiredEvidenceMet(links, wp.id, req.id);
      if (met) continue;
      out.push({
        workPackageId: wp.id,
        workPackageTitle: wp.title,
        requirement: req,
        areaIds: req.taskRef ? [req.taskRef.areaId] : packageAreaIds,
      });
    }
  }
  return out;
}

/** Owed-proof count per areaId — drives the area-card "Proof needed" chip. A
 *  multi-area package counts once in each of its areas (the proof is owed
 *  wherever the work is), consistent with how the area drill-in shows the same
 *  package summary on each of its tasks. */
export function owedProofCountByArea(
  items: ReadonlyArray<OwedProofItem>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    for (const areaId of item.areaIds) {
      m.set(areaId, (m.get(areaId) ?? 0) + 1);
    }
  }
  return m;
}

/**
 * Where an attention item's in-page anchor lives in the rooms layout. The
 * flag-off page scrolls to these anchors on one long page; inside the rooms,
 * the same signal navigates to the room that now owns the section — the Now
 * room never dead-ends a critical signal behind a broken anchor (the #133
 * criterion).
 */
export function roomForAttentionAnchor(anchor: string): PhilJobRoom {
  switch (anchor) {
    case "#phil-job-snags":
      return "work";
    case "#phil-job-itps":
      return "proof";
    case "#phil-job-site":
      return "site";
    default:
      return "now";
  }
}
