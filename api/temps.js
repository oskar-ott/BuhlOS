// Temps / Temporary Tools tracking — Phase 1.
//
// Storage:
//   temps/assets.json                    → global asset register
//   jobs/<jobId>/temps.json              → per-job deployment ledger
//   temps/movements.json                 → flat movement history (last 1000)
//
// Actions (single endpoint, action-based routing):
//   GET  /api/temps                            → list global assets (admin/LH/tradie)
//   POST /api/temps                            → create new asset (admin only)
//   PATCH /api/temps?id=<assetId>              → edit asset (admin only)
//   DELETE /api/temps?id=<assetId>             → retire asset (admin; soft — sets status=retired)
//
//   GET  /api/temps?action=for-job&jobId=X     → list deployments for one job
//   POST /api/temps?action=deploy              → deploy asset to a job
//   POST /api/temps?action=return              → return a deployed item
//   POST /api/temps?action=report              → report missing / damaged
//   GET  /api/temps?action=history&id=<assetId>→ movement history for an asset
//   GET  /api/temps?action=summary             → admin overview counts
//
// Data shapes — see top-of-file comments next to each helper.
//
// Permissions:
//   admin       — everything
//   leadingHand — read all, deploy/return/report on assigned jobs
//   tradie      — read all (so they can find gear), report-only writes
//   client      — 403 (Temps is internal)
//
// Role gating is done after auth; deploy/return/report further check
// canManageJob() against the target jobId.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

const ASSETS_KEY    = 'temps/assets.json';
const MOVEMENTS_KEY = 'temps/movements.json';
const MAX_MOVEMENTS = 1000;

const VALID_ASSET_STATUSES = ['available', 'deployed', 'returned', 'missing', 'damaged', 'repair', 'retired'];
const VALID_LOCATION_TYPES = ['workshop', 'vehicle', 'job', 'user', 'repair', 'missing', 'retired'];
const VALID_DEPLOYMENT_STATUSES = ['deployed', 'due_soon', 'overdue', 'returned', 'missing', 'damaged'];

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Old per-job temps had shape { temps: [{ id, type, location, loggedBy, date, photoUrl }] }
// or, due to a bug in the prior POST handler, sometimes just a single object.
// Migrate-on-read: convert legacy entries to the new deployment shape so
// existing data isn't lost. Idempotent.
function migrateLegacyJobTemps(jobId, blob) {
  if (!blob) return { deployments: [] };
  if (Array.isArray(blob.deployments)) return blob; // already new shape
  // Legacy: { temps: [...] }
  if (Array.isArray(blob.temps)) {
    const deployments = blob.temps.map(t => ({
      id:                   t.id || newId('dep'),
      tempItemId:           null, // legacy entries weren't linked to a global asset
      assetCode:            '',
      name:                 t.type || 'Temp item',
      category:             t.type || 'Other',
      jobId:                jobId,
      locationOnSite:       t.location || '',
      deployedAt:           t.createdAt || (t.date ? legacyDateToIso(t.date) : new Date().toISOString()),
      deployedBy:           t.loggedBy || '',
      deployedByUserId:     null,
      expectedReturnDate:   null,
      returnedAt:           null,
      returnedBy:           null,
      status:               'deployed',
      conditionOut:         'good',
      conditionReturn:      null,
      notes:                '',
      photoUrls:            t.photoUrl ? [t.photoUrl] : [],
    }));
    return { deployments };
  }
  // Single-object junk from the broken POST — wrap in deployments array.
  if (blob.type || blob.location) {
    return migrateLegacyJobTemps(jobId, { temps: [blob] });
  }
  return { deployments: [] };
}

function legacyDateToIso(s) {
  // Old format: 'dd/mm/yyyy'
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return new Date().toISOString();
  return new Date(+m[3], +m[2] - 1, +m[1]).toISOString();
}

async function readAssets() {
  return await readBlob(ASSETS_KEY, { items: [] });
}
async function writeAssets(data) {
  await writeBlob(ASSETS_KEY, data);
}

async function readJobDeployments(jobId) {
  const raw = await readBlob('jobs/' + jobId + '/temps.json', null);
  return migrateLegacyJobTemps(jobId, raw);
}
async function writeJobDeployments(jobId, data) {
  await writeBlob('jobs/' + jobId + '/temps.json', data);
}

async function appendMovement(mv) {
  const data = await readBlob(MOVEMENTS_KEY, { movements: [] });
  data.movements = data.movements || [];
  data.movements.push({ ...mv, id: mv.id || newId('mov') });
  // Trim from the front so the file doesn't grow unbounded. Old movements
  // can still be reconstructed from job deployment records if needed.
  if (data.movements.length > MAX_MOVEMENTS) {
    data.movements = data.movements.slice(-MAX_MOVEMENTS);
  }
  await writeBlob(MOVEMENTS_KEY, data);
}

// ── Handlers ─────────────────────────────────────────────────────────────

async function handleListAssets(req, res, user) {
  const data = await readAssets();
  // Filter retired by default unless ?includeRetired=1
  const includeRetired = req.query && req.query.includeRetired === '1';
  let items = data.items || [];
  if (!includeRetired) items = items.filter(i => i.status !== 'retired');
  return res.status(200).json({ items });
}

async function handleCreateAsset(req, res, user) {
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const body = req.body || {};
  const errors = [];
  if (!body.assetCode || !String(body.assetCode).trim()) errors.push('assetCode required');
  if (!body.name      || !String(body.name).trim())      errors.push('name required');
  if (!body.category  || !String(body.category).trim())  errors.push('category required');
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const data = await readAssets();
  data.items = data.items || [];
  if (data.items.find(i => String(i.assetCode).toLowerCase() === String(body.assetCode).trim().toLowerCase())) {
    return res.status(409).json({ error: 'asset code already exists' });
  }
  const now = new Date().toISOString();
  const item = {
    id:                   newId('temp'),
    assetCode:            String(body.assetCode).trim(),
    name:                 String(body.name).trim(),
    category:             String(body.category).trim(),
    description:          body.description ? String(body.description).trim() : '',
    serialNumber:         body.serialNumber ? String(body.serialNumber).trim() : '',
    testTagId:            body.testTagId ? String(body.testTagId).trim() : '',
    purchaseDate:         body.purchaseDate || '',
    purchaseCost:         body.purchaseCost != null ? Number(body.purchaseCost) : null,
    dailyCostRate:        body.dailyCostRate != null ? Number(body.dailyCostRate) : null,
    status:               'available',
    currentLocationType:  body.currentLocationType && VALID_LOCATION_TYPES.includes(body.currentLocationType) ? body.currentLocationType : 'workshop',
    currentLocationLabel: body.currentLocationLabel ? String(body.currentLocationLabel).trim() : 'Workshop',
    currentJobId:         null,
    assignedToUserId:     null,
    lastSeenAt:           now,
    condition:            body.condition || 'good',
    notes:                body.notes ? String(body.notes).trim() : '',
    createdAt:            now,
    createdBy:            user.username,
  };
  data.items.push(item);
  await writeAssets(data);
  await appendMovement({
    tempItemId:        item.id,
    action:            'created',
    fromLocationType:  null,
    fromLocationLabel: null,
    toLocationType:    item.currentLocationType,
    toLocationLabel:   item.currentLocationLabel,
    jobId:             null,
    userId:            user.id,
    userName:          user.username,
    timestamp:         now,
    notes:             '',
  });
  return res.status(201).json({ item });
}

async function handleUpdateAsset(req, res, user) {
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = req.body || {};
  const data = await readAssets();
  const idx = (data.items || []).findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  // Whitelist editable fields — status/location/job/assignedTo are managed
  // by the deploy/return flows, not raw edits.
  const editable = ['assetCode', 'name', 'category', 'description', 'serialNumber',
                    'testTagId', 'purchaseDate', 'purchaseCost', 'dailyCostRate',
                    'condition', 'notes'];
  for (const k of editable) if (body[k] !== undefined) data.items[idx][k] = body[k];
  // Allow admin to manually set status/location for fixing data state.
  if (body.status && VALID_ASSET_STATUSES.includes(body.status)) data.items[idx].status = body.status;
  if (body.currentLocationType && VALID_LOCATION_TYPES.includes(body.currentLocationType)) {
    data.items[idx].currentLocationType = body.currentLocationType;
  }
  if (body.currentLocationLabel) data.items[idx].currentLocationLabel = body.currentLocationLabel;
  data.items[idx].updatedAt = new Date().toISOString();
  await writeAssets(data);
  return res.status(200).json({ item: data.items[idx] });
}

async function handleRetireAsset(req, res, user) {
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = await readAssets();
  const idx = (data.items || []).findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  // Soft delete — keep the asset for history but mark retired.
  data.items[idx].status = 'retired';
  data.items[idx].currentLocationType = 'retired';
  data.items[idx].currentLocationLabel = 'Retired';
  data.items[idx].currentJobId = null;
  const now = new Date().toISOString();
  data.items[idx].updatedAt = now;
  await writeAssets(data);
  await appendMovement({
    tempItemId:        id,
    action:            'retired',
    fromLocationType:  null,
    fromLocationLabel: null,
    toLocationType:    'retired',
    toLocationLabel:   'Retired',
    jobId:             null,
    userId:            user.id,
    userName:          user.username,
    timestamp:         now,
    notes:             '',
  });
  return res.status(200).json({ ok: true });
}

async function handleListJobDeployments(req, res, user) {
  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const blob = await readJobDeployments(jobId);
  // Compute due/overdue server-side so all clients agree on the day's state.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  // Only admins + LHs see cost data per the brief — "Do not expose cost
  // rates to tradies or clients." We enrich with dailyCostRate +
  // computed days-onsite + accruedCost for those roles only.
  const showCost = user.role === 'admin' || user.role === 'leadingHand';
  let assetsById = {};
  if (showCost) {
    try {
      const assetsBlob = await readAssets();
      for (const a of (assetsBlob.items || [])) assetsById[a.id] = a;
    } catch { /* tolerate */ }
  }

  const enriched = (blob.deployments || []).map(d => {
    let derived;
    if (d.status === 'deployed') {
      const due = d.expectedReturnDate ? Date.parse(d.expectedReturnDate + 'T00:00:00') : NaN;
      if (Number.isFinite(due)) {
        const days = Math.floor((due - todayMs) / (24 * 60 * 60 * 1000));
        if (days < 0)         derived = { derivedStatus: 'overdue', daysToDue: days };
        else if (days <= 3)   derived = { derivedStatus: 'due_soon', daysToDue: days };
        else                  derived = { derivedStatus: 'deployed', daysToDue: days };
      } else {
        derived = { derivedStatus: 'deployed', daysToDue: null };
      }
    } else {
      derived = {};
    }
    // Cost enrichment: days × rate. Returned deployments use returnedAt;
    // active ones use today.
    let cost = {};
    if (showCost) {
      const asset = assetsById[d.tempItemId];
      const rate = asset && Number.isFinite(Number(asset.dailyCostRate)) ? Number(asset.dailyCostRate) : 0;
      if (rate > 0 && d.deployedAt) {
        const start = Date.parse(d.deployedAt);
        const end = d.returnedAt ? Date.parse(d.returnedAt) : Date.now();
        if (Number.isFinite(start) && Number.isFinite(end)) {
          const days = Math.max(0, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
          cost = { dailyCostRate: rate, daysOnSite: days, accruedCost: Math.round(rate * days * 100) / 100 };
        } else {
          cost = { dailyCostRate: rate, daysOnSite: 0, accruedCost: 0 };
        }
      }
    }
    return { ...d, ...derived, ...cost };
  });
  return res.status(200).json({ deployments: enriched });
}

async function handleDeploy(req, res, user) {
  const body = req.body || {};
  const jobId = body.jobId || (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!canManageJob(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot deploy to this job' });
  }
  if (!body.tempItemId) return res.status(400).json({ error: 'tempItemId required' });

  const assetsBlob = await readAssets();
  const asset = (assetsBlob.items || []).find(i => i.id === body.tempItemId);
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  if (asset.status === 'retired') return res.status(409).json({ error: 'cannot deploy retired item' });
  if (asset.status === 'deployed') return res.status(409).json({ error: 'item already deployed — return it first' });
  if ((asset.status === 'missing' || asset.status === 'damaged' || asset.status === 'repair') && user.role !== 'admin') {
    return res.status(409).json({ error: 'item is ' + asset.status + ' — admin override required' });
  }

  const now = new Date().toISOString();
  const deployment = {
    id:                 newId('dep'),
    tempItemId:         asset.id,
    assetCode:          asset.assetCode,
    name:               asset.name,
    category:           asset.category,
    jobId:              jobId,
    locationOnSite:     body.locationOnSite ? String(body.locationOnSite).trim() : '',
    deployedAt:         now,
    deployedBy:         user.username,
    deployedByUserId:   user.id,
    expectedReturnDate: body.expectedReturnDate || null,
    returnedAt:         null,
    returnedBy:         null,
    status:             'deployed',
    conditionOut:       body.conditionOut || asset.condition || 'good',
    conditionReturn:    null,
    notes:              body.notes ? String(body.notes).trim() : '',
    photoUrls:          Array.isArray(body.photoUrls) ? body.photoUrls : [],
  };

  const jobBlob = await readJobDeployments(jobId);
  jobBlob.deployments = jobBlob.deployments || [];
  jobBlob.deployments.push(deployment);
  await writeJobDeployments(jobId, jobBlob);

  // Update asset status + location
  const assetIdx = assetsBlob.items.findIndex(i => i.id === asset.id);
  const fromType = asset.currentLocationType;
  const fromLabel = asset.currentLocationLabel;
  assetsBlob.items[assetIdx].status               = 'deployed';
  assetsBlob.items[assetIdx].currentLocationType  = 'job';
  assetsBlob.items[assetIdx].currentLocationLabel = deployment.locationOnSite || ('Job: ' + jobId);
  assetsBlob.items[assetIdx].currentJobId         = jobId;
  assetsBlob.items[assetIdx].lastSeenAt           = now;
  assetsBlob.items[assetIdx].updatedAt            = now;
  await writeAssets(assetsBlob);

  await appendMovement({
    tempItemId:        asset.id,
    action:            'deployed',
    fromLocationType:  fromType,
    fromLocationLabel: fromLabel,
    toLocationType:    'job',
    toLocationLabel:   deployment.locationOnSite || ('Job: ' + jobId),
    jobId:             jobId,
    userId:            user.id,
    userName:          user.username,
    timestamp:         now,
    notes:             deployment.notes,
  });

  return res.status(201).json({ deployment });
}

async function handleReturn(req, res, user) {
  const body = req.body || {};
  const jobId = body.jobId || (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!body.deploymentId) return res.status(400).json({ error: 'deploymentId required' });
  if (!canManageJob(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot return from this job' });
  }

  const jobBlob = await readJobDeployments(jobId);
  const idx = (jobBlob.deployments || []).findIndex(d => d.id === body.deploymentId);
  if (idx < 0) return res.status(404).json({ error: 'deployment not found' });
  const dep = jobBlob.deployments[idx];
  if (dep.status !== 'deployed') {
    return res.status(409).json({ error: 'deployment is already ' + dep.status });
  }

  const now = new Date().toISOString();
  const conditionReturn = body.conditionReturn || 'good';
  const returnLocationType  = body.returnLocationType  && VALID_LOCATION_TYPES.includes(body.returnLocationType)
    ? body.returnLocationType : 'workshop';
  const returnLocationLabel = body.returnLocationLabel
    ? String(body.returnLocationLabel).trim()
    : (returnLocationType === 'workshop' ? 'Workshop' : returnLocationType.charAt(0).toUpperCase() + returnLocationType.slice(1));

  jobBlob.deployments[idx] = {
    ...dep,
    status:          'returned',
    returnedAt:      now,
    returnedBy:      user.username,
    conditionReturn: conditionReturn,
    notes:           body.notes ? String(body.notes).trim() : dep.notes,
  };
  await writeJobDeployments(jobId, jobBlob);

  // Update asset status + location
  if (dep.tempItemId) {
    const assetsBlob = await readAssets();
    const aIdx = (assetsBlob.items || []).findIndex(i => i.id === dep.tempItemId);
    if (aIdx >= 0) {
      // If returned damaged or to repair, reflect that in asset status.
      const newStatus = conditionReturn === 'damaged' ? 'damaged'
                      : returnLocationType === 'repair' ? 'repair'
                      : 'available';
      assetsBlob.items[aIdx].status               = newStatus;
      assetsBlob.items[aIdx].currentLocationType  = returnLocationType;
      assetsBlob.items[aIdx].currentLocationLabel = returnLocationLabel;
      assetsBlob.items[aIdx].currentJobId         = null;
      assetsBlob.items[aIdx].condition            = conditionReturn;
      assetsBlob.items[aIdx].lastSeenAt           = now;
      assetsBlob.items[aIdx].updatedAt            = now;
      await writeAssets(assetsBlob);
    }
  }

  await appendMovement({
    tempItemId:        dep.tempItemId,
    action:            'returned',
    fromLocationType:  'job',
    fromLocationLabel: dep.locationOnSite || ('Job: ' + jobId),
    toLocationType:    returnLocationType,
    toLocationLabel:   returnLocationLabel,
    jobId:             jobId,
    userId:            user.id,
    userName:          user.username,
    timestamp:         now,
    notes:             body.notes ? String(body.notes).trim() : '',
  });

  return res.status(200).json({ deployment: jobBlob.deployments[idx] });
}

async function handleReport(req, res, user) {
  const body = req.body || {};
  const jobId = body.jobId || (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!body.deploymentId) return res.status(400).json({ error: 'deploymentId required' });
  if (!body.reason) return res.status(400).json({ error: 'reason required (missing|damaged|other)' });
  // Reports are open to anyone with read access — even tradies. Server-side
  // canManageJob isn't required because this is a status flag, not a write
  // to job-config; we still gate to crew (no clients).
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const jobBlob = await readJobDeployments(jobId);
  const idx = (jobBlob.deployments || []).findIndex(d => d.id === body.deploymentId);
  if (idx < 0) return res.status(404).json({ error: 'deployment not found' });
  const dep = jobBlob.deployments[idx];

  const now = new Date().toISOString();
  const newStatus = body.reason === 'missing' ? 'missing'
                  : body.reason === 'damaged' ? 'damaged'
                  : dep.status; // 'other' keeps current status, just notes
  jobBlob.deployments[idx] = {
    ...dep,
    status:           newStatus,
    notes:            (dep.notes ? dep.notes + ' · ' : '') + 'Reported ' + body.reason +
                      (body.notes ? ': ' + String(body.notes).trim() : '') +
                      ' by ' + user.username + ' at ' + now,
  };
  await writeJobDeployments(jobId, jobBlob);

  // Update asset status if linked
  if (dep.tempItemId && (newStatus === 'missing' || newStatus === 'damaged')) {
    const assetsBlob = await readAssets();
    const aIdx = (assetsBlob.items || []).findIndex(i => i.id === dep.tempItemId);
    if (aIdx >= 0) {
      assetsBlob.items[aIdx].status    = newStatus;
      assetsBlob.items[aIdx].lastSeenAt = now;
      assetsBlob.items[aIdx].updatedAt  = now;
      await writeAssets(assetsBlob);
    }
  }

  await appendMovement({
    tempItemId:        dep.tempItemId,
    action:            'reported_' + body.reason,
    fromLocationType:  null,
    fromLocationLabel: null,
    toLocationType:    null,
    toLocationLabel:   null,
    jobId:             jobId,
    userId:            user.id,
    userName:          user.username,
    timestamp:         now,
    notes:             body.notes ? String(body.notes).trim() : '',
  });

  return res.status(200).json({ deployment: jobBlob.deployments[idx] });
}

async function handleHistory(req, res, user) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = await readBlob(MOVEMENTS_KEY, { movements: [] });
  const filtered = (data.movements || [])
    .filter(m => m.tempItemId === id)
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return res.status(200).json({ movements: filtered });
}

async function handleSummary(req, res, user) {
  const data = await readAssets();
  const items = (data.items || []).filter(i => i.status !== 'retired');
  const counts = { total: items.length, available: 0, deployed: 0, missing: 0, damaged: 0, repair: 0, dueSoon: 0, overdue: 0 };
  for (const i of items) {
    if (i.status === 'available') counts.available++;
    else if (i.status === 'deployed') counts.deployed++;
    else if (i.status === 'missing') counts.missing++;
    else if (i.status === 'damaged') counts.damaged++;
    else if (i.status === 'repair') counts.repair++;
  }
  // Walk every deployed asset's current job to compute due/overdue.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  for (const i of items) {
    if (i.status !== 'deployed' || !i.currentJobId) continue;
    try {
      const jb = await readJobDeployments(i.currentJobId);
      const dep = (jb.deployments || []).find(d => d.tempItemId === i.id && d.status === 'deployed');
      if (!dep || !dep.expectedReturnDate) continue;
      const dueMs = Date.parse(dep.expectedReturnDate + 'T00:00:00');
      if (!Number.isFinite(dueMs)) continue;
      const days = Math.floor((dueMs - todayMs) / (24 * 60 * 60 * 1000));
      if (days < 0) counts.overdue++;
      else if (days <= 3) counts.dueSoon++;
    } catch { /* tolerate */ }
  }
  return res.status(200).json({ counts });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') {
    if (action === 'for-job')  return handleListJobDeployments(req, res, user);
    if (action === 'history')  return handleHistory(req, res, user);
    if (action === 'summary')  return handleSummary(req, res, user);
    return handleListAssets(req, res, user);
  }
  if (req.method === 'POST') {
    if (action === 'deploy') return handleDeploy(req, res, user);
    if (action === 'return') return handleReturn(req, res, user);
    if (action === 'report') return handleReport(req, res, user);
    return handleCreateAsset(req, res, user);
  }
  if (req.method === 'PATCH')  return handleUpdateAsset(req, res, user);
  if (req.method === 'DELETE') return handleRetireAsset(req, res, user);

  return res.status(405).json({ error: 'method not allowed' });
};
