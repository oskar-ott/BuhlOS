const { readBlob, writeBlob, deleteBlob, setNoCache } = require('./_lib/blob');
const { tagsFromBlob } = require('./_lib/tags-store');
const { requireAuth, getCurrentUser, canManageJob, isLeadingHandRole, canViewDraftJobs, canViewArchivedJobs, isFieldRole, isClientRole, isAdminRole } = require('./_lib/auth');
const { redactJobForViewer } = require('./_lib/job-redaction');
const { readAdminJobsWithPgOverlay, readPhilJobsWithPgOverlay } = require('./_lib/job-read-projection');
const { recordJobsRead } = require('./_lib/job-read-diagnostics');
const { mirrorJobToPg } = require('./_lib/jobs-mirror');
const { isFlagOnSync } = require('./_lib/feature-flags');
const { readJobsSummary, readFieldJobStats, countActiveSnagsV2, countActiveItps } = require('./_lib/jobs-summary');
const { readJobDetailProjection } = require('./_lib/job-detail-projection');

// Canonical job statuses — keep in sync with src/domains/jobs/schema.ts JOB_STATUSES.
const VALID_JOB_STATUS = new Set(['active', 'complete', 'archived', 'on_hold', 'draft']);
const { validateAreaGroups, findDuplicateLiveAreaId, validateTasks, validateCustomFields, visibleStructural } = require('./_lib/validation');

// #200: scope-of-work items — { id, title, detail, order }. ≤50 items,
// title required ≤200, detail ≤2000 (a pasted 10-page PDF is a hard 400,
// never silent truncation). Server ids; order rewritten 0..n-1.
function validateScopeOfWork(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'scopeOfWork must be an array' };
  if (raw.length > 50) return { ok: false, error: 'scopeOfWork: 50 items max' };
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it || typeof it !== 'object') return { ok: false, error: `scopeOfWork[${i}] must be an object` };
    const title = String(it.title || '').trim();
    if (!title) return { ok: false, error: `scopeOfWork[${i}].title required` };
    if (title.length > 200) return { ok: false, error: `scopeOfWork[${i}].title too long (200 max)` };
    const detail = it.detail === undefined || it.detail === null ? '' : String(it.detail);
    if (detail.length > 2000) {
      return { ok: false, error: `scopeOfWork[${i}].detail too long (2000 characters max — split it into items)` };
    }
    items.push({
      id: it.id && String(it.id).startsWith('sw_') ? String(it.id) : 'sw_' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 5),
      title,
      detail,
      order: i,
    });
  }
  return { ok: true, items };
}
const { areaProgressPct, jobTaskCounts } = require('./_lib/job-tasks');
const { createJob } = require('./_lib/job-create');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { buildJobCreatedEntry } = require('./_lib/job-create-audit');
const { appendAudit } = require('./_lib/job-audit');
const { testJobDeleteEligibility } = require('./_lib/test-data');
const { buildDuplicatePayload, copyName } = require('./_lib/job-duplicate');

// slugify / module-flag helpers / Job Basics validator are the canonical
// copies in api/_lib/job-fields.js so the shared job creator (#244) and this
// handler share ONE definition. Re-exposed under the same local names here so
// the rest of this file (POST / PUT / duplicate / GET) is unchanged.
const {
  slugify,
  sanitizeModules,
  effectiveModules,
  validateJobBasics,
} = require('./_lib/job-fields');

// Project a job for response — filter archived areaGroups/areas/tasks
// (R2) and apply explicit `order` (R4). Returns a copy; never mutates.
// Pass { includeArchived: true } on admin editor reads.
function projectJobStructure(job, { includeArchived = false } = {}) {
  if (!job) return job;
  const out = { ...job };
  if (Array.isArray(job.areaGroups)) {
    out.areaGroups = visibleStructural(job.areaGroups, { includeArchived }).map(g => ({
      ...g,
      areas: visibleStructural(g.areas || [], { includeArchived }),
    }));
  }
  if (Array.isArray(job.roughInTasks)) {
    out.roughInTasks = visibleStructural(job.roughInTasks, { includeArchived });
  }
  if (Array.isArray(job.fitOffTasks)) {
    out.fitOffTasks = visibleStructural(job.fitOffTasks, { includeArchived });
  }
  return out;
}

// Aggregate job-level stats. #198: pct is now THE canonical pooled
// task-count progress (jobTaskCounts — archived excluded, % only where a
// total exists), replacing the old average-of-area-percentages. Counts ride
// alongside so surfaces can stay counts-first.
//
// Snags counted as those with status === 'Open'.
function computeJobStats(job, data) {
  const dwellings = (data && data.dwellings) || {};
  const snags     = (data && data.snags)     || [];
  const groups    = (job && job.areaGroups)  || [];
  const areas = groups.flatMap(g => (g.areas || []));
  const areaCount = areas.length;
  const counts = jobTaskCounts(job, dwellings);
  const pct = counts.total ? Math.round((counts.complete / counts.total) * 100) : null;
  const openSnags = snags.filter(s => s && s.status === 'Open').length;
  return { pct, openSnags, areaCount, tasksTotal: counts.total, tasksComplete: counts.complete };
}

// Crew tally for the stats* fields — counts field + leading-hand users assigned
// to each job. One users.json read; shared by the list and single-job GETs so
// they can never disagree.
async function loadCrewCountByJob() {
  const crewCountByJob = {};
  try {
    const usersBlob = await readBlob('users.json', { users: [] });
    (usersBlob.users || []).forEach(u => {
      if (isFieldRole(u.role) || isLeadingHandRole(u.role)) {
        (u.assignedJobIds || []).forEach(jid => {
          crewCountByJob[jid] = (crewCountByJob[jid] || 0) + 1;
        });
      }
    });
  } catch (e) { /* tolerate missing */ }
  return crewCountByJob;
}

// Per-job stats enrichment used by BOTH the /jobs list (?withStats=1) and the
// single-job hub GET (?id=…&withStats=1) — extracted so the two surfaces can't
// drift (a single-job request used to skip this and read every stats* field as
// undefined, which collapsed the hub's Status/attention card, section count
// chips and Test&tag card into a fabricated "all clear"). One blob read per
// job; fine at both the list and single-job scale. Fails soft per job — the
// caller still gets the core job with stats absent rather than a 500.
async function enrichJobsWithStats(jobs, crewCountByJob) {
  // Tag-expiry totals come from per-job tags.json. Parse dd/mm/yyyy and
  // count expired (already past) + soon (≤14 days).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const cutoffMs = todayMs + 14 * 24 * 60 * 60 * 1000;
  const parseDDMM = s => {
    if (!s) return NaN;
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    const m2 = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]).getTime();
    return NaN;
  };

  return Promise.all(jobs.map(async j => {
    try {
      const [d, tagsBlob, itpsBlob, plansBlob] = await Promise.all([
        readBlob(`jobs/${j.id}/data.json`, { dwellings: {}, snags: [] }),
        readBlob(`jobs/${j.id}/tags.json`, { tags: [] }).catch(() => ({ tags: [] })),
        // E1a: per-job ITP instances live on a separate blob, not on
        // data.json — see api/job-itps.js. Missing blob (no ITPs ever
        // attached) falls back to { instances: [] }.
        readBlob(`jobs/${j.id}/itps.json`, { instances: [] }).catch(() => ({ instances: [] })),
        // E2: per-job plan/spec index lives on its own blob — see
        // api/plans.js. Missing blob (no plans uploaded yet) falls back to
        // { plans: [] } so statsDocumentsCurrent reads as 0 not a reject.
        readBlob(`jobs/${j.id}/plans-index.json`, { plans: [] }).catch(() => ({ plans: [] })),
      ]);
      const stats = computeJobStats(j, d);
      let expiredTags = 0, expiringTags = 0;
      for (const t of tagsFromBlob(tagsBlob)) {
        const ms = parseDDMM(t.expiryDate);
        if (!Number.isFinite(ms)) continue;
        if (ms < todayMs) expiredTags++;
        else if (ms <= cutoffMs) expiringTags++;
      }
      // V2 namespace counts for the rebuild admin jobs index. computeJobStats
      // counts the legacy snags[] array; the rebuild surfaces consume the
      // parallel evidence[] + snagsV2[] arrays on the same data.json. Both
      // reads share the single data.json fetch above — zero extra blob hits.
      const evidenceArr = Array.isArray(d.evidence) ? d.evidence : [];
      let evidencePendingV2 = 0;
      for (const e of evidenceArr) {
        const s = e && e.status;
        if (s === 'submitted' || s === 'pending_upload') evidencePendingV2++;
      }
      // statsSnagsV2Active / statsItpsActive via the SHARED counters (single
      // source of truth with the summary withStats path — api/_lib/jobs-summary.js
      // countActiveSnagsV2 / countActiveItps) so the two read paths can't diverge.
      const snagsActiveV2 = countActiveSnagsV2(d);
      const itpsActive = countActiveItps(itpsBlob);
      // statsItpsNeedsReview = the witnessed subset (Command Centre "ITPs needing
      // sign-off" queue) — admin-only, not a field stat, so it stays here.
      const itpsArr = Array.isArray(itpsBlob && itpsBlob.instances) ? itpsBlob.instances : [];
      let itpsNeedsReview = 0;
      for (const inst of itpsArr) {
        if (inst && !inst.archived && inst.status === 'witnessed') itpsNeedsReview++;
      }
      // E2: current (non-superseded, non-archived) plan/spec rows. Legacy rows
      // without a `status` default to 'current' (matches api/plans.js).
      const plansArr = Array.isArray(plansBlob && plansBlob.plans) ? plansBlob.plans : [];
      let documentsCurrent = 0;
      for (const p of plansArr) {
        if (!p) continue;
        const st = p.status;
        if (!st || st === 'current') documentsCurrent++;
      }
      return Object.assign({}, j, {
        statsPct:               stats.pct,
        statsTasksTotal:        stats.tasksTotal,
        statsTasksComplete:     stats.tasksComplete,
        statsOpenSnags:         stats.openSnags,
        statsCrewCount:         crewCountByJob[j.id] || 0,
        statsAreaCount:         stats.areaCount,
        statsExpiredTags:       expiredTags,
        statsExpiringTags:      expiringTags,
        statsEvidenceV2Pending: evidencePendingV2,
        statsSnagsV2Active:     snagsActiveV2,
        statsItpsActive:        itpsActive,
        statsItpsNeedsReview:   itpsNeedsReview,
        statsDocumentsCurrent:  documentsCurrent,
      });
    } catch (e) {
      // Fail soft — caller still gets the core job, stats just absent.
      return Object.assign({}, j, {
        statsPct: null, statsTasksTotal: 0, statsTasksComplete: 0, statsOpenSnags: 0,
        statsCrewCount: crewCountByJob[j.id] || 0,
        statsAreaCount: 0,
        statsExpiredTags: 0, statsExpiringTags: 0,
        statsEvidenceV2Pending: 0, statsSnagsV2Active: 0,
        statsItpsActive: 0,
        statsItpsNeedsReview: 0,
        statsDocumentsCurrent: 0,
      });
    }
  }));
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Perf (Phil mobile LCP): serve the FIELD/leading-hand plain job LIST from the
  // small derived jobs-summary.json instead of reading+parsing the full jobs.json
  // monolith (~3.5s). ENV-gated (isFlagOnSync = no flags.json read) so when DARK
  // this block is a cheap boolean and the #674 path below stays byte-identical.
  // Scope: the field LIST (no ?id; single-job needs full structure → full read).
  // ?withStats=1 is supported via lightweight per-job stat reads (snags + ITPs
  // only — the two chips /phil/jobs renders); task/area stats (which need
  // areaGroups) are NOT served on this path. Admin/client fall through. The
  // summary is freshness-validated and falls back to the full read on ANY miss/error.
  if (
    req.method === 'GET' &&
    !(req.query && req.query.id) &&
    isFlagOnSync('phil_jobs_summary_read')
  ) {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    // Field/LH only. This TAKES PRECEDENCE over the J7 supabase_read_phil_jobs PG
    // overlay for the field plain LIST: the overlay rides on top of the full
    // jobs.json read (it does not remove the ~3.5s monolith fetch), so it does
    // not fix LCP; the summary does. Output stays parity-correct because the
    // summary is built from the SAME Blob spine (jobs.json) the overlay falls
    // back to, and jobs.json is kept current by supabase_dual_write_jobs (PG
    // remains the truth for admin reads + dual-write; the field LIST reads the
    // dual-written, drift-alarmed Blob spine via the summary). Clients use a
    // different visibility filter (kept on the full read). Any failure → fall
    // through to the authoritative full read.
    if (isFieldRole(me.role) || isLeadingHandRole(me.role)) {
      try {
        const { records } = await readJobsSummary();
        // Same per-viewer visibility filter as the full list branch: the worker's
        // assigned, non-draft, non-archived jobs.
        let visible = records.filter(
          (j) =>
            (me.assignedJobIds || []).includes(j.id) &&
            j.status !== 'draft' &&
            j.status !== 'archived' &&
            j.status !== 'complete' // #349: closed-out jobs are field-invisible
        );
        // ?withStats=1: attach ONLY the two stats /phil/jobs renders
        // (statsSnagsV2Active, statsItpsActive), computed from the per-job
        // data.json + itps.json (the SAME shared counters the full path uses) —
        // no areaGroups, no monolith. Task/area stats are deliberately omitted
        // (the field list never reads them; see philJobsListSignals).
        if (req.query && req.query.withStats === '1') {
          const statsByJob = await readFieldJobStats(visible.map((j) => j.id));
          visible = visible.map((j) => Object.assign({}, j, statsByJob[j.id] || {
            statsSnagsV2Active: 0,
            statsItpsActive: 0,
          }));
        }
        // Same redaction boundary as the full path (typeName already resolved in
        // the record; money omitted from the record entirely).
        return res.status(200).json({ jobs: visible.map((j) => redactJobForViewer(j, me.role)) });
      } catch (e) {
        console.error('jobs-summary read failed; falling back to full jobs.json', e && e.message);
        // fall through to the full read below
      }
    }
    // Admin opt-in base list from the summary (?summary=1, no ?withStats): serve
    // the small jobs-summary base (id/name/status/ref/site/type + kept non-money
    // fields such as cashWatch) instead of the ~3.5-8s jobs.json monolith — for
    // admin surfaces that need ONLY base fields: the /employees active-jobs picker
    // (id/name/ref) and the /reports cash-watch tile (job.cashWatch). OPT-IN so
    // existing admin plain /api/jobs consumers (no ?summary) keep the full read +
    // money + structure. Admin sees all statuses (parity with the admin plain
    // list); redactJobForViewer is a no-op for admin and the summary already omits
    // money. Any error → full read fallback.
    if (isAdminRole(me.role) && req.query && req.query.summary === '1') {
      try {
        const { records } = await readJobsSummary();
        return res.status(200).json({ jobs: records.map((j) => redactJobForViewer(j, me.role)) });
      } catch (e) {
        console.error('admin summary base read failed; falling back to full jobs.json', e && e.message);
        // fall through to the full read below
      }
    }
    // Not eligible (admin/client) or summary errored → fall through.
    // getCurrentUser below is a cheap cache hit (users.json, 5s TTL).
  }

  // Perf (Phil mobile job-detail LCP): serve the FIELD/leading-hand SINGLE-JOB
  // detail GET (?id=, the read behind /phil/jobs/[jobId]) from the small per-job
  // jobs/<id>/field-detail.json projection instead of reading+parsing the whole
  // jobs.json monolith (~3.5s) to return one job. The structure-bearing sibling of
  // the LIST summary above — same ENV-gate, same freshness/fallback contract, and
  // the SAME precedence over the J7 supabase_read_phil_jobs PG overlay for the
  // field read (the projection rides the dual-written Blob spine jobs.json; PG
  // stays truth for admin reads + dual-write — see the list block above). Scope:
  // field/LH, an ASSIGNED job, and NO ?withStats / ?includeArchived (admin-only
  // knobs → full read). The read path runs the SAME projectJobStructure +
  // effectiveModules + redactJobForViewer pipeline on the small record that the
  // full read runs on the monolith, so the response is byte-identical (modulo
  // money, which field/LH never see). ANY miss / stale / draft / archived / error
  // → fall through to the authoritative full read (the one place that enforces
  // 404/403 + every visibility rule).
  if (
    req.method === 'GET' &&
    req.query &&
    req.query.id &&
    req.query.withStats !== '1' &&
    req.query.includeArchived !== '1' &&
    isFlagOnSync('phil_jobs_summary_read')
  ) {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    if (
      (isFieldRole(me.role) || isLeadingHandRole(me.role)) &&
      (me.assignedJobIds || []).includes(req.query.id)
    ) {
      try {
        const { record } = await readJobDetailProjection(req.query.id);
        // Only short-circuit the happy path: the job exists and is live. Draft and
        // archived are office-only (field/LH 404) — defer to the full read so the
        // exact 404/403 semantics live in exactly one place.
        if (record && record.status !== 'draft' && record.status !== 'archived') {
          const cleaned = projectJobStructure(record, { includeArchived: false });
          const projected = { ...cleaned, modules: effectiveModules(record) };
          return res.status(200).json({ job: redactJobForViewer(projected, me.role) });
        }
        // null (not in monolith) / draft / archived → fall through to the full read.
      } catch (e) {
        console.error('job-detail projection read failed; falling back to full jobs.json', e && e.message);
        // fall through to the authoritative full read below
      }
    }
    // Not eligible (admin/client/unassigned) or projection errored → fall through.
  }

  // Perf (admin Command Centre LCP): /api/jobs?withStats=1&statsOnly=1 serves the
  // ADMIN jobs list with ONLY the per-job COUNT stats the Command Centre aggregates
  // (crew / evidence-pending / snags-active / ITPs-needs-review) — it never reads
  // the areaGroups-derived task counts (statsTasksTotal/Pct/areaCount). So it builds
  // from the small jobs-summary base + the SAME enrichJobsWithStats per-job reads,
  // SKIPPING the ~8s jobs.json monolith (measured prod: jobs?withStats=1 ~8s vs the
  // other snapshot reads ~3s — the monolith was the sole gate of the landing). The
  // areaGroups-derived stats come out 0/null on summary records (no structure) and
  // are STRIPPED here — omitted, never served as a fabricated task count (P7). Same
  // ENV flag + freshness/fallback contract as the field summary; any error → full
  // read below. Output for the kept count stats is parity-identical (same
  // enrichJobsWithStats, same per-job blobs). Admin tier only (the Command Centre).
  if (
    req.method === 'GET' &&
    !(req.query && req.query.id) &&
    req.query &&
    req.query.statsOnly === '1' &&
    req.query.withStats === '1' &&
    isFlagOnSync('phil_jobs_summary_read')
  ) {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });
    if (isAdminRole(me.role)) {
      try {
        const { records } = await readJobsSummary();
        const crewCountByJob = await loadCrewCountByJob();
        const enriched = await enrichJobsWithStats(records, crewCountByJob);
        // areaGroups-derived stats are meaningless on structure-less summary
        // records — drop them so no consumer reads a fabricated task count.
        const TASK_STATS = ['statsPct', 'statsTasksTotal', 'statsTasksComplete', 'statsAreaCount'];
        const out = enriched.map((j) => {
          const c = Object.assign({}, j);
          for (const k of TASK_STATS) delete c[k];
          return c;
        });
        return res.status(200).json({ jobs: out.map((j) => redactJobForViewer(j, me.role)) });
      } catch (e) {
        console.error('admin statsOnly read failed; falling back to full jobs.json', e && e.message);
        // fall through to the authoritative full read below
      }
    }
    // Not admin or statsOnly errored → fall through to the full read.
  }

  // Perf (Phil mobile LCP): the field/Phil GET path was gated on a chain of
  // INDEPENDENT cold blob reads run serially — users.json (auth, via
  // getCurrentUser), jobs.json (the dominant ~2.5s read), and, on the list GET,
  // job-types.json (the type-name lookup). None depends on another's CONTENT,
  // so firing them together collapses the serial wall-clock (~sum) to ~max(read).
  // The 401 gate still runs BEFORE any data is used; an unauthenticated request
  // just discards the side-effect-free reads (same pattern as #670). job-types is
  // only needed by the list GET, so it is only prefetched there. Output is
  // byte-identical to the serial version (proven by jobs-api parity tests).
  const wantsJobTypes = req.method === 'GET' && !(req.query && req.query.id);
  const [me, data, jobTypesData] = await Promise.all([
    getCurrentUser(req),
    readBlob('jobs.json', { jobs: [] }),
    wantsJobTypes ? readBlob('job-types.json', { jobTypes: [] }) : Promise.resolve(null),
  ]);
  if (!me) return res.status(401).json({ error: 'not authenticated' });
  data.jobs = data.jobs || [];

  // J6 — DARK admin read cutover. Blob (read above) stays authoritative. For the
  // ADMIN TIER only, when `supabase_read_jobs` is ON, each job's migrated fields
  // are served from the Postgres reconstruction where PG is byte-identical to
  // Blob (else that job stays on Blob); any PG error → full Blob fallback. Output
  // is provably == Blob, so this changes nothing admin sees while exercising the
  // PG read path. Phil/field/clients are NEVER touched (they keep pure Blob), and
  // the flag is OFF by default + unset in production, so prod is unchanged.
  if (isAdminRole(me.role)) {
    const overlay = await readAdminJobsWithPgOverlay({ blobJobs: data.jobs });
    data.jobs = overlay.jobs;
    recordJobsRead(overlay.diag);
  } else if (isFieldRole(me.role) || isLeadingHandRole(me.role)) {
    // J7 — DARK Phil (field) read cutover. Same parity-gated Blob-spine overlay
    // as J6, behind `supabase_read_phil_jobs` (default OFF, unset in prod), but
    // SCOPED to this worker's VISIBLE jobs (their assigned, non-draft/archived
    // jobs — the exact set the list filter below grants). PG is never read for
    // jobs they can't see, so there is no cross-worker leakage; the visibility
    // filter that follows is unchanged. Output is provably == Blob (faithful
    // jobs) or pure Blob (drift/new/error). Clients are NOT touched.
    const visibleJobIds = data.jobs
      .filter(j => (me.assignedJobIds || []).includes(j.id) && j.status !== 'draft' && j.status !== 'archived' && j.status !== 'complete')
      .map(j => j.id);
    const overlay = await readPhilJobsWithPgOverlay({ blobJobs: data.jobs, visibleJobIds });
    data.jobs = overlay.jobs;
    recordJobsRead(overlay.diag, 'phil');
  }

  // GET — list or single
  if (req.method === 'GET') {
    const { id } = req.query || {};
    if (id) {
      const job = data.jobs.find(j => j.id === id);
      if (!job) return res.status(404).json({ error: 'job not found' });
      // Draft and archived jobs are office-only. An admin building a job can
      // open them, but they stay invisible to the field (and clients) — even
      // to a worker already assigned to the job. Reported as "not found" so
      // unpublished or retired work never leaks. publishJob() flips a draft
      // to 'active' (src/domains/jobs/client.ts); see also the list filter.
      // Draft/archived single-GET visibility now matches canManageJob: the
      // admin TIER (boss/owner/manager/office/pm/estimator) may open them, not
      // just literal 'admin' — previously an office user could edit a draft via
      // PUT (canManageJob) yet 404'd opening it here. Field/LH/clients still
      // never see draft or archived work.
      if (
        (job.status === 'draft' && !canViewDraftJobs(me.role)) ||
        (job.status === 'archived' && !canViewArchivedJobs(me.role)) ||
        // #349: a closed-out job is office-only, gated like archived.
        (job.status === 'complete' && !canViewArchivedJobs(me.role))
      ) {
        return res.status(404).json({ error: 'job not found' });
      }
      const canSee =
        canManageJob(me, id) ||
        (me.assignedJobIds || []).includes(id) ||
        (isClientRole(me.role) && job.clientUserId === me.id);
      if (!canSee) return res.status(403).json({ error: 'forbidden' });
      // Hydrate modules + filter archived structural items unless the
      // caller passes ?includeArchived=1 (admin editor only). Mobile +
      // tradie surfaces see the live structure; archived rooms / tasks
      // disappear from their lists without ever being deleted (rigidity
      // audit R2 — archive is the universal "remove" verb).
      const includeArchived =
        req.query &&
        req.query.includeArchived === '1' &&
        canViewArchivedJobs(me.role);
      const cleaned = projectJobStructure(job, { includeArchived });
      const projected = { ...cleaned, modules: effectiveModules(job) };
      // ?withStats=1 on the single-job hub GET — run the SAME per-job stats
      // enrichment the list uses, so the hub's Status/attention card, section
      // count chips and Test&tag card read real numbers instead of undefined
      // (which used to collapse them into a fabricated "all clear"). Shared
      // helper → list + single can't drift.
      if (req.query && req.query.withStats === '1') {
        const crewCountByJob = await loadCrewCountByJob();
        const [enrichedSingle] = await enrichJobsWithStats([projected], crewCountByJob);
        return res.status(200).json({ job: redactJobForViewer(enrichedSingle, me.role) });
      }
      return res.status(200).json({ job: redactJobForViewer(projected, me.role) });
    }
    // Non-admin roles never see draft or archived jobs (office-only).
    // Admin sees every status so the Builder can list + open its own drafts.
    let visible;
    if (canViewDraftJobs(me.role) && canViewArchivedJobs(me.role)) {
      visible = data.jobs;
    } else if (isClientRole(me.role)) {
      visible = data.jobs.filter(j =>
        j.clientUserId === me.id && j.status !== 'draft' && j.status !== 'archived' && j.status !== 'complete'
      );
    } else {
      visible = data.jobs.filter(j =>
        (me.assignedJobIds || []).includes(j.id) &&
        j.status !== 'draft' &&
        j.status !== 'archived' &&
        j.status !== 'complete' // #349: a closed-out job is field-invisible, like archived
      );
    }
    // Enrich with human-readable type name (cheap lookup; small list).
    // Clients/tradies can't read /api/job-types, so resolve server-side.
    let typeMap = {};
    if (jobTypesData && visible.some(j => j.type)) {
      (jobTypesData.jobTypes || []).forEach(t => { typeMap[t.id] = t.name; });
    }
    // Listing surface filters archived structural items by default.
    // The admin job-list page doesn't need them; if a future surface
    // does it can opt in (?includeArchived=1) like the single-job GET.
    const includeArchivedList =
      req.query &&
      req.query.includeArchived === '1' &&
      canViewArchivedJobs(me.role);
    let enriched = visible.map(j => {
      const base = j.type && typeMap[j.type] ? { ...j, typeName: typeMap[j.type] } : { ...j };
      const projected = projectJobStructure(base, { includeArchived: includeArchivedList });
      projected.modules = effectiveModules(j);
      return projected;
    });

    // Optional stats enrichment — used by the /jobs list page so users can scan
    // progress + open-snag count without drilling in. Opt-in via ?withStats=1
    // (one blob read per job; fine for the list-view scale).
    if (req.query && req.query.withStats === '1') {
      const crewCountByJob = await loadCrewCountByJob();
      enriched = await enrichJobsWithStats(enriched, crewCountByJob);
    }

    // #382: strip admin-only money fields for non-admin viewers (admin rows
    // pass through untouched — byte-identical for the hub/cash surfaces).
    return res.status(200).json({ jobs: enriched.map(j => redactJobForViewer(j, me.role)) });
  }

  // POST ?action=duplicate&id=<jobId> — copy a job's structure into a NEW
  // draft (#190). Fresh ids + clean state by construction: the mapper strips
  // ids/state/archived entries and the payload runs through the SAME
  // validators as create. Nothing operational is carried (no assignment,
  // evidence, snags, ITPs, hours, history).
  if (req.method === 'POST' && (req.query && req.query.action) === 'duplicate') {
    // role-literal-ok: duplication mints a job — same deliberate literal-admin gate as CREATE below
    if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const sourceId = String((req.query && req.query.id) || '');
    if (!sourceId) return res.status(400).json({ error: 'id required' });
    const source = data.jobs.find(j => j && j.id === sourceId);
    if (!source) return res.status(404).json({ error: 'job not found' });

    // Unique "<name> (copy[ n])" whose slug doesn't collide.
    let name = null;
    let jobId = null;
    for (let attempt = 1; attempt <= 50 && !jobId; attempt++) {
      const candidate = copyName(source.name, attempt);
      const slug = slugify(candidate);
      if (slug && !data.jobs.find(j => j && j.id === slug)) {
        name = candidate;
        jobId = slug;
      }
    }
    if (!jobId) return res.status(409).json({ error: 'could not find a free copy name' });

    const p = buildDuplicatePayload(source);
    const parsedGroups = validateAreaGroups(p.areaGroups, 'areaGroups');
    if (!parsedGroups.ok) return res.status(500).json({ error: 'duplicate mapping failed: ' + parsedGroups.error });
    const ri = validateTasks(p.roughInTasks, 'rt');
    if (!ri.ok) return res.status(500).json({ error: 'duplicate mapping failed: ' + ri.error });
    const fo = validateTasks(p.fitOffTasks, 'ft');
    if (!fo.ok) return res.status(500).json({ error: 'duplicate mapping failed: ' + fo.error });
    let parsedCf = [];
    if (p.customFields !== undefined) {
      const cf = validateCustomFields(p.customFields, 'customFields');
      if (!cf.ok) return res.status(500).json({ error: 'duplicate mapping failed: ' + cf.error });
      parsedCf = cf.fields;
    }
    const basics = validateJobBasics(p);
    if (!basics.ok) return res.status(500).json({ error: 'duplicate mapping failed: ' + basics.error });

    const job = {
      id: jobId,
      name,
      clientUserId: null,
      type: p.type || null,
      areaGroups: parsedGroups.groups,
      roughInTasks: ri.tasks,
      fitOffTasks: fo.tasks,
      status: 'draft',
      modules: sanitizeModules(p.modules),
      customFields: parsedCf,
      ...basics.patch,
      createdAt: new Date().toISOString(),
    };
    data.jobs.push(job);
    await writeBlob('jobs.json', data);
    await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
    await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
    await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
    // J8 — best-effort structure dual-write of the duplicated job (Blob authoritative).
    await mirrorJobToPg(jobId);
    await appendAudit(jobId, {
      byUserId: me.id,
      byUsername: me.username || me.id,
      kind: 'duplicated',
      summary: `Duplicated from ${source.id} (${source.name})`,
    }).catch(() => {});
    return res.status(200).json({ job: { ...projectJobStructure(job), modules: effectiveModules(job) } });
  }

  // POST — create (admin only)
  if (req.method === 'POST') {
    // role-literal-ok: job CREATE is deliberately literal-admin (documented in src/lib/auth/permissions.ts + /v2/jobs/new) — widening is a product decision
    if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    // The validation + construction + seed writes live in the shared
    // createJob lib (api/_lib/job-create.js) so won-quote conversion
    // (api/quotes.js handleConvert, #244) writes jobs through THE SAME
    // sanctioned path — there is no second raw writeBlob('jobs.json') job
    // writer anywhere. slugify / sanitizeModules / validateJobBasics are the
    // canonical copies in this module, passed in so they have one definition.
    const result = await createJob(data, req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const job = result.job;
    // #581: record Job Builder job creation in the canonical audit journal —
    // best-effort after the write, so a journal failure never affects the create.
    await appendAuditLog(
      buildJobCreatedEntry({ actor: me, job, source: 'builder' }),
    ).catch(() => {});
    return res.status(200).json({ job: { ...projectJobStructure(job), modules: effectiveModules(job) } });
  }

  // PUT — update (patch): admin OR leadingHand on that job (restricted fields)
  if (req.method === 'PUT') {
    const {
      id, name, clientUserId, type, areaGroups, status, roughInTasks, fitOffTasks,
      // Polish (brief §13 prereq): contract + claims fields drive
      // the Cash & margin rollup. Admin-only writable (per-role
      // gate runs below alongside name/type/status).
      contractValue, labourEstimate, materialEstimate,
      claimedToDate, paidToDate, oldestClaimDays,
      // #228: client + contract context — admin-only, never field-visible
      // (stripped by job-redaction.js for non-admin reads).
      clientReference, contractNotes,
      // Per-job module flags (rigidity audit R1). Admin-only.
      modules,
      // Custom fields on the Job (rigidity audit R3). Admin or LH writable.
      customFields,
      // #200: scope of work — ordered items, admin-tier writable, LH
      // read-only (redaction layer), never in field/client payloads.
      scopeOfWork,
      // Job Basics (audit C-1 / M-2 / M-3 / L-4). Admin / LH writable —
      // site address + access notes are field-needed information, LH
      // should be able to fix typos on site.
      ref, serviceM8JobId,
      siteAddress, accessNotes, parkingNotes,
      siteContactName, siteContactPhone,
      safetyNotes, inductionRequired,
      startDate, dueDate, programmedDurationDays,
    } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const job = data.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    // Permission: admin OR leadingHand on this specific job
    if (!canManageJob(me, id)) return res.status(403).json({ error: 'forbidden' });

    // Snapshot the fields we'll audit before any mutation runs. We compare
    // shallow values (name, status, type, clientUserId, modules, custom-
    // fields length, area-group count, task count) — enough to produce a
    // useful "renamed", "archived 2 areas", "tasks +1/-0" entry without
    // bloating the audit blob with full JSON diffs.
    const _before = {
      name: job.name,
      status: job.status,
      type: job.type,
      clientUserId: job.clientUserId,
      modulesJson: JSON.stringify(effectiveModules(job)),
      customFieldsLen: (job.customFields || []).length,
      areaGroupsCount: (job.areaGroups || []).length,
      areasCount: (job.areaGroups || []).reduce((s, g) => s + ((g.areas || []).length), 0),
      areasArchivedCount: (job.areaGroups || []).reduce((s, g) =>
        s + ((g.areas || []).filter(a => a.archived).length) + (g.archived ? 1 : 0), 0),
      roughInTasksCount: (job.roughInTasks || []).length,
      fitOffTasksCount:  (job.fitOffTasks  || []).length,
      // Basics — tracked so the audit can show "address changed" etc.
      basicsJson: JSON.stringify({
        ref: job.ref || '', siteAddress: job.siteAddress || '',
        startDate: job.startDate || '', dueDate: job.dueDate || '',
        siteContactName: job.siteContactName || '',
        siteContactPhone: job.siteContactPhone || '',
        inductionRequired: !!job.inductionRequired,
      }),
    };

    // leadingHand may only patch areaGroups, roughInTasks, fitOffTasks, clientUserId.
    // Tier-aware so every LH alias (lh / leadinghand / leading-hand) is held to
    // the restriction — a literal 'leadingHand' check let an aliased LH (who
    // still passes canManageJob) edit money + module fields.
    if (isLeadingHandRole(me.role)) {
      if (name !== undefined || type !== undefined || status !== undefined ||
          contractValue !== undefined || labourEstimate !== undefined ||
          materialEstimate !== undefined || claimedToDate !== undefined ||
          paidToDate !== undefined || oldestClaimDays !== undefined ||
          clientReference !== undefined || contractNotes !== undefined ||
          modules !== undefined || scopeOfWork !== undefined) {
        return res.status(403).json({ error: 'leadingHand cannot change job money, module or scope fields' });
      }
    }

    // Module flags — admin-only patch (LH check above blocks LH). Merge
    // over the existing set so a partial PUT doesn't wipe other modules.
    if (modules !== undefined) {
      job.modules = sanitizeModules({ ...effectiveModules(job), ...modules });
    }

    // Custom fields — full replacement. Caller sends the new array (or
    // an empty array to clear). Validated as a whole; partial-merge is
    // a UI concern, not API responsibility.
    if (customFields !== undefined) {
      const cf = validateCustomFields(customFields, 'customFields');
      if (!cf.ok) return res.status(400).json({ error: cf.error });
      job.customFields = cf.fields;
    }

    // #200: scope of work — full-array replacement, validated as a whole
    // (the customFields precedent). Order is normalised server-side so
    // reorders can't leave collisions; empty array clears honestly.
    if (scopeOfWork !== undefined) {
      const sw = validateScopeOfWork(scopeOfWork);
      if (!sw.ok) return res.status(400).json({ error: sw.error });
      job.scopeOfWork = sw.items;
    }

    // Job Basics — assign any of the validated fields the caller provided.
    // Field-by-field so a PUT with just { id, siteAddress: '...' } only
    // touches that one slot.
    const basicsPatch = validateJobBasics(req.body || {});
    if (!basicsPatch.ok) return res.status(400).json({ error: basicsPatch.error });
    Object.assign(job, basicsPatch.patch);

    // Polish (brief §13 prereq): contract + claims numeric fields.
    // null clears; numbers persist. Negative values rejected.
    const moneyFields = { contractValue, labourEstimate, materialEstimate,
                          claimedToDate, paidToDate, oldestClaimDays };
    for (const [k, v] of Object.entries(moneyFields)) {
      if (v === undefined) continue;
      if (v === null) { delete job[k]; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: `${k} must be a non-negative number or null` });
      }
      job[k] = n;
    }

    // #228: client + contract text — admin-only (LH blocked above). Trimmed
    // (trim keeps internal newlines); empty/null clears the field.
    if (clientReference !== undefined) {
      const v = clientReference === null ? '' : String(clientReference).trim();
      if (v === '') delete job.clientReference;
      else job.clientReference = v.slice(0, 200);
    }
    if (contractNotes !== undefined) {
      const v = contractNotes === null ? '' : String(contractNotes).trim();
      if (v === '') delete job.contractNotes;
      else job.contractNotes = v.slice(0, 4000);
    }

    if (name !== undefined) {
      if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name must be a non-empty string' });
      job.name = name.trim();
    }
    if (clientUserId !== undefined) job.clientUserId = clientUserId || null;
    if (status !== undefined) {
      // #383: any string used to become a job status (the deleted legacy
      // builder offered 'paused'); one out-of-enum row breaks strict list
      // parsers. Transition RULES stay with #349 — this is the enum gate.
      if (!VALID_JOB_STATUS.has(status)) {
        return res.status(400).json({
          error: 'status must be one of: ' + [...VALID_JOB_STATUS].join(', '),
        });
      }
      job.status = status;
    }

    if (type !== undefined) {
      if (type !== null) {
        const jtData = await readBlob('job-types.json', { jobTypes: [] });
        const typeExists = (jtData.jobTypes || []).some(t => t.id === type);
        if (!typeExists) return res.status(400).json({ error: 'type not found in job-types.json' });
      }
      job.type = type;
    }

    if (areaGroups !== undefined) {
      const parsed = validateAreaGroups(areaGroups, 'areaGroups');
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      // Merge: preserve existing ids for groups/areas already on the job,
      // only generate new ids for newly-added entries (matched by name).
      // Also preserve per-area override task IDs so renaming a task doesn't
      // erase recorded progress (same name → same id).
      const existingGroupsByName = {};
      for (const eg of (job.areaGroups || [])) {
        existingGroupsByName[eg.name] = eg;
      }
      const preserveTaskIds = (existingArr, newArr) => {
        if (!Array.isArray(newArr) || !newArr.length) return undefined;
        const byName = {};
        for (const t of (existingArr || [])) byName[t.name] = t;
        return newArr.map(t => ({
          id: (byName[t.name] && byName[t.name].id) ? byName[t.name].id : t.id,
          name: t.name,
        }));
      };
      // Carry server-owned structural metadata (#578). archived state, sort
      // `order` and `customFields` are NOT part of the editable structure the
      // builder round-trips, so the remap (which rebuilds each entry) must
      // preserve them or the PUT silently drops them. Prefer the (validated)
      // payload value, else the stored entry. Note: a structure PUT can never
      // silently UN-archive — un/re-archive is the bulk-edit path's job — so a
      // matched entry that is archived on disk stays archived.
      const carryMeta = (out, payloadEntry, existingEntry) => {
        const arch = (payloadEntry && payloadEntry.archived) ? payloadEntry
          : (existingEntry && existingEntry.archived) ? existingEntry : null;
        if (arch) {
          out.archived = true;
          if (arch.archivedAt) out.archivedAt = arch.archivedAt;
          if (arch.archivedBy) out.archivedBy = arch.archivedBy;
        }
        const order = (payloadEntry && typeof payloadEntry.order === 'number') ? payloadEntry.order
          : (existingEntry && typeof existingEntry.order === 'number') ? existingEntry.order : undefined;
        if (typeof order === 'number' && Number.isFinite(order)) out.order = order;
        const cf = (payloadEntry && payloadEntry.customFields !== undefined) ? payloadEntry.customFields
          : (existingEntry ? existingEntry.customFields : undefined);
        if (cf !== undefined) out.customFields = cf;
        return out;
      };

      job.areaGroups = parsed.groups.map(g => {
        const existing = existingGroupsByName[g.name];
        const groupId = (existing && existing.id) ? existing.id : g.id;
        const existingAreasByName = {};
        for (const ea of (existing ? existing.areas : [])) {
          existingAreasByName[ea.name] = ea;
        }
        const payloadAreaNames = new Set(g.areas.map(a => a.name));
        const areas = g.areas.map(a => {
          const ea = existingAreasByName[a.name];
          const out = { id: (ea && ea.id) ? ea.id : a.id, name: a.name };
          if (a.spaceType) out.spaceType = a.spaceType;
          // Per-area overrides: preserve task ids by name where possible.
          const newRough = preserveTaskIds(ea && ea.roughInTasks, a.roughInTasks);
          if (newRough && newRough.length) out.roughInTasks = newRough;
          const newFit = preserveTaskIds(ea && ea.fitOffTasks, a.fitOffTasks);
          if (newFit && newFit.length) out.fitOffTasks = newFit;
          return carryMeta(out, a, ea);
        });
        // Retention (#578): an ARCHIVED area the payload omits is NOT a delete —
        // the builder freezes + strips areaGroups for jobs with archived
        // structure, so it can't send them; a direct PUT must not destroy them.
        // Re-append archived stored areas the payload didn't carry, intact.
        if (existing) {
          for (const ea of (existing.areas || [])) {
            if (ea && ea.archived && !payloadAreaNames.has(ea.name)) areas.push(ea);
          }
        }
        return carryMeta({ id: groupId, name: g.name, areas }, g, existing);
      });

      // Retention (#578): re-append ARCHIVED stored groups the payload omitted,
      // intact — same reasoning as archived areas above.
      {
        const payloadGroupNames = new Set(parsed.groups.map(g => g.name));
        for (const eg of Object.values(existingGroupsByName)) {
          if (eg && eg.archived && !payloadGroupNames.has(eg.name)) job.areaGroups.push(eg);
        }
      }

      // Invariant guard at the PERSISTED-OUTPUT boundary, not just the incoming
      // payload. The name-based id remap above reuses an existing area's id for
      // every input area matched by name, so two input areas that share a name
      // collapse onto ONE id even when the SUBMITTED ids were distinct (and so
      // passed validateAreaGroups). Re-run the SAME live-area-id uniqueness check
      // on the FINAL job.areaGroups before writeBlob and reject (400, no write)
      // if the merge produced a duplicate — the whole Phil + task-state stack
      // keys on a unique live areaId (dwellings[areaId], /api/task-toggle target,
      // the Phil area selector's first-match find, the canonical task index).
      const dupAfterRemap = findDuplicateLiveAreaId(job.areaGroups);
      if (dupAfterRemap) {
        return res.status(400).json({ error: `areaGroups duplicate live area id after merge: ${dupAfterRemap}` });
      }
    }

    // Patch roughInTasks — preserve existing IDs for tasks matched by name
    if (roughInTasks !== undefined) {
      const v = validateTasks(roughInTasks, 'rt');
      if (!v.ok) return res.status(400).json({ error: v.error });
      const existingByName = {};
      for (const t of (job.roughInTasks || [])) existingByName[t.name] = t;
      job.roughInTasks = v.tasks.map(t => ({
        id: (existingByName[t.name] && existingByName[t.name].id) ? existingByName[t.name].id : t.id,
        name: t.name,
      }));
    }

    // Patch fitOffTasks — preserve existing IDs for tasks matched by name
    if (fitOffTasks !== undefined) {
      const v = validateTasks(fitOffTasks, 'ft');
      if (!v.ok) return res.status(400).json({ error: v.error });
      const existingByName = {};
      for (const t of (job.fitOffTasks || [])) existingByName[t.name] = t;
      job.fitOffTasks = v.tasks.map(t => ({
        id: (existingByName[t.name] && existingByName[t.name].id) ? existingByName[t.name].id : t.id,
        name: t.name,
      }));
    }

    await writeBlob('jobs.json', data);

    // J8 — best-effort structure dual-write of the edited job (Blob authoritative;
    // dark behind supabase_dual_write_jobs; never throws into this handler).
    await mirrorJobToPg(job.id);

    // Audit log (rigidity audit R5). One entry per meaningful field
    // change. Fire-and-forget — a logging failure must never block the
    // response or roll back the mutation.
    try {
      const _now = {
        name: job.name,
        status: job.status,
        type: job.type,
        clientUserId: job.clientUserId,
        modulesJson: JSON.stringify(effectiveModules(job)),
        customFieldsLen: (job.customFields || []).length,
        areaGroupsCount: (job.areaGroups || []).length,
        areasCount: (job.areaGroups || []).reduce((s, g) => s + ((g.areas || []).length), 0),
        areasArchivedCount: (job.areaGroups || []).reduce((s, g) =>
          s + ((g.areas || []).filter(a => a.archived).length) + (g.archived ? 1 : 0), 0),
        roughInTasksCount: (job.roughInTasks || []).length,
        fitOffTasksCount:  (job.fitOffTasks  || []).length,
        basicsJson: JSON.stringify({
          ref: job.ref || '', siteAddress: job.siteAddress || '',
          startDate: job.startDate || '', dueDate: job.dueDate || '',
          siteContactName: job.siteContactName || '',
          siteContactPhone: job.siteContactPhone || '',
          inductionRequired: !!job.inductionRequired,
        }),
      };
      const audits = [];
      if (_before.name !== _now.name) {
        audits.push({ kind: 'rename', summary: `Renamed "${_before.name}" → "${_now.name}"`, before: _before.name, after: _now.name });
      }
      if (_before.status !== _now.status) {
        audits.push({ kind: 'status', summary: `Status ${_before.status || 'active'} → ${_now.status || 'active'}` });
      }
      if (_before.type !== _now.type) {
        audits.push({ kind: 'type', summary: `Type ${_before.type || '—'} → ${_now.type || '—'}` });
      }
      if (_before.clientUserId !== _now.clientUserId) {
        audits.push({ kind: 'client', summary: `Client link ${_before.clientUserId || '—'} → ${_now.clientUserId || '—'}` });
      }
      if (_before.modulesJson !== _now.modulesJson) {
        audits.push({ kind: 'modules', summary: 'Module flags changed', before: JSON.parse(_before.modulesJson), after: JSON.parse(_now.modulesJson) });
      }
      if (_before.customFieldsLen !== _now.customFieldsLen) {
        audits.push({ kind: 'custom-fields', summary: `Custom fields ${_before.customFieldsLen} → ${_now.customFieldsLen}` });
      }
      const areaDelta = _now.areasCount - _before.areasCount;
      const grpDelta  = _now.areaGroupsCount - _before.areaGroupsCount;
      const archDelta = _now.areasArchivedCount - _before.areasArchivedCount;
      if (areaDelta !== 0 || grpDelta !== 0 || archDelta !== 0) {
        const bits = [];
        if (grpDelta)  bits.push(`${grpDelta > 0 ? '+' : ''}${grpDelta} area group${Math.abs(grpDelta) === 1 ? '' : 's'}`);
        if (areaDelta) bits.push(`${areaDelta > 0 ? '+' : ''}${areaDelta} area${Math.abs(areaDelta) === 1 ? '' : 's'}`);
        if (archDelta) bits.push(`${archDelta > 0 ? '+' : ''}${archDelta} archived`);
        audits.push({ kind: 'structure', summary: bits.join(' · ') });
      }
      const rDelta = _now.roughInTasksCount - _before.roughInTasksCount;
      const fDelta = _now.fitOffTasksCount  - _before.fitOffTasksCount;
      if (rDelta !== 0) audits.push({ kind: 'rough-tasks', summary: `Rough-in tasks ${_before.roughInTasksCount} → ${_now.roughInTasksCount}` });
      if (fDelta !== 0) audits.push({ kind: 'fit-tasks',   summary: `Fit-off tasks ${_before.fitOffTasksCount} → ${_now.fitOffTasksCount}` });
      if (_before.basicsJson !== _now.basicsJson) {
        audits.push({
          kind: 'basics',
          summary: 'Updated job basics (address / dates / contact / safety)',
          before: JSON.parse(_before.basicsJson),
          after: JSON.parse(_now.basicsJson),
        });
      }
      for (const a of audits) {
        await appendAudit(job.id, {
          byUserId: me.id, byUsername: me.username,
          kind: a.kind, summary: a.summary,
          before: a.before, after: a.after,
        });
      }
    } catch (e) { console.warn('job audit write failed', e); }

    // PUT mutations should return the *complete* server-side view so
    // admin editors get archived rows back too — they want to see what
    // they just archived. Mobile-facing GETs filter via the default.
    return res.status(200).json({ job: { ...projectJobStructure(job, { includeArchived: true }), modules: effectiveModules(job) } });
  }

  // DELETE — remove an automated QA/test job (admin only).
  //
  // Deliberately NARROW: this is test-data hygiene, not a general job
  // delete. The guard (api/_lib/test-data.js) refuses anything whose name
  // lacks a QA prefix (SMOKE_TEST_/STRESS_TEST_/QA_SEED_) — real jobs are
  // never deletable through this path; archive them instead. Only
  // explicitly parked (draft) or archived jobs are accepted — anything
  // else (active/complete/on_hold/missing status) is still field-visible
  // per the GET list gate above, which also protects the one
  // allowed-Active fixture QA_SEED_FIELD_ACTIVE_JOB the field smoke
  // depends on. See docs/testing/Test-Data-Rules.md.
  //
  // Removes the jobs.json row plus the canonical per-job blobs
  // (jobs/<id>/data.json, tags.json, audit.json) best-effort. Generated
  // smoke jobs never get other per-job blobs (the smoke is non-mutating
  // beyond the builder round-trip), and ids may linger in users.json
  // assignedJobIds — consumers resolve against the live jobs list, so a
  // dangling id is inert. No cascade beyond that is attempted or implied.
  //
  // Accepts ONE id or a comma-separated batch (`?id=a,b,c`). The batch
  // form exists because back-to-back single deletes are not safe with
  // this storage model: each request is a read-modify-write of the whole
  // jobs.json, and a follow-up request can land on another function
  // instance whose read (cached up to BLOB_TTL_MS, plus Vercel Blob's
  // multi-second post-put propagation lag — see writeBlob in _lib/blob.js)
  // predates the previous write, silently resurrecting the just-deleted
  // row. A batch is ONE read and ONE write, so the cleanup card sends a
  // single request no matter how many parked test jobs it clears.
  if (req.method === 'DELETE') {
    // role-literal-ok: job DELETE (test-data purge) is deliberately literal-admin, mirroring the create gate
    if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const ids = String(id).split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'id required' });

    const refusalMessage = (job, eligibility) => {
      if (!job) return 'job not found';
      return eligibility.reason === 'live'
        ? 'job is still live — park it to draft (unpublish) before deleting'
        : 'only automated test jobs (SMOKE_TEST_ / STRESS_TEST_ / QA_SEED_) can be deleted';
    };

    const deletable = [];
    const refused = [];
    for (const one of ids) {
      const job = data.jobs.find(j => j.id === one);
      const eligibility = job ? testJobDeleteEligibility(job) : { ok: false };
      if (job && eligibility.ok) deletable.push(job);
      else refused.push({ id: one, error: refusalMessage(job, eligibility) });
    }

    // Single-id callers keep the original strict contract (404 unknown,
    // 400 ineligible, 200 { ok, deletedId }) so curl/scripted use stays
    // simple. The batch form reports per-id outcomes instead of failing
    // the whole request because one id was already gone.
    if (ids.length === 1 && refused.length === 1) {
      const status = refused[0].error === 'job not found' ? 404 : 400;
      return res.status(status).json({ error: refused[0].error });
    }

    if (deletable.length > 0) {
      const dropIds = new Set(deletable.map(j => j.id));
      data.jobs = data.jobs.filter(j => !dropIds.has(j.id));
      await writeBlob('jobs.json', data);

      // Per-job blobs are unreachable once the rows are gone; sweep the
      // known keys best-effort (deleteBlob already swallows + logs
      // failures). Sweeping after the single jobs.json write keeps the
      // jobs document the only read-modify-write in the request.
      for (const job of deletable) {
        await deleteBlob(`jobs/${job.id}/data.json`);
        await deleteBlob(`jobs/${job.id}/tags.json`);
        await deleteBlob(`jobs/${job.id}/audit.json`);
      }

      // The per-job audit blob dies with the job, so the deletion itself is
      // logged to the function output only — enough to trace who removed
      // test data without keeping a tombstone store for it.
      for (const job of deletable) {
        console.log(`test job deleted: ${job.id} ("${job.name}") by ${me.username || me.id}`);
      }
    }

    if (ids.length === 1) {
      return res.status(200).json({ ok: true, deletedId: ids[0] });
    }
    return res.status(200).json({
      ok: true,
      deleted: deletable.map(j => j.id),
      refused,
    });
  }

  res.status(405).end();
};
