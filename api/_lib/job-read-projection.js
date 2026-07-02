// J5 — DARK Postgres read projection for jobs/tasks. Reconstructs the legacy
// Blob/job shape (jobs.json job + per-job data.json: dwellings, evidence) FROM the
// canonical Postgres graph (jobs → site_area_groups → site_areas →
// job_task_templates → tasks → task_status_events* → evidence_files), so a reader
// could be served from Postgres instead of Blob.
//
// *task_status_events is the audit history, not part of the current-state read.
//
// DARK + SAFE BY DEFAULT: nothing in the app consumes this yet. readJobsFromPgIfEnabled
// is gated behind the `supabase_read_jobs` flag (default OFF) and is best-effort —
// any error returns { pg:false } so the caller falls back to Blob, which stays
// AUTHORITATIVE. No write path; no route/UI cutover (that is a later rung).
//
// The reconstruction reverses the importer mappings exactly (composite area/group
// legacy_id → blob id via decomposeLegacyId; bare legacy_template_id → blob taskId;
// uuid FKs → legacy ids via joins; *_label preserved where the actor uuid is null),
// so feeding the reconstruction back through the importers' Blob projections yields
// the SAME migrated entities as the real Blob — the J5 parity proof
// (scripts/importers/job-read-parity.js).

const { decomposeLegacyId } = require('../../scripts/importers/lib/structure-legacy-id');

const STAGE_KEYS = { roughIn: 'roughInTasks', fitOff: 'fitOffTasks' };

function localId(legacy) {
  const d = decomposeLegacyId(legacy);
  return d ? d.localId : legacy; // jobs keep raw ids; groups/areas are composite
}
function emptyStageLists() {
  return { roughInTasks: [], fitOffTasks: [] };
}

/**
 * Reconstruct the Blob sources shape from flat PG rows (each carrying its own
 * legacy id + parent legacy ids resolved by the loader's joins). PURE.
 * @returns {{ jobs: { jobs: object[] }, jobData: Record<string, object> }}
 */
function reconstructFromPg(rows = {}) {
  const jobsRows = rows.jobs || [];
  const groups = rows.groups || [];
  const areas = rows.areas || [];
  const templates = rows.templates || [];
  const tasks = rows.tasks || [];
  const evidence = rows.evidence || [];

  const byJob = new Map(); // jobLegacy → { job, areasById }
  const jobs = jobsRows.map((j) => {
    const job = {
      id: j.legacy_id, name: j.name, status: j.status, ref: j.ref,
      type: j.job_type_label, serviceM8JobId: j.external_ref, siteAddress: j.site_address,
      siteContactName: j.site_contact_name, siteContactPhone: j.site_contact_phone,
      accessNotes: j.access_notes, parkingNotes: j.parking_notes, safetyNotes: j.safety_notes,
      inductionRequired: j.induction_required, startDate: j.start_date, dueDate: j.due_date,
      programmedDurationDays: j.programmed_duration_days, createdAt: j.created_at,
      areaGroups: [], roughInTasks: [], fitOffTasks: [],
    };
    byJob.set(j.legacy_id, { job, groupsById: new Map(), areasById: new Map() });
    return job;
  });

  for (const g of groups) {
    const ctx = byJob.get(g.job_legacy);
    if (!ctx) continue;
    const group = { id: localId(g.legacy_id), name: g.name, order: g.sort_order, archived: g.archived === true, areas: [] };
    ctx.groupsById.set(g.legacy_id, group);
    ctx.job.areaGroups.push(group);
  }
  for (const a of areas) {
    const ctx = byJob.get(a.job_legacy);
    if (!ctx) continue;
    const group = a.group_legacy ? ctx.groupsById.get(a.group_legacy) : null;
    // Fail closed: the Blob model nests every area inside a group (the importer
    // always sets group_id). An area with no group, or a group_legacy that doesn't
    // resolve, can't be placed in areaGroups — rather than silently drop it from
    // the reconstructed shape, throw. readJobsFromPgIfEnabled is best-effort, so
    // this degrades to a clean Blob fallback rather than serving partial data.
    if (!group) {
      throw new Error(`area ${a.legacy_id}: no resolvable group (group_legacy=${a.group_legacy}) — cannot reconstruct the Blob shape`);
    }
    const area = {
      id: localId(a.legacy_id), name: a.name, spaceType: a.space_type, order: a.sort_order,
      archived: a.archived === true, ...emptyStageLists(),
    };
    ctx.areasById.set(a.legacy_id, area);
    group.areas.push(area);
  }
  for (const t of templates) {
    const ctx = byJob.get(t.job_legacy);
    if (!ctx) continue;
    const entry = { id: t.legacy_id, name: t.name, order: t.sort_order, archived: t.archived === true };
    const key = STAGE_KEYS[t.stage];
    if (!key) continue;
    if (t.area_legacy) {
      const area = ctx.areasById.get(t.area_legacy);
      if (area) area[key].push(entry);
    } else {
      ctx.job[key].push(entry); // job-level default
    }
  }

  const jobData = {};
  const dataFor = (jobLegacy) => {
    if (!jobData[jobLegacy]) jobData[jobLegacy] = { dwellings: {}, evidence: [], snags: [], notes: [] };
    return jobData[jobLegacy];
  };
  for (const t of tasks) {
    if (!byJob.has(t.job_legacy) || !t.area_legacy || !STAGE_KEYS[t.stage] || !t.legacy_template_id) continue;
    const areaId = localId(t.area_legacy);
    const d = dataFor(t.job_legacy).dwellings;
    if (!d[areaId]) d[areaId] = {};
    if (!d[areaId][t.stage]) d[areaId][t.stage] = { tasks: {} };
    d[areaId][t.stage].tasks[t.legacy_template_id] = t.status;
  }
  for (const e of evidence) {
    if (!byJob.has(e.job_legacy)) continue;
    dataFor(e.job_legacy).evidence.push({
      id: e.legacy_id, kind: e.kind, photoId: e.photo_blob_id, photoUrl: e.blob_url,
      thumbnailUrl: e.thumbnail_url, note: e.note,
      areaId: e.area_legacy ? localId(e.area_legacy) : null,
      stage: e.stage, taskId: e.task_legacy_template_id || null,
      capturedById: e.captured_by_legacy || null, capturedByName: e.captured_by_label,
      capturedAt: e.captured_at, clientCapturedAt: e.client_captured_at,
      exifLocation: e.exif_lat != null || e.exif_lng != null ? { lat: e.exif_lat, lng: e.exif_lng } : null,
      status: e.status, source: e.source,
      reviewedById: e.reviewed_by_legacy || null, reviewedByName: e.reviewed_by_label,
      reviewedAt: e.reviewed_at, rejectionReason: e.rejection_reason, createdAt: e.created_at,
    });
  }

  return { jobs: { jobs }, jobData };
}

// Query the PG graph (with parent-legacy joins) and reconstruct. Structure rows
// include archived (deleted_at not null) so the reconstruction round-trips
// archived groups/areas/templates as `archived:true` blob entries.
async function loadJobStructureFromPg(sql, tenantId) {
  // ORDER BY makes the reconstruction DETERMINISTIC: arrays come back in
  // sort_order (then legacy_id as a stable tiebreak), so the same PG state always
  // reconstructs to byte-identical arrays. This is what lets the J6 admin overlay
  // gate per job on an order-sensitive hash and still guarantee Blob-identical
  // output. (The J5 parity proof hashes order-independently, so it is unaffected.)
  // The six structure queries are INDEPENDENT (each selects a different table by
  // tenant_id; no JS-level dependency between them). Run them concurrently —
  // postgres.js pipelines them over the single pooled connection, collapsing six
  // stacked Vercel→Supabase round-trips (the dominant cost of this dark overlay)
  // into ~one. Same queries, same ORDER BY ⇒ byte-identical reconstruction — a
  // pure latency cut, no change to what the overlay produces.
  const [jobs, groups, areas, templates, tasks, evidence] = await Promise.all([
    sql`
    select legacy_id, name, status, ref, job_type_label, external_ref, site_address,
           site_contact_name, site_contact_phone, access_notes, parking_notes, safety_notes,
           induction_required, start_date::text as start_date, due_date::text as due_date,
           programmed_duration_days, created_at::text as created_at
    from public.jobs where tenant_id = ${tenantId} and legacy_id is not null and deleted_at is null
    order by legacy_id`,
    sql`
    select g.legacy_id, jb.legacy_id as job_legacy, g.name, g.sort_order, (g.deleted_at is not null) as archived
    from public.site_area_groups g join public.jobs jb on jb.id = g.job_id
    where g.tenant_id = ${tenantId} and g.legacy_id is not null
    order by g.sort_order, g.legacy_id`,
    sql`
    select a.legacy_id, jb.legacy_id as job_legacy, gp.legacy_id as group_legacy, a.name, a.space_type,
           a.sort_order, (a.deleted_at is not null) as archived
    from public.site_areas a join public.jobs jb on jb.id = a.job_id
    left join public.site_area_groups gp on gp.id = a.group_id
    where a.tenant_id = ${tenantId} and a.legacy_id is not null
    order by a.sort_order, a.legacy_id`,
    sql`
    select t.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy, t.stage, t.name,
           t.sort_order, (t.deleted_at is not null) as archived
    from public.job_task_templates t join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_id is not null
    order by t.sort_order, t.legacy_id`,
    sql`
    select jb.legacy_id as job_legacy, ar.legacy_id as area_legacy, t.stage, t.legacy_template_id, t.status
    from public.tasks t join public.jobs jb on jb.id = t.job_id
    join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_template_id is not null and t.deleted_at is null
    order by t.legacy_template_id, ar.legacy_id, jb.legacy_id`,
    sql`
    select ef.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy,
           tk.legacy_template_id as task_legacy_template_id, ef.kind, ef.photo_blob_id, ef.blob_url,
           ef.thumbnail_url, ef.note, ef.stage, cu.legacy_user_id as captured_by_legacy, ef.captured_by_label,
           ef.captured_at::text as captured_at, ef.client_captured_at::text as client_captured_at,
           ef.exif_lat, ef.exif_lng, ef.status, ef.source, ru.legacy_user_id as reviewed_by_legacy,
           ef.reviewed_by_label, ef.reviewed_at::text as reviewed_at, ef.rejection_reason, ef.created_at::text as created_at
    from public.evidence_files ef join public.jobs jb on jb.id = ef.job_id
    left join public.site_areas ar on ar.id = ef.site_area_id
    left join public.tasks tk on tk.id = ef.task_id
    left join public.user_profiles cu on cu.id = ef.captured_by
    left join public.user_profiles ru on ru.id = ef.reviewed_by
    where ef.tenant_id = ${tenantId} and ef.legacy_id is not null and ef.deleted_at is null
    order by ef.created_at, ef.legacy_id`,
  ]);

  return reconstructFromPg({
    jobs: [...jobs], groups: [...groups], areas: [...areas],
    templates: [...templates], tasks: [...tasks], evidence: [...evidence],
  });
}

/**
 * DARK reader. Returns { pg:false } unless the `supabase_read_jobs` flag is ON
 * (so Blob stays authoritative), and best-effort: any error → { pg:false } for a
 * clean Blob fallback. Injectable deps for tests.
 */
async function readJobsFromPgIfEnabled(deps = {}) {
  const { getDb = realGetDb, isFlagOn = realIsFlagOn, tenantSlug = 'buhl' } = deps;
  if (!process.env.SUPABASE_DB_URL) return { pg: false, reason: 'no supabase env' };
  try {
    if (!(await isFlagOn('supabase_read_jobs'))) return { pg: false, reason: 'flag off' };
    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return { pg: false, reason: 'no tenant' };
    const sources = await loadJobStructureFromPg(sql, tenant[0].id);
    return { pg: true, sources };
  } catch (err) {
    console.warn('[job-read-projection] PG read failed (Blob authoritative):', err && err.message ? err.message : err);
    return { pg: false, reason: 'error' };
  }
}

function realGetDb(opts) {
  return require('./supabase-db').getDb(opts);
}
function realIsFlagOn(key) {
  return require('./feature-flags').isFlagOn(key);
}
function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}

// ───────────────────────────────────────────────────────────────────────────
// J6 — admin read cutover (DARK). The admin jobs read can be served from the PG
// reconstruction, behind the `supabase_read_jobs` flag, WITHOUT changing what
// admin sees. Two hard realities shape the design:
//
//   1. Jobs/tasks are NOT dual-written (only hours is) → Postgres is a FROZEN
//      snapshot from the last importer run. Any job edited since has drifted, so
//      the cutover cannot trust PG blindly: it is gated PER JOB.
//   2. Admin consumes Blob-ONLY fields PG never stored (modules, customFields,
//      scopeOfWork, clientUserId, and any structural extras), and existence is
//      Blob-authoritative (new/draft jobs live only in Blob). So PG never
//      REPLACES the Blob read — it OVERLAYS it.
//
// Serve policy: Blob is the spine. For each job present in both, if the PG
// reconstruction's MIGRATED fields hash-equal the Blob's (order-sensitive,
// key-order-normalised), that job's migrated fields are sourced from PG;
// otherwise the Blob job is kept untouched. Because "faithful" means byte-equal,
// the served output is PROVABLY identical to Blob — PG is genuinely exercised,
// nothing admin sees changes, and drift/new/error all fall back to Blob.
// ───────────────────────────────────────────────────────────────────────────

// The job fields the PG reconstruction OWNS and may serve. createdAt is
// deliberately excluded: PG stores it as a timestamp whose ::text form differs
// from the Blob's string, which would mark every job drifted and is meaningless
// to "cut over" anyway. Everything not in this list (modules, customFields,
// scopeOfWork, clientUserId, …) stays Blob-authoritative via the spine.
const MIGRATED_JOB_FIELDS = [
  'name', 'status', 'ref', 'type', 'serviceM8JobId', 'siteAddress',
  'siteContactName', 'siteContactPhone', 'accessNotes', 'parkingNotes', 'safetyNotes',
  'inductionRequired', 'startDate', 'dueDate', 'programmedDurationDays',
  'areaGroups', 'roughInTasks', 'fitOffTasks',
];

// Deterministic serialisation: object keys sorted at every depth (so key order
// can't forge a diff), array ORDER preserved (so a genuine reordering still
// counts as drift — which protects Blob-identical output). undefined→null.
function deepCanonOrdered(v) {
  if (Array.isArray(v)) return v.map(deepCanonOrdered);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = deepCanonOrdered(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}

const crypto = require('node:crypto');

function migratedFieldsHash(job) {
  const picked = {};
  for (const f of MIGRATED_JOB_FIELDS) picked[f] = job ? (job[f] === undefined ? null : job[f]) : null;
  return crypto.createHash('sha256').update(JSON.stringify(deepCanonOrdered(picked))).digest('hex');
}

/**
 * PURE. Per-job parity-gated overlay of PG migrated fields onto the Blob spine.
 * @returns {{ jobs: object[], pgFaithfulCount, driftedCount, onlyInBlobCount,
 *             onlyInPgCount, matchedCount, parityMatch: boolean, blobHash, pgHash,
 *             driftedIds: string[] }}
 */
function overlayAdminJobs(blobJobs = [], pgJobs = []) {
  const pgById = new Map();
  for (const p of pgJobs) pgById.set(p.id, p);
  const blobIds = new Set();

  let pgFaithfulCount = 0;
  let matchedCount = 0;
  const driftedIds = [];
  const matchedBlobHashes = [];
  const matchedPgHashes = [];

  const jobs = blobJobs.map((b) => {
    blobIds.add(b.id);
    const p = pgById.get(b.id);
    if (!p) return b; // only in Blob (new/draft) — existence is Blob-authoritative
    matchedCount += 1;
    const bh = migratedFieldsHash(b);
    const ph = migratedFieldsHash(p);
    matchedBlobHashes.push(bh);
    matchedPgHashes.push(ph);
    if (bh !== ph) {
      driftedIds.push(b.id); // PG stale vs Blob — keep Blob untouched
      return b;
    }
    pgFaithfulCount += 1;
    // Faithful: source the migrated fields from PG. Only overlay keys the Blob
    // job ALREADY has, so the served object's key SET is identical to Blob's (PG
    // may store an optional field as null that Blob omits — adding it would be a
    // subtle change). Keep all Blob-only fields (modules/customFields/scopeOfWork/
    // clientUserId/…) intact. Because the job is faithful, the result is
    // semantically identical to Blob (same data & order; only nested JSON key
    // ordering may differ, which no consumer depends on).
    const merged = { ...b };
    for (const f of MIGRATED_JOB_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(b, f) && p[f] !== undefined) merged[f] = p[f];
    }
    return merged;
  });

  let onlyInPgCount = 0;
  for (const p of pgJobs) if (!blobIds.has(p.id)) onlyInPgCount += 1;

  // blobHash/pgHash are AGGREGATE summary hashes over the matched jobs (for the
  // diagnostics readout only). The actual serve decision is the PER-JOB hash
  // compare above (bh !== ph) — never these aggregates.
  const aggregate = (arr) =>
    crypto.createHash('sha256').update(arr.slice().sort().join('|')).digest('hex');

  return {
    jobs,
    pgFaithfulCount,
    driftedCount: driftedIds.length,
    onlyInBlobCount: jobs.length - matchedCount,
    onlyInPgCount,
    matchedCount,
    parityMatch: driftedIds.length === 0,
    blobHash: aggregate(matchedBlobHashes),
    pgHash: aggregate(matchedPgHashes),
    driftedIds,
  };
}

// J7 — Phil read overlay scoped to a worker's VISIBLE jobs. Reuses overlayAdminJobs
// on just the visible subset, then merges the overlaid visible jobs back into the
// full Blob list. Jobs the worker can't see are NEVER touched and PG is never even
// compared for them (no cross-worker leakage); the counts are scoped to the
// worker's visible jobs so diagnostics report exactly what they can see.
function overlayPhilJobs(blobJobs = [], pgJobs = [], visibleJobIds = []) {
  const visible = new Set(visibleJobIds);
  const visibleBlob = blobJobs.filter((j) => visible.has(j.id));
  const o = overlayAdminJobs(visibleBlob, pgJobs);
  const overlaidById = new Map(o.jobs.map((j) => [j.id, j]));
  const jobs = blobJobs.map((j) => overlaidById.get(j.id) || j);
  // onlyInPgCount from the full-tenant pgJobs is meaningless when scoped to the
  // Blob-derived visible ids (every visible id is by definition in Blob) → 0.
  return { ...o, jobs, onlyInPgCount: 0 };
}

const EMPTY_DIAG_BLOB = (reason, latencyMs, flagOn) => ({
  readSource: 'blob', reason, flagOn: flagOn === true, reconstructed: false,
  parityMatch: null, pgFaithfulCount: 0, driftedCount: 0, onlyInBlobCount: 0,
  onlyInPgCount: 0, matchedCount: 0, blobHash: null, pgHash: null,
  latencyMs, fallbackUsed: false, error: null,
});

/**
 * Shared gate→reconstruct→overlay→diag core for the admin (J6) and Phil (J7) read
 * cutovers. Blob stays authoritative: returns the Blob jobs untouched unless
 * `flagKey` is ON and PG reconstructs; faithful jobs are served from PG (output
 * provably == Blob); any error → full Blob fallback (never throws into the
 * caller). opts.eligibleIds (Phil) scopes the overlay + diagnostics to the
 * worker's visible jobs. Injectable deps.
 */
async function runJobsOverlay(flagKey, input = {}, opts = {}) {
  const { blobJobs = [], getDb = realGetDb, isFlagOn = realIsFlagOn, tenantSlug = 'buhl', now = Date.now } = input;
  const eligibleIds = opts.eligibleIds || null; // null → all jobs (admin); array → scoped (Phil)
  const started = now();
  const elapsed = () => Math.max(0, now() - started);

  if (!process.env.SUPABASE_DB_URL) {
    return { jobs: blobJobs, diag: EMPTY_DIAG_BLOB('no supabase env', elapsed(), false) };
  }
  let flagOn = false;
  try {
    flagOn = (await isFlagOn(flagKey)) === true;
    if (!flagOn) return { jobs: blobJobs, diag: EMPTY_DIAG_BLOB('flag off', elapsed(), false) };

    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) {
      // PG was reached but the tenant is absent — Blob fallback (PG was attempted).
      return { jobs: blobJobs, diag: { ...EMPTY_DIAG_BLOB('no tenant', elapsed(), true), fallbackUsed: true } };
    }

    const sources = await loadJobStructureFromPg(sql, tenant[0].id);
    const pgJobs = (sources && sources.jobs && sources.jobs.jobs) || [];
    const o = eligibleIds ? overlayPhilJobs(blobJobs, pgJobs, eligibleIds) : overlayAdminJobs(blobJobs, pgJobs);
    const servedFromPg = o.pgFaithfulCount > 0;
    return {
      jobs: o.jobs,
      diag: {
        readSource: servedFromPg ? 'postgres' : 'blob',
        reason: servedFromPg
          ? (o.driftedCount > 0 ? 'served from postgres (some jobs drifted → blob)' : 'served from postgres')
          : 'all in-both jobs drifted or absent → blob',
        flagOn: true, reconstructed: true, parityMatch: o.parityMatch,
        pgFaithfulCount: o.pgFaithfulCount, driftedCount: o.driftedCount,
        onlyInBlobCount: o.onlyInBlobCount, onlyInPgCount: o.onlyInPgCount,
        matchedCount: o.matchedCount, blobHash: o.blobHash, pgHash: o.pgHash,
        latencyMs: elapsed(), fallbackUsed: false, error: null,
      },
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[job-read-projection] PG overlay failed (Blob authoritative) [${flagKey}]:`, msg);
    return {
      jobs: blobJobs,
      diag: { ...EMPTY_DIAG_BLOB('error', elapsed(), flagOn), fallbackUsed: flagOn === true, error: msg },
    };
  }
}

/**
 * DARK admin read. Blob authoritative behind `supabase_read_jobs`. Returns
 * { jobs, diag }; faithful jobs served from PG (output == Blob), any error → Blob.
 */
async function readAdminJobsWithPgOverlay(input = {}) {
  return runJobsOverlay('supabase_read_jobs', input);
}

/**
 * DARK Phil (field/leading-hand) read. Same overlay behind `supabase_read_phil_jobs`,
 * scoped to the worker's VISIBLE (assigned, non-draft/archived) job ids so PG is
 * never read for jobs they can't see and the diagnostics report their visible jobs.
 */
async function readPhilJobsWithPgOverlay(input = {}) {
  const { visibleJobIds = [], ...rest } = input;
  if (!Array.isArray(visibleJobIds) || visibleJobIds.length === 0) {
    // Nothing this worker can see → no point reconstructing PG; serve Blob.
    return { jobs: rest.blobJobs || [], diag: EMPTY_DIAG_BLOB('no visible jobs', 0, false) };
  }
  return runJobsOverlay('supabase_read_phil_jobs', rest, { eligibleIds: visibleJobIds });
}

/**
 * Read-only diagnostics probe for the admin /jobs-read-status page. Reads the
 * Blob jobs + runs the same overlay logic, returning ONLY the diag (it does not
 * serve or record). Never throws. Injectable deps.
 */
async function probeAdminJobsRead(deps = {}) {
  const { readBlob = realReadBlob, now = Date.now } = deps;
  const started = now();
  try {
    const blob = await readBlob('jobs.json', { jobs: [] });
    const { diag } = await readAdminJobsWithPgOverlay({ ...deps, blobJobs: (blob && blob.jobs) || [] });
    return diag;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { ...EMPTY_DIAG_BLOB('probe error', Math.max(0, now() - started), false), error: msg };
  }
}

module.exports = {
  reconstructFromPg, loadJobStructureFromPg, readJobsFromPgIfEnabled,
  MIGRATED_JOB_FIELDS, migratedFieldsHash, deepCanonOrdered, overlayAdminJobs, overlayPhilJobs,
  readAdminJobsWithPgOverlay, readPhilJobsWithPgOverlay, probeAdminJobsRead,
};
