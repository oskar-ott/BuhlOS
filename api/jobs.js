const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser, canManageJob } = require('./_lib/auth');
const { validateAreaGroups, validateTasks } = require('./_lib/validation');
const { areaProgressPct } = require('./_lib/job-tasks');

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Aggregate job-level stats. Uses the shared `areaProgressPct` helper so
// per-area custom checklists are respected — an area with its own
// rough-in / fit-off list contributes its own pct to the job average,
// not a stat derived from the (possibly-different) job-level defaults.
// Areas with no applicable checklist (no override, no defaults) are
// excluded from the average — they don't pull the number down to 0%.
//
// Snags counted as those with status === 'Open'.
// Returns { pct, openSnags, areaCount }. pct is null for jobs with no areas.
function computeJobStats(job, data) {
  const dwellings = (data && data.dwellings) || {};
  const snags     = (data && data.snags)     || [];
  const groups    = (job && job.areaGroups)  || [];
  const areas = groups.flatMap(g => (g.areas || []));
  const areaCount = areas.length;
  let pct = null;
  if (areaCount) {
    let sum = 0, counted = 0;
    for (const a of areas) {
      const p = areaProgressPct(job, a, dwellings);
      if (p == null) continue;
      sum += p; counted++;
    }
    if (counted) pct = Math.round(sum / counted);
  }
  const openSnags = snags.filter(s => s && s.status === 'Open').length;
  return { pct, openSnags, areaCount };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const data = await readBlob('jobs.json', { jobs: [] });
  data.jobs = data.jobs || [];

  // GET — list or single
  if (req.method === 'GET') {
    const { id } = req.query || {};
    if (id) {
      const job = data.jobs.find(j => j.id === id);
      if (!job) return res.status(404).json({ error: 'job not found' });
      const canSee =
        me.role === 'admin' ||
        (me.assignedJobIds || []).includes(id) ||
        (me.role === 'client' && job.clientUserId === me.id);
      if (!canSee) return res.status(403).json({ error: 'forbidden' });
      return res.status(200).json({ job });
    }
    let visible;
    if (me.role === 'admin') {
      visible = data.jobs;
    } else if (me.role === 'client') {
      visible = data.jobs.filter(j => j.clientUserId === me.id);
    } else {
      visible = data.jobs.filter(j => (me.assignedJobIds || []).includes(j.id));
    }
    // Enrich with human-readable type name (cheap lookup; small list).
    // Clients/tradies can't read /api/job-types, so resolve server-side.
    let typeMap = {};
    if (visible.some(j => j.type)) {
      const jt = await readBlob('job-types.json', { jobTypes: [] });
      (jt.jobTypes || []).forEach(t => { typeMap[t.id] = t.name; });
    }
    let enriched = visible.map(j => (
      j.type && typeMap[j.type] ? { ...j, typeName: typeMap[j.type] } : j
    ));

    // Optional stats enrichment — used by the /jobs list page so users can scan
    // progress + open-snag count without drilling in. Opt-in via ?withStats=1
    // (one blob read per job; fine for the list-view scale).
    if (req.query && req.query.withStats === '1') {
      // Cheap: load users.json once for crew-count tally.
      let crewCountByJob = {};
      try {
        const usersBlob = await readBlob('users.json', { users: [] });
        (usersBlob.users || []).forEach(u => {
          if (u.role === 'tradie' || u.role === 'leadingHand') {
            (u.assignedJobIds || []).forEach(jid => {
              crewCountByJob[jid] = (crewCountByJob[jid] || 0) + 1;
            });
          }
        });
      } catch (e) { /* tolerate missing */ }

      // Tag-expiry totals come from per-job tags.json. Parse dd/mm/yyyy and
      // count expired (already past) + soon (≤14 days). One extra blob read
      // per job; acceptable for the list-view scale.
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

      enriched = await Promise.all(enriched.map(async j => {
        try {
          const [d, tagsBlob] = await Promise.all([
            readBlob(`jobs/${j.id}/data.json`, { dwellings: {}, snags: [] }),
            readBlob(`jobs/${j.id}/tags.json`, { tags: [] }).catch(() => ({ tags: [] })),
          ]);
          const stats = computeJobStats(j, d);
          let expiredTags = 0, expiringTags = 0;
          for (const t of (tagsBlob.tags || [])) {
            const ms = parseDDMM(t.expiryDate);
            if (!Number.isFinite(ms)) continue;
            if (ms < todayMs) expiredTags++;
            else if (ms <= cutoffMs) expiringTags++;
          }
          return Object.assign({}, j, {
            statsPct:          stats.pct,
            statsOpenSnags:    stats.openSnags,
            statsCrewCount:    crewCountByJob[j.id] || 0,
            statsAreaCount:    stats.areaCount,
            statsExpiredTags:  expiredTags,
            statsExpiringTags: expiringTags,
          });
        } catch (e) {
          // Fail soft — caller still gets the core job, stats just absent.
          return Object.assign({}, j, {
            statsPct: null, statsOpenSnags: 0,
            statsCrewCount: crewCountByJob[j.id] || 0,
            statsAreaCount: 0,
            statsExpiredTags: 0, statsExpiringTags: 0,
          });
        }
      }));
    }

    return res.status(200).json({ jobs: enriched });
  }

  // POST — create (admin only)
  if (req.method === 'POST') {
    if (me.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { name, id, clientUserId, type, areaGroups, roughInTasks, fitOffTasks } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const jobId = slugify(id || name);
    if (!jobId) return res.status(400).json({ error: 'invalid id' });
    if (data.jobs.find(j => j.id === jobId))
      return res.status(400).json({ error: 'job id already exists' });

    // Validate type if provided
    if (type) {
      const jtData = await readBlob('job-types.json', { jobTypes: [] });
      const typeExists = (jtData.jobTypes || []).some(t => t.id === type);
      if (!typeExists) return res.status(400).json({ error: 'type not found in job-types.json' });
    }

    // Validate areaGroups if provided
    let parsedGroups = [];
    if (areaGroups !== undefined) {
      const parsed = validateAreaGroups(areaGroups, 'areaGroups');
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      parsedGroups = parsed.groups;
    }

    // Validate task lists if provided
    let parsedRoughIn = [];
    if (roughInTasks !== undefined) {
      const v = validateTasks(roughInTasks, 'rt');
      if (!v.ok) return res.status(400).json({ error: v.error });
      parsedRoughIn = v.tasks;
    }
    let parsedFitOff = [];
    if (fitOffTasks !== undefined) {
      const v = validateTasks(fitOffTasks, 'ft');
      if (!v.ok) return res.status(400).json({ error: v.error });
      parsedFitOff = v.tasks;
    }

    const job = {
      id: jobId,
      name,
      clientUserId: clientUserId || null,
      type: type || null,
      areaGroups: parsedGroups,
      roughInTasks: parsedRoughIn,
      fitOffTasks: parsedFitOff,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    data.jobs.push(job);
    await writeBlob('jobs.json', data);
    await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
    await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
    await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
    // Legacy jobs/<id>/hours.json no longer seeded — hours live in
    // users/<userId>/time-entries/<date>.json (per-user, per-day).
    return res.status(200).json({ job });
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
    } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const job = data.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    // Permission: admin OR leadingHand on this specific job
    if (!canManageJob(me, id)) return res.status(403).json({ error: 'forbidden' });

    // leadingHand may only patch areaGroups, roughInTasks, fitOffTasks, clientUserId
    if (me.role === 'leadingHand') {
      if (name !== undefined || type !== undefined || status !== undefined ||
          contractValue !== undefined || labourEstimate !== undefined ||
          materialEstimate !== undefined || claimedToDate !== undefined ||
          paidToDate !== undefined || oldestClaimDays !== undefined) {
        return res.status(403).json({ error: 'leadingHand cannot change job money fields' });
      }
    }

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

    if (name !== undefined) {
      if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name must be a non-empty string' });
      job.name = name.trim();
    }
    if (clientUserId !== undefined) job.clientUserId = clientUserId || null;
    if (status !== undefined) job.status = status;

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
      job.areaGroups = parsed.groups.map(g => {
        const existing = existingGroupsByName[g.name];
        const groupId = (existing && existing.id) ? existing.id : g.id;
        const existingAreasByName = {};
        for (const ea of (existing ? existing.areas : [])) {
          existingAreasByName[ea.name] = ea;
        }
        const areas = g.areas.map(a => {
          const ea = existingAreasByName[a.name];
          const out = { id: (ea && ea.id) ? ea.id : a.id, name: a.name };
          if (a.spaceType) out.spaceType = a.spaceType;
          // Per-area overrides: preserve task ids by name where possible.
          const newRough = preserveTaskIds(ea && ea.roughInTasks, a.roughInTasks);
          if (newRough && newRough.length) out.roughInTasks = newRough;
          const newFit = preserveTaskIds(ea && ea.fitOffTasks, a.fitOffTasks);
          if (newFit && newFit.length) out.fitOffTasks = newFit;
          return out;
        });
        return { id: groupId, name: g.name, areas };
      });
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
    return res.status(200).json({ job });
  }

  res.status(405).end();
};
