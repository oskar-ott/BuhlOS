// Quote labour rate presets (#193) — reusable {loadedCostRate, sellRate} pairs
// the quote builder's labour section can apply to a line.
//
//   GET    /api/quote-rate-presets                 → list LIVE presets (office tier)
//   GET    /api/quote-rate-presets?includeArchived=1 → list incl. archived
//   POST   /api/quote-rate-presets {name, loadedCostRate, sellRate} → create (admin)
//   PUT    /api/quote-rate-presets {id, name?, loadedCostRate?, sellRate?, archived?}
//                                                  → update / archive (admin)
//
// INDEPENDENCE: applying a preset to a quote line SNAPSHOTS its rates onto the
// line (src/domains/quoting/labour-calc.ts applyPresetToLine). Editing or
// archiving a preset here therefore CANNOT change any existing quote line's
// totals — the rate was copied at apply time. Archived presets stay in the
// store (hidden from the default picker) so historical snapshots remain
// meaningful.
//
// Storage: quote-rate-presets.json
//   { presets: [{id, name, loadedCostRate, sellRate, archived, createdAt,
//                createdBy, updatedAt, updatedBy}], updatedAt, updatedBy }
// Listed in the backup manifest (EXACT_STORES).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { nanoid } = require('./_lib/validation');

const STORE_KEY = 'quote-rate-presets.json';
const NAME_MAX = 80;

async function readStore() {
  return readBlob(STORE_KEY, { presets: [] });
}

/** A valid rate is a finite number >= 0. Checked on the RAW body value so that
 *  null / undefined / "" / booleans (which Number() would silently coerce to 0)
 *  are REJECTED, not turned into a free $0 rate (matches policy.js's typeof
 *  guard). Numeric strings are also rejected — rates arrive as JSON numbers. */
function isValidRate(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
}

/** Public projection — drop nothing (all fields are office-safe). */
function publicPreset(p) {
  return {
    id: p.id,
    name: p.name,
    loadedCostRate: p.loadedCostRate,
    sellRate: p.sellRate,
    archived: Boolean(p.archived),
    createdAt: p.createdAt || null,
    createdBy: p.createdBy || null,
    updatedAt: p.updatedAt || null,
    updatedBy: p.updatedBy || null,
  };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Reading presets is office tooling — match policy.js GET (whole office tier).
    const me = await requireAuth(req, res, { roles: ['admin', 'leadingHand', 'office', 'accounts'] });
    if (!me) return;
    const store = await readStore();
    const all = Array.isArray(store.presets) ? store.presets : [];
    const includeArchived = String((req.query && req.query.includeArchived) || '') === '1';
    const rows = (includeArchived ? all : all.filter(p => p && !p.archived)).map(publicPreset);
    return res.status(200).json({ presets: rows });
  }

  if (req.method === 'POST') {
    // Writes are admin-tier only (commercial config), tier-aware via requireAuth.
    const me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length > NAME_MAX) {
      return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });
    }
    if (!isValidRate(body.loadedCostRate)) {
      return res.status(400).json({ error: 'loadedCostRate must be a finite number >= 0' });
    }
    if (!isValidRate(body.sellRate)) {
      return res.status(400).json({ error: 'sellRate must be a finite number >= 0' });
    }
    const loadedCostRate = body.loadedCostRate;
    const sellRate = body.sellRate;

    const store = await readStore();
    if (!Array.isArray(store.presets)) store.presets = [];
    // Uniqueness among LIVE (non-archived) presets only — archiving frees a name.
    if (store.presets.some(p => p && !p.archived && p.name === name)) {
      return res.status(409).json({ error: 'a live preset with that name already exists' });
    }

    const now = new Date().toISOString();
    const preset = {
      id: nanoid('qrp_'),
      name,
      loadedCostRate,
      sellRate,
      archived: false,
      createdAt: now,
      createdBy: me.id,
      updatedAt: now,
      updatedBy: me.id,
    };
    store.presets.push(preset);
    store.updatedAt = now;
    store.updatedBy = me.id;
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(201).json({ preset: publicPreset(preset) });
  }

  if (req.method === 'PUT') {
    const me = await requireAuth(req, res, { roles: ['admin'] });
    if (!me) return;
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });

    const store = await readStore();
    if (!Array.isArray(store.presets)) store.presets = [];
    const preset = store.presets.find(p => p && p.id === id);
    if (!preset) return res.status(404).json({ error: 'preset not found' });

    // Validate provided fields (all optional; absent → unchanged).
    let nextName = preset.name;
    if (body.name !== undefined) {
      const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
      if (!trimmed) return res.status(400).json({ error: 'name required' });
      if (trimmed.length > NAME_MAX) {
        return res.status(400).json({ error: `name must be ${NAME_MAX} characters or fewer` });
      }
      nextName = trimmed;
    }
    let nextLoaded = preset.loadedCostRate;
    if (body.loadedCostRate !== undefined) {
      if (!isValidRate(body.loadedCostRate)) {
        return res.status(400).json({ error: 'loadedCostRate must be a finite number >= 0' });
      }
      nextLoaded = body.loadedCostRate;
    }
    let nextSell = preset.sellRate;
    if (body.sellRate !== undefined) {
      if (!isValidRate(body.sellRate)) {
        return res.status(400).json({ error: 'sellRate must be a finite number >= 0' });
      }
      nextSell = body.sellRate;
    }
    let nextArchived = Boolean(preset.archived);
    if (body.archived !== undefined) nextArchived = Boolean(body.archived);

    // Re-check name uniqueness among OTHER live presets. A preset being archived
    // in this same call is not "live", so its name no longer collides.
    if (!nextArchived && store.presets.some(p => p && p.id !== id && !p.archived && p.name === nextName)) {
      return res.status(409).json({ error: 'a live preset with that name already exists' });
    }

    const now = new Date().toISOString();
    // Editing a preset NEVER touches a quote line — independence is enforced by
    // snapshot-on-use in labour-calc.ts (rates are copied onto the line at apply
    // time). This handler only mutates the preset record itself.
    preset.name = nextName;
    preset.loadedCostRate = nextLoaded;
    preset.sellRate = nextSell;
    preset.archived = nextArchived;
    preset.updatedAt = now;
    preset.updatedBy = me.id;
    store.updatedAt = now;
    store.updatedBy = me.id;
    try {
      await writeBlob(STORE_KEY, store);
    } catch (e) {
      return res.status(502).json({ error: 'write failed: ' + (e.message || 'unknown') });
    }
    return res.status(200).json({ preset: publicPreset(preset) });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
