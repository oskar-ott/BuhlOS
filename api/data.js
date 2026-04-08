const fs = require('fs');
const path = require('path');

const DATA_FILE = '/tmp/birdwood_data.json';

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return { dwellings: {}, snags: [] };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json(readData());
  }

  if (req.method === 'POST') {
    try {
      const data = req.body;
      writeData(data);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).end();
};
