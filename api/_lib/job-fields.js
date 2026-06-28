// Canonical job-field helpers (#244).
//
// slugify / module-flag sanitiser / Job Basics validator — extracted from
// api/jobs.js so the SAME definitions are reused by the sanctioned job
// creator (api/_lib/job-create.js) and every other caller (api/jobs.js POST /
// PUT / duplicate / GET, api/quotes.js convert). One definition, no forks.

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Per-job module flags (rigidity audit R1).
//
// The full set the system supports — admin can turn any of these off on
// a job that doesn't need the concept ("rewire small pub" wouldn't track
// switchboards or temps; an industrial job might hide hours-on-job from
// the field UI). Defaults to everything on so existing jobs and callers
// that don't pass `modules` get current behaviour unchanged.
//
// Coerces input to booleans, drops unknown keys, fills missing keys true.
const MODULE_KEYS = [
  'areas', 'snags', 'photos', 'hours', 'materials',
  'tags',  'temps', 'plans', 'contacts',
  // Modular concepts to come — opt-in by default false so they don't
  // appear in the UI until the job actively enables them.
  'switchboards', 'circuits', 'itps', 'levels',
];
const MODULE_DEFAULTS_TRUE = new Set([
  'areas', 'snags', 'photos', 'hours', 'materials',
  'tags',  'temps', 'plans', 'contacts',
]);
function sanitizeModules(input) {
  const out = {};
  const src = (input && typeof input === 'object') ? input : {};
  for (const k of MODULE_KEYS) {
    if (k in src) out[k] = !!src[k];
    else          out[k] = MODULE_DEFAULTS_TRUE.has(k);
  }
  return out;
}
function effectiveModules(job) {
  // Read helper that hydrates a job loaded from storage — old records
  // without `modules` get the default set, so the rest of the code
  // can rely on `effective.tags` being a real boolean.
  return sanitizeModules((job && job.modules) || {});
}

// Job Basics field validators (audit C-1 / M-2 / M-3 / L-4). All optional;
// validation only runs on the values that *were* provided. Caps lengths
// so a malicious POST can't bloat storage; coerces types so callers
// don't need to be perfect.
//
// Returns { ok: true, patch } where `patch` is a partial object the
// caller can `Object.assign` into the job, or { ok: false, error }.
const BASIC_TEXT = {
  ref:               { max: 60 },
  serviceM8JobId:    { max: 60 },
  siteAddress:       { max: 240 },
  accessNotes:       { max: 1000 },
  parkingNotes:      { max: 240 },
  siteContactName:   { max: 120 },
  safetyNotes:       { max: 1000 },
};
function validateJobBasics(body) {
  const patch = {};
  for (const [k, spec] of Object.entries(BASIC_TEXT)) {
    if (body[k] === undefined) continue;
    if (body[k] === null) { patch[k] = ''; continue; }
    if (typeof body[k] !== 'string') return { ok: false, error: `${k} must be a string` };
    patch[k] = body[k].trim().slice(0, spec.max);
  }
  if (body.siteContactPhone !== undefined) {
    if (body.siteContactPhone === null) patch.siteContactPhone = '';
    else if (typeof body.siteContactPhone !== 'string') return { ok: false, error: 'siteContactPhone must be a string' };
    else {
      const v = body.siteContactPhone.trim().slice(0, 40);
      if (v && !/^[+\d\s\-()/]{6,}$/.test(v)) return { ok: false, error: 'siteContactPhone format' };
      patch.siteContactPhone = v;
    }
  }
  if (body.inductionRequired !== undefined) {
    patch.inductionRequired = !!body.inductionRequired;
  }
  if (body.startDate !== undefined) {
    if (body.startDate === null || body.startDate === '') patch.startDate = '';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate))) return { ok: false, error: 'startDate must be YYYY-MM-DD' };
    else patch.startDate = String(body.startDate);
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate === null || body.dueDate === '') patch.dueDate = '';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate))) return { ok: false, error: 'dueDate must be YYYY-MM-DD' };
    else patch.dueDate = String(body.dueDate);
  }
  if (body.programmedDurationDays !== undefined) {
    if (body.programmedDurationDays === null || body.programmedDurationDays === '') patch.programmedDurationDays = null;
    else {
      const n = Number(body.programmedDurationDays);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'programmedDurationDays must be a non-negative number' };
      patch.programmedDurationDays = Math.round(n);
    }
  }
  // #235: defect liability period dates. Mirror startDate/dueDate exactly —
  // null/'' clears the slot, otherwise must be a YYYY-MM-DD string.
  if (body.handoverDate !== undefined) {
    if (body.handoverDate === null || body.handoverDate === '') patch.handoverDate = '';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.handoverDate))) return { ok: false, error: 'handoverDate must be YYYY-MM-DD' };
    else patch.handoverDate = String(body.handoverDate);
  }
  if (body.defectPeriodEndsAt !== undefined) {
    if (body.defectPeriodEndsAt === null || body.defectPeriodEndsAt === '') patch.defectPeriodEndsAt = '';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.defectPeriodEndsAt))) return { ok: false, error: 'defectPeriodEndsAt must be YYYY-MM-DD' };
    else patch.defectPeriodEndsAt = String(body.defectPeriodEndsAt);
  }
  // Cross-check dates if both provided.
  if (patch.startDate && patch.dueDate && patch.startDate > patch.dueDate) {
    return { ok: false, error: 'dueDate must be on or after startDate' };
  }
  // #235: the defect period cannot end before handover. Same precedent as the
  // startDate/dueDate cross-check — only enforced when BOTH are in this patch.
  if (patch.handoverDate && patch.defectPeriodEndsAt && patch.defectPeriodEndsAt < patch.handoverDate) {
    return { ok: false, error: 'defectPeriodEndsAt must be on or after handoverDate' };
  }
  return { ok: true, patch };
}

module.exports = {
  slugify,
  MODULE_KEYS,
  MODULE_DEFAULTS_TRUE,
  sanitizeModules,
  effectiveModules,
  validateJobBasics,
  BASIC_TEXT,
};
