const { put, del } = require('@vercel/blob');

const INDEX_KEY = 'birdwood-photos-index.json';

async function readIndex() {
  try {
    const res = await fetch(`https://blob.vercel-storage.com/${INDEX_KEY}`, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
    });
    if (!res.ok) return {};
    return await res.json();
  } catch (e) {
    return {};
  }
}

async function writeIndex(index) {
  await put(INDEX_KEY, JSON.stringify(index), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const index = await readIndex();
    const { dwelling } = req.query;
    if (dwelling) return res.status(200).json(index[dwelling] || []);
    return res.status(200).json(index);
  }

  if (req.method === 'POST') {
    try {
      const { dwelling, stage, group, caption, uploadedBy, dataUrl } = req.body;
      if (!dwelling || !dataUrl) return res.status(400).json({ error: 'Missing fields' });

      // Store actual image in blob
      const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
      const base64Data = dataUrl.split(',')[1];
      const mimeType = dataUrl.match(/data:([^;]+)/)[1];
      const buffer = Buffer.from(base64Data, 'base64');

      const blob = await put(`birdwood-photos/${photoId}.jpg`, buffer, {
        access: 'public',
        contentType: mimeType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });

      const index = await readIndex();
      if (!index[dwelling]) index[dwelling] = [];
      index[dwelling].push({
        id: photoId,
        url: blob.url,
        stage, group, caption: caption || '',
        uploadedBy: uploadedBy || 'Unknown',
        date: new Date().toLocaleDateString('en-AU'),
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
      });
      await writeIndex(index);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { dwelling, photoId } = req.body;
      const index = await readIndex();
      if (index[dwelling]) {
        index[dwelling] = index[dwelling].filter(p => p.id !== photoId);
        await writeIndex(index);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
