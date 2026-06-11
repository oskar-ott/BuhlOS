// Duplicate-job mapper (#190) — PURE: source job → a fresh CREATE payload.
//
// The whole trick: api/jobs.js's create-path validators mint fresh ids for
// any structure entry WITHOUT an id (validation.js: `t.id || nanoid(...)`).
// So duplication = strip every id, strip every piece of state, skip every
// archived entry, and feed the result through the SAME validated create
// path a hand-built job takes. Fresh ids and clean state by construction —
// no second id-generation scheme to drift.
//
// Copied:   name (+" (copy)"), site basics (address/access/parking/contact/
//           safety/induction), type, module flags, job custom fields,
//           job-level default task lists, area groups → areas (spaceType,
//           order, custom fields, per-stage task overrides).
// Reset:    status → draft (field-invisible until published), all task
//           state (per-job data.json is seeded empty by the create path),
//           created/updated stamps.
// Dropped:  archived groups/areas/tasks (never resurrected), stats*,
//           worker assignment (lives on users.assignedJobIds), client
//           portal link (clientUserId), schedule (start/due/duration),
//           job-specific refs (ref, serviceM8JobId), evidence/snags/ITPs/
//           hours/audit history (per-job blobs are never copied).

function copyTask(t) {
  const out = { name: t.name };
  if (typeof t.order === 'number') out.order = t.order;
  return out;
}

function copyTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.name && !t.archived)
    .map(copyTask);
}

function copyArea(a) {
  const out = { name: a.name };
  if (a.spaceType) out.spaceType = a.spaceType;
  if (typeof a.order === 'number') out.order = a.order;
  if (Array.isArray(a.customFields) && a.customFields.length) out.customFields = a.customFields;
  const ri = copyTasks(a.roughInTasks);
  if (ri.length) out.roughInTasks = ri;
  const fo = copyTasks(a.fitOffTasks);
  if (fo.length) out.fitOffTasks = fo;
  return out;
}

/** "Unit 4 Bondi (copy)" / "Unit 4 Bondi (copy 3)". */
function copyName(sourceName, attempt) {
  const base = String(sourceName || 'Job').trim();
  return attempt <= 1 ? `${base} (copy)` : `${base} (copy ${attempt})`;
}

/** Pure: a CREATE-shaped payload for the duplicate. Never throws. */
function buildDuplicatePayload(source) {
  const payload = {
    status: 'draft',
    type: source.type || null,
    modules: source.modules || undefined,
    customFields: Array.isArray(source.customFields) ? source.customFields : undefined,
    roughInTasks: copyTasks(source.roughInTasks),
    fitOffTasks: copyTasks(source.fitOffTasks),
    areaGroups: (Array.isArray(source.areaGroups) ? source.areaGroups : [])
      .filter((g) => g && !g.archived)
      .map((g) => {
        const out = {
          name: g.name,
          areas: (Array.isArray(g.areas) ? g.areas : [])
            .filter((a) => a && !a.archived)
            .map(copyArea),
        };
        if (typeof g.order === 'number') out.order = g.order;
        return out;
      }),
  };
  // Site basics — the field-needed facts that genuinely repeat across
  // duplicated work. Only copied when present (create validates them).
  for (const k of [
    'siteAddress',
    'accessNotes',
    'parkingNotes',
    'siteContactName',
    'siteContactPhone',
    'safetyNotes',
    'inductionRequired',
  ]) {
    if (source[k] !== undefined && source[k] !== null && source[k] !== '') payload[k] = source[k];
  }
  return payload;
}

/** Capture ONE area group as a reusable preset shape (#192): ids stripped,
 *  archived areas/tasks skipped, no task state — same rules as duplication. */
function captureGroup(group) {
  return {
    name: group.name,
    areas: (Array.isArray(group.areas) ? group.areas : [])
      .filter((a) => a && !a.archived)
      .map(copyArea),
  };
}

module.exports = { buildDuplicatePayload, copyName, copyArea, copyTasks, captureGroup };
