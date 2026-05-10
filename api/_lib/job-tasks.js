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

// Per-area progress percentage. Used by both the jobs API stats endpoint
// and any client-side progress code that wants a single source of truth.
//
// Returns 0..100 (rounded), or null if the area has no applicable tasks
// (caller should render "no checklist" rather than 0%).
function areaProgressPct(job, area, dwellings) {
  const dw = (dwellings && dwellings[area.id]) || {};
  const rough = effectiveRoughInTasks(job, area);
  const fit   = effectiveFitOffTasks(job, area);
  const rTasks = ((dw.roughIn || {}).tasks) || {};
  const fTasks = ((dw.fitOff  || {}).tasks) || {};
  if (!rough.length && !fit.length) return null;
  const rPct = rough.length
    ? Math.round(rough.filter(t => rTasks[t.id] === 'complete').length / rough.length * 100)
    : 0;
  const fPct = fit.length
    ? Math.round(fit.filter(t => fTasks[t.id] === 'complete').length / fit.length * 100)
    : 0;
  if (rough.length && fit.length) return Math.round((rPct + fPct) / 2);
  return rough.length ? rPct : fPct;
}

module.exports = {
  effectiveRoughInTasks,
  effectiveFitOffTasks,
  areaUsesCustomChecklist,
  areaProgressPct,
};
