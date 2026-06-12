// Worker licences & tickets (#331) — the per-worker credential register the
// office maintains. Current tickets are the licence to operate (electrical
// licence, white card, EWP, heights, first aid, driver); an expired one must
// surface BEFORE the site audit does.
//
//   GET    /api/licences?mine=1     → own records (any signed-in worker)
//   GET    /api/licences            → all records (admin tier)
//   GET    /api/licences?userId=X   → one worker's records (admin tier)
//   POST   /api/licences            → add  { userId, typeId, label?, number?,
//            licenceClass?, notes?, issueDate?, expiryDate? }   (admin tier)
//   PUT    /api/licences            → update { id, ...same fields }  (admin)
//   DELETE /api/licences?id=        → remove (admin tier)
//
// Every response row carries computed { status, daysToExpiry } from the ONE
// shared engine (api/_lib/licence-compliance.js) so chips, drawer, Phil and
// the alert cron can never disagree. Dates are strict ISO and validated at
// WRITE — this store never inherits the tags register's silent NaN-drops.
// Records are keyed by users.json userId (the session identity); archived /
// disabled workers keep their records (audit trail) but never alert.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isClientRole } = require('./_lib/auth');
const { append: appendAuditLog } = require('./_lib/audit-log');
const {
  LICENCE_TYPES,
  parseIsoDay,
  licenceStatusFor,
  worstStatusByUser,
} = require('./_lib/licence-compliance');

const KEY = 'workforce/credentials.json';
const WITHIN_DAYS = 60;

function newId() {
  return 'cred_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readCredentials() {
  const data = await readBlob(KEY, { credentials: [] });
  return Array.isArray(data.credentials) ? data : { credentials: [] };
}

function withStatus(record, now) {
  const { status, daysToExpiry } = licenceStatusFor(record.expiryDate, {
    now,
    withinDays: WITHIN_DAYS,
  });
  return { ...record, status, daysToExpiry };
}

/** Validate + normalise the writable fields. Returns { error } or { fields }. */
function parseFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.typeId !== undefined) {
    const type = LICENCE_TYPES.find(t => t.id === body.typeId);
    if (!type) {
      return { error: 'typeId must be one of: ' + LICENCE_TYPES.map(t => t.id).join(', ') };
    }
    out.typeId = type.id;
    // Label frozen at write: known types get the canonical label; 'other'
    // needs the office to say what the ticket is.
    if (type.id === 'other') {
      const label = String(body.label || '').trim();
      if (!label) return { error: 'label is required for type "other"' };
      out.label = label.slice(0, 80);
    } else {
      out.label = type.label;
    }
  }
  for (const [field, max] of [['number', 80], ['licenceClass', 80], ['notes', 500]]) {
    if (body[field] !== undefined) {
      const v = body[field] === null ? null : String(body[field]).trim().slice(0, max) || null;
      out[field] = v;
    }
  }
  for (const field of ['issueDate', 'expiryDate']) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === '') {
        out[field] = null; // explicit "doesn't expire" / unknown issue date
      } else {
        if (!Number.isFinite(parseIsoDay(body[field]))) {
          return { error: field + ' must be a real date in YYYY-MM-DD form' };
        }
        out[field] = String(body[field]);
      }
    }
  }
  return { fields: out };
}

async function audit(user, action, record) {
  // PII discipline: type label + worker, never the licence number.
  await appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId: null,
    targetType: 'credential',
    targetId: record.id,
    summary: `${action.split('.')[1]} ${record.label} for ${record.userName || record.userId}`,
    metadata: { userId: record.userId, typeId: record.typeId, expiryDate: record.expiryDate || null },
  }).catch(() => {});
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await requireAuth(req, res);
  if (!me) return;
  if (isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const now = new Date();

  if (req.method === 'GET') {
    const data = await readCredentials();
    // Self view first: no userId parameter on this path — the session IS the
    // identity, so a field worker can never read a colleague's records.
    if (req.query && req.query.mine === '1') {
      return res.status(200).json({
        credentials: data.credentials.filter(c => c.userId === me.id).map(c => withStatus(c, now)),
        types: LICENCE_TYPES,
        withinDays: WITHIN_DAYS,
      });
    }
    if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });
    const userId = req.query && req.query.userId;
    const list = userId ? data.credentials.filter(c => c.userId === userId) : data.credentials;
    return res.status(200).json({
      credentials: list.map(c => withStatus(c, now)),
      types: LICENCE_TYPES,
      withinDays: WITHIN_DAYS,
      // Register chips: worst status per worker, computed by the ONE engine
      // (renewals collapse — an old expired ticket superseded by its renewal
      // never flags the worker).
      worstByUser: worstStatusByUser(data.credentials, { now, withinDays: WITHIN_DAYS }),
    });
  }

  // All writes are office-tier (v1: workers read, the office maintains).
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.userId) return res.status(400).json({ error: 'userId required' });
    const usersBlob = await readBlob('users.json', { users: [] });
    const target = (usersBlob.users || []).find(u => u.id === body.userId);
    if (!target) return res.status(404).json({ error: 'worker not found' });
    if (isClientRole(target.role)) {
      return res.status(400).json({ error: 'clients do not hold worker licences' });
    }
    const parsed = parseFields(body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const record = {
      id: newId(),
      kind: 'licence', // kind-discriminated store: #336 adds 'training' later
      userId: target.id,
      userName: target.username || target.id,
      number: null,
      licenceClass: null,
      notes: null,
      issueDate: null,
      expiryDate: null,
      ...parsed.fields,
      createdAt: now.toISOString(),
      createdBy: me.id,
      updatedAt: now.toISOString(),
    };
    const data = await readCredentials();
    data.credentials.push(record);
    await writeBlob(KEY, data);
    await audit(me, 'credential.added', record);
    return res.status(201).json({ credential: withStatus(record, now) });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: 'id required' });
    const data = await readCredentials();
    const record = data.credentials.find(c => c.id === body.id);
    if (!record) return res.status(404).json({ error: 'record not found' });
    const parsed = parseFields(body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    Object.assign(record, parsed.fields, { updatedAt: now.toISOString(), updatedBy: me.id });
    await writeBlob(KEY, data);
    await audit(me, 'credential.updated', record);
    return res.status(200).json({ credential: withStatus(record, now) });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readCredentials();
    const idx = data.credentials.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'record not found' });
    const [removed] = data.credentials.splice(idx, 1);
    await writeBlob(KEY, data);
    await audit(me, 'credential.removed', removed);
    return res.status(200).json({ ok: true, removedId: id });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
