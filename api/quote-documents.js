// Quote / Tender — document upload and register.
// Mirrors /api/plans.js but scoped under quotes/<quoteId>/documents/.
//
//   GET    /api/quote-documents?quoteId=X            → list docs (admin)
//   POST   /api/quote-documents?quoteId=X            → upload (dataUrl pattern)
//                                                       body: { fileName, mimeType, dataUrl,
//                                                               documentType, drawingNumber, revision,
//                                                               title, level, category, notes }
//   PATCH  /api/quote-documents?quoteId=X&id=docId   → edit metadata
//   DELETE /api/quote-documents?quoteId=X&id=docId   → soft-archive
//
// Permissions: admin only.

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const VALID_STATUSES = ['current', 'superseded', 'archived'];
const VALID_TYPES = [
  'Electrical plan', 'Architectural plan', 'Specification',
  'Scope', 'Addendum', 'Schedule', 'Photo', 'Other',
];
const MAX_BYTES = 25 * 1024 * 1024;

function newId() {
  return 'qdoc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function extFor(mime) {
  if (!mime) return 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return 'bin';
}
function isAllowedMime(mime) {
  if (!mime) return false;
  if (mime === 'application/pdf') return true;
  if (mime.startsWith('image/')) return true;
  if (mime.includes('officedocument')) return true; // docx/xlsx
  return false;
}

async function readIndex(quoteId) {
  return await readBlob('quotes/' + quoteId + '/documents-index.json', { documents: [] });
}
async function writeIndex(quoteId, data) {
  await writeBlob('quotes/' + quoteId + '/documents-index.json', data);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const quoteId = (req.query && req.query.quoteId) || '';
  if (!quoteId) return res.status(400).json({ error: 'quoteId required' });

  if (req.method === 'GET') {
    const data = await readIndex(quoteId);
    const includeArchived = req.query && req.query.includeArchived === '1';
    let docs = data.documents || [];
    if (!includeArchived) docs = docs.filter(d => d.status !== 'archived');
    return res.status(200).json({ documents: docs });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.dataUrl || typeof body.dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl required' });
    }
    const mime = body.mimeType ||
                 ((body.dataUrl.match(/^data:([^;]+);/) || [])[1]) ||
                 'application/octet-stream';
    if (!isAllowedMime(mime)) {
      return res.status(400).json({ error: 'unsupported file type' });
    }
    const base64 = String(body.dataUrl).split(',')[1];
    if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'file too large (max 25 MB)' });
    }

    const id = newId();
    const ext = extFor(mime);
    const blobPath = 'quotes/' + quoteId + '/documents/' + id + '.' + ext;
    const uploaded = await put(blobPath, buf, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const now = new Date().toISOString();
    const docType = (body.documentType && VALID_TYPES.includes(body.documentType))
      ? body.documentType
      : 'Other';
    const doc = {
      id,
      quoteId,
      fileName:      body.fileName ? String(body.fileName).slice(0, 200) : (id + '.' + ext),
      blobPath,
      url:           uploaded.url,
      mimeType:      mime,
      sizeBytes:     buf.length,
      documentType:  docType,
      drawingNumber: body.drawingNumber ? String(body.drawingNumber).trim() : '',
      revision:      body.revision ? String(body.revision).trim() : '',
      title:         body.title ? String(body.title).trim() : '',
      level:         body.level ? String(body.level).trim() : '',
      category:      body.category ? String(body.category).trim() : '',
      status:        'current',
      notes:         body.notes ? String(body.notes).trim() : '',
      uploadedAt:    now,
      uploadedBy:    user.username,
    };
    const data = await readIndex(quoteId);
    data.documents = data.documents || [];
    data.documents.push(doc);
    await writeIndex(quoteId, data);
    return res.status(201).json({ document: doc });
  }

  if (req.method === 'PATCH') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const data = await readIndex(quoteId);
    const idx = (data.documents || []).findIndex(d => d.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    const editable = ['drawingNumber', 'revision', 'title', 'level', 'category', 'notes'];
    for (const k of editable) {
      if (body[k] !== undefined) data.documents[idx][k] = String(body[k] || '').trim();
    }
    if (body.documentType && VALID_TYPES.includes(body.documentType)) {
      data.documents[idx].documentType = body.documentType;
    }
    if (body.status && VALID_STATUSES.includes(body.status)) {
      data.documents[idx].status = body.status;
      // If marking current, demote any other "current" doc with the same drawing #.
      if (body.status === 'current' && data.documents[idx].drawingNumber) {
        for (const d of data.documents) {
          if (d.id !== id && d.drawingNumber === data.documents[idx].drawingNumber && d.status === 'current') {
            d.status = 'superseded';
          }
        }
      }
    }
    data.documents[idx].updatedAt = new Date().toISOString();
    await writeIndex(quoteId, data);
    return res.status(200).json({ document: data.documents[idx] });
  }

  if (req.method === 'DELETE') {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readIndex(quoteId);
    const idx = (data.documents || []).findIndex(d => d.id === id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    data.documents[idx].status = 'archived';
    data.documents[idx].updatedAt = new Date().toISOString();
    await writeIndex(quoteId, data);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
