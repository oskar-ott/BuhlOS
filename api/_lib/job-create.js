// Shared job-creation lib (#244).
//
// THE single sanctioned way a job is written into jobs.json. Extracted
// verbatim from api/jobs.js POST so that every caller — the Job Builder
// (POST /api/jobs) AND won-quote conversion (api/quotes.js handleConvert) —
// routes through the same validation (type / areaGroups / tasks / custom
// fields / basics), the same job object shape (modules / customFields /
// basics / status), and the same seed writes (jobs.json read-modify-write
// + jobs/<id>/data.json, tags.json, temps.json). There must be no second
// raw writeBlob('jobs.json') job writer anywhere (issue #244 technical notes).
//
// I/O goes through the blob module, so the existing real-handler harnesses
// (jobs-api.test.ts) exercise this unchanged.

const { readBlob, writeBlob } = require('./blob');
const {
  validateAreaGroups,
  validateTasks,
  validateCustomFields,
} = require('./validation');
const { slugify, sanitizeModules, validateJobBasics } = require('./job-fields');

/**
 * Create a job through the sanctioned, validated path.
 *
 * @param {object} data    The already-read jobs.json blob ({ jobs: [...] }).
 *                         Mutated in place (job pushed) and persisted here —
 *                         the caller does NOT writeBlob('jobs.json') itself.
 * @param {object} input   The create payload (same field set api/jobs.js POST
 *                         accepts): name, id?, clientUserId?, type?, status?,
 *                         areaGroups?, roughInTasks?, fitOffTasks?, modules?,
 *                         customFields?, + Job Basics, + fromQuoteId?.
 *
 * @returns {Promise<{ ok: true, job: object } | { ok: false, status: number, error: string }>}
 *          On success the job has been pushed onto data.jobs, jobs.json written,
 *          and the per-job seeds (data.json / tags.json / temps.json) written.
 *          On failure nothing is written; `status` is the HTTP code the caller
 *          should return (400 invalid input / id collision).
 */
async function createJob(data, input) {
  const body = input || {};

  const {
    name, id, clientUserId, type, status,
    areaGroups, roughInTasks, fitOffTasks,
    modules, customFields,
    fromQuoteId,
  } = body;

  if (!name) return { ok: false, status: 400, error: 'name required' };
  const jobId = slugify(id || name);
  if (!jobId) return { ok: false, status: 400, error: 'invalid id' };
  if (data.jobs.find(j => j.id === jobId))
    return { ok: false, status: 400, error: 'job id already exists' };

  // Validate type if provided
  if (type) {
    const jtData = await readBlob('job-types.json', { jobTypes: [] });
    const typeExists = (jtData.jobTypes || []).some(t => t.id === type);
    if (!typeExists) return { ok: false, status: 400, error: 'type not found in job-types.json' };
  }

  // Validate areaGroups if provided
  let parsedGroups = [];
  if (areaGroups !== undefined) {
    const parsed = validateAreaGroups(areaGroups, 'areaGroups');
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    parsedGroups = parsed.groups;
  }

  // Validate task lists if provided
  let parsedRoughIn = [];
  if (roughInTasks !== undefined) {
    const v = validateTasks(roughInTasks, 'rt');
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    parsedRoughIn = v.tasks;
  }
  let parsedFitOff = [];
  if (fitOffTasks !== undefined) {
    const v = validateTasks(fitOffTasks, 'ft');
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    parsedFitOff = v.tasks;
  }

  // Custom fields on the Job itself (rigidity audit R3). Optional.
  let parsedCustomFields = [];
  if (customFields !== undefined) {
    const cf = validateCustomFields(customFields, 'customFields');
    if (!cf.ok) return { ok: false, status: 400, error: cf.error };
    parsedCustomFields = cf.fields;
  }

  // Job Basics (audit C-1 / M-2 / M-3 / L-4) — validate everything
  // the caller provided.
  const basicsResult = validateJobBasics(body);
  if (!basicsResult.ok) return { ok: false, status: 400, error: basicsResult.error };

  // Initial status. The Job Builder creates jobs as 'draft' so the office
  // can fill them in before publishing to the field — a draft is invisible
  // to non-admin callers in the GET handler (publishJob() flips it to
  // 'active'). Only draft/active are valid on create; omitting status keeps
  // the legacy create-then-immediately-live behaviour for callers that
  // don't know about drafts. See src/domains/jobs/client.ts publishJob().
  let initialStatus = 'active';
  if (status !== undefined) {
    if (status !== 'draft' && status !== 'active') {
      return { ok: false, status: 400, error: 'status must be draft or active on create' };
    }
    initialStatus = status;
  }

  // Per-job module flags (rigidity audit R1). Defaults to "everything on".
  // Unknown keys dropped; values coerced to boolean.
  const job = {
    id: jobId,
    name,
    clientUserId: clientUserId || null,
    type: type || null,
    areaGroups: parsedGroups,
    roughInTasks: parsedRoughIn,
    fitOffTasks: parsedFitOff,
    status: initialStatus,
    modules: sanitizeModules(modules),
    customFields: parsedCustomFields,
    ...basicsResult.patch,
    createdAt: new Date().toISOString(),
  };
  // Two-way trace to the originating quote (#244). Only set when a quote
  // converted into this job; ordinary Job Builder creates omit it entirely.
  if (fromQuoteId) job.fromQuoteId = String(fromQuoteId);

  data.jobs.push(job);
  await writeBlob('jobs.json', data);
  await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
  await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
  await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
  // Legacy jobs/<id>/hours.json no longer seeded — hours live in
  // users/<userId>/time-entries/<date>.json (per-user, per-day).

  return { ok: true, job };
}

module.exports = { createJob };
