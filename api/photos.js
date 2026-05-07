// photos.js — per-dwelling photo index, now namespaced per job + auth protected.
// Preserves original behaviour: base64 dataUrl upload, per-dwelling index,
// DELETE by photoId.
const { put, del } = require('@vercel/blob');
const { setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function indexKey(jobId) {
  return `jobs/${jobId}/photos-index.json`;
}

async function readIndex(jobId) {
  try {
    const { list } = require('@vercel/blob');
    const key = indexKey(jobId);
    const { blobs } = await list({ prefix: key, token: process.env.BLOB_READ_WRITE_TOKEN });
    const match = blobs.find(b => b.pathname === key);
    if (!match) return {};
    const res = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch (e) {
    return {};
  }
}

async function writeIndex(jobId, index) {
  await put(indexKey(jobId), JSON.stringify(index), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

// ── Snag photo storage ─────────────────────────────────────────────
// Separate namespace from dwelling ITP photos: `jobs/<jobId>/snag-photos/<id>.jpg`.
// We don't maintain a photos-index for snags — the canonical list of photos
// lives on the snag itself (snag.photos[]) in data.json, and the frontend
// persists the whole data blob whenever it mutates.
const { readBlob, writeBlob } = require('./_lib/blob');
const MAX_SNAG_PHOTOS = 5;

async function uploadSnagPhoto(req, res, user, jobId) {
  const { snagId, dataUrl } = req.body || {};
  if (!snagId || !dataUrl) return res.status(400).json({ error: 'snagId and dataUrl required' });

  // Enforce 5-photo cap server-side so a double-submit can't bust the limit.
  // We read the live snag state rather than trust the client.
  const DATA_KEY = `jobs/${jobId}/data.json`;
  const data = await readBlob(DATA_KEY, { snags: [] });
  const snag = (data.snags || []).find(s => s.id === snagId);
  if (snag && (snag.photos || []).length >= MAX_SNAG_PHOTOS) {
    return res.status(400).json({ error: `max ${MAX_SNAG_PHOTOS} photos per snag` });
  }

  const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const base64Data = dataUrl.split(',')[1];
  const mimeType = (dataUrl.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const buffer = Buffer.from(base64Data, 'base64');

  const blob = await put(`jobs/${jobId}/snag-photos/${photoId}.jpg`, buffer, {
    access: 'public',
    contentType: mimeType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  return res.status(200).json({
    id: photoId,
    url: blob.url,
    addedBy: user.username || 'Unknown',
    addedAt: new Date().toISOString(),
  });
}

async function deleteSnagPhoto(req, res, user, jobId) {
  const { photoId } = req.body || {};
  if (!photoId) return res.status(400).json({ error: 'photoId required' });
  try {
    await del(`jobs/${jobId}/snag-photos/${photoId}.jpg`, {
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
  } catch (e) {
    // Already gone / never existed — not fatal, frontend will still strip from
    // the snag's photos[] and the next persist() wins.
  }
  return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Snag-photo actions piggy-back on the same endpoint. Distinct `action`
  // query keeps URL shape obvious without requiring a second serverless fn.
  const action = (req.query && req.query.action) || '';
  if (action === 'upload-snag-photo' && req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try { return await uploadSnagPhoto(req, res, user, jobId); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (action === 'delete-snag-photo' && req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try { return await deleteSnagPhoto(req, res, user, jobId); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'GET') {
    const index = await readIndex(jobId);
    const { dwelling } = req.query;
    if (dwelling) return res.status(200).json(index[dwelling] || []);
    return res.status(200).json(index);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try {
      const { dwelling, stage, group, caption, uploadedBy, dataUrl } = req.body;
      if (!dwelling || !dataUrl) return res.status(400).json({ error: 'Missing fields' });

      const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
      const base64Data = dataUrl.split(',')[1];
      const mimeType = (dataUrl.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
      const buffer = Buffer.from(base64Data, 'base64');

      const blob = await put(`jobs/${jobId}/photos/${photoId}.jpg`, buffer, {
        access: 'public',
        contentType: mimeType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });

      const index = await readIndex(jobId);
      if (!index[dwelling]) index[dwelling] = [];
      index[dwelling].push({
        id: photoId,
        url: blob.url,
        stage, group, caption: caption || '',
        uploadedBy: uploadedBy || user.username || 'Unknown',
        date: new Date().toLocaleDateString('en-AU'),
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
      });
      await writeIndex(jobId, index);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try {
      const { dwelling, photoId } = req.body;
      const index = await readIndex(jobId);
      if (index[dwelling]) {
        index[dwelling] = index[dwelling].filter(p => p.id !== photoId);
        await writeIndex(jobId, index);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
