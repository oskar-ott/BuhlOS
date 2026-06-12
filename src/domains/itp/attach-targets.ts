import type { Job } from "@/domains/jobs/types";

/**
 * Scope targets for the ITP attach flow (#387) — the REVERSE of
 * itp-scope.ts's resolveScopeName. That resolver maps a stored scopeId back
 * to a name; this builds the pickable id+name lists the attach modal offers,
 * from the same structure fields, so anything attached here resolves cleanly
 * everywhere (queue rows, Phil scope lines).
 *
 *   scope='level' → an areaGroup (legacy semantic: scopeId = group.id)
 *   scope='area'  → an area, labelled with its group for disambiguation
 *   scope='switchboard' → free text; jobs carry NO switchboard register
 *     (itp-scope.ts documents the same gap) — the modal says so honestly.
 *
 * Archived groups/areas are excluded — attaching a check to a part of the
 * structure the builder removed would orphan it.
 */

export interface ScopeTarget {
  id: string;
  label: string;
}

export function levelTargets(job: Pick<Job, "areaGroups">): ScopeTarget[] {
  return (job.areaGroups ?? [])
    .filter((g) => !g.archived)
    .map((g) => ({ id: g.id, label: g.name }));
}

export function areaTargets(job: Pick<Job, "areaGroups">): ScopeTarget[] {
  const out: ScopeTarget[] = [];
  for (const group of job.areaGroups ?? []) {
    if (group.archived) continue;
    for (const area of group.areas ?? []) {
      if (area.archived) continue;
      out.push({ id: area.id, label: `${group.name} · ${area.name}` });
    }
  }
  return out;
}
