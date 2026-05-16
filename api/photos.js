// Job photos — full rebuild for onsite construction/electrical use.
//
// Storage:
//   jobs/<jobId>/photos.json                          → metadata index (photos: [])
//   jobs/<jobId>/photos/<timestamp>-<safeName>        → full-resolution blob
//   jobs/<jobId>/photos/thumbs/<timestamp>-<safeName> → optional thumbnail blob
//
// A photo is more than an image: it's job evidence. Each record carries the
// category (progress, defect, ITP, as-built, etc.), the area/location, the
// uploader, optional notes, and an optional link to a task / ITP stage /
// defect so the office can use the photo as proof later.
//
// Endpoints (all need ?jobId=X):
//   GET                                  → { photos, categories }
//   GET    ?id=Y                         → { photo }
//   POST                                 → upload new photo (multipart-ish, base64 in JSON)
//   PATCH  ?id=Y                         → update notes / category / area / links
//   DELETE ?id=Y                         → delete photo + blob (and thumb if any)

const { put, del } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { trimStr, trimStrOrNull, newId, nowIso } = require('./_lib/validation');

const PHOTO_CATEGORIES = [
  'progress',
  'before',
  'after',
  'completed',
  'defect',
  'damage',
  'safety',
  'asbuilt',
  'itp',
  'material',
  'site',
  'variation',
  'other',
];

// Accepted image MIME types — anything else is rejected with 415.
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB after base64-decode
const MAX_THUMB_BYTES = 512 * 1024;     // 512 KB — thumbs should be tiny

// Magic-byte sniff so a client can't smuggle non-image bytes by lying about contentType.
function looksLikeImage(buf) {
  if (!buf || buf.length < 8) return false;
  const b = buf;
  // JPEG
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;
  // WEBP — "RIFF....WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  // HEIC/HEIF — ftyp box at offset 4
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
  return false;
}

function metaKey(jobId) { return `jobs/${jobId}/photos.json`; }
function blobPrefix(jobId) { return `jobs/${jobId}/photos/`; }
function thumbPrefix(jobId) { return `jobs/${jobId}/photos/thumbs/`; }

async function readPhotos(jobId) {
  const doc = await readBlob(metaKey(jobId), { photos: [] });
  doc.photos = Array.isArray(doc.photos) ? doc.photos : [];
  return doc;
}

function sanitizeCategory(input, fallback = 'progress') {
  if (PHOTO_CATEGORIES.includes(input)) return input;
  return fallback;
}

function safeFilename(name) {
  const cleaned = String(name || 'photo.jpg').replace(/[^\w.\-()+ ]/g, '_').slice(0, 200);
  return cleaned || 'photo.jpg';
}

function decodeBase64(data) {
  if (typeof data !== 'string') return null;
  // accept either "iVBOR..." or "data:image/jpeg;base64,iVBOR..."
  const commaIdx = data.indexOf(',');
  const payload = commaIdx >= 0 && data.slice(0, commaIdx).includes('base64') ? data.slice(commaIdx + 1) : data;
  try {
    return Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
}

function buildPhotoRecord(input, jobId, user) {
  return {
    id: newId('ph'),
    jobId,
    category: sanitizeCategory(input.category, 'progress'),
    area: trimStrOrNull(input.area, 200) || '',
    taskId: trimStrOrNull(input.taskId, 80) || null,
    itpStage: trimStrOrNull(input.itpStage, 120) || null,
    defectId: trimStrOrNull(input.defectId, 80) || null,
    dwelling: trimStrOrNull(input.dwelling, 200) || null,
    notes: trimStrOrNull(input.notes, 2000) || '',
    uploadedBy: user.id,
    uploadedByName: user.username || user.name || '',
    uploadedAt: nowIso(),
    url: '',
    blobPath: '',
    thumbUrl: null,
    thumbPath: null,
    fileName: '',
    contentType: 'image/jpeg',
    size: 0,
    width: Number.isFinite(+input.width) ? +input.width : null,
    height: Number.isFinite(+input.height) ? +input.height : null,
  };
}

function sortPhotos(photos) {
  return photos.slice().sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
}

function applyFilters(photos, q) {
  let out = photos;
  if (q.category) out = out.filter(p => p.category === q.category);
  if (q.area) out = out.filter(p => (p.area || '').toLowerCase() === String(q.area).toLowerCase());
  if (q.taskId) out = out.filter(p => p.taskId === q.taskId);
  if (q.itpStage) out = out.filter(p => p.itpStage === q.itpStage);
  if (q.defectId) out = out.filter(p => p.defectId === q.defectId);
  if (q.dwelling) out = out.filter(p => p.dwelling === q.dwelling);
  if (q.uploadedBy) out = out.filter(p => p.uploadedBy === q.uploadedBy);
  if (q.since) out = out.filter(p => (p.uploadedAt || '') >= q.since);
  return out;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const id = (req.query && req.query.id) || '';
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const doc = await readPhotos(jobId);

  // ── GET ──
  if (req.method === 'GET') {
    if (id) {
      const photo = doc.photos.find(p => p.id === id);
      if (!photo) return res.status(404).json({ error: 'photo not found' });
      return res.status(200).json({ photo });
    }
    const filtered = applyFilters(doc.photos, req.query || {});
    return res.status(200).json({
      photos: sortPhotos(filtered),
      total: doc.photos.length,
      categories: PHOTO_CATEGORIES,
    });
  }

  // ── POST — upload a new photo ──
  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const body = req.body || {};
    const { filename, data, contentType, thumbData } = body;
    if (!data) return res.status(400).json({ error: 'data required' });

    const buf = decodeBase64(data);
    if (!buf) return res.status(400).json({ error: 'invalid base64 data' });
    if (buf.length === 0) return res.status(400).json({ error: 'empty image' });
    if (buf.length > MAX_FILE_BYTES) {
      return res.status(413).json({ error: `image too large (max ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB)` });
    }
    if (!looksLikeImage(buf)) {
      return res.status(415).json({ error: 'file is not a recognised image (jpeg/png/webp/heic)' });
    }

    const safeName = safeFilename(filename || 'photo.jpg');
    const stamp = Date.now();
    const path = `${blobPrefix(jobId)}${stamp}-${safeName}`;
    const ct = (typeof contentType === 'string' && ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase()))
      ? contentType.toLowerCase()
      : 'image/jpeg';

    let blob;
    try {
      blob = await put(path, buf, {
        access: 'public',
        contentType: ct,
        token,
        addRandomSuffix: false,
      });
    } catch (e) {
      return res.status(500).json({ error: 'upload failed: ' + e.message });
    }

    // Optional thumbnail (sent as base64 from the client). Failure is non-fatal.
    let thumbUrl = null;
    let thumbPath = null;
    if (thumbData) {
      const tbuf = decodeBase64(thumbData);
      if (tbuf && tbuf.length > 0 && tbuf.length <= MAX_THUMB_BYTES && looksLikeImage(tbuf)) {
        const tpath = `${thumbPrefix(jobId)}${stamp}-${safeName}`;
        try {
          const tblob = await put(tpath, tbuf, {
            access: 'public',
            contentType: ct,
            token,
            addRandomSuffix: false,
          });
          thumbUrl = tblob.url;
          thumbPath = tpath;
        } catch {
          // ignore thumb errors — full photo still saved
        }
      }
    }

    const record = buildPhotoRecord(body, jobId, user);
    record.url = blob.url;
    record.blobPath = path;
    record.thumbUrl = thumbUrl;
    record.thumbPath = thumbPath;
    record.fileName = safeName;
    record.contentType = ct;
    record.size = buf.length;

    doc.photos.push(record);
    await writeBlob(metaKey(jobId), doc);
    return res.status(200).json({ photo: record });
  }

  // ── PATCH — update metadata only ──
  if (req.method === 'PATCH') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = doc.photos.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'photo not found' });
    const existing = doc.photos[idx];
    // Tradies can only edit their own photos; admins can edit any.
    if (user.role !== 'admin' && existing.uploadedBy !== user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const body = req.body || {};
    if (body.category !== undefined) existing.category = sanitizeCategory(body.category, existing.category);
    if (body.area !== undefined) existing.area = trimStrOrNull(body.area, 200) || '';
    if (body.notes !== undefined) existing.notes = trimStrOrNull(body.notes, 2000) || '';
    if (body.taskId !== undefined) existing.taskId = trimStrOrNull(body.taskId, 80) || null;
    if (body.itpStage !== undefined) existing.itpStage = trimStrOrNull(body.itpStage, 120) || null;
    if (body.defectId !== undefined) existing.defectId = trimStrOrNull(body.defectId, 80) || null;
    if (body.dwelling !== undefined) existing.dwelling = trimStrOrNull(body.dwelling, 200) || null;
    existing.updatedAt = nowIso();
    existing.updatedBy = user.id;
    await writeBlob(metaKey(jobId), doc);
    return res.status(200).json({ photo: existing });
  }

  // ── DELETE ──
  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = doc.photos.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'photo not found' });
    const existing = doc.photos[idx];
    if (user.role !== 'admin' && existing.uploadedBy !== user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      if (existing.url) await del(existing.url, { token });
    } catch {}
    try {
      if (existing.thumbUrl) await del(existing.thumbUrl, { token });
    } catch {}
    doc.photos.splice(idx, 1);
    await writeBlob(metaKey(jobId), doc);
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
