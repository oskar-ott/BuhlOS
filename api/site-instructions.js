// api/site-instructions.js — #283 per-job site-instructions register.
//
//   GET   /api/site-instructions?jobId=X                    → list (admin / managing LH read)
//   POST  /api/site-instructions?jobId=X                    → record an instruction (admin)
//   PATCH /api/site-instructions?jobId=X    {id, ...}        → edit / flag / link (admin)
//   POST  /api/site-instructions?jobId=X&action=acknowledge {id, channel} (admin)
//   POST  /api/site-instructions?jobId=X&action=close       {id, reason}   (admin)
//
// Builders direct work on the fly ("move that GPO"); those instructions change
// cost and sequence and today live in nobody's records. This per-job register
// makes them provable: who instructed what, when, through which channel; an
// acknowledgement back to the builder; and a cost/time-implication flag so the
// costed ones spawn an RFI/variation instead of becoming free work.
//
// Office-side: admin / managing-LH read, admin write. The field side (the
// `client_instruction` observation + capture chip) is unchanged. Dark behind
// the global `site_instructions_register` flag. Per-job store
// jobs/<jobId>/site-instructions.json; writes use writeBlob CAS so a concurrent
// record can't clobber a sibling write or reuse an SI number.
//
// HONESTY: an acknowledgement records who/when/channel — it is NOT a claim that
// an email was sent. `emailSentAt` is only ever stamped on a real provider send
// (slice B); `acknowledgedAt` is never `emailSentAt`. The instruction text is
// frozen once the instruction leaves `recorded` (the ack quoted it verbatim).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { append: appendAuditLog } = require('./_lib/audit-log');

const FLAG = 'site_instructions_register';
const TEXT_MAX = 2000;
const REASON_MAX = 500;
const CHANNELS = new Set(['verbal', 'phone', 'email', 'text', 'on_site']);
const STATUSES = new Set(['recorded', 'acknowledged', 'closed']);
// recorded → acknowledged → closed, plus the verbal-only shortcut recorded → closed.
const ALLOWED_TRANSITIONS = {
  recorded: new Set(['acknowledged', 'closed']),
  acknowledged: new Set(['closed']),
  closed: new Set(),
};

function key(jobId) { return 'jobs/' + jobId + '/site-instructions.json'; }
async function read(jobId) { return await readBlob(key(jobId), { instructions: [] }); }
function revOf(data) { return data && Number.isFinite(data.__rev) ? data.__rev : undefined; }
function newId() { return 'si_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function dateOnly(raw) {
  const t = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

// Mirror of src/domains/site-instructions/logic.ts nextInstructionRef — max-seen
// + 1, never a gap-fill (a reused SI number would forge history). Re-read the
// store immediately before calling so two concurrent records can't collide.
function nextRef(instructions) {
  let max = 0;
  for (const i of instructions) {
    const m = /^SI-(\d+)$/.exec(String(i && i.ref || '').trim());
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > max) max = n; }
  }
  return 'SI-' + String(max + 1).padStart(3, '0');
}

// Snapshot the instructing contact at record time — contacts are mutable and
// deletable, so never deref later.
function normaliseInstructedBy(raw) {
  const r = raw || {};
  const name = String(r.name != null ? r.name : '').trim().slice(0, 200);
  return {
    name,
    contactId: r.contactId ? String(r.contactId).slice(0, 200) : null,
    email: r.email ? String(r.email).trim().slice(0, 320) : null,
  };
}

async function audit(user, jobId, action, id, summary, metadata) {
  return appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'instruction',
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
  // Office-side register: admin / managing LH may READ; only admin may WRITE.
  if (!isAdminRole(user.role) && !canManageJob(user, jobId)) {
    return res.status(403).json({ error: 'admin / manager only' });
  }
  const action = (req.query && req.query.action) || '';

  // ---- GET list (admin / managing-LH read) ----
  if (req.method === 'GET') {
    const data = await read(jobId);
    return res.status(200).json({ instructions: data.instructions || [] });
  }

  // ---- POST record (admin only) ----
  if (req.method === 'POST' && !action) {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};

    const instructedBy = normaliseInstructedBy(body.instructedBy);
    if (!instructedBy.name) return res.status(400).json({ error: 'instructedBy.name required' });

    const channel = String(body.channel || '').trim();
    if (!CHANNELS.has(channel)) return res.status(400).json({ error: 'invalid channel' });

    const dateReceived = dateOnly(body.dateReceived);
    if (!dateReceived) return res.status(400).json({ error: 'dateReceived (YYYY-MM-DD) required' });

    const rawText = body.instructionText != null ? String(body.instructionText) : '';
    if (rawText.length > TEXT_MAX) {
      return res.status(400).json({ error: 'instruction text too long (max ' + TEXT_MAX + ' characters)' });
    }
    const instructionText = rawText.trim();
    if (!instructionText) return res.status(400).json({ error: 'instruction text required' });

    const data = await read(jobId);
    data.instructions = data.instructions || [];
    const now = new Date().toISOString();
    const id = newId();
    const entry = {
      id,
      jobId,
      ref: nextRef(data.instructions),
      instructedBy,
      channel,
      instructionText,
      dateReceived,
      status: 'recorded',
      costTimeImplication: body.costTimeImplication === true,
      linkedRfiId: null,
      linkedVariationId: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgementChannel: null,
      emailSentAt: null,
      closedAt: null,
      closedBy: null,
      closeReason: null,
      recordedBy: user.username || user.id,
      createdAt: now,
      updatedAt: now,
      auditLogIds: [],
    };
    const a = await audit(
      user, jobId, 'instruction.created', id,
      `Recorded site instruction ${entry.ref} from ${instructedBy.name.slice(0, 80)} (${channel})`,
      { ref: entry.ref, channel, costTimeImplication: entry.costTimeImplication },
    );
    if (a && a.id) entry.auditLogIds.push(a.id);
    data.instructions.push(entry);
    await writeBlob(key(jobId), data, { expectedRev: revOf(data), actor: user.id });
    return res.status(201).json({ instruction: entry });
  }

  // ---- PATCH edit / flag / link (admin only) ----
  if (req.method === 'PATCH') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const data = await read(jobId);
    const entry = (data.instructions || []).find((i) => i.id === id);
    if (!entry) return res.status(404).json({ error: 'instruction not found' });

    const frozen = entry.status !== 'recorded';

    // Verbatim-text fields are frozen once the instruction leaves `recorded` —
    // the acknowledgement quoted them. A post-ack correction is a NEW instruction.
    const editsFrozenFields =
      body.instructionText !== undefined ||
      body.dateReceived !== undefined ||
      body.channel !== undefined ||
      body.instructedBy !== undefined;
    if (frozen && editsFrozenFields) {
      return res.status(409).json({ error: 'instruction text is frozen once acknowledged — record a new linked instruction' });
    }

    if (body.instructionText !== undefined) {
      const t = String(body.instructionText);
      if (t.length > TEXT_MAX) return res.status(400).json({ error: 'instruction text too long' });
      const trimmed = t.trim();
      if (!trimmed) return res.status(400).json({ error: 'instruction text required' });
      entry.instructionText = trimmed;
    }
    if (body.dateReceived !== undefined) {
      const d = dateOnly(body.dateReceived);
      if (!d) return res.status(400).json({ error: 'invalid dateReceived' });
      entry.dateReceived = d;
    }
    if (body.channel !== undefined) {
      if (!CHANNELS.has(String(body.channel))) return res.status(400).json({ error: 'invalid channel' });
      entry.channel = String(body.channel);
    }
    if (body.instructedBy !== undefined) {
      const ib = normaliseInstructedBy(body.instructedBy);
      if (!ib.name) return res.status(400).json({ error: 'instructedBy.name required' });
      entry.instructedBy = ib;
    }
    // The cost/time flag and the spawned-link ids stay editable after ack —
    // an RFI/variation is often raised once the instruction is confirmed.
    if (body.costTimeImplication !== undefined) entry.costTimeImplication = body.costTimeImplication === true;
    if (body.linkedRfiId !== undefined) entry.linkedRfiId = body.linkedRfiId ? String(body.linkedRfiId).slice(0, 200) : null;
    if (body.linkedVariationId !== undefined) entry.linkedVariationId = body.linkedVariationId ? String(body.linkedVariationId).slice(0, 200) : null;

    entry.updatedAt = new Date().toISOString();
    await writeBlob(key(jobId), data, { expectedRev: revOf(data), actor: user.id });
    return res.status(200).json({ instruction: entry });
  }

  // ---- POST acknowledge (admin only) ----
  if (req.method === 'POST' && action === 'acknowledge') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    // The office records HOW it confirmed back (verbal / phone / email). Email
    // SENDING is slice B — this only records the formal acknowledgement.
    const channel = String(body.channel || '').trim();
    if (!CHANNELS.has(channel)) return res.status(400).json({ error: 'invalid acknowledgement channel' });

    const data = await read(jobId);
    const entry = (data.instructions || []).find((i) => i.id === id);
    if (!entry) return res.status(404).json({ error: 'instruction not found' });
    if (!ALLOWED_TRANSITIONS[entry.status] || !ALLOWED_TRANSITIONS[entry.status].has('acknowledged')) {
      return res.status(409).json({ error: `cannot acknowledge — instruction is ${entry.status}` });
    }

    const now = new Date().toISOString();
    const from = entry.status;
    entry.status = 'acknowledged';
    entry.acknowledgedAt = now;
    entry.acknowledgedBy = user.username || user.id;
    entry.acknowledgementChannel = channel;
    entry.updatedAt = now;
    const a = await audit(
      user, jobId, 'instruction.transitioned', id,
      `Acknowledged site instruction ${entry.ref} (${channel})`,
      { ref: entry.ref, from, to: 'acknowledged', acknowledgementChannel: channel },
    );
    if (a && a.id) { entry.auditLogIds = entry.auditLogIds || []; entry.auditLogIds.push(a.id); }
    await writeBlob(key(jobId), data, { expectedRev: revOf(data), actor: user.id });
    return res.status(200).json({ instruction: entry });
  }

  // ---- POST close (admin only) ----
  if (req.method === 'POST' && action === 'close') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const reason = body.reason ? String(body.reason).trim().slice(0, REASON_MAX) : '';

    const data = await read(jobId);
    const entry = (data.instructions || []).find((i) => i.id === id);
    if (!entry) return res.status(404).json({ error: 'instruction not found' });
    if (!ALLOWED_TRANSITIONS[entry.status] || !ALLOWED_TRANSITIONS[entry.status].has('closed')) {
      return res.status(409).json({ error: `cannot close — instruction is ${entry.status}` });
    }

    const now = new Date().toISOString();
    const from = entry.status;
    entry.status = 'closed';
    entry.closedAt = now;
    entry.closedBy = user.username || user.id;
    entry.closeReason = reason || null;
    entry.updatedAt = now;
    const a = await audit(
      user, jobId, 'instruction.transitioned', id,
      `Closed site instruction ${entry.ref}`,
      { ref: entry.ref, from, to: 'closed', reason: reason || null },
    );
    if (a && a.id) { entry.auditLogIds = entry.auditLogIds || []; entry.auditLogIds.push(a.id); }
    await writeBlob(key(jobId), data, { expectedRev: revOf(data), actor: user.id });
    return res.status(200).json({ instruction: entry });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
