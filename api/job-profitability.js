// Per-job profitability (#327, Epic 14). ADMIN-TIER ONLY.
//
//   GET /api/job-profitability?jobId=<id>
//   GET /api/job-profitability?jobId=<id>&format=pdf  → the printable job cost report
//       (api/_lib/job-report-pdf.js): the same figures + every approved day, every
//       confirmed supplier invoice / receipt with its lines, the typed ledger.
//     → { jobId, contractValueCents, labourCostCents, materialCostCents,
//         marginCents, marginPct, completeness, badges, budget, variance,
//         hoursTotal, labourChargeOutCents, chargeOutHours, unratedWorkerRefs, asOf }
//
// Revenue (contractValue) − labour − material, with an honest completeness
// statement. Labour is APPROVED hours costed at the EFFECTIVE-DATED cost rate
// (#304) for the day those hours fall on — a worker with no rate effective on
// an entry's date has those hours EXCLUDED and is named (never a silent 0),
// with the employee record the rate is set on (unratedWorkerRefs) so the card
// can link straight to the fix. The same hours valued at each worker's
// optional CHARGE-OUT rate give labourChargeOutCents — "what is this labour
// worth" (owner ask 2026-08-23), kept separate from cost; null until at least
// one worker on the job carries a charge-out rate.
//
// Material (owner pull 2026-08-23): the per-job materials SPEND ledger
// (api/_lib/job-materials.js) when the job_materials_spend flag is on for the
// viewer and the job has lines → materialSource 'ledger'. Since 2026-09-23
// (owner direction: "cost must reach the job's money figures") CONFIRMED
// supplier-invoice allocations (invoice_capture, Supabase
// supplier_invoice_allocations, active rows only — credit notes negative) are
// added to the same Materials figure: materialSource stays 'ledger' when the
// ledger has lines, is 'invoices' when only invoices carry the figure, and the
// response names the invoice share (`supplierInvoices`) so the card can say
// what the number is made of. Otherwise the legacy received-materials rollup
// (jobs/<id>/materials-list.json — written by a tool the 2026-07 gut deleted,
// so present on no current job) as a labelled proxy, else 'none'. Never a
// fabricated $0; an unreadable invoice store is reported, not silently 0.
//
// Walks the per-user time-entry blobs through the fully paginated helper
// (api/_lib/time-entry-blobs.js, #935) — there is no per-job hours index.
//
// Reconciliation note: this counts APPROVED entries only, at the confidential
// cost rate. The hub's Labour card costs the same entries with the same pure
// effective-date resolution (src/domains/jobs/job-hours.ts costJobHours), so
// the two labour figures agree by construction.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { readCostRates, historyFor, effectiveCostRate } = require('./_lib/cost-rates');
const { computeJobProfitability, buildBudgetLines } = require('./_lib/job-profitability');
const { listTimeEntryBlobs, fetchTimeEntries } = require('./_lib/time-entry-blobs');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { readLedger, summariseLedger } = require('./_lib/job-materials');
const { getDb } = require('./_lib/supabase-db');
const invoiceStore = require('./_lib/invoices/store');
const { buildWorkerLabeller } = require('./_lib/worker-names');
const { composeJobReportPdf } = require('./_lib/job-report-pdf');
const { CATEGORY_LABELS } = require('./_lib/invoices/categories');
const { measureOf, measureTotals } = require('./_lib/invoices/measure');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  const jobId = String((req.query && req.query.jobId) || '');
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const [usersBlob, employeesBlob, ratesData, matsList, ledgerOn, invoicesOn] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('employees.json', { employees: [] }),
    readCostRates(),
    readBlob(`jobs/${jobId}/materials-list.json`, null),
    isFlagEnabled('job_materials_spend', me),
    isFlagEnabled('invoice_capture', me),
  ]);
  const userById = {};
  (usersBlob.users || []).forEach((u) => { userById[u.id] = u; });
  const employeeIdByUserId = {};
  ((employeesBlob && employeesBlob.employees) || []).forEach((e) => {
    if (e && e.userId && e.id) employeeIdByUserId[e.userId] = e.id;
  });

  // ── Labour: walk approved entries allocated to this job ──────────────────
  let labourCostCents = 0;
  let hoursTotal = 0;
  let chargeOutCents = 0;
  let chargeOutHours = 0;
  const totalHoursByUser = {};
  const costedHoursByUser = {};
  // Per-day rows for the printable job report (?format=pdf) — the same walk,
  // the same rates, so the document's labour equals the card's by construction.
  const labourRows = [];
  let pendingHours = 0;
  try {
    const entries = await fetchTimeEntries(await listTimeEntryBlobs());
    for (const e of entries) {
      if (!e || (e.status !== 'approved' && e.status !== 'submitted')) continue;
      const hrs = (e.allocations || [])
        .filter((a) => a && a.jobId === jobId)
        .reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (!hrs) continue;
      if (e.status === 'submitted') { pendingHours += hrs; continue; }
      hoursTotal += hrs;
      totalHoursByUser[e.userId] = (totalHoursByUser[e.userId] || 0) + hrs;
      const rate = effectiveCostRate(historyFor(ratesData, e.userId), e.date);
      const dayCost = rate && rate.costRateCents > 0 ? Math.round(hrs * rate.costRateCents) : null;
      labourRows.push({ date: e.date, userId: e.userId, userName: e.userName || null, hours: hrs, costCents: dayCost });
      if (rate && rate.costRateCents > 0) {
        labourCostCents += Math.round(hrs * rate.costRateCents);
        costedHoursByUser[e.userId] = (costedHoursByUser[e.userId] || 0) + hrs;
      }
      if (rate && rate.chargeOutRateCents > 0) {
        chargeOutCents += Math.round(hrs * rate.chargeOutRateCents);
        chargeOutHours += hrs;
      }
    }
  } catch (err) {
    // Non-fatal: a labour-walk failure yields 0 labour + an understated badge,
    // never a 500 — the admin still gets revenue + materials.
    console.error('job-profitability: labour walk failed', err && err.message);
  }

  // A worker is "unrated" when ANY of their approved hours on the job could not
  // be costed (no rate effective on that entry's date) — their costable hours
  // are still counted, but the labour figure is flagged understated. Named by
  // LIVE full name (owner-directed 2026-08-16), never a nickname.
  const unratedWorkerRefs = [];
  for (const uid of Object.keys(totalHoursByUser)) {
    const costed = costedHoursByUser[uid] || 0;
    if (costed < totalHoursByUser[uid] - 0.001) {
      const u = userById[uid];
      const name = (u && (u.name || u.username)) || uid;
      unratedWorkerRefs.push({ userId: uid, name, employeeId: employeeIdByUserId[uid] || null });
    }
  }
  unratedWorkerRefs.sort((a, b) => a.name.localeCompare(b.name));
  const unratedWorkers = unratedWorkerRefs.map((w) => w.name);

  // ── Supplier invoices: confirmed allocations (invoice_capture) ─────────────
  // null = the feature is off for this viewer (no trace). `unavailable` = the
  // store could not be read; the card says so rather than showing a quiet 0.
  let supplierInvoices = null;
  if (invoicesOn) {
    try {
      const sql = getDb({ mode: 'read' });
      const tenant = await invoiceStore.resolveTenant(sql);
      if (tenant) {
        const s = await invoiceStore.jobSummary(sql, tenant.id, jobId);
        supplierInvoices = { confirmedCents: s.confirmedCents, confirmedCount: s.confirmedCount, awaitingCount: s.awaitingCount, unavailable: false };
      }
    } catch (err) {
      console.error('job-profitability: supplier-invoice read failed', { code: (err && err.code) || 'db' });
      supplierInvoices = { confirmedCents: 0, confirmedCount: 0, awaitingCount: 0, unavailable: true };
    }
  }

  // ── Materials: spend ledger + confirmed supplier invoices, else the legacy proxy, else none ─
  let materialCostCents = null;
  let materialSource = 'none';
  let ledgerCents = 0;
  let ledgerCount = 0;
  if (ledgerOn) {
    try {
      const ledger = summariseLedger(await readLedger(jobId));
      ledgerCents = ledger.totalCents;
      ledgerCount = ledger.count;
    } catch (err) {
      console.error('job-profitability: materials ledger read failed', err && err.message);
    }
  }
  const invoiceCount = supplierInvoices ? supplierInvoices.confirmedCount : 0;
  if (ledgerCount > 0 || invoiceCount > 0) {
    materialCostCents = ledgerCents + (invoiceCount > 0 ? supplierInvoices.confirmedCents : 0);
    materialSource = ledgerCount > 0 ? 'ledger' : 'invoices';
  }
  if (materialSource === 'none' && matsList && matsList.costRollup) {
    const dollars = Number(matsList.costRollup.receivedExGst) ||
                    Number(matsList.costRollup.invoicedExGst) || 0;
    if (dollars > 0) {
      materialCostCents = Math.round(dollars * 100);
      materialSource = 'received_proxy';
    }
  }

  // ── Revenue ──────────────────────────────────────────────────────────────
  const cv = Number(job.contractValue);
  const contractValueCents = job.contractValue != null && Number.isFinite(cv) && cv > 0
    ? Math.round(cv * 100)
    : null;

  const result = computeJobProfitability({
    contractValueCents,
    labourCostCents,
    unratedWorkers,
    materialCostCents,
    materialSource,
  });

  // #341: budget variance — actual vs estimate, the same money module.
  const le = Number(job.labourEstimate);
  const me_ = Number(job.materialEstimate);
  const labourEstimateCents = job.labourEstimate != null && Number.isFinite(le) && le > 0 ? Math.round(le * 100) : null;
  const materialEstimateCents = job.materialEstimate != null && Number.isFinite(me_) && me_ > 0 ? Math.round(me_ * 100) : null;
  const budget = { labourEstimateCents, materialEstimateCents };
  const variance = buildBudgetLines({
    labourCostCents,
    materialCostCents,
    labourEstimateCents,
    materialEstimateCents,
    contractValueCents,
  });

  if (String((req.query && req.query.format) || '') === 'pdf') {
    return sendJobReport(res, { job, jobId, me, result, labourRows, pendingHours, hoursTotal, unratedWorkers, usersBlob, employeesBlob, ledgerOn, invoicesOn, supplierInvoices });
  }

  return res.status(200).json({
    jobId,
    ...result,
    unratedWorkerRefs,
    supplierInvoices,
    labourChargeOutCents: chargeOutHours > 0 ? chargeOutCents : null,
    chargeOutHours: round2(chargeOutHours),
    budget,
    variance,
    hoursTotal: round2(hoursTotal),
    asOf: new Date().toISOString(),
  });
};

/**
 * The printable job cost report (owner pull 2026-09-28). Same figures as the
 * JSON above; adds the per-day labour rows, every confirmed supplier invoice /
 * receipt with its lines, and the typed materials ledger.
 */
async function sendJobReport(res, ctx) {
  const { job, jobId, me, result, labourRows, pendingHours, hoursTotal, unratedWorkers, usersBlob, employeesBlob, ledgerOn, invoicesOn, supplierInvoices } = ctx;
  const labelFor = buildWorkerLabeller({ users: usersBlob && usersBlob.users, employees: employeesBlob && employeesBlob.employees });
  const days = labourRows
    .map((r) => ({ date: String(r.date).slice(0, 10), name: labelFor(r.userId, r.userName), hours: round2(r.hours), costCents: r.costCents }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.name.localeCompare(b.name));
  const byWorker = new Map();
  for (const d of days) {
    const w = byWorker.get(d.name) || { name: d.name, dates: new Set(), hours: 0, costCents: 0, uncosted: false };
    w.dates.add(d.date);
    w.hours += d.hours;
    if (d.costCents == null) w.uncosted = true; else w.costCents += d.costCents;
    byWorker.set(d.name, w);
  }
  const workers = Array.from(byWorker.values())
    .map((w) => ({ name: w.name, days: w.dates.size, hours: round2(w.hours), costCents: w.uncosted && !w.costCents ? null : w.costCents }))
    .sort((a, b) => b.hours - a.hours);

  const materials = { source: result.completeness ? result.completeness.material : null, invoicesShown: false, ledgerShown: false, categories: [], invoices: [], ledger: [], awaitingCount: supplierInvoices ? supplierInvoices.awaitingCount : 0 };
  if (invoicesOn) {
    try {
      const sql = getDb({ mode: 'read' });
      const tenant = await invoiceStore.resolveTenant(sql);
      if (tenant) {
        const b = await invoiceStore.jobMaterialsBreakdown(sql, tenant.id, jobId);
        const lines = b.lines.map((l) => ({ ...l, measure: measureOf(l.description, l.quantity, l.unit) }));
        const cats = new Map();
        for (const l of lines) {
          const c = cats.get(l.category) || { label: CATEGORY_LABELS[l.category] || l.category, cents: 0, lines: [] };
          c.cents += l.signedCents; c.lines.push(l);
          cats.set(l.category, c);
        }
        materials.categories = Array.from(cats.values()).map((c) => ({ label: c.label, cents: c.cents, measure: measureTotals(c.lines).totals })).sort((a, c) => c.cents - a.cents);
        materials.invoices = (b.invoices || []).map((inv) => ({
          date: inv.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : null, supplier: inv.supplierName || 'Unknown supplier', number: inv.supplierInvoiceNumber, source: inv.source, documentType: inv.documentType, purchaser: inv.purchaser,
          amountCents: inv.amountCents,
          lines: lines.filter((l) => l.invoiceId === inv.invoiceId).map((l) => ({ quantity: l.quantity, unit: l.unit, description: l.description, category: CATEGORY_LABELS[l.category] || l.category, signedCents: l.signedCents })),
        }));
        materials.invoicesShown = true;
      }
    } catch (err) {
      console.error('job-report: supplier-invoice read failed', { code: (err && err.code) || 'db' });
    }
  }
  if (ledgerOn) {
    try {
      const ledger = summariseLedger(await readLedger(jobId));
      materials.ledger = ledger.lines.slice().sort((a, c) => String(a.date).localeCompare(String(c.date))).map((l) => ({ date: l.date, supplier: l.supplier, description: l.description || null, amountCents: l.amountCents }));
      materials.ledgerShown = true;
    } catch (err) {
      console.error('job-report: materials ledger read failed', err && err.message);
    }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const pdf = await composeJobReportPdf({
    job: { id: job.id, name: job.name || job.id, code: typeof job.code === 'string' ? job.code : null, siteAddress: job.siteAddress || null, status: job.status || null, clientName: job.clientName || null },
    generatedAt: today,
    money: { contractValueCents: result.contractValueCents, labourCostCents: result.labourCostCents, materialCostCents: result.materialCostCents, marginCents: result.marginCents, marginPct: result.marginPct },
    labour: { hoursTotal: round2(hoursTotal), pendingHours: round2(pendingHours), unratedWorkers, workers, days },
    materials,
  });
  const slug = `${job.code || ''} ${job.name || job.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="buhlos-job-report-${slug}-${today}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  console.log('[job-report] generated', { by: me && me.id, days: days.length, invoices: materials.invoices.length });
  return res.status(200).end(Buffer.from(pdf));
}
