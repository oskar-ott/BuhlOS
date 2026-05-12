const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, getCurrentUser, canManageJob } = require('./_lib/auth');
const { validateAreaGroups, validateTasks, validateCustomFields, visibleStructural } = require('./_lib/validation');
const { areaProgressPct } = require('./_lib/job-tasks');
const { appendAudit } = require('./_lib/job-audit');

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
      // Hydrate modules + filter archived structural items unless the
      // caller passes ?includeArchived=1 (admin editor only). Mobile +
      // tradie surfaces see the live structure; archived rooms / tasks
      // disappear from their lists without ever being deleted (rigidity
      // audit R2 — archive is the universal "remove" verb).
      const includeArchived = req.query && req.query.includeArchived === '1';
      const cleaned = projectJobStructure(job, { includeArchived });
      return res.status(200).json({ job: { ...cleaned, modules: effectiveModules(job) } });
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
    // Listing surface filters archived structural items by default.
    // The admin job-list page doesn't need them; if a future surface
    // does it can opt in (?includeArchived=1) like the single-job GET.
    const includeArchivedList = req.query && req.query.includeArchived === '1';
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
    const { name, id, clientUserId, type, areaGroups, roughInTasks, fitOffTasks, modules, customFields } = req.body || {};
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

    // Custom fields on the Job itself (rigidity audit R3). Optional.
    let parsedCustomFields = [];
    if (customFields !== undefined) {
      const cf = validateCustomFields(customFields, 'customFields');
      if (!cf.ok) return res.status(400).json({ error: cf.error });
      parsedCustomFields = cf.fields;
    }

    // Per-job module flags (rigidity audit R1). Lets a "rewire pub"
    // hide concepts it doesn't need (switchboards, temps, ITPs) and a
    // 14-storey fitout keep them. Defaults to "everything on" so existing
    // jobs and any caller that doesn't know about modules keeps current
    // behaviour. Unknown keys are dropped; values coerced to boolean.
    const job = {
      id: jobId,
      name,
      clientUserId: clientUserId || null,
      type: type || null,
      areaGroups: parsedGroups,
      roughInTasks: parsedRoughIn,
      fitOffTasks: parsedFitOff,
      status: 'active',
      modules: sanitizeModules(modules),
      customFields: parsedCustomFields,
      createdAt: new Date().toISOString(),
    };
    data.jobs.push(job);
    await writeBlob('jobs.json', data);
    await writeBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [], notes: [] });
    await writeBlob(`jobs/${jobId}/tags.json`, { tags: [] });
    await writeBlob(`jobs/${jobId}/temps.json`, { temps: [] });
    // Legacy jobs/<id>/hours.json no longer seeded — hours live in
    // users/<userId>/time-entries/<date>.json (per-user, per-day).
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
      // Per-job module flags (rigidity audit R1). Admin-only.
      modules,
      // Custom fields on the Job (rigidity audit R3). Admin or LH writable.
      customFields,
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
    };

    // leadingHand may only patch areaGroups, roughInTasks, fitOffTasks, clientUserId
    if (me.role === 'leadingHand') {
      if (name !== undefined || type !== undefined || status !== undefined ||
          contractValue !== undefined || labourEstimate !== undefined ||
          materialEstimate !== undefined || claimedToDate !== undefined ||
          paidToDate !== undefined || oldestClaimDays !== undefined ||
          modules !== undefined) {
        return res.status(403).json({ error: 'leadingHand cannot change job money or module fields' });
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

  res.status(405).end();
};
