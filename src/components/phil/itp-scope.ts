import type { ITPInstance } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";

/**
 * Resolve a human-readable name for an ITP instance's `scopeId`.
 *
 * The instance carries `{ scope, scopeId }` where scopeId is a foreign
 * key into the job's structure:
 *   scope='job'         → no scopeId, name is "Whole job"
 *   scope='level'       → scopeId = areaGroup.id (legacy semantic)
 *   scope='area'        → scopeId = area.id
 *   scope='switchboard' → scopeId = an electrical-equipment id
 *
 * Job records don't currently expose a switchboard / equipment register
 * in the rebuild Job type, so 'switchboard' falls back to the raw id.
 * That's fine for E1b — the worker sees the scope label + id, and the
 * scope label alone is enough context for most jobs (the legacy data
 * rarely populates multiple switchboards per job).
 *
 * Pure logic; tested via itp-scope.test.ts.
 *
 * Cross-ref:
 *   api/job-itps.js — scope value definition
 *   src/domains/itp/format.ts#scopeContextLine — consumes this
 */
export function resolveScopeName(
  job: Job,
  instance: ITPInstance,
): string | null {
  if (instance.scope === "job") return null;
  const scopeId = instance.scopeId;
  if (!scopeId) return null;
  switch (instance.scope) {
    case "level": {
      const group = (job.areaGroups ?? []).find((g) => g.id === scopeId);
      return group?.name ?? scopeId;
    }
    case "area": {
      for (const group of job.areaGroups ?? []) {
        const area = (group.areas ?? []).find((a) => a.id === scopeId);
        if (area) return area.name ?? scopeId;
      }
      return scopeId;
    }
    case "switchboard":
      // No switchboard register on Job today — fall back to the raw id
      // so the worker still sees a label (legacy data rarely populates
      // more than one).
      return scopeId;
  }
}
