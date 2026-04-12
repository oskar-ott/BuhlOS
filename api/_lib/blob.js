// Shared blob read/write helpers.
// Centralises the list+fetch+put pattern so API routes stay thin.
const { put, list, del } = require('@vercel/blob');

const token = () => process.env.BLOB_READ_WRITE_TOKEN;

async function readBlob(key, fallback = null) {
  try {
    const { blobs } = await list({ prefix: key, token: token() });
    const match = blobs.find(b => b.pathname === key);
    if (!match) return fallback;
    const r = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) {
    console.error('readBlob error', key, e.message);
    return fallback;
  }
}

async function writeBlob(key, data) {
  await put(key, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: token(),
  });
}

async function deleteBlob(key) {
  try {
    const { blobs } = await list({ prefix: key, token: token() });
    const match = blobs.find(b => b.pathname === key);
    if (match) await del(match.url, { token: token() });
  } catch (e) {
    console.error('deleteBlob error', key, e.message);
  }
}

function setNoCache(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cache-Control', 'no-store,no-cache,must-revalidate,max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
}

module.exports = { readBlob, writeBlob, deleteBlob, setNoCache };
