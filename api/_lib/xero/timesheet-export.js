// Draft-timesheet export service (#249) — the first Xero WRITE. Exports a
// LOCKED payroll batch's immutable snapshot to Xero Payroll AU as DRAFT
// timesheets (one per employee), then reads each back and reconciles it.
//
// Non-negotiables (payroll-boundary ADR #609 + the M4 review amendments):
//   * source is the LOCKED batch snapshot — never live time entries;
//   * a durable `pending` event is written BEFORE every POST (no unrecorded
//     write); the attempt row is IMMUTABLE, inserted with its terminal outcome;
//   * `accepted_by_xero` (POST 200) and `verified_against_xero` (readback
//     matched) are DISTINCT — success is only reported after reconciliation;
//   * idempotency by (org, employee, period) → content hash: unchanged = skip,
//     changed-for-an-already-accepted-worker = BLOCKED into a correction
//     (never a blind overwrite-by-match);
//   * partial success is itemised; failed workers stay retry-eligible; only
//     accepted+verified workers get the compatibility exportId stamp;
//   * DRAFT only. No pay runs / approval / STP / tax / super / payslips.

const crypto = require('crypto');
const { getDb } = require('../supabase-db');
const store = require('./token-store');
const { xeroFetch } = require('./client');
const { XeroError } = require('./errors');
const { PAYROLL_AU_BASE, hasTimesheetWriteScope } = require('./config');
const { buildTimesheets, contentHashOf } = require('./timesheet-payload');
const { readEntry, writeEntry, appendAudit } = require('../time-entries');
const { toCsv } = require('../payroll-csv');

function db(sql, mode) {
  return sql || getDb({ mode: mode || 'write' });
}

// postgres 'date'/'timestamp' → 'YYYY-MM-DD' (dates come back as Date objects)
function toDateStr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }

// jsonb event detail comes back parsed, but tolerate a text column too.
function parseDetail(d) {
  if (d == null) return {};
  if (typeof d === 'string') { try { return JSON.parse(d); } catch { return {}; } }
  return d;
}

async function currentConnection(deps = {}) {
  const s = deps.store || store;
  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  if (row.status === 'pending_selection' || !row.external_tenant_id) throw new XeroError('pending_selection');
  if (row.status === 'reconnect_required') throw new XeroError('reconnect_required');
  return row;
}

function normalisePayload(payload) {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return null; }
}

/** Cached Xero employees + calendars for this org (mapping/validation only). */
async function loadReference(sql, conn) {
  const rows = await sql`
    select kind, xero_id, name, active, payload
    from public.xero_reference_items
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind in ('employee', 'payroll_calendar')
  `;
  const employeesById = new Map();
  const calendarsById = new Map();
  for (const r of rows) {
    const v = { name: r.name, active: r.active, payload: normalisePayload(r.payload) };
    if (r.kind === 'employee') employeesById.set(r.xero_id, v);
    else calendarsById.set(r.xero_id, v);
  }
  return { employeesById, calendarsById };
}

function mapItem(r) {
  return {
    workerId: r.worker_id,
    workerName: r.worker_name,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    earningsRateId: r.earnings_rate_id,
    earningsRateName: r.earnings_rate_name,
    entryDate: toDateStr(r.entry_date),
    hours: Number(r.hours),
  };
}

async function loadBatch(sql, batchId) {
  const rows = await sql`select * from public.payroll_batches where id = ${batchId}`;
  return rows.length ? rows[0] : null;
}
async function loadItems(sql, batchId) {
  const rows = await sql`
    select * from public.payroll_batch_items where batch_id = ${batchId}
    order by worker_name, entry_date
  `;
  return rows.map(mapItem);
}

/** Latest ACCEPTED attempt for a worker-period — the idempotency anchor. */
async function latestAccepted(sql, { externalTenantId, employeeId, periodStart, periodEnd }) {
  if (!employeeId) return null;
  const rows = await sql`
    select * from public.payroll_batch_timesheet_attempts
    where external_tenant_id = ${externalTenantId}
      and employee_id = ${employeeId}
      and period_start = ${periodStart} and period_end = ${periodEnd}
      and outcome = 'accepted'
    order by created_at desc
    limit 1
  `;
  return rows.length ? rows[0] : null;
}

/** Latest lifecycle event for a worker in a batch (current per-worker status). */
async function latestEvent(sql, { batchId, workerId }) {
  const rows = await sql`
    select event, attempt_id, detail, created_at
    from public.payroll_batch_timesheet_events
    where batch_id = ${batchId} and worker_id = ${workerId}
    order by created_at desc limit 1
  `;
  return rows.length ? rows[0] : null;
}

async function insertEvent(sql, { tenantId, batchId, attemptId, workerId, event, detail }) {
  await sql`
    insert into public.payroll_batch_timesheet_events
      (tenant_id, batch_id, attempt_id, worker_id, event, detail)
    values (${tenantId}, ${batchId}, ${attemptId || null}, ${workerId}, ${event},
      ${detail ? JSON.stringify(detail) : null}::jsonb)
  `;
}

async function insertAttempt(sql, a) {
  await sql`
    insert into public.payroll_batch_timesheet_attempts (
      id, tenant_id, batch_id, external_tenant_id, worker_id, worker_name,
      employee_id, period_start, period_end, content_hash, request_hash,
      xero_timesheet_id, correlation_id, http_status, outcome,
      error_category, error_detail, actor_legacy_id, actor_name
    ) values (
      ${a.id}, ${a.tenantId}, ${a.batchId}, ${a.externalTenantId}, ${a.workerId}, ${a.workerName},
      ${a.employeeId || null}, ${a.periodStart}, ${a.periodEnd}, ${a.contentHash}, ${a.requestHash || null},
      ${a.xeroTimesheetId || null}, ${a.correlationId || null}, ${a.httpStatus == null ? null : a.httpStatus}, ${a.outcome},
      ${a.errorCategory || null}, ${a.errorDetail || null},
      ${a.actor ? String(a.actor.id) : null}, ${a.actor ? String(a.actor.name || a.actor.username || '') : null}
    )
  `;
}

// ── assembly (shared by preview / export / retry) ────────────────────────────

async function assemble({ batchId, deps = {} }) {
  const sql = db(deps.sql, 'read');
  const conn = await currentConnection(deps);
  const batch = await loadBatch(sql, batchId);
  if (!batch) throw new XeroError('validation', { detail: 'unknown_batch' });
  if (batch.external_tenant_id !== conn.external_tenant_id) {
    throw new XeroError('conflict', { detail: 'org_mismatch' });
  }
  const [items, reference] = await Promise.all([loadItems(sql, batchId), loadReference(sql, conn)]);
  const periodStart = toDateStr(batch.period_start);
  const periodEnd = toDateStr(batch.period_end);
  const built = buildTimesheets({
    items, periodStart, periodEnd,
    employeesById: reference.employeesById,
    calendarsById: reference.calendarsById,
  });
  return { conn, batch, periodStart, periodEnd, built };
}

/** Per-worker idempotency verdict against prior accepted attempts. */
async function verdictFor(sql, conn, w, periodStart, periodEnd) {
  if (!w.aligned) return { verdict: 'blocked', blocker: w.blocker };
  const prior = await latestAccepted(sql, {
    externalTenantId: conn.external_tenant_id, employeeId: w.employeeId, periodStart, periodEnd,
  });
  if (!prior) return { verdict: 'send' };
  if (prior.content_hash === w.contentHash) {
    return { verdict: 'skip', priorTimesheetId: prior.xero_timesheet_id };
  }
  // Changed content for a worker Xero already accepted — NEVER overwrite by
  // employee+period. Block into an explicit correction (a correction batch,
  // or an operator-confirmed owned-TimesheetID update — not done here).
  return { verdict: 'requires_correction', priorTimesheetId: prior.xero_timesheet_id, priorHash: prior.content_hash };
}

// ── preview (no write) ───────────────────────────────────────────────────────

async function previewExport({ batchId, deps = {} }) {
  const sql = db(deps.sql, 'read');
  const { conn, batch, periodStart, periodEnd, built } = await assemble({ batchId, deps });
  const workers = [];
  for (const w of built.workers) {
    const v = await verdictFor(sql, conn, w, periodStart, periodEnd);
    workers.push({
      workerId: w.workerId, workerName: w.workerName,
      employeeId: w.employeeId, employeeName: w.employeeName,
      calendarName: w.calendarName || null, period: w.period || null,
      totalUnits: w.totalUnits, dayCount: w.dayCount,
      aligned: w.aligned, blocker: w.blocker || null,
      verdict: v.verdict, priorTimesheetId: v.priorTimesheetId || null,
      timesheet: w.timesheet, contentHash: w.contentHash,
    });
  }
  return {
    org: { externalTenantId: conn.external_tenant_id, status: conn.status },
    batch: {
      id: batch.id, periodStart, periodEnd, status: batch.status,
      sourceHash: batch.source_hash, itemCount: batch.item_count, totalHours: Number(batch.total_hours),
      locked: ['locked', 'exporting', 'partially_exported', 'exported'].includes(batch.status),
    },
    workers,
    counts: summarise(workers),
  };
}

function summarise(workers) {
  const c = { total: workers.length, toSend: 0, toSkip: 0, blocked: 0, requiresCorrection: 0 };
  for (const w of workers) {
    if (w.verdict === 'send') c.toSend += 1;
    else if (w.verdict === 'skip') c.toSkip += 1;
    else if (w.verdict === 'requires_correction') c.requiresCorrection += 1;
    else c.blocked += 1;
  }
  return c;
}

// ── export (the write) ───────────────────────────────────────────────────────

async function exportBatch({ batchId, actor, deps = {} }) {
  const wsql = db(deps.sql, 'write');
  // Lock the batch into 'exporting' via CAS (locked→exporting). An already-
  // exporting batch resumes; anything else is a conflict.
  const pre = await loadBatch(wsql, batchId);
  if (!pre) throw new XeroError('validation', { detail: 'unknown_batch' });
  if (pre.status === 'locked') {
    const moved = await wsql`
      update public.payroll_batches set status = 'exporting'
      where id = ${batchId} and status = 'locked' returning id
    `;
    if (!moved.length) throw new XeroError('conflict', { detail: 'export_race' });
  } else if (pre.status !== 'exporting' && pre.status !== 'partially_exported') {
    throw new XeroError('conflict', { detail: `batch_${pre.status}` });
  }

  return runWorkers({ batchId, actor, deps, onlyRetryable: false });
}

async function retryExport({ batchId, actor, deps = {} }) {
  const wsql = db(deps.sql, 'write');
  const pre = await loadBatch(wsql, batchId);
  if (!pre) throw new XeroError('validation', { detail: 'unknown_batch' });
  if (!['exporting', 'partially_exported'].includes(pre.status)) {
    throw new XeroError('conflict', { detail: `batch_${pre.status}` });
  }
  return runWorkers({ batchId, actor, deps, onlyRetryable: true });
}

async function runWorkers({ batchId, actor, deps, onlyRetryable }) {
  const wsql = db(deps.sql, 'write');
  const { conn, batch, periodStart, periodEnd, built } = await assemble({ batchId, deps: { ...deps, sql: wsql } });
  // Pre-flight the WRITE scope: a connection minted before #249 (or without the
  // export flag on at connect) can't POST timesheets. Fail loudly with a
  // reconnect message BEFORE any attempt row — never a raw Xero 403 mid-batch.
  if (!hasTimesheetWriteScope(conn.granted_scopes)) {
    throw new XeroError('reconnect_required', { detail: 'missing_write_scope' });
  }
  const results = [];

  for (const w of built.workers) {
    w._ps = periodStart; w._pe = periodEnd; // batch period — every attempt row is stamped with it (non-null even when blocked)
    const last = await latestEvent(wsql, { batchId, workerId: w.workerId });
    const alreadyVerified = last && last.event === 'verified_against_xero';
    if (onlyRetryable && alreadyVerified) { results.push({ worker: w.workerName, outcome: 'skipped', reason: 'already_verified' }); continue; }

    const v = await verdictFor(wsql, conn, w, periodStart, periodEnd);

    if (v.verdict === 'blocked') { results.push(await recordBlocked(wsql, { conn, batchId, w, actor, blocker: v.blocker })); continue; }
    if (v.verdict === 'requires_correction') { results.push(await recordBlocked(wsql, { conn, batchId, w, actor, blocker: { code: 'requires_correction', message: `${w.workerName} was already exported with different hours — create a correction batch; the existing Xero timesheet is never overwritten by matching employee+period.`, priorTimesheetId: v.priorTimesheetId }, outcome: 'blocked' })); continue; }
    if (v.verdict === 'skip') {
      // Unchanged content Xero already ACCEPTED — never re-POST. If it isn't
      // verified yet (a crash between accept and readback, or an earlier drift),
      // re-run the READBACK against the recorded timesheet id; otherwise it is a
      // genuine no-op skip. This holds for export AND retry.
      if (alreadyVerified) { results.push({ worker: w.workerName, outcome: 'skipped', reason: 'already_verified', xeroTimesheetId: v.priorTimesheetId || null }); continue; }
      results.push(await reconcileWorker(wsql, { conn, batchId, w, actor, attemptId: last && last.attempt_id, xeroId: v.priorTimesheetId, deps })); continue;
    }

    // SEND. Pre-generate the attempt id so a durable 'pending' event (with the
    // hashes) exists BEFORE the POST — a crash after the POST is reconcilable.
    const attemptId = crypto.randomUUID();
    // Payroll AU 1.0 POST bodies are BARE ARRAYS — the {"Timesheets": [...]}
    // envelope exists only in RESPONSES. Sending the envelope produced
    // "Cannot deserialize the current JSON object into type
    // UpdateTimesheetRequest" (find #5 of the first live proving run).
    const body = [w.timesheet];
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
    await insertEvent(wsql, {
      tenantId: conn.tenant_id, batchId, attemptId, workerId: w.workerId, event: 'pending',
      detail: { employeeId: w.employeeId, contentHash: w.contentHash, requestHash, period: { periodStart, periodEnd } },
    });

    let resp, err;
    try {
      resp = await xeroFetch(`${PAYROLL_AU_BASE}/Timesheets`, { method: 'POST', body, deps });
    } catch (e) { err = e; }

    if (err) {
      const cat = err instanceof XeroError ? err.category : 'unexpected';
      const retryable = err instanceof XeroError ? err.retryable : false;
      await insertAttempt(wsql, attempt(conn, batchId, w, {
        id: attemptId, requestHash, outcome: 'error', errorCategory: cat,
        errorDetail: err instanceof XeroError ? err.message : 'unexpected', correlationId: err && err.correlationId, httpStatus: err && err.status, actor,
      }));
      await insertEvent(wsql, { tenantId: conn.tenant_id, batchId, attemptId, workerId: w.workerId, event: retryable ? 'retry_required' : 'rejected', detail: { category: cat } });
      results.push({ worker: w.workerName, outcome: retryable ? 'retry_required' : 'rejected', category: cat });
      continue;
    }

    const remote = firstTimesheet(resp && resp.data);
    const xeroId = remote && (remote.TimesheetID || remote.TimesheetId);
    if (!xeroId) {
      await insertAttempt(wsql, attempt(conn, batchId, w, { id: attemptId, requestHash, outcome: 'rejected', errorCategory: 'validation', errorDetail: 'no_timesheet_id_in_response', correlationId: resp && resp.correlationId, httpStatus: 200, actor }));
      await insertEvent(wsql, { tenantId: conn.tenant_id, batchId, attemptId, workerId: w.workerId, event: 'rejected', detail: { reason: 'no_timesheet_id' } });
      results.push({ worker: w.workerName, outcome: 'rejected', category: 'validation' });
      continue;
    }

    // accepted_by_xero — NOT yet reconciled.
    await insertAttempt(wsql, attempt(conn, batchId, w, { id: attemptId, requestHash, outcome: 'accepted', xeroTimesheetId: xeroId, correlationId: resp && resp.correlationId, httpStatus: 200, actor }));
    await insertEvent(wsql, { tenantId: conn.tenant_id, batchId, attemptId, workerId: w.workerId, event: 'accepted_by_xero', detail: { xeroTimesheetId: xeroId, correlationId: resp && resp.correlationId } });

    // readback reconciliation — a POST 200 is not "verified".
    const recon = await reconcile({ xeroId, sent: w.timesheet, deps });
    await insertEvent(wsql, {
      tenantId: conn.tenant_id, batchId, attemptId, workerId: w.workerId,
      event: recon.verified ? 'verified_against_xero' : 'drifted',
      detail: recon.verified ? { xeroTimesheetId: xeroId } : { xeroTimesheetId: xeroId, mismatches: recon.mismatches },
    });

    if (recon.verified) {
      await stampWorkerEntries({ batchId, workerId: w.workerId, actor }).catch(() => {});
      results.push({ worker: w.workerName, outcome: 'verified', xeroTimesheetId: xeroId, correlationId: resp && resp.correlationId });
    } else {
      results.push({ worker: w.workerName, outcome: 'drifted', xeroTimesheetId: xeroId, mismatches: recon.mismatches });
    }
  }

  // Batch outcome from the full per-worker event picture.
  const finalStatus = await settleBatchStatus(wsql, { batchId, built });
  return { batch: { id: batchId, status: finalStatus, periodStart, periodEnd }, workers: results };
}

function attempt(conn, batchId, w, over) {
  return {
    tenantId: conn.tenant_id, batchId, externalTenantId: conn.external_tenant_id,
    workerId: w.workerId, workerName: w.workerName, employeeId: w.employeeId,
    periodStart: w._ps, periodEnd: w._pe, // the batch period, always non-null
    contentHash: w.contentHash || 'none', ...over,
  };
}

async function recordBlocked(sql, { conn, batchId, w, actor, blocker, outcome }) {
  const id = crypto.randomUUID();
  await insertAttempt(sql, attempt(conn, batchId, w, { id, outcome: outcome || 'blocked', errorCategory: 'validation', errorDetail: blocker && blocker.code, actor }));
  await insertEvent(sql, { tenantId: conn.tenant_id, batchId, attemptId: id, workerId: w.workerId, event: 'rejected', detail: { blocker } });
  return { worker: w.workerName, outcome: 'blocked', blocker };
}

/** Read the recorded draft back and record verified/drifted — NEVER a POST.
 *  Shared by the export/retry skip path and reconcileExport. */
async function reconcileWorker(sql, { conn, batchId, w, actor, attemptId, xeroId, deps }) {
  if (!xeroId) return { worker: w.workerName, outcome: 'unable_to_verify', reason: 'no_recorded_timesheet_id' };
  const recon = await reconcile({ xeroId, sent: w.timesheet, deps });
  await insertEvent(sql, {
    tenantId: conn.tenant_id, batchId, attemptId: attemptId || null, workerId: w.workerId,
    event: recon.verified ? 'verified_against_xero' : 'drifted',
    detail: recon.verified
      ? { xeroTimesheetId: xeroId, reconcile: true }
      : { xeroTimesheetId: xeroId, mismatches: recon.mismatches, reconcile: true },
  });
  if (recon.verified) {
    await stampWorkerEntries({ batchId, workerId: w.workerId, actor }).catch(() => {});
    return { worker: w.workerName, outcome: 'verified', xeroTimesheetId: xeroId };
  }
  return { worker: w.workerName, outcome: 'drifted', xeroTimesheetId: xeroId, mismatches: recon.mismatches };
}

function firstTimesheet(data) {
  if (!data) return null;
  const arr = data.Timesheets || data.timesheets;
  if (Array.isArray(arr) && arr.length) return arr[0];
  // Payroll AU answers single-resource GETs with a SINGULAR `Timesheet` key
  // (proving-run find #6: every readback of a freshly accepted draft parsed
  // as empty → honest-but-wrong 'drifted: readback_empty').
  const one = data.Timesheet || data.timesheet;
  return one && typeof one === 'object' ? one : null;
}

/** Read the draft back and compare field-by-field (employee/period/status/lines). */
async function reconcile({ xeroId, sent, deps }) {
  let got;
  try {
    const resp = await xeroFetch(`${PAYROLL_AU_BASE}/Timesheets/${xeroId}`, { deps });
    got = firstTimesheet(resp && resp.data);
  } catch (e) {
    return { verified: false, mismatches: [`readback_failed:${e instanceof XeroError ? e.category : 'unexpected'}`] };
  }
  if (!got) return { verified: false, mismatches: ['readback_empty'] };
  const mism = [];
  if (str(got.EmployeeID) !== str(sent.EmployeeID)) mism.push('employee');
  if (dateOnly(got.StartDate) !== sent.StartDate) mism.push('start_date');
  if (dateOnly(got.EndDate) !== sent.EndDate) mism.push('end_date');
  if (String(got.Status || '').toUpperCase() !== 'DRAFT') mism.push(`status:${got.Status}`);
  if (lineSig(got.TimesheetLines) !== lineSig(sent.TimesheetLines)) mism.push('lines');
  return { verified: mism.length === 0, mismatches: mism };
}

function str(v) { return v == null ? null : String(v); }
function dateOnly(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/(\d{4}-\d{2}-\d{2})/) || v.match(/\/Date\((\d+)/);
  if (m && m[1] && m[1].includes('-')) return m[1];
  if (m && m[1]) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return null;
}
function lineSig(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => `${l.EarningsRateID}:${(l.NumberOfUnits || []).map((u) => Math.round(Number(u) * 100) / 100).join(',')}`)
    .sort().join('|');
}

/** Compatibility stamp — per-worker, only after accepted+verified. Best-effort. */
async function stampWorkerEntries({ batchId, workerId, actor }) {
  const rsql = getDb({ mode: 'read' });
  const rows = await rsql`
    select distinct entry_date from public.payroll_batch_items
    where batch_id = ${batchId} and worker_id = ${workerId}
  `;
  const stampedAt = new Date().toISOString();
  for (const r of rows) {
    const date = toDateStr(r.entry_date);
    const entry = await readEntry(workerId, date);
    if (!entry || entry.exportId) continue; // never re-stamp
    await writeEntry(workerId, { ...entry, exportedAt: stampedAt, exportId: String(batchId), updatedAt: stampedAt });
    await appendAudit(workerId, entry.id, 'exported', actor ? actor.id : 'system', String(batchId), null);
  }
}

/** Set the batch to exported / partially_exported from the per-worker events. */
async function settleBatchStatus(sql, { batchId, built }) {
  const verifiedWorkers = new Set();
  const events = await sql`
    select distinct on (worker_id) worker_id, event
    from public.payroll_batch_timesheet_events
    where batch_id = ${batchId}
    order by worker_id, created_at desc
  `;
  const byWorker = new Map(events.map((e) => [e.worker_id, e.event]));
  let allVerified = true;
  for (const w of built.workers) {
    if (byWorker.get(w.workerId) === 'verified_against_xero') verifiedWorkers.add(w.workerId);
    else allVerified = false;
  }
  const status = allVerified && built.workers.length ? 'exported' : 'partially_exported';
  // 'exporting' during a live export; 'partially_exported' when a later reconcile
  // finally verifies the last drifted worker. Never moves an 'exported' batch.
  await sql`update public.payroll_batches set status = ${status}
    where id = ${batchId} and status in ('exporting', 'partially_exported')`;
  return status;
}

// ── reconcile (re-verify accepted-but-unverified — NEVER a second POST) ───────

async function reconcileExport({ batchId, actor, deps = {} }) {
  const wsql = db(deps.sql, 'write');
  const pre = await loadBatch(wsql, batchId);
  if (!pre) throw new XeroError('validation', { detail: 'unknown_batch' });
  if (!['exporting', 'partially_exported', 'exported'].includes(pre.status)) {
    throw new XeroError('conflict', { detail: `batch_${pre.status}` });
  }
  const { conn, periodStart, periodEnd, built } = await assemble({ batchId, deps: { ...deps, sql: wsql } });
  const results = [];
  for (const w of built.workers) {
    w._ps = periodStart; w._pe = periodEnd;
    const last = await latestEvent(wsql, { batchId, workerId: w.workerId });
    // Only accepted-but-unverified workers are reconcilable. A verified/rejected/
    // pending/blocked worker has nothing to re-read; a not-yet-sent worker needs
    // an EXPORT, never a reconcile — we never POST here.
    if (!last || !['accepted_by_xero', 'drifted'].includes(last.event)) {
      results.push({ worker: w.workerName, outcome: last ? last.event : 'not_started', reason: 'nothing_to_reconcile' });
      continue;
    }
    const detail = parseDetail(last.detail);
    const xeroId = detail.xeroTimesheetId || detail.xero_timesheet_id;
    results.push(await reconcileWorker(wsql, { conn, batchId, w, actor, attemptId: last.attempt_id, xeroId, deps }));
  }
  const finalStatus = await settleBatchStatus(wsql, { batchId, built });
  return { batch: { id: batchId, status: finalStatus, periodStart, periodEnd }, workers: results };
}

// ── batch CSV fallback (pure PG read; works while Xero is disconnected) ────────

/** CSV built from the IMMUTABLE locked batch snapshot — never Xero, never a write. */
async function batchCsv({ batchId, deps = {} }) {
  const sql = db(deps.sql, 'read');
  const batch = await loadBatch(sql, batchId);
  if (!batch) return null;
  const rows = await sql`
    select worker_name, employee_id, work_type, earnings_rate_name, entry_date, job_name, hours
    from public.payroll_batch_items where batch_id = ${batchId}
    order by worker_name, entry_date, earnings_rate_name
  `;
  const from = toDateStr(batch.period_start);
  const to = toDateStr(batch.period_end);
  const cols = ['Pay Period Start', 'Pay Period End', 'Worker Name', 'Xero Employee ID', 'Work Type', 'Earnings Rate', 'Date', 'Hours'];
  const toCells = (r) => [from, to, r.worker_name, r.employee_id || '', r.work_type || '', r.earnings_rate_name || '', toDateStr(r.entry_date), round2(r.hours)];
  return {
    filename: `buhlos-payroll-batch-${String(batch.id).slice(0, 8)}-${from}-to-${to}.csv`,
    csv: toCsv(cols, rows, toCells),
    rowCount: rows.length,
    batch: { id: batch.id, status: batch.status, periodStart: from, periodEnd: to },
  };
}

/** Current export state for a batch — per-worker latest attempt + event. */
async function exportState({ batchId, deps = {} }) {
  const sql = db(deps.sql, 'read');
  await currentConnection(deps);
  const batch = await loadBatch(sql, batchId);
  if (!batch) return null;
  const [attempts, events] = await Promise.all([
    sql`select worker_id, worker_name, employee_id, xero_timesheet_id, correlation_id, outcome, error_category, created_at
        from public.payroll_batch_timesheet_attempts where batch_id = ${batchId} order by created_at desc`,
    sql`select worker_id, event, detail, created_at
        from public.payroll_batch_timesheet_events where batch_id = ${batchId} order by created_at desc`,
  ]);
  const latestEvent = new Map();
  for (const e of events) if (!latestEvent.has(e.worker_id)) latestEvent.set(e.worker_id, e);
  const latestAttempt = new Map();
  for (const a of attempts) if (!latestAttempt.has(a.worker_id)) latestAttempt.set(a.worker_id, a);
  const workers = [...latestAttempt.values()].map((a) => ({
    workerId: a.worker_id, workerName: a.worker_name, employeeId: a.employee_id,
    xeroTimesheetId: a.xero_timesheet_id, correlationId: a.correlation_id,
    lastOutcome: a.outcome, errorCategory: a.error_category,
    status: latestEvent.has(a.worker_id) ? latestEvent.get(a.worker_id).event : null,
  }));
  return {
    batch: { id: batch.id, status: batch.status, periodStart: toDateStr(batch.period_start), periodEnd: toDateStr(batch.period_end) },
    workers, attemptCount: attempts.length, eventCount: events.length,
  };
}

module.exports = {
  previewExport,
  exportBatch,
  retryExport,
  reconcileExport,
  batchCsv,
  exportState,
  reconcile,
  lineSig,
};
