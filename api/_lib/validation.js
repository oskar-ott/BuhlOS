// Shared validation + ID-generation helpers used by api/jobs.js.

// 8-char base36 id with caller-supplied prefix.
function nanoid(prefix) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * 36)];
  return prefix + s;
}

// Validate and normalise an areaGroups array.
// Preserves existing ids; generates missing ones server-side.
//
// Per-area customisation (added 2026-05): each area may carry optional
// `spaceType` (free-text label like "Bathroom", "Switch room"),
// `roughInTasks` and `fitOffTasks` arrays. Absent OR empty arrays mean
// "fall back to the job-level default checklist" — so existing jobs that
// don't supply these keep working unchanged. Validation accepts the
// overrides if present and normalises them via validateTasks().
//
// Returns { ok: true, groups } or { ok: false, error }.
function validateAreaGroups(raw, fieldName) {
  const f = fieldName || 'areaGroups';
  if (!Array.isArray(raw)) return { ok: false, error: `${f} must be an array` };
  const groups = [];
  for (let gi = 0; gi < raw.length; gi++) {
    const g = raw[gi];
    if (!g || typeof g !== 'object') return { ok: false, error: `${f}[${gi}] must be an object` };
    if (!g.name || typeof g.name !== 'string' || !g.name.trim())
      return { ok: false, error: `${f}[${gi}].name must be a non-empty string` };
    if (!Array.isArray(g.areas)) return { ok: false, error: `${f}[${gi}].areas must be an array` };
    const areas = [];
    for (let ai = 0; ai < g.areas.length; ai++) {
      const a = g.areas[ai];
      if (!a || typeof a !== 'object') return { ok: false, error: `${f}[${gi}].areas[${ai}] must be an object` };
      if (!a.name || typeof a.name !== 'string' || !a.name.trim())
        return { ok: false, error: `${f}[${gi}].areas[${ai}].name must be a non-empty string` };
      const out = { id: a.id || nanoid('ar_'), name: a.name.trim() };
      // spaceType is a hint label (no enum) — capped to keep storage tidy.
      if (a.spaceType !== undefined && a.spaceType !== null && a.spaceType !== '') {
        if (typeof a.spaceType !== 'string') return { ok: false, error: `${f}[${gi}].areas[${ai}].spaceType must be a string` };
        const st = a.spaceType.trim().slice(0, 60);
        if (st) out.spaceType = st;
      }
      // Universal archive flag (rigidity audit R2). Areas with progress
      // can't be hard-deleted, so archive becomes the universal "remove"
      // verb. Filters out of mobile / default admin lists; reachable via
      // ?includeArchived=1. The audit fields are append-only and trusted
      // from the caller — clients always send a server-known userId in
      // archivedBy via /api/jobs PUT which is admin/LH-gated.
      if (a.archived) {
        out.archived = true;
        if (a.archivedAt) out.archivedAt = String(a.archivedAt);
        if (a.archivedBy) out.archivedBy = String(a.archivedBy);
      }
      // Order — explicit numeric position, used by sort-respecting list
      // renders. Missing → fall back to the index in the source array.
      if (typeof a.order === 'number' && Number.isFinite(a.order)) {
        out.order = a.order;
      }
      // Optional per-area task overrides. Validate via validateTasks but
      // allow empty arrays (which we collapse — empty == "use defaults").
      if (a.roughInTasks !== undefined && a.roughInTasks !== null) {
        if (!Array.isArray(a.roughInTasks))
          return { ok: false, error: `${f}[${gi}].areas[${ai}].roughInTasks must be an array` };
        if (a.roughInTasks.length) {
          const v = validateTasks(a.roughInTasks, 'rt');
          if (!v.ok) return { ok: false, error: `${f}[${gi}].areas[${ai}].${v.error}` };
          out.roughInTasks = v.tasks;
        }
      }
      if (a.fitOffTasks !== undefined && a.fitOffTasks !== null) {
        if (!Array.isArray(a.fitOffTasks))
          return { ok: false, error: `${f}[${gi}].areas[${ai}].fitOffTasks must be an array` };
        if (a.fitOffTasks.length) {
          const v = validateTasks(a.fitOffTasks, 'ft');
          if (!v.ok) return { ok: false, error: `${f}[${gi}].areas[${ai}].${v.error}` };
          out.fitOffTasks = v.tasks;
        }
      }
      areas.push(out);
    }
    const groupOut = { id: g.id || nanoid('ag_'), name: g.name.trim(), areas };
    if (g.archived) {
      groupOut.archived = true;
      if (g.archivedAt) groupOut.archivedAt = String(g.archivedAt);
      if (g.archivedBy) groupOut.archivedBy = String(g.archivedBy);
    }
    if (typeof g.order === 'number' && Number.isFinite(g.order)) {
      groupOut.order = g.order;
    }
    groups.push(groupOut);
  }
  return { ok: true, groups };
}

// Validate and normalise a tasks array (roughInTasks / fitOffTasks).
// prefix: 'rt' for rough-in, 'ft' for fit-off — used to generate missing ids.
// Returns { ok: true, tasks } or { ok: false, error }.
function validateTasks(raw, prefix) {
  if (!Array.isArray(raw)) return { ok: false, error: `${prefix}Tasks must be an array` };
  const tasks = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t || typeof t !== 'object') return { ok: false, error: `task[${i}] must be an object` };
    if (!t.name || typeof t.name !== 'string' || !t.name.trim())
      return { ok: false, error: `task[${i}].name must be a non-empty string` };
    const out = { id: t.id || nanoid(prefix + '_'), name: t.name.trim() };
    // Universal archive (R2) + ordering (R4).
    if (t.archived) {
      out.archived = true;
      if (t.archivedAt) out.archivedAt = String(t.archivedAt);
      if (t.archivedBy) out.archivedBy = String(t.archivedBy);
    }
    if (typeof t.order === 'number' && Number.isFinite(t.order)) {
      out.order = t.order;
    }
    tasks.push(out);
  }
  return { ok: true, tasks };
}

// Sort + filter helpers consumers can apply to archived/ordered lists.
// Pure functions — accept arrays + return new ones; don't mutate.
function visibleStructural(arr, { includeArchived = false } = {}) {
  if (!Array.isArray(arr)) return [];
  const filtered = includeArchived ? arr.slice() : arr.filter(x => !x || !x.archived);
  // Stable sort by `order` ascending; entries without `order` slot in by
  // original index so old data without `order` keeps its current order.
  return filtered
    .map((x, i) => ({ x, i, o: typeof x.order === 'number' ? x.order : Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.o - b.o) || (a.i - b.i))
    .map(t => t.x);
}

module.exports = {
  nanoid,
  validateAreaGroups,
  validateTasks,
  visibleStructural,
};
