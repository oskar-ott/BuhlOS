export type JobPhase = "draft" | "active" | "on_hold" | "finishing" | "closed" | "archived";

export interface LifecycleJob {
  status?: string | null;
  completedAt?: string | null;
  reopenedAt?: string | null;
  name?: string | null;
  code?: string | null;
  ref?: string | null;
  siteAddress?: string | null;
}

export const GRACE_DAYS: number;
export function graceEndsAt(job: LifecycleJob | null | undefined): string | null;
export function jobPhase(job: LifecycleJob | null | undefined, now?: Date | string | null): JobPhase;
export function isFieldListedByDefault(job: LifecycleJob | null | undefined, now?: Date | string | null): boolean;
export function isFieldOpenable(job: LifecycleJob | null | undefined): boolean;
export function acceptsHours(job: LifecycleJob | null | undefined): boolean;
export function lifecycleStamps(
  before: LifecycleJob | null | undefined,
  after: string | null | undefined,
  now: string
): { completedAt?: string; reopenedAt?: string; journal: "job.closed" | "job.reopened" } | null;
export function jobMatchesQuery(job: LifecycleJob, q: string): boolean;
