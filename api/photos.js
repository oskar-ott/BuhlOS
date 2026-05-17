// photos.js — per-job photo upload + listing with metadata sidecar.
// Each photo is stored at jobs/<jobId>/photos/<filename> and accompanied by
// a sidecar jobs/<jobId>/photos/<filename>.meta.json holding {area, stage,
// note, by, dwelling, caption, uploadedBy, ...}. GET merges the sidecar into
// each photo so Switchboard can filter/search photos by area/stage/who.
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
    // Index sidecars by their target pathname (drop ".meta.json").
    const photos = [];
    const sidecars = new Map();
    for (const b of blobs) {
      if (b.pathname.endsWith('.meta.json')) {
        sidecars.set(b.pathname.slice(0, -('.meta.json'.length)), b);
      } else {
        photos.push(b);
      }
    }
    // Fetch sidecars in parallel (small JSON each).
    const enriched = await Promise.all(photos.map(async b => {
      const base = {
        url: b.url,
        pathname: b.pathname,
        uploadedAt: b.uploadedAt,
        size: b.size,
      };
      const sc = sidecars.get(b.pathname);
      if (!sc) return base;
      try {
        const r = await fetch(sc.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return base;
        const meta = await r.json();
        return { ...base, meta };
      } catch {
        return base;
      }
    }));
    // Sort newest-first so Phil / Switchboard get a useful order by default.
    enriched.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return res.status(200).json({ photos: enriched });
  }

  if (req.method === 'POST') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const body = req.body || {};
    const { filename, data, contentType, meta } = body;
    if (!filename || !data) return res.status(400).json({ error: 'filename and data required' });
    // Reject any sidecar-shadowing filenames so a malicious upload can't
    // overwrite another photo's sidecar.
    if (/\.meta\.json$/i.test(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    const buf = Buffer.from(data, 'base64');
    const key = `${prefix}${Date.now()}-${filename}`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: contentType || 'image/jpeg',
      token,
    });
    // Persist metadata as a sidecar JSON file next to the photo. Always write
    // a sidecar — even minimal context (uploadedBy + timestamp) is useful so
    // Switchboard can attribute photos.
    const enrichedMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      uploadedBy: (meta && meta.by) || (meta && meta.uploadedBy) || user.username,
      uploadedById: user.id,
      uploadedAt: new Date().toISOString(),
      photoPathname: blob.pathname,
    };
    let metaBlob = null;
    try {
      metaBlob = await put(blob.pathname + '.meta.json', JSON.stringify(enrichedMeta), {
        access: 'public',
        contentType: 'application/json',
        token,
        addRandomSuffix: false,
      });
    } catch (e) {
      // Don't fail the photo upload if sidecar write fails; just log.
      console.error('photo meta sidecar write failed', e.message);
    }
    return res.status(200).json({
      url: blob.url,
      pathname: blob.pathname,
      meta: enrichedMeta,
      metaPathname: metaBlob ? metaBlob.pathname : null,
    });
  }

  if (req.method === 'DELETE') {
    if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });
    const { url } = req.query || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    await del(url, { token });
    // Best-effort: also remove the sidecar if we can find it by URL pattern.
    try {
      const u = new URL(url);
      const pathname = u.pathname.replace(/^\/+/, '').replace(/^.*?\/jobs\//, 'jobs/');
      const { blobs } = await list({ prefix: pathname + '.meta.json', token });
      const sc = blobs.find(b => b.pathname === pathname + '.meta.json');
      if (sc) await del(sc.url, { token });
    } catch {}
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
