import { isFieldRole, isLeadingHandRole } from "@/lib/auth/roles";
import type { AssignableWorker, AssignmentChange, UserAccount } from "./types";

/**
 * Pure job-assignment logic for the production login store (users.json).
 *
 * The mission's data rule: write to USERS, preserve each user's OTHER assigned
 * jobs, and update only the users whose membership actually changed. The
 * `/api/users` PUT REPLACES `assignedJobIds` wholesale, so the caller must send
 * the full, correctly-toggled array — computed here.
 *
 * Eligibility mirrors Phil access: a worker is assignable iff they are on the
 * field tier or the leading-hand tier (the roles that can open /phil/jobs and
 * whose visibility is gated on assignedJobIds). Admin-tier and client accounts
 * are never assignable — they don't use Phil job visibility. Role tiers come
 * from the canonical src/lib/auth/roles.ts so this stays in step with the
 * middleware + API gates.
 */

/** Field tier or leading-hand tier — the Phil-capable, assignment-gated roles. */
export function isAssignableWorkerRole(role: unknown): boolean {
  return isFieldRole(role) || isLeadingHandRole(role);
}

/** A disabled/archived account is never offered for assignment. */
export function isActiveAccount(u: Pick<UserAccount, "archived" | "disabled" | "status">): boolean {
  return !u.archived && !u.disabled && u.status !== "disabled";
}

/** Narrow a full account to the secret-free worker projection (4 fields only). */
export function toAssignableWorker(u: UserAccount): AssignableWorker {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    assignedJobIds: [...(u.assignedJobIds ?? [])],
  };
}

/**
 * The assignable-worker list for the panel: field/LH tier, active only, with
 * non-field roles (admin/office/client) filtered out. Stable, de-duplicated by
 * id (first wins), sorted by username for a predictable UI.
 */
export function filterAssignableWorkers(
  users: ReadonlyArray<UserAccount>
): AssignableWorker[] {
  const seen = new Set<string>();
  const out: AssignableWorker[] = [];
  for (const u of users) {
    if (seen.has(u.id)) continue;
    if (!isAssignableWorkerRole(u.role)) continue;
    if (!isActiveAccount(u)) continue;
    seen.add(u.id);
    out.push(toAssignableWorker(u));
  }
  return out.sort((a, b) => a.username.localeCompare(b.username));
}

/** Whether a worker is currently assigned to the given job. */
export function isAssignedToJob(
  worker: Pick<AssignableWorker, "assignedJobIds">,
  jobId: string
): boolean {
  return worker.assignedJobIds.includes(jobId);
}

/**
 * Toggle one job id in/out of a worker's assignment array while preserving
 * every OTHER assigned job. De-duplicates the target id, preserves the order of
 * the rest, and is idempotent (assigning an already-assigned job is a no-op).
 */
export function computeAssignedJobIds(
  current: ReadonlyArray<string>,
  jobId: string,
  assign: boolean
): string[] {
  const withoutTarget = current.filter((id) => id !== jobId);
  return assign ? [...withoutTarget, jobId] : withoutTarget;
}

/**
 * Diff the desired selection against current state and return ONLY the workers
 * whose membership for THIS job changes — each with their full, toggled
 * assignedJobIds array. Workers already in the desired state are skipped, so we
 * never PUT an unchanged user.
 */
export function diffWorkerAssignments(
  workers: ReadonlyArray<AssignableWorker>,
  jobId: string,
  selectedIds: ReadonlySet<string>
): AssignmentChange[] {
  const changes: AssignmentChange[] = [];
  for (const w of workers) {
    const was = isAssignedToJob(w, jobId);
    const now = selectedIds.has(w.id);
    if (was === now) continue;
    changes.push({
      id: w.id,
      username: w.username,
      assignedJobIds: computeAssignedJobIds(w.assignedJobIds, jobId, now),
      assigned: now,
    });
  }
  return changes;
}
