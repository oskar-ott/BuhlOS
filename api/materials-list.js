// Materials Takeoff / Order List + Wholesaler Pricing Email — Phase 1.
//
// Job-scoped materials list. Each job has its own materials-list.json with
// items + saved email request drafts. Used inside Admin Job Setup to build
// a materials list from the plans and generate a clean pricing email.
//
//   GET    /api/materials-list?jobId=<id>                  → list items + drafts
//   POST   /api/materials-list?jobId=<id>                  → add item
//                                                            body: item shape (see below)
//   POST   /api/materials-list?jobId=<id>&action=bulk-add  → add many items from parsed list
//                                                            body: { lines: ["40 x Twin GPO", ...] }
//   PATCH  /api/materials-list?jobId=<id>&id=<itemId>      → update item
//   DELETE /api/materials-list?jobId=<id>&id=<itemId>      → remove item
//   POST   /api/materials-list?jobId=<id>&action=email     → save email draft
//                                                            body: { wholesalerName, recipientEmail, subject, body, itemIds[] }
//
// Permissions:
//   admin:        full access
//   leadingHand:  full on managed jobs (canManageJob)
//   tradie:       read on jobs they're on
//   client:       403
//
// Storage: jobs/<jobId>/materials-list.json — { items: [...], emailRequests: [...] }

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

const VALID_STATUSES = ['draft', 'ready_to_price', 'priced', 'ordered', 'received', 'cancelled'];

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function readList(jobId) {
  return await readBlob('jobs/' + jobId + '/materials-list.json', { items: [], emailRequests: [] });
}
async function writeList(jobId, data) {
  await writeBlob('jobs/' + jobId + '/materials-list.json', data);
}

// Parse a free-text bulk-add line into a partial item. Tolerant; missing
// fields stay empty. Recognised patterns:
//   "40 x Twin GPO"
//   "40 x Twin GPO - Clipsal Iconic"
//   "250m x 2.5mm TPS"
function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  // Try "<qty><unit>? x <name> [- <spec>]"
  // qty: number; unit: trailing letters of qty token (m, mm, etc.)
  const m = raw.match(/^([\d.]+)\s*([a-zA-Z]*)\s*[x×]\s*(.+)$/i);
  if (m) {
    const qty = parseFloat(m[1]) || 0;
    const unit = (m[2] || '').toLowerCase() || 'each';
    let rest = m[3].trim();
    let spec = '';
    const dashIdx = rest.indexOf(' - ');
    if (dashIdx > 0) { spec = rest.slice(dashIdx + 3).trim(); rest = rest.slice(0, dashIdx).trim(); }
    return { name: rest, brandOrSpec: spec, quantity: qty, unit };
  }
  // Fallback: whole line is the item name with qty=1
  return { name: raw, brandOrSpec: '', quantity: 1, unit: 'each' };
}

function buildItem(body, user) {
  const now = new Date().toISOString();
  return {
    id:            newId('mat'),
    jobId:         body.jobId || null,
    name:          body.name ? String(body.name).trim() : '',
    description:   body.description ? String(body.description).trim() : '',
    brandOrSpec:   body.brandOrSpec ? String(body.brandOrSpec).trim() : '',
    category:      body.category ? String(body.category).trim() : 'Other',
    subcategory:   body.subcategory ? String(body.subcategory).trim() : '',
    quantity:      body.quantity != null ? Number(body.quantity) : 1,
    unit:          body.unit ? String(body.unit).trim() : 'each',
    drawingRef:    body.drawingRef ? String(body.drawingRef).trim() : '',
    level:         body.level ? String(body.level).trim() : '',
    area:          body.area ? String(body.area).trim() : '',
    notes:         body.notes ? String(body.notes).trim() : '',
    status:        body.status && VALID_STATUSES.includes(body.status) ? body.status : 'draft',
    quotedUnitPrice: body.quotedUnitPrice != null ? Number(body.quotedUnitPrice) : null,
    quotedTotal:     body.quotedTotal != null ? Number(body.quotedTotal) : null,
    selectedWholesaler: body.selectedWholesaler ? String(body.selectedWholesaler).trim() : '',
    quoteStatus:        body.quoteStatus ? String(body.quoteStatus).trim() : '',
    createdAt:     now,
    createdBy:     user.username,
    updatedAt:     now,
  };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const action = (req.query && req.query.action) || '';

  if (req.method === 'GET') {
    const isCrew = (user.assignedJobIds || []).includes(jobId);
    if (user.role !== 'admin' && !canManageJob(user, jobId) && !isCrew) {
      return res.status(403).json({ error: 'no access to this job' });
    }
    const data = await readList(jobId);
    return res.status(200).json(data);
  }

  // Mutations require manager-level access.
  if (!canManageJob(user, jobId) && user.role !== 'admin') {
    return res.status(403).json({ error: 'cannot manage this job' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    if (action === 'bulk-add') {
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (!lines.length) return res.status(400).json({ error: 'no lines provided' });
      const data = await readList(jobId);
      data.items = data.items || [];
      const created = [];
      for (const raw of lines) {
        const parsed = parseLine(raw);
        if (!parsed) continue;
        const item = buildItem({
          ...parsed,
          jobId,
          category: body.category || 'Other',
          level: body.level || '',
          drawingRef: body.drawingRef || '',
        }, user);
        data.items.push(item);
        created.push(item);
      }
      await writeList(jobId, data);
      return res.status(201).json({ items: created });
    }

    if (action === 'email') {
      if (!body.subject || !body.body) {
        return res.status(400).json({ error: 'subject and body required' });
      }
      const data = await readList(jobId);
      data.emailRequests = data.emailRequests || [];
      const request = {
        id:              newId('req'),
        createdAt:       new Date().toISOString(),
        createdBy:       user.username,
        wholesalerName:  body.wholesalerName ? String(body.wholesalerName).trim() : '',
        recipientEmail:  body.recipientEmail ? String(body.recipientEmail).trim() : '',
        subject:         String(body.subject),
        body:            String(body.body),
        itemIds:         Array.isArray(body.itemIds) ? body.itemIds : [],
        status:          'draft',
      };
      data.emailRequests.push(request);
      await writeList(jobId, data);
      return res.status(201).json({ request });
    }

    // Default POST: add single item
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const data = await readList(jobId);
    data.items = data.items || [];
    const item = buildItem({ ...body, jobId }, user);
    data.items.push(item);
    await writeList(jobId, data);
    return res.status(201).json({ item });
  }

  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readList(jobId);
    const idx = (data.items || []).findIndex(i => i.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    const editable = ['name', 'description', 'brandOrSpec', 'category', 'subcategory',
                      'quantity', 'unit', 'drawingRef', 'level', 'area', 'notes',
                      'quotedUnitPrice', 'quotedTotal', 'selectedWholesaler', 'quoteStatus'];
    for (const k of editable) {
      if (body[k] !== undefined) data.items[idx][k] = body[k];
    }
    if (body.status && VALID_STATUSES.includes(body.status)) data.items[idx].status = body.status;
    data.items[idx].updatedAt = new Date().toISOString();
    await writeList(jobId, data);
    return res.status(200).json({ item: data.items[idx] });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readList(jobId);
    const before = (data.items || []).length;
    data.items = (data.items || []).filter(i => i.id !== id);
    if (data.items.length === before) return res.status(404).json({ error: 'not found' });
    await writeList(jobId, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
