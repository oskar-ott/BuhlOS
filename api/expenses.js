// Expenses (#536) — field worker submits a receipt + amount for reimbursement;
// the office reviews → approves → marks reimbursed. A structured, trackable
// record, NOT a lossy "photo to the boss" observation.
//
//   POST /api/expenses?action=upload-receipt { dataUrl }  → { id, url, capturedAt }
//   POST /api/expenses { amountCents, category, receiptPhotoId, receiptPhotoUrl,
//                        note?, jobId?, idempotencyKey? }  → 201 { expense }
//   GET  /api/expenses[?status=&userId=]                   → { expenses }
//                        admin sees all; field/LH see only their own
//   PATCH /api/expenses { id, status, reviewNote? }        → 200 { expense }  (admin only)
//
// MONEY: integer cents (AUD) only — the server is the source of truth, never a
// client float total (P7). PAYOUT runs through payroll/Xero (#249), not here
// (payroll-boundary ADR #609): BuhlOS captures + approves, Xero pays.
//
// Store: 'expenses.json' → { expenses: [ExpenseItem, ...], __idempotency: [...] }
// (org-wide, like observations.json — the office reviews across workers/jobs).

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isClientRole, isAdminRole } = require('./_lib/auth');
const { idempotencyKeyFrom, findIdempotent, recordIdempotent } = require('./_lib/idempotency');
const { appendActivity } = require('./_lib/activity');
const { sendPushToUserId } = require('./_lib/push');

const STORE = 'expenses.json';
const CATEGORIES = ['fuel', 'parking', 'materials', 'tolls', 'other'];
const STATUSES = ['submitted', 'approved', 'rejected', 'reimbursed'];
const NOTE_MAX = 500;
const AMOUNT_MIN_CENTS = 1;
const AMOUNT_MAX_CENTS = 10_000_000; // $100,000 fat-finger ceiling
const RECEIPT_MAX_BYTES = 6 * 1024 * 1024;

// Status machine — mirrored from src/domains/expenses/schema.ts.
const TRANSITIONS = {
  submitted: ['approved', 'rejected'],
  approved: ['reimbursed', 'rejected'],
  rejected: [],
  reimbursed: [],
};

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Any authenticated staff/field user; clients are never allowed near expenses.
  const me = await requireAuth(req, res, {});
  if (!me) return;
  if (isClientRole(me.role)) return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';
  if (req.method === 'POST' && action === 'upload-receipt') return handleUploadReceipt(req, res, me);
  if (req.method === 'POST') return handleCreate(req, res, me);
  if (req.method === 'GET') return handleList(req, res, me);
  if (req.method === 'PATCH') return handleTransition(req, res, me);
  return res.status(405).json({ error: 'method not allowed' });
};

// ── POST ?action=upload-receipt : receipt photo binary → Blob URL ────────────
async function handleUploadReceipt(req, res, me) {
  const { dataUrl } = req.body || {};
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });
  const base64Data = String(dataUrl).split(',')[1];
  if (!base64Data) return res.status(400).json({ error: 'malformed dataUrl' });
  const mimeType = (String(dataUrl).match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > RECEIPT_MAX_BYTES) {
    return res.status(413).json({ error: 'receipt too large — try a smaller image' });
  }
  // Lazy require so the api harness can stub @vercel/blob per test.
  const { put } = require('@vercel/blob');
  const photoId = 'rcpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const blob = await put(`expense-receipts/${photoId}.jpg`, buffer, {
    access: 'public',
    contentType: mimeType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return res.status(200).json({ id: photoId, url: blob.url, capturedAt: new Date().toISOString() });
}

// ── POST : submit an expense ─────────────────────────────────────────────────
async function handleCreate(req, res, me) {
  const body = req.body || {};

  // Money first — integer cents, in range, never a float total (P7).
  const amountCents = body.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) ||
      amountCents < AMOUNT_MIN_CENTS || amountCents > AMOUNT_MAX_CENTS) {
    return res.status(400).json({ error: 'amountCents must be a whole number of cents between 1 and 10000000' });
  }
  if (!CATEGORIES.includes(body.category)) {
    return res.status(400).json({ error: 'category must be one of: ' + CATEGORIES.join(', ') });
  }
  const receiptPhotoId = String(body.receiptPhotoId || '').trim();
  const receiptPhotoUrl = String(body.receiptPhotoUrl || '').trim();
  if (!receiptPhotoId || !receiptPhotoUrl) {
    return res.status(400).json({ error: 'a receipt photo is required' });
  }
  if (!/^https?:\/\//.test(receiptPhotoUrl)) {
    return res.status(400).json({ error: 'receiptPhotoUrl must be a URL' });
  }
  let note = body.note == null ? null : String(body.note).trim();
  if (note && note.length > NOTE_MAX) return res.status(400).json({ error: 'note too long' });
  if (note === '') note = null;
  const jobId = body.jobId ? String(body.jobId).trim() : null;

  const store = await readBlob(STORE, { expenses: [] });
  store.expenses = Array.isArray(store.expenses) ? store.expenses : [];

  // Replay-safety: scope the key by submitter so it can't collide across users.
  const idemKey = idempotencyKeyFrom(req);
  const scopedKey = idemKey ? `expense:${me.id}:${idemKey}` : null;
  if (scopedKey) {
    const replay = findIdempotent(store, scopedKey);
    if (replay) return res.status(201).json({ ...replay, idempotentReplay: true });
  }

  // Denormalise the job name (a hint for the office) — null if not found.
  let jobName = null;
  if (jobId) {
    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const j = (jobsBlob.jobs || []).find((x) => x && x.id === jobId);
    jobName = j ? j.name || null : null;
  }

  const now = new Date().toISOString();
  const item = {
    id: 'expn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    amountCents,
    category: body.category,
    note,
    receiptPhotoId,
    receiptPhotoUrl,
    jobId,
    jobName,
    status: 'submitted',
    submittedById: me.id,
    submittedByName: me.username || me.name || me.id,
    submittedByRole: me.role,
    reviewedById: null,
    reviewedByName: null,
    reviewNote: null,
    createdAt: now,
    updatedAt: now,
    reimbursedAt: null,
  };
  store.expenses.push(item);

  const result = { expense: item };
  if (scopedKey) recordIdempotent(store, scopedKey, result);
  await writeBlob(STORE, store);

  appendActivity({
    action: 'expense.submitted',
    scope: 'expenses',
    actor: me.id,
    actorName: me.username || me.id,
    target: `expense/${item.id}`,
    targetLabel: `${formatAud(amountCents)} · ${item.category}`,
    meta: { amountCents, category: item.category, jobId },
  }).catch(() => null);
  notifyAdminsOfExpense(me, item).catch(() => null);

  return res.status(201).json(result);
}

// ── GET : list (admin = all, field/LH = own) ─────────────────────────────────
async function handleList(req, res, me) {
  const store = await readBlob(STORE, { expenses: [] });
  let expenses = Array.isArray(store.expenses) ? store.expenses : [];
  const admin = isAdminRole(me.role);
  if (!admin) {
    expenses = expenses.filter((e) => e && e.submittedById === me.id);
  }
  const status = req.query && req.query.status;
  if (status && STATUSES.includes(status)) {
    expenses = expenses.filter((e) => e && e.status === status);
  }
  const userId = req.query && req.query.userId;
  if (userId && admin) {
    expenses = expenses.filter((e) => e && e.submittedById === userId);
  }
  return res.status(200).json({ expenses });
}

// ── PATCH : review transition (admin only) ───────────────────────────────────
async function handleTransition(req, res, me) {
  if (!isAdminRole(me.role)) return res.status(403).json({ error: 'forbidden' });
  const body = req.body || {};
  const id = String(body.id || '').trim();
  const status = body.status;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
  let reviewNote = body.reviewNote == null ? null : String(body.reviewNote).trim();
  if (reviewNote && reviewNote.length > NOTE_MAX) return res.status(400).json({ error: 'reviewNote too long' });
  if (reviewNote === '') reviewNote = null;

  const store = await readBlob(STORE, { expenses: [] });
  store.expenses = Array.isArray(store.expenses) ? store.expenses : [];
  const item = store.expenses.find((e) => e && e.id === id);
  if (!item) return res.status(404).json({ error: 'expense not found' });
  if (item.status === status) return res.status(409).json({ error: 'already ' + status });
  if (!(TRANSITIONS[item.status] || []).includes(status)) {
    return res.status(409).json({ error: `cannot move from ${item.status} to ${status}` });
  }

  const now = new Date().toISOString();
  const from = item.status;
  item.status = status;
  item.reviewedById = me.id;
  item.reviewedByName = me.username || me.name || me.id;
  if (reviewNote != null) item.reviewNote = reviewNote;
  if (status === 'reimbursed') item.reimbursedAt = now;
  item.updatedAt = now;
  await writeBlob(STORE, store);

  appendActivity({
    action: 'expense.' + status,
    scope: 'expenses',
    actor: me.id,
    actorName: me.username || me.id,
    target: `expense/${id}`,
    targetLabel: formatAud(item.amountCents),
    meta: { from, to: status, reviewNote },
  }).catch(() => null);
  notifySubmitterOfOutcome(item, status).catch(() => null);

  return res.status(200).json({ expense: item });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatAud(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// Best-effort: tell the office a new claim landed. Never blocks the write.
async function notifyAdminsOfExpense(me, item) {
  const usersBlob = await readBlob('users.json', { users: [] });
  const admins = (usersBlob.users || []).filter(
    (u) => u && isAdminRole(u.role) && !u.archived && !u.disabled,
  );
  await Promise.all(
    admins.map((u) =>
      sendPushToUserId(
        u.id,
        {
          title: 'New expense to review',
          body: `${item.submittedByName} · ${formatAud(item.amountCents)} · ${item.category}`,
          url: '/expenses',
          tag: 'expense-' + item.id,
        },
        { ttlSeconds: 6 * 3600 },
      ).catch(() => null),
    ),
  );
}

// Best-effort: tell the worker their claim was decided.
async function notifySubmitterOfOutcome(item, status) {
  if (status !== 'approved' && status !== 'rejected' && status !== 'reimbursed') return;
  const word = status === 'reimbursed' ? 'reimbursed' : status === 'approved' ? 'approved' : 'declined';
  await sendPushToUserId(
    item.submittedById,
    {
      title: `Your ${formatAud(item.amountCents)} receipt was ${word}`,
      body: item.category + (item.reviewNote ? ` — ${item.reviewNote}` : ''),
      url: '/phil/my-day',
      tag: 'expense-' + item.id,
    },
    { ttlSeconds: 24 * 3600 },
  ).catch(() => null);
}
