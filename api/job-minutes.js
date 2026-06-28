// api/job-minutes.js — #217 per-job meeting-minutes register (APPEND-ONLY).
//
//   GET  /api/job-minutes?jobId=X                 → list (admin / managing LH read)
//   POST /api/job-minutes?jobId=X                 → record a minute (admin only)
//   POST /api/job-minutes?jobId=X&action=amend    → add a stamped amendment (admin only)
//
// A per-job register of meeting minutes: date, title, attendees, body and/or a
// PDF/image attachment. APPEND-ONLY — a minute's body is NEVER mutated; a
// correction is recorded as a stamped amendment ({at, by, note}) beneath the
// unchanged original. Office-side: admin/managing-LH read, admin write. Dark
// behind the global `minutes_register` flag. Per-job store jobs/<jobId>/
// minutes.json; the attachment is a direct-blob sibling (jobs/<id>/minutes/<id>.
// <ext>) — this register owns its own files (NOT a Documents-register category).
//
// Writes use writeBlob(..., { expectedRev }) CAS so a concurrent record/amend
// can't clobber a sibling write.

const { put, del } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob, isAdminRole } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { append: appendAuditLog } = require('./_lib/audit-log');

const FLAG = 'minutes_register';
const BODY_MAX = 10000;
const MAX_BYTES = 25 * 1024 * 1024;

function minutesKey(jobId) { return 'jobs/' + jobId + '/minutes.json'; }
async function readMinutes(jobId) { return await readBlob(minutesKey(jobId), { minutes: [] }); }
/** The stored revision (writeBlob stamps __rev); absent on a never-written doc. */
function revOf(data) {
  return data && Number.isFinite(data.__rev) ? data.__rev : undefined;
}
function newId() {
  return 'min_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function dateOnly(raw) {
  const t = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}
function extFor(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}
function isAllowedMime(mime) {
  if (!mime) return false;
  if (mime === 'application/pdf') return true;
  if (mime.startsWith('image/')) return true;
  return false;
}
/** Normalise attendees: free-text names + optional project-contact links. */
function normaliseAttendees(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a) continue;
    const name = String((a.name != null ? a.name : a)).trim().slice(0, 200);
    if (!name) continue;
    out.push({ name, contactId: a.contactId ? String(a.contactId) : null });
    if (out.length >= 100) break;
  }
  return out;
}
async function audit(user, jobId, action, id, summary, metadata) {
  return appendAuditLog({
    action,
    actorId: user.id,
    actorName: user.username || 'Unknown',
    actorRole: user.role || null,
    jobId,
    targetType: 'minutes',
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
  // Office-side register: admin / managing LH may READ.
  if (!isAdminRole(user.role) && !canManageJob(user, jobId)) {
    return res.status(403).json({ error: 'admin / manager only' });
  }
  const action = (req.query && req.query.action) || '';

  // ---- GET list (admin / managing-LH read) ----
  if (req.method === 'GET') {
    const data = await readMinutes(jobId);
    return res.status(200).json({ minutes: data.minutes || [] });
  }

  // ---- POST record (admin only) ----
  if (req.method === 'POST' && !action) {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    const date = dateOnly(body.date);
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
    const title = body.title ? String(body.title).trim().slice(0, 200) : '';
    if (!title) return res.status(400).json({ error: 'title required' });

    // Body is capped server-side (re-asserted, not trusted from the edge).
    const rawBody = body.body != null ? String(body.body) : '';
    if (rawBody.length > BODY_MAX) {
      return res.status(400).json({ error: 'minutes body too long (max ' + BODY_MAX + ' characters)' });
    }
    const minuteBody = rawBody.trim();

    // Optional PDF/image attachment (dataUrl). PDF/image only, 25 MB cap.
    let attachment = null;
    if (body.dataUrl) {
      if (typeof body.dataUrl !== 'string') return res.status(400).json({ error: 'invalid dataUrl' });
      const mime =
        body.mimeType || ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) || 'application/octet-stream';
      if (!isAllowedMime(mime)) {
        return res.status(400).json({ error: 'unsupported file type (PDF or image only)' });
      }
      const base64 = String(body.dataUrl).split(',')[1];
      if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
      const buf = Buffer.from(base64, 'base64');
      if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'file too large (max 25 MB)' });

      const id0 = newId();
      const blobPath = 'jobs/' + jobId + '/minutes/' + id0 + '.' + extFor(mime);
      const uploaded = await put(blobPath, buf, {
        access: 'public',
        contentType: mime,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      attachment = {
        blobPath,
        url: uploaded.url,
        fileName: body.fileName ? String(body.fileName).slice(0, 200) : title + '.' + extFor(mime),
        mimeType: mime,
        sizeBytes: buf.length,
      };
    }

    // A minute must carry SOMETHING: a body or an attachment (both-empty → 400).
    if (!minuteBody && !attachment) {
      return res.status(400).json({ error: 'a minutes body or an attachment is required' });
    }

    const data = await readMinutes(jobId);
    data.minutes = data.minutes || [];
    const now = new Date().toISOString();
    const id = newId();
    const entry = {
      id,
      jobId,
      date,
      title,
      attendees: normaliseAttendees(body.attendees),
      body: minuteBody,
      attachment,
      amendments: [],
      createdBy: user.username || user.id,
      createdAt: now,
      updatedAt: now,
      auditLogIds: [],
    };
    const a = await audit(user, jobId, 'minutes.recorded', id, `Recorded minutes "${title.slice(0, 80)}" (${date})`, {
      date,
      hasAttachment: !!attachment,
      attendees: entry.attendees.length,
    });
    if (a && a.id) entry.auditLogIds.push(a.id);
    data.minutes.push(entry);
    try {
      await writeBlob(minutesKey(jobId), data, { expectedRev: revOf(data), actor: user.id });
    } catch (e) {
      // Audit: the attachment blob is put() BEFORE this CAS-guarded write. On a
      // stale-revision conflict (or any write failure) the uploaded blob would
      // orphan, so best-effort delete it before surfacing the error.
      if (attachment && attachment.blobPath) {
        try { await del(attachment.blobPath, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch { /* best effort */ }
      }
      throw e;
    }
    return res.status(201).json({ minute: entry });
  }

  // ---- POST amend (admin only; append-only — NEVER mutate body) ----
  if (req.method === 'POST' && action === 'amend') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const note = body.note ? String(body.note).trim().slice(0, 2000) : '';
    if (!note) return res.status(400).json({ error: 'an amendment note is required' });

    const data = await readMinutes(jobId);
    const entry = (data.minutes || []).find((m) => m.id === id);
    if (!entry) return res.status(404).json({ error: 'minute not found' });

    const now = new Date().toISOString();
    entry.amendments = entry.amendments || [];
    entry.amendments.push({ at: now, by: user.username || user.id, note });
    entry.updatedAt = now;
    const a = await audit(user, jobId, 'minutes.amended', id, `Amended minutes "${(entry.title || '').slice(0, 80)}"`, {
      date: entry.date,
      amendments: entry.amendments.length,
    });
    if (a && a.id) {
      entry.auditLogIds = entry.auditLogIds || [];
      entry.auditLogIds.push(a.id);
    }
    await writeBlob(minutesKey(jobId), data, { expectedRev: revOf(data), actor: user.id });
    return res.status(200).json({ minute: entry });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
