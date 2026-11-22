// Customer stage invoices — the office API (docs/customer-invoices.md;
// rules: docs/architecture/customer-invoicing-boundary-adr.md).
//
// A job's payment stages, listed in BuhlOS. NOT supplier invoices
// (api/invoices.js — bills coming in). Built so far: the schedule (#1148) and
// the Xero set-up an invoice will need (#1149 — the job's client linked to a
// Xero contact, and the default sales account, tax rate and payment terms),
// and the send (#1150): ONE write to Xero — creating a DRAFT sales invoice —
// in api/_lib/customer-invoices/xero-send.js. Every other Xero call is a read.
// BuhlOS never approves, emails, edits, voids or deletes an invoice in Xero.
//
// ADMIN-TIER ONLY on every method (money is office data; a leading hand never
// reads it). Dark behind the `customer_invoices` launch-gate: 404 while off.
//
//   GET    /api/customer-invoices?jobId=X              the job's profile, stages, totals and Xero readiness
//   POST   /api/customer-invoices?action=stage-add     { jobId, stage }
//   POST   /api/customer-invoices?action=stage-edit&id=S    { stage, expectedVersion }
//   POST   /api/customer-invoices?action=stage-remove&id=S  { expectedVersion }
//   PUT    /api/customer-invoices?action=profile       { jobId, retentionBp, expectedVersion }
//   GET    /api/customer-invoices?action=contacts&q=   live Xero contact search → [{ id, name }]
//   PUT    /api/customer-invoices?action=contact-link  { jobId, contactId, expectedVersion }
//                                                      the contact is re-read from Xero; its name is Xero's, not the browser's
//   PUT    /api/customer-invoices?action=contact-unlink { jobId, expectedVersion }
//   GET    /api/customer-invoices?action=settings      Xero readiness + the saved defaults for the connected organisation
//   GET    /api/customer-invoices?action=settings-options  live from Xero: active revenue accounts + sales tax rates
//   PUT    /api/customer-invoices?action=settings      { salesAccountCode, taxType, paymentTermsDays, expectedVersion }
//                                                      both codes must exist in Xero now; names + rate are snapshotted from Xero
//
//   POST   /api/customer-invoices?action=preview&id=S   { invoiceDate?, reference? }
//                                                      exactly what would be sent + every blocker; writes nothing, calls Xero for nothing
//   POST   /api/customer-invoices?action=send&id=S      { expectedVersion, invoiceDate?, reference? }
//                                                      THE ONE WRITE TO XERO (#1150): a DRAFT sales invoice, create-only,
//                                                      read back and compared. 409 { error:'blocked', blockers } when it can't go
//   POST   /api/customer-invoices?action=retry&id=S     a stage stuck sending / failed: looks the number up in Xero FIRST —
//                                                      adopts what is there, or sends again from the frozen snapshot
//   POST   /api/customer-invoices?action=reset&id=S     back to planned (to edit) — only once Xero confirms it holds nothing under the number
//   POST   /api/customer-invoices?action=raise-again&id=S   the number is taken in Xero: burn it, add a planned copy that takes the next
//   POST   /api/customer-invoices?action=retention-release  { jobId, amountCents, title? }  a planned stage that releases retention held
//
//   ── part 2 (docs/product/job-invoicing-part-2-plan.md) ──
//   POST   ?action=stage-add / stage-edit with stage.kind = 'itemised'   an ITEMISED invoice (#1161): lines with a
//                                                      quantity and a unit price, and wording-only notes. A line may bill
//                                                      the job's own hours / materials / an approved variation (`refs`);
//                                                      the server checks nothing is billed twice and works out the cost
//   GET    ?action=billable&jobId=X[&invoiceId=S]      the job's approved hours and materials, each marked with the
//                                                      invoice it is already on (#1162)
//   GET    ?action=prefs                               the business's usual markup, usual charges, hours rounding
//   PUT    ?action=prefs                               { materialsMarkupBp, labourRoundMinutes, usualCharges, expectedVersion }
//   POST   ?action=variation-add                       { jobId, variation }                       (#1163)
//   POST   ?action=variation-edit&id=V                 { variation, expectedVersion }
//   POST   ?action=variation-decide&id=V               { status, approvedCents?, approvalRef?, decidedOn?, expectedVersion }
//   POST   ?action=variation-remove&id=V               { expectedVersion }
//   POST   ?action=variation-bill&id=V                 { stageId?, expectedStageVersion? }  on a planned stage, or — with no
//                                                      stageId — on an invoice by itself
//   PUT    ?action=payment-claim                       { jobId, on, expectedVersion }  payment-claim wording (#1164)
//
//   POST   /api/customer-invoices?action=refresh        { jobId }  "Check Xero now" (#1151): asks Xero what happened to
//                                                      the job's sent invoices (approved, paid, part-paid, voided, deleted,
//                                                      edited) and mirrors XERO'S figures. A read of Xero only.
//   GET    /api/customer-invoices?action=poll           cron (CRON_SECRET) — the same check, hourly, for every unsettled
//                                                      sent invoice; skipped while the flag is off or Xero isn't connected
//
// raise-again also serves a SENT stage Xero shows as deleted or voided: a new
// planned copy takes the next number and the old row stays as history.
//
// send / retry / reset answer the job's refreshed payload plus
// `send: { outcome, … }` — outcome sent | adopted | failed | unknown | reset.
// `unknown` means Xero gave no answer: the stage stays "sending" and the next
// step is a look-up, never a blind re-send.
//
// A Xero failure answers { error: 'xero_<category>' } with a matching status
// (409 not connected / reconnect needed, 429 busy, 502 otherwise) — and, for
// a missing invoice permission, reason: 'missing_invoice_scope'.
//
// MONEY IS INTEGER CENTS; percentages are basis points (500 = 5%). Every
// mutation validates (zod), checks the tier, is a compare-and-swap on the
// row's version, writes a per-invoice event and a platform audit entry (never
// with amounts), and returns { error: <stable code> } on failure — never an
// exception message. A figure that cannot be worked out is null, never 0.

const { z } = require('zod');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled, isFlagOn } = require('./_lib/feature-flags');
const { getDb } = require('./_lib/supabase-db');
const auditLog = require('./_lib/audit-log');
const { withErrorCapture } = require('./_lib/error-wrap');
const store = require('./_lib/customer-invoices/store');
const crypto = require('crypto');
const {
  MAX_CENTS, BP_WHOLE, MAX_ITEMS, MAX_QUANTITY_MILLI, MAX_UNIT_CENTS,
  contractCentsOf, computeStage, jobTotals, itemsOf, itemsSummary, lineAmountCents,
} = require('./_lib/customer-invoices/amounts');
const billable = require('./_lib/customer-invoices/billable');
const { listTimeEntryBlobs, fetchTimeEntries } = require('./_lib/time-entry-blobs');
const { readCostRates, historyFor, effectiveCostRate } = require('./_lib/cost-rates');
const { buildWorkerLabeller } = require('./_lib/worker-names');
const supplierInvoiceStore = require('./_lib/invoices/store');
const { readLedger, summariseLedger } = require('./_lib/job-materials');
const { displayStatus } = require('./_lib/customer-invoices/status');
const xero = require('./_lib/customer-invoices/xero-lookups');
const sendSvc = require('./_lib/customer-invoices/xero-send');
const statusSvc = require('./_lib/customer-invoices/xero-status');
const { requireCron } = require('./_lib/cron-auth');
const syncBridge = require('./_lib/customer-invoices/sync-bridge');
const { XeroError } = require('./_lib/xero/errors');

const MAX_EXTRA_LINES = 20;

// ── request shapes ──────────────────────────────────────────────────────────
const uuid = z.string().uuid();
const centsIn = z.number().int().min(1).max(MAX_CENTS);
const bp = z.number().int().min(0).max(BP_WHOLE);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const version = z.number().int().min(1);

const ExtraLine = z.object({
  description: z.string().trim().min(1).max(500),
  amountCents: centsIn,
  // set when the line bills an approved variation (#1163)
  variationId: uuid.optional(),
}).strict();

// ── an itemised invoice's lines (#1161 / #1162) ──
const jobIdIn = z.string().min(1).max(200);
const Ref = z.union([
  z.object({ t: z.literal('h'), u: z.string().min(1).max(200), d: day, m: z.number().int().min(1).max(24000) }).strict(),
  z.object({ t: z.enum(['sl', 'si', 'ml', 'v']), id: z.string().min(1).max(200) }).strict(),
]);
const ItemLine = z.object({
  id: z.string().min(1).max(40).optional(),
  type: z.literal('line'),
  description: z.string().trim().min(1).max(1000),
  quantityMilli: z.number().int().min(1).max(MAX_QUANTITY_MILLI),
  unit: z.string().trim().max(12).nullable().optional(),
  // negative = a discount or credit line
  unitCents: z.number().int().min(-MAX_UNIT_CENTS).max(MAX_UNIT_CENTS),
  source: z.enum(['manual', 'labour', 'material', 'variation']).optional(),
  // the office's own cost for a TYPED line; ignored on a line that bills job data
  costCents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  refs: z.array(Ref).max(billable.MAX_REFS_PER_LINE).optional(),
}).strict();
const ItemNote = z.object({
  id: z.string().min(1).max(40).optional(),
  type: z.literal('note'),
  description: z.string().trim().min(1).max(2000),
}).strict();
const ItemisedBody = z.object({
  kind: z.literal('itemised'),
  title: z.string().trim().min(1).max(200),
  items: z.array(z.union([ItemLine, ItemNote])).min(1).max(MAX_ITEMS),
  retentionBp: bp.nullable().optional(),
  plannedDate: day.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict().superRefine((s, ctx) => {
  const total = s.items.reduce((sum, it) => sum + (it.type === 'line' ? lineAmountCents(it.quantityMilli, it.unitCents) || 0 : 0), 0);
  if (!s.items.some((it) => it.type === 'line')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'needs a charge' });
  else if (total < 1 || total > MAX_CENTS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'total' });
});

const UsualCharge = z.object({
  id: z.string().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().max(12).nullable().optional(),
  unitCents: z.number().int().min(1).max(MAX_UNIT_CENTS),
  kind: z.enum(['labour', 'other']),
}).strict();
const PrefsBody = z.object({
  materialsMarkupBp: z.number().int().min(0).max(100000).nullable(),
  labourRoundMinutes: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]),
  usualCharges: z.array(UsualCharge).max(40),
  expectedVersion: z.number().int().min(1).nullable(),
}).strict();

const centsOrZero = z.number().int().min(0).max(MAX_CENTS);
const VariationBody = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(2000).nullable().optional(),
  requestedBy: z.string().trim().max(200).nullable().optional(),
  requestedOn: day.nullable().optional(),
  // null = not priced yet
  quotedCents: centsOrZero.nullable().optional(),
}).strict();
const VariationAddBody = z.object({ jobId: jobIdIn, variation: VariationBody }).strict();
const VariationEditBody = z.object({ variation: VariationBody, expectedVersion: z.number().int().min(1) }).strict();
const VariationDecideBody = z.object({
  status: z.enum(['approved', 'declined', 'proposed']),
  approvedCents: centsOrZero.nullable().optional(),
  approvalRef: z.string().trim().max(300).nullable().optional(),
  decidedOn: day.nullable().optional(),
  expectedVersion: z.number().int().min(1),
}).strict().superRefine((d, ctx) => {
  if (d.status === 'approved' && d.approvedCents == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedCents'], message: 'required' });
  }
});
const VariationBillBody = z.object({
  // omitted = an invoice of its own
  stageId: uuid.optional(),
  expectedStageVersion: z.number().int().min(1).optional(),
}).strict();
const PaymentClaimBody = z.object({
  jobId: jobIdIn,
  on: z.boolean(),
  expectedVersion: z.number().int().min(1).nullable(),
}).strict();

const StageBody = z.object({
  title: z.string().trim().min(1).max(200),
  basis: z.enum(['amount', 'percent']),
  amountCents: centsIn.nullable().optional(),
  percentBp: z.number().int().min(1).max(BP_WHOLE).nullable().optional(),
  extraLines: z.array(ExtraLine).max(MAX_EXTRA_LINES).optional(),
  // null / omitted = use the job's retention; a number overrides it for this stage
  retentionBp: bp.nullable().optional(),
  plannedDate: day.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict().superRefine((s, ctx) => {
  if (s.basis === 'amount' && s.amountCents == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountCents'], message: 'required' });
  }
  if (s.basis === 'percent' && s.percentBp == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percentBp'], message: 'required' });
  }
});

const AddBody = z.object({ jobId: z.string().min(1).max(200), stage: StageBody }).strict();
const EditBody = z.object({ stage: StageBody, expectedVersion: version }).strict();
const AddItemisedBody = z.object({ jobId: jobIdIn, stage: ItemisedBody }).strict();
const EditItemisedBody = z.object({ stage: ItemisedBody, expectedVersion: version }).strict();
const isItemisedBody = (b) => !!(b && b.stage && typeof b.stage === 'object' && b.stage.kind === 'itemised');
const RemoveBody = z.object({ expectedVersion: version }).strict();
const ProfileBody = z.object({
  jobId: z.string().min(1).max(200),
  retentionBp: bp,
  // null on the first save (no profile row yet)
  expectedVersion: version.nullable(),
}).strict();

const ContactLinkBody = z.object({
  jobId: z.string().min(1).max(200),
  contactId: uuid,
  expectedVersion: version.nullable(),
}).strict();
const ContactUnlinkBody = z.object({
  jobId: z.string().min(1).max(200),
  expectedVersion: version,
}).strict();
const SettingsBody = z.object({
  salesAccountCode: z.string().trim().min(1).max(20),
  taxType: z.string().trim().min(1).max(50),
  paymentTermsDays: z.number().int().min(0).max(365),
  expectedVersion: version.nullable(),
}).strict();

const reference = z.string().trim().max(255);
const PreviewBody = z.object({
  invoiceDate: day.optional(),
  reference: reference.nullable().optional(),
}).strict();
const SendBody = z.object({
  expectedVersion: version,
  invoiceDate: day.optional(),
  reference: reference.nullable().optional(),
}).strict();
const NoBody = z.object({}).strict();
const RefreshBody = z.object({ jobId: z.string().min(1).max(200) }).strict();
const ReleaseBody = z.object({
  jobId: z.string().min(1).max(200),
  amountCents: centsIn,
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

function invalid(res, parsed) {
  const fields = parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean);
  return res.status(400).json({ error: 'invalid_request', fields: Array.from(new Set(fields)) });
}

function actorOf(me) {
  return { id: me.id, name: me.name || me.username || '', role: me.role || null };
}

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function readJobs() {
  const data = await readBlob('jobs.json', { jobs: [] });
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function isLive(j) {
  return !!j && j.deleted !== true && !j.deletedAt;
}

async function liveJob(jobId) {
  const j = (await readJobs()).find((x) => x && x.id === jobId);
  return isLive(j) ? j : null;
}

const clientKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Other live jobs that carry the same client name as this one. */
async function sameClientJobIds(job) {
  const key = clientKey(job.clientName);
  if (!key) return [];
  return (await readJobs())
    .filter((j) => isLive(j) && j.id !== job.id && clientKey(j.clientName) === key)
    .map((j) => j.id);
}

/** A Xero failure → a stable response. Never the exception's message. */
function xeroFailure(res, err) {
  const c = err.category;
  const status =
    c === 'not_connected' || c === 'pending_selection' || c === 'reconnect_required' || c === 'not_configured' || c === 'conflict' ? 409
      : c === 'validation' ? 400
        : c === 'forbidden' ? 403
          : c === 'rate_limit' ? 429
            : 502;
  const body = { error: `xero_${c}` };
  if (c === 'reconnect_required' && err.reason === 'missing_invoice_scope') body.reason = 'missing_invoice_scope';
  if (c === 'rate_limit' && Number.isFinite(err.retryAfterSeconds)) body.retryAfterSeconds = err.retryAfterSeconds;
  return res.status(status).json(body);
}

/**
 * Where the job stands against Xero — decided from stored rows only (no Xero
 * call): is Xero usable, are the defaults chosen, is the client linked, and
 * was it linked in the organisation that is connected now.
 */
async function xeroStanding(sql, tenant, job, profile) {
  let ready;
  try {
    ready = await xero.readiness({ sql });
  } catch (e) {
    // The schedule must stay usable when the connection can't be read (P8):
    // say so rather than fail the whole card.
    console.error('[customer-invoices] xero readiness unreadable', { code: (e && e.code) || 'db' });
    ready = { state: 'unavailable', organisationName: null, externalTenantId: null };
  }
  const settings = await store.getSettings(sql, tenant.id, ready.externalTenantId);
  const linked = !!(profile && profile.xeroContactId);
  const otherOrganisation =
    linked && !!ready.externalTenantId && profile.externalTenantId !== ready.externalTenantId;
  let suggestion = null;
  if (!linked && ready.state === 'connected') {
    const ids = await sameClientJobIds(job);
    suggestion = await store.latestContactAmongJobs(sql, tenant.id, ids, ready.externalTenantId);
  }
  const settingsComplete = store.settingsComplete(settings);
  return {
    state: ready.state,
    organisationName: ready.organisationName,
    settingsComplete,
    // Everything a send needs at JOB level is in place (a stage can still be
    // blocked by its own amount — the preview names that).
    sendReady:
      ready.state === 'connected' && settingsComplete && linked && !otherOrganisation &&
      typeof job.code === 'string' && /^IV\d{4}$/.test(job.code),
    client: {
      linked,
      name: linked ? profile.xeroContactName : null,
      otherOrganisation,
      suggestion: suggestion ? { id: suggestion.id, name: suggestion.name } : null,
    },
  };
}

/** Privacy line (same as the supplier-invoice journal): never an amount. */
async function journal(me, action, { jobId, targetId, summary, metadata }) {
  try {
    await auditLog.append({
      action,
      actorId: me.id,
      actorName: actorOf(me).name,
      actorRole: me.role || null,
      jobId: jobId || null,
      targetType: 'customer_invoice',
      targetId: String(targetId),
      summary: String(summary).slice(0, 240),
      metadata: metadata || {},
    });
  } catch (e) {
    console.error('[customer-invoices] audit append failed', { action, code: (e && e.code) || 'audit' });
  }
}

/** One stage as the screen needs it: the stored row, what it works out to
 *  today (for unsent stages), and the one status a person reads. */
function presentStage(row, ctx, today) {
  const frozen = row.state !== 'planned' && Number.isInteger(row.grossCents);
  const computed = frozen
    ? {
        grossCents: row.grossCents,
        retentionCents: row.retentionCents,
        netCents: row.netCents,
        retentionBp: row.retentionBp == null ? ctx.retentionBp : row.retentionBp,
        reason: null,
      }
    : computeStage(row, ctx);
  return {
    ...row,
    computed: {
      grossCents: computed.grossCents,
      retentionBp: computed.retentionBp,
      retentionCents: computed.retentionCents,
      netCents: computed.netCents,
      reason: computed.reason,
    },
    display: displayStatus(row, today),
    // An itemised invoice's lines as priced, and (office only) what they cost.
    ...(row.kind === 'itemised' ? { items: itemsOf(row), itemsSummary: itemsSummary(row) } : {}),
    // A sent stage Xero shows as deleted or voided can be raised again — once.
    canRaiseAgain:
      row.state === 'sent' && (row.xeroStatus === 'DELETED' || row.xeroStatus === 'VOIDED') && !row.replacedById,
  };
}

async function jobPayload(sql, tenant, job) {
  const [profile, rows, variations] = await Promise.all([
    store.getProfile(sql, tenant.id, job.id),
    store.listJobInvoices(sql, tenant.id, job.id),
    store.listVariations(sql, tenant.id, job.id),
  ]);
  const ctx = {
    contractCents: contractCentsOf(job.contractValue),
    retentionBp: profile ? profile.retentionBp : 0,
    variations,
  };
  const today = sydneyToday();
  const billedOn = billable.variationBilling(rows);
  return {
    jobId: job.id,
    job: {
      name: job.name || job.id,
      code: typeof job.code === 'string' ? job.code : null,
      clientName: typeof job.clientName === 'string' && job.clientName ? job.clientName : null,
      contractCents: ctx.contractCents,
    },
    profile: profile || { jobId: job.id, retentionBp: 0, paymentClaim: false, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: null },
    stages: rows.map((r) => presentStage(r, ctx, today)),
    // The variations register (#1163). `billedOn` is the invoice a variation
    // is on — read from the invoices' own lines, never stored on the variation.
    variations: variations.map((v) => ({ ...v, number: `V${v.seq}`, billedOn: billedOn.get(v.id) || null })),
    totals: jobTotals(rows, ctx),
    // How fresh the paid / owing figures are: the OLDEST "last checked with
    // Xero" among the job's sent invoices (null when nothing has been sent).
    statusAsOf: rows
      .filter((r) => r.state === 'sent' && r.xeroInvoiceId)
      .map((r) => r.lastCheckedAt)
      .reduce((oldest, t) => (t && (!oldest || t < oldest) ? t : oldest), null),
    xero: await xeroStanding(sql, tenant, job, profile),
    asOf: new Date().toISOString(),
  };
}

function stageInput(s) {
  return {
    kind: 'stage',
    title: s.title,
    basis: s.basis,
    amountCents: s.basis === 'amount' ? s.amountCents : null,
    percentBp: s.basis === 'percent' ? s.percentBp : null,
    extraLines: s.extraLines || [],
    retentionBp: s.retentionBp == null ? null : s.retentionBp,
    plannedDate: s.plannedDate || null,
    note: s.note || null,
  };
}

const newItemId = () => `it_${crypto.randomBytes(5).toString('hex')}`;

/** What is stored for an itemised invoice. `amount_cents` is the lines added
 *  up — kept so every total that reads the row sees one figure. */
function itemisedInput(s, items) {
  const withIds = items.map((it) => ({ ...it, id: it.id || newItemId() }));
  return {
    kind: 'itemised',
    title: s.title,
    basis: 'amount',
    amountCents: itemsSummary({ items: withIds }).totalCents,
    percentBp: null,
    extraLines: [],
    items: withIds,
    retentionBp: s.retentionBp == null ? null : s.retentionBp,
    plannedDate: s.plannedDate || null,
    note: s.note || null,
  };
}

/** The job's hours and materials, read once (the slow part: every source is a
 *  walk or a query). Each source answers `available: false` rather than
 *  failing the request. */
async function jobSources(sql, tenant, job, me) {
  const [supplierInvoices, ledger] = await Promise.all([
    isFlagEnabled('invoice_capture', me),
    isFlagEnabled('job_materials_spend', me),
  ]);
  return billable.loadSources({
    job, sql, tenantId: tenant.id,
    flags: { supplierInvoices, ledger },
    deps: {
      timeEntries: async () => fetchTimeEntries(await listTimeEntryBlobs()),
      costRates: readCostRates,
      historyFor,
      effectiveCostRate,
      users: async () => {
        const [u, e] = await Promise.all([readBlob('users.json', { users: [] }), readBlob('employees.json', { employees: [] })]);
        return { users: (u && u.users) || [], employees: (e && e.employees) || [] };
      },
      labeller: buildWorkerLabeller,
      supplierBreakdown: supplierInvoiceStore.jobMaterialsBreakdown,
      ledger: readLedger,
      ledgerLines: (data) => summariseLedger(data).lines,
    },
  });
}

/** A line that bills something it can't → a stable answer a person can act on. */
function billableResponse(res, e) {
  const status = e.code === 'ref_not_found' ? 409 : e.code === 'already_billed' ? 409 : e.code === 'line_invalid' ? 400 : 409;
  return res.status(status).json({ error: e.code, ...(e.extra || {}) });
}

function variationInput(v) {
  return {
    title: v.title,
    detail: v.detail || null,
    requestedBy: v.requestedBy || null,
    requestedOn: v.requestedOn || null,
    quotedCents: v.quotedCents == null ? null : v.quotedCents,
  };
}

function conflictResponse(res, e) {
  if (e.reason === 'not_found') return res.status(404).json({ error: 'stage_not_found' });
  if (e.reason === 'not_planned') return res.status(409).json({ error: 'stage_not_editable' });
  // Two stages of one job sent at the same instant: the second loses the number.
  if (e.reason === 'number_clash') return res.status(409).json({ error: 'number_clash' });
  if (e.reason === 'not_resettable' || e.reason === 'not_raisable') return res.status(409).json({ error: e.reason });
  return res.status(409).json({ error: 'stale_version' });
}

/**
 * The cron body: ask Xero about every unsettled sent invoice. Always answers
 * 200 with what happened (a failed read is reported in the body and on the
 * sync log — a 5xx here would only make the scheduler retry blindly).
 */
async function statusPoll(res) {
  let sql;
  let tenant;
  try {
    sql = getDb({ mode: 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[customer-invoices] poll: store unavailable', { code: (e && e.code) || 'db' });
    return res.status(200).json({ ok: false, error: 'store_unavailable' });
  }
  if (!tenant) return res.status(200).json({ ok: false, error: 'store_unprovisioned' });
  try {
    const summary = await statusSvc.pollAll({ tenant, deps: { sql } });
    const syncLogWarning = await syncBridge.recordStatusOutcome({ summary });
    return res.status(200).json({
      ok: true,
      ...(summary.skipped ? { skipped: summary.skipped } : {}),
      checked: summary.checked, changed: summary.changed, notFound: summary.notFound, stoppedEarly: summary.stoppedEarly,
      ...(syncLogWarning ? { syncLogWarning } : {}),
    });
  } catch (e) {
    const category = e instanceof XeroError ? e.category : 'unexpected';
    console.error('[customer-invoices] poll failed', { category });
    const syncLogWarning = await syncBridge.recordStatusOutcome({ error: { category } });
    return res.status(200).json({ ok: false, error: `xero_${category}`, ...(syncLogWarning ? { syncLogWarning } : {}) });
  }
}

async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const action = String(q.action || '');

  // ── the hourly status check (no user session; CRON_SECRET) ───────────────
  // isFlagOn, not isFlagEnabled: the flag is admin-tier, and a cron has no
  // viewer — isFlagEnabled would be false forever.
  if (action === 'poll' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!(await isFlagOn('customer_invoices'))) return res.status(200).json({ skipped: 'flag_off' });
    return statusPoll(res);
  }

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!(await isFlagEnabled('customer_invoices', me))) return res.status(404).json({ error: 'not found' });
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'admin only' });

  let sql;
  let tenant;
  try {
    // A live Xero read may rotate the connection's tokens (a database write),
    // so those two GETs must clear the WRITE gate like any mutation does.
    const callsXero = action === 'contacts' || action === 'settings-options';
    sql = getDb({ mode: req.method === 'GET' && !callsXero ? 'read' : 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[customer-invoices] store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });

  const id = typeof q.id === 'string' ? q.id : '';
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const actor = actorOf(me);

  try {
    // ── read ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && !action) {
      const jobId = String(q.jobId || '');
      if (!jobId) return res.status(400).json({ error: 'jobId required' });
      const job = await liveJob(jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    // ── add a planned stage ──────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'stage-add') {
      const itemised = isItemisedBody(body);
      const parsed = (itemised ? AddItemisedBody : AddBody).safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const stage = parsed.data.stage;
      // The slow read (hours, materials) happens BEFORE the transaction; the
      // check against other invoices happens inside it, under the job's lock.
      const sources = itemised && billable.needsSources(stage.items) ? await jobSources(sql, tenant, job, me) : null;
      const row = await store.createStage(sql, tenant.id, job.id, itemised ? null : stageInput(stage), actor, {
        prepare: async (tx) => {
          const [rows, variations] = await Promise.all([
            store.listJobInvoices(tx, tenant.id, job.id),
            store.listVariations(tx, tenant.id, job.id),
          ]);
          if (!itemised) {
            billable.checkVariationLines({ extraLines: stage.extraLines, rows, variations });
            return stageInput(stage);
          }
          return itemisedInput(stage, billable.resolveItems({ items: stage.items, sources, rows, variations }));
        },
      });
      await journal(me, 'customer_invoice.stage_added', {
        jobId: job.id, targetId: row.id,
        summary: `Added ${itemised ? 'itemised' : 'stage'} invoice "${row.title}" to ${job.name || job.id}`,
        metadata: itemised ? { kind: 'itemised', lines: row.items.length } : { basis: row.basis },
      });
      return res.status(201).json(await jobPayload(sql, tenant, job));
    }

    // ── edit / remove a planned stage ────────────────────────────────────────
    if (req.method === 'POST' && (action === 'stage-edit' || action === 'stage-remove')) {
      if (!uuid.safeParse(id).success) return res.status(400).json({ error: 'id required' });
      const existing = await store.getInvoice(sql, tenant.id, id);
      if (!existing) return res.status(404).json({ error: 'stage_not_found' });
      const job = await liveJob(existing.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });

      if (action === 'stage-edit') {
        const itemised = isItemisedBody(body);
        const parsed = (itemised ? EditItemisedBody : EditBody).safeParse(body);
        if (!parsed.success) return invalid(res, parsed);
        // An invoice keeps the kind it was made as.
        if (itemised !== (existing.kind === 'itemised')) return res.status(409).json({ error: 'kind_mismatch' });
        const stage = parsed.data.stage;
        const sources = itemised && billable.needsSources(stage.items) ? await jobSources(sql, tenant, job, me) : null;
        const row = await store.updateStage(sql, tenant.id, id, null, {
          expectedVersion: parsed.data.expectedVersion, actor, jobId: job.id,
          prepare: async (tx) => {
            const [rows, variations] = await Promise.all([
              store.listJobInvoices(tx, tenant.id, job.id),
              store.listVariations(tx, tenant.id, job.id),
            ]);
            if (!itemised) {
              billable.checkVariationLines({ extraLines: stage.extraLines, rows, variations, excludeInvoiceId: id });
              return { ...stageInput(stage), kind: existing.kind };
            }
            return itemisedInput(stage, billable.resolveItems({ items: stage.items, sources, rows, variations, excludeInvoiceId: id }));
          },
        });
        await journal(me, 'customer_invoice.stage_edited', {
          jobId: job.id, targetId: row.id,
          summary: `Edited ${itemised ? 'itemised' : 'stage'} invoice "${row.title}" on ${job.name || job.id}`,
          metadata: itemised ? { kind: 'itemised', lines: row.items.length } : { basis: row.basis },
        });
        return res.status(200).json(await jobPayload(sql, tenant, job));
      }

      const parsed = RemoveBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      await store.removeStage(sql, tenant.id, id, { expectedVersion: parsed.data.expectedVersion, actor });
      await journal(me, 'customer_invoice.stage_removed', {
        jobId: job.id, targetId: id,
        summary: `Removed planned stage invoice "${existing.title}" from ${job.name || job.id}`,
      });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    // ── what on the job can go on an invoice (#1162) ─────────────────────────
    if (req.method === 'GET' && action === 'billable') {
      const job = await liveJob(String(q.jobId || ''));
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const excludeInvoiceId = uuid.safeParse(q.invoiceId).success ? q.invoiceId : null;
      const [sources, rows, prefs] = await Promise.all([
        jobSources(sql, tenant, job, me),
        store.listJobInvoices(sql, tenant.id, job.id),
        store.getPrefs(sql, tenant.id),
      ]);
      return res.status(200).json({
        jobId: job.id,
        ...billable.present(sources, rows, { excludeInvoiceId }),
        prefs: prefs || { materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: null },
        asOf: new Date().toISOString(),
      });
    }

    // ── the business's invoicing habits (#1162) ──────────────────────────────
    if (req.method === 'GET' && action === 'prefs') {
      const prefs = await store.getPrefs(sql, tenant.id);
      return res.status(200).json({ prefs: prefs || { materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: null } });
    }
    if (req.method === 'PUT' && action === 'prefs') {
      const parsed = PrefsBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const prefs = await store.savePrefs(sql, tenant.id, {
        materialsMarkupBp: parsed.data.materialsMarkupBp,
        labourRoundMinutes: parsed.data.labourRoundMinutes,
        usualCharges: parsed.data.usualCharges.map((c) => ({
          id: c.id || newItemId(), name: c.name, unit: c.unit || null, unitCents: c.unitCents, kind: c.kind,
        })),
      }, { expectedVersion: parsed.data.expectedVersion, actor });
      await journal(me, 'customer_invoice.prefs_updated', {
        targetId: 'prefs',
        summary: 'Changed the usual invoice charges and markup',
        metadata: { usualCharges: prefs.usualCharges.length, hasMarkup: prefs.materialsMarkupBp != null },
      });
      return res.status(200).json({ prefs });
    }

    // ── variations (#1163) ───────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'variation-add') {
      const parsed = VariationAddBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const v = await store.createVariation(sql, tenant.id, job.id, variationInput(parsed.data.variation), actor);
      await journal(me, 'customer_invoice.variation_added', {
        jobId: job.id, targetId: v.id,
        summary: `Added variation V${v.seq} "${v.title}" to ${job.name || job.id}`,
        metadata: { number: `V${v.seq}` },
      });
      return res.status(201).json(await jobPayload(sql, tenant, job));
    }

    if (req.method === 'POST' && ['variation-edit', 'variation-decide', 'variation-remove', 'variation-bill'].includes(action)) {
      if (!uuid.safeParse(id).success) return res.status(400).json({ error: 'id required' });
      const existing = await store.getVariation(sql, tenant.id, id);
      if (!existing) return res.status(404).json({ error: 'variation_not_found' });
      const job = await liveJob(existing.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const number = `V${existing.seq}`;
      // A variation that is on an invoice is settled: it can't be edited,
      // re-decided or removed. Checked under the job's lock.
      const notOnAnInvoice = async (tx) => {
        const rows = await store.listJobInvoices(tx, tenant.id, job.id);
        const on = billable.variationBilling(rows).get(id);
        if (on) throw new billable.BillableError('variation_billed', { on });
      };
      try {
        if (action === 'variation-edit') {
          const parsed = VariationEditBody.safeParse(body);
          if (!parsed.success) return invalid(res, parsed);
          // The quote can't move under an approval that was given for it.
          if (existing.status === 'approved') return res.status(409).json({ error: 'variation_decided' });
          await store.updateVariation(sql, tenant.id, id, variationInput(parsed.data.variation), {
            expectedVersion: parsed.data.expectedVersion, actor, guard: notOnAnInvoice, jobId: job.id,
          });
          await journal(me, 'customer_invoice.variation_edited', {
            jobId: job.id, targetId: id, summary: `Edited variation ${number} on ${job.name || job.id}`, metadata: { number },
          });
          return res.status(200).json(await jobPayload(sql, tenant, job));
        }

        if (action === 'variation-decide') {
          const parsed = VariationDecideBody.safeParse(body);
          if (!parsed.success) return invalid(res, parsed);
          const d = parsed.data;
          await store.decideVariation(sql, tenant.id, id, {
            status: d.status,
            approvedCents: d.status === 'approved' ? d.approvedCents : null,
            approvalRef: d.approvalRef || null,
            decidedOn: d.decidedOn || sydneyToday(),
          }, { expectedVersion: d.expectedVersion, actor, guard: notOnAnInvoice, jobId: job.id });
          await journal(me, d.status === 'approved' ? 'customer_invoice.variation_approved' : d.status === 'declined' ? 'customer_invoice.variation_declined' : 'customer_invoice.variation_reopened', {
            jobId: job.id, targetId: id,
            summary: d.status === 'approved' ? `Marked variation ${number} approved on ${job.name || job.id}`
              : d.status === 'declined' ? `Marked variation ${number} declined on ${job.name || job.id}`
                : `Put variation ${number} back to proposed on ${job.name || job.id}`,
            metadata: { number, status: d.status },
          });
          return res.status(200).json(await jobPayload(sql, tenant, job));
        }

        if (action === 'variation-remove') {
          const parsed = RemoveBody.safeParse(body);
          if (!parsed.success) return invalid(res, parsed);
          await store.removeVariation(sql, tenant.id, id, {
            expectedVersion: parsed.data.expectedVersion, actor, guard: notOnAnInvoice, jobId: job.id,
          });
          await journal(me, 'customer_invoice.variation_removed', {
            jobId: job.id, targetId: id, summary: `Removed variation ${number} from ${job.name || job.id}`, metadata: { number },
          });
          return res.status(200).json(await jobPayload(sql, tenant, job));
        }

        // variation-bill: an approved variation onto a planned stage, or — with
        // no stage named — onto an invoice of its own.
        const parsed = VariationBillBody.safeParse(body);
        if (!parsed.success) return invalid(res, parsed);
        if (existing.status !== 'approved' || !Number.isInteger(existing.approvedCents)) {
          return res.status(409).json({ error: 'variation_not_approved' });
        }
        if (existing.approvedCents < 1) return res.status(409).json({ error: 'variation_amount' });
        const wording = `Variation ${number} — ${existing.title}`.slice(0, 500);
        let target;
        if (parsed.data.stageId) {
          if (parsed.data.expectedStageVersion == null) return res.status(400).json({ error: 'invalid_request', fields: ['expectedStageVersion'] });
          const stage = await store.getInvoice(sql, tenant.id, parsed.data.stageId);
          if (!stage || stage.jobId !== job.id || stage.state === 'cancelled') return res.status(404).json({ error: 'stage_not_found' });
          if (stage.kind !== 'stage') return res.status(409).json({ error: 'kind_mismatch' });
          if (stage.extraLines.length >= MAX_EXTRA_LINES) return res.status(409).json({ error: 'too_many_lines' });
          target = await store.appendExtraLine(sql, tenant.id, stage.id, {
            description: wording, amountCents: existing.approvedCents, variationId: id,
          }, { expectedVersion: parsed.data.expectedStageVersion, actor, guard: notOnAnInvoice, jobId: job.id });
        } else {
          const items = [{
            id: newItemId(), type: 'line', description: wording, quantityMilli: 1000, unit: null,
            unitCents: existing.approvedCents, source: 'variation', costCents: null, refs: [{ t: 'v', id }],
          }];
          target = await store.createStage(sql, tenant.id, job.id, null, actor, {
            prepare: async (tx) => {
              await notOnAnInvoice(tx);
              return itemisedInput({ title: wording.slice(0, 200), retentionBp: null, plannedDate: null, note: null }, items);
            },
          });
        }
        await journal(me, 'customer_invoice.variation_billed', {
          jobId: job.id, targetId: id,
          summary: parsed.data.stageId
            ? `Put variation ${number} on the stage "${target.title}" (${job.name || job.id})`
            : `Put variation ${number} on an invoice of its own (${job.name || job.id})`,
          metadata: { number, invoiceId: target.id },
        });
        return res.status(201).json(await jobPayload(sql, tenant, job));
      } catch (e) {
        // A conflict here is about the VARIATION (or the stage it was going on).
        if (e instanceof store.StoreConflict && e.reason === 'not_found' && action !== 'variation-bill') {
          return res.status(404).json({ error: 'variation_not_found' });
        }
        throw e;
      }
    }

    // ── payment-claim wording on this job's invoices (#1164) ─────────────────
    if (req.method === 'PUT' && action === 'payment-claim') {
      const parsed = PaymentClaimBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      await store.saveProfile(sql, tenant.id, job.id, { paymentClaim: parsed.data.on }, {
        expectedVersion: parsed.data.expectedVersion, actor,
      });
      await journal(me, 'customer_invoice.profile_updated', {
        jobId: job.id, targetId: job.id,
        summary: `Turned payment-claim wording ${parsed.data.on ? 'on' : 'off'} for ${job.name || job.id}`,
        metadata: { fields: ['paymentClaim'], on: parsed.data.on },
      });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    // ── per-job profile (retention %) ────────────────────────────────────────
    if (req.method === 'PUT' && action === 'profile') {
      const parsed = ProfileBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      await store.saveProfile(sql, tenant.id, job.id, { retentionBp: parsed.data.retentionBp }, {
        expectedVersion: parsed.data.expectedVersion, actor,
      });
      await journal(me, 'customer_invoice.profile_updated', {
        jobId: job.id, targetId: job.id,
        summary: `Updated invoicing set-up on ${job.name || job.id}`,
        metadata: { fields: ['retentionBp'] },
      });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    // ── a planned stage that releases retention held (#1150) ─────────────────
    if (req.method === 'POST' && action === 'retention-release') {
      const parsed = ReleaseBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const [profile, rows] = await Promise.all([
        store.getProfile(sql, tenant.id, job.id),
        store.listJobInvoices(sql, tenant.id, job.id),
      ]);
      const held = jobTotals(rows, { contractCents: contractCentsOf(job.contractValue), retentionBp: profile ? profile.retentionBp : 0 }).retentionHeldCents;
      // Releases already planned (or mid-send) are spoken for.
      const pending = rows
        .filter((r) => r.kind === 'retention_release' && r.state !== 'sent')
        .reduce((s, r) => s + (Number.isInteger(r.grossCents) ? r.grossCents : r.amountCents || 0), 0);
      if (parsed.data.amountCents > held - pending) {
        return res.status(409).json({ error: 'exceeds_retention_held', heldCents: held, alreadyPlannedCents: pending });
      }
      const row = await store.createStage(sql, tenant.id, job.id, {
        kind: 'retention_release',
        title: parsed.data.title || 'Retention release',
        basis: 'amount',
        amountCents: parsed.data.amountCents,
        percentBp: null,
        extraLines: [],
        retentionBp: 0,
        plannedDate: null,
        note: null,
      }, actor);
      await journal(me, 'customer_invoice.stage_added', {
        jobId: job.id, targetId: row.id,
        summary: `Added a retention release to ${job.name || job.id}`,
        metadata: { basis: 'amount', kind: 'retention_release' },
      });
      return res.status(201).json(await jobPayload(sql, tenant, job));
    }

    // ── "Check Xero now" for one job (#1151) ─────────────────────────────────
    if (req.method === 'POST' && action === 'refresh') {
      const parsed = RefreshBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const summary = await statusSvc.refreshJob({ tenant, job, deps: { sql } });
      await journal(me, 'customer_invoice.status_checked', {
        jobId: job.id, targetId: job.id,
        summary: `Checked Xero for ${job.name || job.id}'s invoices — ${summary.checked} checked, ${summary.changed} changed`,
        metadata: { checked: summary.checked, changed: summary.changed, notFound: summary.notFound },
      });
      return res.status(200).json({
        ...(await jobPayload(sql, tenant, job)),
        refresh: { checked: summary.checked, changed: summary.changed, notFound: summary.notFound },
      });
    }

    // ── preview / send / retry / reset / raise again (#1150) ─────────────────
    if (req.method === 'POST' && ['preview', 'send', 'retry', 'reset', 'raise-again'].includes(action)) {
      if (!uuid.safeParse(id).success) return res.status(400).json({ error: 'id required' });
      const schema = action === 'preview' ? PreviewBody : action === 'send' ? SendBody : NoBody;
      const parsed = schema.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const invoice = await store.getInvoice(sql, tenant.id, id);
      if (!invoice || invoice.state === 'cancelled') return res.status(404).json({ error: 'stage_not_found' });
      const job = await liveJob(invoice.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });

      if (action === 'preview') {
        return res.status(200).json(await sendSvc.preview({ tenant, invoice, job, options: parsed.data, deps: { sql } }));
      }

      if (action === 'raise-again') {
        // Two cases, both leaving the old number untouched (never reused):
        //   * the number was TAKEN in Xero before anything of ours existed
        //     (#1150) — the stage is cancelled and drops off the list;
        //   * the invoice WAS sent and Xero now shows it deleted or voided
        //     (#1151) — the old row stays as history, marked as replaced.
        const taken = invoice.state === 'failed' && invoice.failureCategory === 'number_taken';
        const dead = invoice.state === 'sent' && (invoice.xeroStatus === 'DELETED' || invoice.xeroStatus === 'VOIDED') && !invoice.replacedById;
        if (!taken && !dead) return res.status(409).json({ error: 'not_raisable' });
        const fresh = taken
          ? await store.raiseAgain(sql, tenant.id, id, { actor })
          : await store.raiseAgainSent(sql, tenant.id, id, { actor });
        await journal(me, 'customer_invoice.raised_again', {
          jobId: job.id, targetId: fresh.id,
          summary: taken
            ? `Raised "${fresh.title}" again on ${job.name || job.id} — ${invoice.invoiceNumber} is taken in Xero`
            : `Raised "${fresh.title}" again on ${job.name || job.id} — ${invoice.invoiceNumber} was ${invoice.xeroStatus === 'DELETED' ? 'deleted' : 'voided'} in Xero`,
          metadata: { burnedNumber: invoice.invoiceNumber, replaces: invoice.id, ...(dead ? { xeroStatus: invoice.xeroStatus } : {}) },
        });
        return res.status(201).json(await jobPayload(sql, tenant, job));
      }

      const run =
        action === 'send'
          ? sendSvc.send({ tenant, invoice, job, options: parsed.data, actor, deps: { sql } })
          : action === 'retry'
            ? sendSvc.retry({ tenant, invoice, job, actor, deps: { sql } })
            : sendSvc.reset({ tenant, invoice, job, actor, deps: { sql } });
      const result = await run;
      if (result.outcome === 'blocked') return res.status(409).json({ error: 'blocked', blockers: result.blockers });

      const landed = result.outcome === 'sent' || result.outcome === 'adopted';
      const verb =
        action === 'reset' && result.outcome === 'reset' ? 'customer_invoice.send_reset'
          : action === 'send' ? (landed ? 'customer_invoice.sent_to_xero' : 'customer_invoice.send_failed')
            : 'customer_invoice.send_retried';
      const number = result.invoiceNumber || invoice.invoiceNumber || null;
      await journal(me, verb, {
        jobId: job.id, targetId: invoice.id,
        summary:
          result.outcome === 'sent' ? `Sent ${number} to Xero as a draft (${job.name || job.id})`
            : result.outcome === 'adopted' ? `${number} was already in Xero — taken over, nothing sent twice (${job.name || job.id})`
              : result.outcome === 'reset' ? `Put "${invoice.title}" back to planned on ${job.name || job.id} — nothing reached Xero`
                : result.outcome === 'unknown' ? `No answer from Xero for ${number} (${job.name || job.id}) — it may or may not exist there`
                  : `Xero refused ${number} (${job.name || job.id})`,
        metadata: {
          outcome: result.outcome,
          invoiceNumber: number,
          ...(result.xeroInvoiceId ? { xeroInvoiceId: result.xeroInvoiceId } : {}),
          ...(result.category ? { category: result.category } : {}),
          ...(landed ? { verified: !!result.verified } : {}),
        },
      });
      const syncLogWarning = await syncBridge.recordSendOutcome({ invoiceId: invoice.id, result });
      return res.status(200).json({
        ...(await jobPayload(sql, tenant, job)),
        send: {
          outcome: result.outcome,
          invoiceNumber: number,
          verified: landed ? !!result.verified : null,
          mismatches: landed ? result.mismatches || [] : [],
          category: result.category || null,
          detail: result.detail || null,
        },
        ...(syncLogWarning ? { syncLogWarning } : {}),
      });
    }

    // ── the job's client in Xero (#1149) ─────────────────────────────────────
    if (req.method === 'GET' && action === 'contacts') {
      xero.assertReady(await xero.readiness({ sql }));
      const contacts = await xero.searchContacts(String(q.q || ''), { sql });
      return res.status(200).json({ contacts });
    }

    if (req.method === 'PUT' && action === 'contact-link') {
      const parsed = ContactLinkBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const ready = await xero.readiness({ sql });
      xero.assertReady(ready);
      // The link is confirmed against Xero, and the stored name is Xero's own
      // — never whatever the browser sent (ADR rule 8).
      const contact = await xero.getContact(parsed.data.contactId, { sql });
      if (!contact) return res.status(404).json({ error: 'contact_not_found' });
      if (contact.status && contact.status !== 'ACTIVE') return res.status(409).json({ error: 'contact_not_active' });
      await store.saveProfile(sql, tenant.id, job.id, {
        xeroContactId: contact.id,
        xeroContactName: contact.name,
        externalTenantId: ready.externalTenantId,
      }, { expectedVersion: parsed.data.expectedVersion, actor });
      await journal(me, 'customer_invoice.profile_updated', {
        jobId: job.id, targetId: job.id,
        summary: `Linked ${job.name || job.id} to the Xero contact "${contact.name}"`,
        metadata: { fields: ['xeroContact'], xeroContactId: contact.id },
      });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    if (req.method === 'PUT' && action === 'contact-unlink') {
      const parsed = ContactUnlinkBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      await store.saveProfile(sql, tenant.id, job.id, {
        xeroContactId: null, xeroContactName: null, externalTenantId: null,
      }, { expectedVersion: parsed.data.expectedVersion, actor });
      await journal(me, 'customer_invoice.profile_updated', {
        jobId: job.id, targetId: job.id,
        summary: `Removed the Xero contact link from ${job.name || job.id}`,
        metadata: { fields: ['xeroContact'] },
      });
      return res.status(200).json(await jobPayload(sql, tenant, job));
    }

    // ── invoice defaults for the connected organisation (#1149) ──────────────
    if (req.method === 'GET' && action === 'settings') {
      const ready = await xero.readiness({ sql });
      const settings = await store.getSettings(sql, tenant.id, ready.externalTenantId);
      return res.status(200).json({
        xero: { state: ready.state, organisationName: ready.organisationName },
        settings,
        complete: store.settingsComplete(settings),
      });
    }

    if (req.method === 'GET' && action === 'settings-options') {
      xero.assertReady(await xero.readiness({ sql }));
      const [accounts, taxRates] = await Promise.all([xero.salesAccounts({ sql }), xero.taxRates({ sql })]);
      return res.status(200).json({ accounts, taxRates });
    }

    if (req.method === 'PUT' && action === 'settings') {
      const parsed = SettingsBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const ready = await xero.readiness({ sql });
      xero.assertReady(ready);
      // Both choices must exist in Xero NOW; their names and the rate are
      // taken from Xero, so the browser can't store a made-up account or rate.
      const [accounts, taxRates] = await Promise.all([xero.salesAccounts({ sql }), xero.taxRates({ sql })]);
      const account = accounts.find((a) => a.code === parsed.data.salesAccountCode);
      if (!account) return res.status(409).json({ error: 'account_not_in_xero' });
      const tax = taxRates.find((t) => t.taxType === parsed.data.taxType);
      if (!tax) return res.status(409).json({ error: 'tax_rate_not_in_xero' });
      const settings = await store.saveSettings(sql, tenant.id, ready.externalTenantId, {
        salesAccountCode: account.code,
        salesAccountName: account.name,
        taxType: tax.taxType,
        taxName: tax.name,
        taxRateBp: tax.rateBp,
        paymentTermsDays: parsed.data.paymentTermsDays,
      }, { expectedVersion: parsed.data.expectedVersion, actor });
      await journal(me, 'customer_invoice.settings_updated', {
        targetId: 'settings',
        summary: `Changed the invoice defaults for ${ready.organisationName || 'the connected Xero organisation'}`,
        metadata: { salesAccountCode: account.code, taxType: tax.taxType, paymentTermsDays: parsed.data.paymentTermsDays },
      });
      return res.status(200).json({
        xero: { state: ready.state, organisationName: ready.organisationName },
        settings,
        complete: store.settingsComplete(settings),
      });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    if (e instanceof billable.BillableError) return billableResponse(res, e);
    if (e instanceof store.StoreConflict) return conflictResponse(res, e);
    if (e instanceof XeroError) return xeroFailure(res, e);
    console.error('[customer-invoices] request failed', { action, code: (e && e.code) || 'error' });
    return res.status(500).json({ error: 'server_error' });
  }
}

module.exports = withErrorCapture(handler, 'customer-invoices');
