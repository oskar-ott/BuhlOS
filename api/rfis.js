// api/rfis.js — #276 per-job RFI register (raise → send → answered → closed).
//
//   GET  /api/rfis?jobId=X                 → list (admin/manager)
//   POST /api/rfis?jobId=X                 → raise (assigns sequential ref, status open)
//   PATCH /api/rfis?jobId=X&id=R           → edit an open RFI (subject/question/askedOf/responseDue/links)
//   POST /api/rfis?jobId=X&action=send     → email it to the builder, stamp sentAt (open → sent)
//   POST /api/rfis?jobId=X&action=answer   → record the answer (… → answered)
//   POST /api/rfis?jobId=X&action=close    → close with an answer OR a no-longer-required reason
//
// Office-side: RFIs go to the builder, so this is admin/manager only — the field
// raises questions via Phil's "Question for office" chip (rfi-typed observations;
// converting one INTO an RFI is the next slice). Dark behind `rfi_register`.
// Per-job store jobs/<jobId>/rfis.json (like snags); no cross-job index in v1.
//
// "Send" performs a REAL email (api/_lib/email.js) and only stamps sentAt on a
// successful send — the status never claims sent without an actual send.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { append: appendAuditLog } = require('./_lib/audit-log');
const { sendEmail, isEmailConfigured, companyName } = require('./_lib/email');

const FLAG = 'rfi_register';

function rfisKey(jobId) { return 'jobs/' + jobId + '/rfis.json'; }
async function readRfis(jobId) { return await readBlob(rfisKey(jobId), { rfis: [] }); }
function newId() {
  return 'rfi_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function nextRef(existing) {
  let max = 0;
  for (const r of existing || []) {
    const m = /(\d+)\s*$/.exec((r && r.ref) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'RFI-' + String(max + 1).padStart(3, '0');
}
function dateOnly(raw) {
  const t = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function audit(user, jobId, action, id, summary, metadata) {
  return appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'rfi',
    targetId: id,
    summary,
    metadata,
  }).catch(() => null);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await isFlagEnabled(FLAG, user))) return res.status(404).json({ error: 'not found' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  // Office-side register: admin / managing LH only.
  if (!isAdminRole(user.role) && !canManageJob(user, jobId)) {
    return res.status(403).json({ error: 'admin / manager only' });
  }
  const action = (req.query && req.query.action) || '';

  // ---- GET list ----
  if (req.method === 'GET') {
    const data = await readRfis(jobId);
    return res.status(200).json({ rfis: data.rfis || [] });
  }

  // ---- POST raise ----
  if (req.method === 'POST' && !action) {
    const body = req.body || {};
    const subject = body.subject ? String(body.subject).trim().slice(0, 200) : '';
    const question = body.question ? String(body.question).trim().slice(0, 4000) : '';
    if (!subject) return res.status(400).json({ error: 'subject required' });
    if (!question) return res.status(400).json({ error: 'question required' });

    const data = await readRfis(jobId);
    data.rfis = data.rfis || [];
    const now = new Date().toISOString();
    const id = newId();
    const rfi = {
      id,
      jobId,
      ref: nextRef(data.rfis),
      subject,
      question,
      askedOf: body.askedOf ? String(body.askedOf).trim().slice(0, 200) : '',
      status: 'open',
      responseDue: dateOnly(body.responseDue),
      sentAt: null,
      answer: '',
      answeredAt: null,
      answeredBy: null,
      closedReason: '',
      observationId: body.observationId ? String(body.observationId) : null,
      convertedFromObservationId: null,
      areaId: body.areaId ? String(body.areaId) : null,
      planId: body.planId ? String(body.planId) : null,
      raisedById: user.id,
      raisedByName: user.username || user.id,
      createdAt: now,
      updatedAt: now,
      auditLogIds: [],
    };
    const a = await audit(user, jobId, 'rfi.created', id, `RFI raised ${rfi.ref} — "${subject.slice(0, 80)}"`, {
      ref: rfi.ref,
      status: 'open',
      responseDue: rfi.responseDue,
      observationId: rfi.observationId,
    });
    if (a && a.id) rfi.auditLogIds.push(a.id);
    data.rfis.push(rfi);
    await writeBlob(rfisKey(jobId), data);
    return res.status(201).json({ rfi });
  }

  // ---- PATCH edit (open RFI) ----
  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readRfis(jobId);
    const r = (data.rfis || []).find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: 'RFI not found' });
    if (r.status !== 'open') return res.status(409).json({ error: 'only an open RFI can be edited' });
    const body = req.body || {};
    if (body.subject !== undefined) r.subject = String(body.subject).trim().slice(0, 200);
    if (body.question !== undefined) r.question = String(body.question).trim().slice(0, 4000);
    if (body.askedOf !== undefined) r.askedOf = String(body.askedOf).trim().slice(0, 200);
    if (body.responseDue !== undefined) r.responseDue = dateOnly(body.responseDue);
    if (body.areaId !== undefined) r.areaId = body.areaId ? String(body.areaId) : null;
    if (body.planId !== undefined) r.planId = body.planId ? String(body.planId) : null;
    r.updatedAt = new Date().toISOString();
    await writeBlob(rfisKey(jobId), data);
    return res.status(200).json({ rfi: r });
  }

  // ---- POST send (real email) ----
  if (req.method === 'POST' && action === 'send') {
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readRfis(jobId);
    const r = (data.rfis || []).find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: 'RFI not found' });
    if (r.status !== 'open') return res.status(409).json({ error: 'only an open RFI can be sent' });

    const to = (body.to && String(body.to).trim()) || r.askedOf;
    if (!to || !to.includes('@')) {
      return res.status(400).json({ error: 'a recipient email (to, or askedOf) is required to send' });
    }
    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'email is not configured on this environment' });
    }
    const subject = `[${r.ref}] RFI — ${r.subject}`;
    const dueLine = r.responseDue ? `Response requested by ${r.responseDue}.` : '';
    try {
      await sendEmail({
        to,
        subject,
        text: `RFI ${r.ref}\n\n${r.question}\n\n${dueLine ? dueLine + '\n\n' : ''}— ${companyName()}`,
        html: `<p><strong>RFI ${r.ref}</strong></p><p>${escapeHtml(r.question)}</p>${dueLine ? `<p>${dueLine}</p>` : ''}<p>— ${escapeHtml(companyName())}</p>`,
      });
    } catch (e) {
      return res.status(502).json({ error: 'send failed: ' + (e && e.message ? e.message : 'unknown') });
    }
    const now = new Date().toISOString();
    r.status = 'sent';
    r.sentAt = now;
    r.askedOf = to;
    r.updatedAt = now;
    const a = await audit(user, jobId, 'rfi.transitioned', id, `RFI ${r.ref} sent to ${to}`, {
      ref: r.ref,
      from: 'open',
      to: 'sent',
      recipient: to,
    });
    if (a && a.id) r.auditLogIds.push(a.id);
    await writeBlob(rfisKey(jobId), data);
    return res.status(200).json({ rfi: r });
  }

  // ---- POST answer ----
  if (req.method === 'POST' && action === 'answer') {
    const body = req.body || {};
    const id = body.id;
    const answer = body.answer ? String(body.answer).trim().slice(0, 8000) : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!answer) return res.status(400).json({ error: 'answer required' });
    const data = await readRfis(jobId);
    const r = (data.rfis || []).find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: 'RFI not found' });
    if (r.status === 'closed') return res.status(409).json({ error: 'RFI is closed' });
    const now = new Date().toISOString();
    const from = r.status;
    r.answer = answer;
    r.answeredAt = now;
    r.answeredBy = user.username || user.id;
    r.status = 'answered';
    r.updatedAt = now;
    const a = await audit(user, jobId, 'rfi.transitioned', id, `RFI ${r.ref} answered`, {
      ref: r.ref,
      from,
      to: 'answered',
    });
    if (a && a.id) r.auditLogIds.push(a.id);
    await writeBlob(rfisKey(jobId), data);
    return res.status(200).json({ rfi: r });
  }

  // ---- POST close (answer OR no-longer-required reason) ----
  if (req.method === 'POST' && action === 'close') {
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readRfis(jobId);
    const r = (data.rfis || []).find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: 'RFI not found' });
    if (r.status === 'closed') return res.status(200).json({ rfi: r, already: true });
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : '';
    if (!r.answer && !reason) {
      return res.status(400).json({ error: 'close requires an answer or a no-longer-required reason' });
    }
    const now = new Date().toISOString();
    const from = r.status;
    if (!r.answer) r.closedReason = reason;
    r.status = 'closed';
    r.updatedAt = now;
    const a = await audit(user, jobId, 'rfi.transitioned', id, `RFI ${r.ref} closed${!r.answer ? ` (${reason})` : ''}`, {
      ref: r.ref,
      from,
      to: 'closed',
      reason: r.answer ? null : reason,
    });
    if (a && a.id) r.auditLogIds.push(a.id);
    await writeBlob(rfisKey(jobId), data);
    return res.status(200).json({ rfi: r });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
