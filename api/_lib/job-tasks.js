// Shared helper: which task list applies to which area.
//
// BuhlOS started with a single per-job rough-in / fit-off checklist that
// every area inherited. Real construction jobs need per-area variation —
// a switch room, a bathroom, an NBN cabinet, and a corridor don't share
// a checklist. This helper centralises the override resolution so every
// surface (jobs API stats, per-job mobile dashboard, client portal,
// /admin/jobs/<id>?s=setup, future analytics) reads the same answer.
//
//   effectiveRoughInTasks(job, area) → [{id,name}, ...]
//   effectiveFitOffTasks(job, area)  → [{id,name}, ...]
//   areaUsesCustomChecklist(area)    → 'roughIn' | 'fitOff' | 'both' | null
//
// Rules:
//   - If `area.roughInTasks` is a non-empty array, that list wins for rough-in.
//   - Otherwise the job-level `job.roughInTasks` is used.
//   - Same for fit-off.
//   - An empty override array == "use the default"; we never want a
//     literal empty checklist to look like a deliberate "no tasks" config.
//     The admin Setup tab represents "no checklist" by removing the
//     override entirely (omit the field), not by storing `[]`.

function effectiveRoughInTasks(job, area) {
  const overr = area && Array.isArray(area.roughInTasks) ? area.roughInTasks : null;
  if (overr && overr.length) return overr;
  return (job && Array.isArray(job.roughInTasks)) ? job.roughInTasks : [];
}

function effectiveFitOffTasks(job, area) {
  const overr = area && Array.isArray(area.fitOffTasks) ? area.fitOffTasks : null;
  if (overr && overr.length) return overr;
  return (job && Array.isArray(job.fitOffTasks)) ? job.fitOffTasks : [];
}

function areaUsesCustomChecklist(area) {
  const r = !!(area && Array.isArray(area.roughInTasks) && area.roughInTasks.length);
  const f = !!(area && Array.isArray(area.fitOffTasks)  && area.fitOffTasks.length);
  if (r && f) return 'both';
  if (r) return 'roughIn';
  if (f) return 'fitOff';
  return null;
}

// ── #198: CANONICAL counts-based progress ─────────────────────────────
// CJS mirror of src/domains/jobs/progress.ts (parity-tested there). The
// definition: complete = recorded state exactly 'complete' (in_progress is
// NOT complete); ARCHIVED tasks/areas/groups excluded; % only where a
// total exists; job-level progress is POOLED task counts, never an
// average of area percentages.

function liveTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(t => t && !t.archived);
}

// Per-area pooled counts across both stages.
function areaTaskCounts(job, area, dwellings) {
  const dw = (dwellings && dwellings[area.id]) || {};
  let total = 0, complete = 0;
  const stages = [
    [liveTasks(effectiveRoughInTasks(job, area)), ((dw.roughIn || {}).tasks) || {}],
    [liveTasks(effectiveFitOffTasks(job, area)), ((dw.fitOff || {}).tasks) || {}],
  ];
  for (const [tasks, states] of stages) {
    total += tasks.length;
    for (const t of tasks) if (states[t.id] === 'complete') complete += 1;
  }
  return { total, complete };
}

// Whole-job pooled counts. Archived groups/areas excluded entirely.
function jobTaskCounts(job, dwellings) {
  let total = 0, complete = 0;
  for (const g of (job && job.areaGroups) || []) {
    if (!g || g.archived) continue;
    for (const a of g.areas || []) {
      if (!a || a.archived) continue;
      const c = areaTaskCounts(job, a, dwellings);
      total += c.total;
      complete += c.complete;
    }
  }
  return { total, complete };
}

// Per-area progress percentage — kept for existing consumers, now the
// canonical pooled-counts math (was a stage-percentage average pre-#198).
// Returns 0..100 (rounded), or null if the area has no applicable tasks
// (caller renders "no checklist", never 0%).
function areaProgressPct(job, area, dwellings) {
  const c = areaTaskCounts(job, area, dwellings);
  if (!c.total) return null;
  return Math.round((c.complete / c.total) * 100);
}

module.exports = {
  effectiveRoughInTasks,
  effectiveFitOffTasks,
  areaUsesCustomChecklist,
  areaProgressPct,
  areaTaskCounts,
  jobTaskCounts,
};
