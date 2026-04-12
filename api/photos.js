// photos.js — preserves existing upload behaviour, adds auth + jobId namespace.
// NOTE: I don't have your original photos.js contents. If this differs from
// what you had, paste the original and I'll merge the auth wrapping into it.
const { put, list, del } = require('@vercel/blob');
const { setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const prefix = `jobs/${jobId}/photos/`;

  if (req.method === 'GET') {
    const { blobs } = await list({ prefix, token });
    return res.status(200).json({ photos: blobs.map(b => ({
      url: b.url,
      pathname: b.pathname,
      uploadedAt: b.uploadedAt,
      size: b.size,
    })) });
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { filename, data, contentType } = req.body || {};
    if (!filename || !data) return res.status(400).json({ error: 'filename and data required' });
    const buf = Buffer.from(data, 'base64');
    const key = `${prefix}${Date.now()}-${filename}`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: contentType || 'image/jpeg',
      token,
    });
    return res.status(200).json({ url: blob.url, pathname: blob.pathname });
  }

  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { url } = req.query || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    await del(url, { token });
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
