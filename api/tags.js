// Per-job Test & Tag register.
// Storage:  jobs/<jobId>/tags.json  ->  { tags: [...] }
//
// Schema (expanded for OCR + pass/fail + user-picked retest interval):
//   id, applianceType, tagNumber, owner, testedBy,
//   testDate (dd/mm/yyyy), expiryDate (dd/mm/yyyy),
//   retestInterval ('1mo' | '3mo' | '6mo' | '12mo' | ''),
//   result ('pass' | 'fail' | ''),
//   notes, photoUrl,
//   ocrConfidence {field: 0..1}, ocrRaw,
//   createdBy, createdAt, updatedAt
//
// Actions:
//   GET  ?jobId=X                       → { tags: [...] }
//   POST ?jobId=X         body: tag     → create (admin/LH/tradie)
//   PUT  ?jobId=X&id=Y    body: tag     → update
//   DELETE ?jobId=X       body: {id}    → delete
//   POST ?jobId=X&action=photo  body:{dataUrl}   → { url }
//   POST ?jobId=X&action=ocr    body:{photoUrl}  → { fields, confidence, raw }

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

function newId() {
  return 'tag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function uploadTagPhoto(req, res, user, jobId) {
  const { dataUrl } = req.body || {};
  if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });
  const base64 = String(dataUrl).split(',')[1];
  if (!base64) return res.status(400).json({ error: 'invalid dataUrl' });
  const mime = (String(dataUrl).match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'photo too large (max 8 MB)' });

  const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const blob = await put(`jobs/${jobId}/tag-photos/${photoId}.jpg`, buf, {
    access: 'public',
    contentType: mime,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return res.status(200).json({ url: blob.url, id: photoId });
}

// ── OCR via Claude vision ─────────────────────────────────────────────
// Keeps the prompt small & deterministic. We demand JSON and zero prose.
const OCR_SYSTEM = `You are an OCR + field extractor for Australian AS/NZS 3760 test & tag stickers and appliance ID labels.
Extract the following fields from the photo of a tag or sticker. Return ONLY valid JSON — no prose, no code fences.

Required JSON shape:
{
  "tagNumber": string,
  "applianceType": string,
  "testedBy": string,
  "testDate": string,     // "dd/mm/yyyy" — convert any date format you see
  "expiryDate": string,   // "dd/mm/yyyy"
  "result": "pass" | "fail" | "",
  "confidence": {
    "tagNumber": number,    // 0..1
    "applianceType": number,
    "testedBy": number,
    "testDate": number,
    "expiryDate": number,
    "result": number
  }
}

Rules:
- If a field is not visible or illegible, return "" for strings and 0 for that confidence.
- Confidence 1.0 only when the characters are crisp and unambiguous. Use <0.7 for any guess.
- Australian dates: dd/mm/yyyy. Convert "15 MAR 2026" → "15/03/2026".
- "result": infer from "PASS"/"FAIL" text, or green/red sticker context. Unknown → "".
- applianceType: the tool/equipment description (e.g. "Makita 18V drill", "Extension lead 15m"). Leave "" if only a tag sticker with no appliance info.`;

async function runOcr(req, res, user) {
  const { photoUrl } = req.body || {};
  if (!photoUrl) return res.status(400).json({ error: 'photoUrl required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // Fetch the image, base64-encode (Anthropic vision supports URL or base64; base64 is safer across CORS/auth)
  let imageBase64, mediaType;
  try {
    const r = await fetch(photoUrl);
    if (!r.ok) throw new Error('image fetch failed (' + r.status + ')');
    mediaType = r.headers.get('content-type') || 'image/jpeg';
    if (!mediaType.startsWith('image/')) mediaType = 'image/jpeg';
    const ab = await r.arrayBuffer();
    imageBase64 = Buffer.from(ab).toString('base64');
  } catch (e) {
    return res.status(502).json({ error: 'image fetch failed: ' + e.message });
  }

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: [
          { type: 'text', text: OCR_SYSTEM, cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: 'Extract the fields from this tag photo. Return only the JSON object.' },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Anthropic request failed: ' + e.message });
  }

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (body && body.error && body.error.message) || `Anthropic ${resp.status}`;
    return res.status(502).json({ error: msg });
  }

  // Claude responds with content blocks; we want the first text block.
  const textBlock = (body.content || []).find(c => c.type === 'text');
  const raw = (textBlock && textBlock.text) || '';
  let parsed;
  try {
    // Tolerate code fences or stray text by extracting the first {...}
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    return res.status(200).json({
      error: 'could not parse OCR response',
      raw,
      fields: { tagNumber:'', applianceType:'', testedBy:'', testDate:'', expiryDate:'', result:'' },
      confidence: { tagNumber:0, applianceType:0, testedBy:0, testDate:0, expiryDate:0, result:0 },
    });
  }

  return res.status(200).json({
    fields: {
      tagNumber: parsed.tagNumber || '',
      applianceType: parsed.applianceType || '',
      testedBy: parsed.testedBy || '',
      testDate: parsed.testDate || '',
      expiryDate: parsed.expiryDate || '',
      result: parsed.result || '',
    },
    confidence: parsed.confidence || {},
    raw,
  });
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const action = (req.query && req.query.action) || '';
  const KEY = `jobs/${jobId}/tags.json`;

  // ── action=photo: upload tag photo to Blob
  if (action === 'photo' && req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try { return await uploadTagPhoto(req, res, user, jobId); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── action=ocr: run Claude vision on a photo URL
  if (action === 'ocr' && req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    try { return await runOcr(req, res, user); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Register CRUD
  if (req.method === 'GET') {
    const data = await readBlob(KEY, { tags: [] });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const body = req.body || {};
    const data = await readBlob(KEY, { tags: [] });
    data.tags = data.tags || [];
    const now = new Date().toISOString();
    const tag = {
      id: newId(),
      // Back-compat: support old field `name` (existing callers) and new `applianceType`
      applianceType: (body.applianceType || body.name || '').trim(),
      tagNumber:     (body.tagNumber || '').trim(),
      owner:         (body.owner || '').trim(),
      testedBy:      (body.testedBy || '').trim(),
      testDate:      (body.testDate || '').trim(),
      expiryDate:    (body.expiryDate || '').trim(),
      retestInterval:(body.retestInterval || '').trim(),
      result:        (body.result || '').trim(),
      notes:         (body.notes || '').trim(),
      photoUrl:      body.photoUrl || '',
      ocrConfidence: body.ocrConfidence || undefined,
      ocrRaw:        body.ocrRaw || undefined,
      createdBy:     user.username,
      createdByUserId: user.id,
      createdAt:     now,
      updatedAt:     now,
    };
    // Keep legacy `name` so existing client code can still read it (some paths still look for `name`)
    tag.name = tag.applianceType;
    data.tags.push(tag);
    try { await writeBlob(KEY, data); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({ tag });
  }

  if (req.method === 'PUT') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readBlob(KEY, { tags: [] });
    const t = (data.tags || []).find(x => x.id === id);
    if (!t) return res.status(404).json({ error: 'tag not found' });
    const b = req.body || {};
    const maybeSet = (k, alt) => {
      if (b[k] !== undefined) t[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
      else if (alt && b[alt] !== undefined) t[k] = typeof b[alt] === 'string' ? b[alt].trim() : b[alt];
    };
    maybeSet('applianceType', 'name');
    maybeSet('tagNumber');
    maybeSet('owner');
    maybeSet('testedBy');
    maybeSet('testDate');
    maybeSet('expiryDate');
    maybeSet('retestInterval');
    maybeSet('result');
    maybeSet('notes');
    maybeSet('photoUrl');
    if (b.ocrConfidence !== undefined) t.ocrConfidence = b.ocrConfidence;
    if (b.ocrRaw !== undefined) t.ocrRaw = b.ocrRaw;
    t.name = t.applianceType;
    t.updatedAt = new Date().toISOString();
    t.updatedByUserId = user.id;
    t.updatedBy = user.username;
    try { await writeBlob(KEY, data); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({ tag: t });
  }

  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const id = (req.body && req.body.id) || (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = await readBlob(KEY, { tags: [] });
    data.tags = (data.tags || []).filter(t => t.id !== id);
    try { await writeBlob(KEY, data); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
