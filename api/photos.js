const fs = require('fs');

const PHOTOS_FILE = '/tmp/birdwood_photos.json';

function readPhotos() {
  try {
    if (fs.existsSync(PHOTOS_FILE)) {
      return JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writePhotos(data) {
  fs.writeFileSync(PHOTOS_FILE, JSON.stringify(data));
}

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/photos?dwelling=Unit+1
  if (req.method === 'GET') {
    const photos = readPhotos();
    const { dwelling } = req.query;
    if (dwelling) {
      return res.status(200).json(photos[dwelling] || []);
    }
    return res.status(200).json(photos);
  }

  // POST /api/photos — add a photo
  // body: { dwelling, stage, group, caption, uploadedBy, dataUrl }
  if (req.method === 'POST') {
    try {
      const { dwelling, stage, group, caption, uploadedBy, dataUrl } = req.body;
      if (!dwelling || !stage || !dataUrl) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const photos = readPhotos();
      if (!photos[dwelling]) photos[dwelling] = [];
      photos[dwelling].push({
        id: Date.now() + '_' + Math.random().toString(36).slice(2),
        stage,
        group,
        caption: caption || '',
        uploadedBy: uploadedBy || 'Unknown',
        date: new Date().toLocaleDateString('en-AU'),
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        dataUrl
      });
      writePhotos(photos);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE /api/photos — remove a photo
  // body: { dwelling, photoId }
  if (req.method === 'DELETE') {
    try {
      const { dwelling, photoId } = req.body;
      const photos = readPhotos();
      if (photos[dwelling]) {
        photos[dwelling] = photos[dwelling].filter(p => p.id !== photoId);
      }
      writePhotos(photos);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
