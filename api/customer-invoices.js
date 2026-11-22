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
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getDb } = require('./_lib/supabase-db');
const auditLog = require('./_lib/audit-log');
const { withErrorCapture } = require('./_lib/error-wrap');
const store = require('./_lib/customer-invoices/store');
const { MAX_CENTS, BP_WHOLE, contractCentsOf, computeStage, jobTotals } = require('./_lib/customer-invoices/amounts');
const { displayStatus } = require('./_lib/customer-invoices/status');
const xero = require('./_lib/customer-invoices/xero-lookups');
const sendSvc = require('./_lib/customer-invoices/xero-send');
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
  };
}

async function jobPayload(sql, tenant, job) {
  const [profile, rows] = await Promise.all([
    store.getProfile(sql, tenant.id, job.id),
    store.listJobInvoices(sql, tenant.id, job.id),
  ]);
  const ctx = {
    contractCents: contractCentsOf(job.contractValue),
    retentionBp: profile ? profile.retentionBp : 0,
  };
  const today = sydneyToday();
  return {
    jobId: job.id,
    job: {
      name: job.name || job.id,
      code: typeof job.code === 'string' ? job.code : null,
      clientName: typeof job.clientName === 'string' && job.clientName ? job.clientName : null,
      contractCents: ctx.contractCents,
    },
    profile: profile || { jobId: job.id, retentionBp: 0, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: null },
    stages: rows.map((r) => presentStage(r, ctx, today)),
    totals: jobTotals(rows, ctx),
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

function conflictResponse(res, e) {
  if (e.reason === 'not_found') return res.status(404).json({ error: 'stage_not_found' });
  if (e.reason === 'not_planned') return res.status(409).json({ error: 'stage_not_editable' });
  // Two stages of one job sent at the same instant: the second loses the number.
  if (e.reason === 'number_clash') return res.status(409).json({ error: 'number_clash' });
  if (e.reason === 'not_resettable' || e.reason === 'not_raisable') return res.status(409).json({ error: e.reason });
  return res.status(409).json({ error: 'stale_version' });
}

async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const action = String(q.action || '');

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
      const parsed = AddBody.safeParse(body);
      if (!parsed.success) return invalid(res, parsed);
      const job = await liveJob(parsed.data.jobId);
      if (!job) return res.status(404).json({ error: 'job_not_found' });
      const row = await store.createStage(sql, tenant.id, job.id, stageInput(parsed.data.stage), actor);
      await journal(me, 'customer_invoice.stage_added', {
        jobId: job.id, targetId: row.id,
        summary: `Added stage invoice "${row.title}" to ${job.name || job.id}`,
        metadata: { basis: row.basis },
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
        const parsed = EditBody.safeParse(body);
        if (!parsed.success) return invalid(res, parsed);
        const row = await store.updateStage(sql, tenant.id, id, stageInput(parsed.data.stage), {
          expectedVersion: parsed.data.expectedVersion, actor,
        });
        await journal(me, 'customer_invoice.stage_edited', {
          jobId: job.id, targetId: row.id,
          summary: `Edited stage invoice "${row.title}" on ${job.name || job.id}`,
          metadata: { basis: row.basis },
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
        // Only for a stage whose number Xero says is taken by something else.
        if (invoice.state !== 'failed' || invoice.failureCategory !== 'number_taken') {
          return res.status(409).json({ error: 'not_raisable' });
        }
        const fresh = await store.raiseAgain(sql, tenant.id, id, { actor });
        await journal(me, 'customer_invoice.raised_again', {
          jobId: job.id, targetId: fresh.id,
          summary: `Raised "${fresh.title}" again on ${job.name || job.id} — ${invoice.invoiceNumber} is taken in Xero`,
          metadata: { burnedNumber: invoice.invoiceNumber, replaces: invoice.id },
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
    if (e instanceof store.StoreConflict) return conflictResponse(res, e);
    if (e instanceof XeroError) return xeroFailure(res, e);
    console.error('[customer-invoices] request failed', { action, code: (e && e.code) || 'error' });
    return res.status(500).json({ error: 'server_error' });
  }
}

module.exports = withErrorCapture(handler, 'customer-invoices');
