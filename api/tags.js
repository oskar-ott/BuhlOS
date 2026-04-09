const { put, list } = require('@vercel/blob');
const KEY = 'birdwood-tags.json';

async function readTags() {
  try {
    const { blobs } = await list({ prefix: KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!blobs.length) return [];
    const r = await fetch(blobs[0].url + '?t=' + Date.now());
    return await r.json();
  } catch(e) { return []; }
}

async function writeTags(data) {
  await put(KEY, JSON.stringify(data), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json(await readTags());
  }

  if (req.method === 'POST') {
    try {
      const tags = await readTags();
      const { id, ...rest } = req.body;
      if (id) {
        // update existing
        const idx = tags.findIndex(t => t.id === id);
        if (idx > -1) tags[idx] = { ...tags[idx], ...rest };
      } else {
        // new tag
        tags.push({
          id: Date.now() + '_' + Math.random().toString(36).slice(2),
          ...rest,
          addedDate: new Date().toLocaleDateString('en-AU')
        });
      }
      await writeTags(tags);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === 'DELETE') {
    try {
      const { id } = req.body;
      const tags = await readTags();
      await writeTags(tags.filter(t => t.id !== id));
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  res.status(405).end();
};
