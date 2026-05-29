// Cross-job materials summary for admin / leading hand.
//
//   GET /api/materials-summary
//
// Walks every visible active job's materials-list.json and aggregates
// "what's outstanding across the business right now": items by status,
// purchase orders by status, and a per-job row of the same numbers so
// the operations dashboard can flag the busiest job.
//
// Why this exists:
//   /api/materials-list answers "what's the materials state on THIS
//   job". Daniel also wants the all-jobs answer — "do I have any POs
//   not yet sent? are there items still pending that should have been
//   ordered last week?". This rolls it up in one call.
//
// Response shape:
//   {
//     asOf,
//     jobsWithMaterials: N,
//     items:  { total, pending, ordered, received, cancelled },
//     purchaseOrders: { total, draft, sent, confirmed,
//                       partial, fulfilled, cancelled },
//     byJob: [{ jobId, jobName,
//               itemsTotal, itemsPending, itemsOrdered, itemsReceived,
//               poCount, poOpen }]
//   }
//
//   `poOpen` = sent + confirmed + partial — POs out in the wild but not
//   yet fully delivered. The number admins glance at for "anything
//   stuck?".
//
// Permissions:
//   - admin: all active jobs
//   - leadingHand: their assigned active jobs only
//   - everyone else: 403
//
// Cost: 1 jobs.json read + N per-job materials-list.json reads in
// parallel. Bounded by active-job count, not item or PO count.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');

const ITEM_STATUSES = ['pending', 'ordered', 'received', 'cancelled'];
const PO_STATUSES   = ['draft', 'sent', 'confirmed', 'partial', 'fulfilled', 'cancelled'];
const PO_OPEN       = new Set(['sent', 'confirmed', 'partial']);

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  const active   = allJobs.filter(j => (j.status || 'active') === 'active');

  const visible = (me.role === 'admin')
    ? active
    : active.filter(j => (me.assignedJobIds || []).includes(j.id));

  // Aggregate buckets.
  const items = Object.fromEntries(ITEM_STATUSES.map(s => [s, 0]));
  items.total = 0;
  const pos = Object.fromEntries(PO_STATUSES.map(s => [s, 0]));
  pos.total = 0;
  const byJob = [];
  let jobsWithMaterials = 0;

  await Promise.all(visible.map(async j => {
    let list;
    try {
      list = await readBlob(`jobs/${j.id}/materials-list.json`, { items: [], purchaseOrders: [] });
    } catch {
      return;
    }
    const jobItems = Array.isArray(list.items)          ? list.items          : [];
    const jobPos   = Array.isArray(list.purchaseOrders) ? list.purchaseOrders : [];

    if (!jobItems.length && !jobPos.length) return;
    jobsWithMaterials++;

    const jobRow = {
      jobId: j.id, jobName: j.name,
      itemsTotal: 0, itemsPending: 0, itemsOrdered: 0, itemsReceived: 0,
      poCount: jobPos.length, poOpen: 0,
    };
    for (const it of jobItems) {
      items.total++;
      jobRow.itemsTotal++;
      const s = ITEM_STATUSES.includes(it.status) ? it.status : 'pending';
      items[s] = (items[s] || 0) + 1;
      if (s === 'pending')  jobRow.itemsPending++;
      if (s === 'ordered')  jobRow.itemsOrdered++;
      if (s === 'received') jobRow.itemsReceived++;
    }
    for (const po of jobPos) {
      pos.total++;
      const s = PO_STATUSES.includes(po.status) ? po.status : 'draft';
      pos[s] = (pos[s] || 0) + 1;
      if (PO_OPEN.has(s)) jobRow.poOpen++;
    }
    byJob.push(jobRow);
  }));

  // Sort byJob: most outstanding work (poOpen + itemsPending) first.
  byJob.sort((a, b) => {
    const ao = a.poOpen + a.itemsPending;
    const bo = b.poOpen + b.itemsPending;
    if (bo !== ao) return bo - ao;
    return (a.jobName || '').localeCompare(b.jobName || '');
  });

  return res.status(200).json({
    asOf: new Date().toISOString(),
    jobsWithMaterials,
    items, purchaseOrders: pos,
    byJob,
  });
};
