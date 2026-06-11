// Shared asset-register access (#305) — extracted from api/assets.js so the
// compliance loop (tags-expiring endpoint + the daily reminder cron in
// api/notifications.js) can enumerate assets without re-implementing the
// one-file-per-asset storage layout:
//
//   assets/<id>.json            — the asset record (one file per asset)
//   assets/<id>/history.json    — append-only transfer log (NOT returned here)
//
// There is deliberately NO assets/registry.json single document — see the
// storage rationale at the top of api/assets.js.

const { list } = require('@vercel/blob');

// List all asset records. Reads bypass any cache (each record is fetched by
// URL with no-store) because the register is small and correctness on the
// admin/compliance surfaces beats latency.
async function listAllAssets() {
  try {
    const { blobs } = await list({ prefix: 'assets/', token: process.env.BLOB_READ_WRITE_TOKEN });
    // Only the per-asset record files at the top level — exclude /history.json under each.
    const flat = (blobs || []).filter(b =>
      b.pathname.startsWith('assets/') &&
      b.pathname.endsWith('.json') &&
      !b.pathname.endsWith('/history.json')
    );
    const records = await Promise.all(flat.map(async b => {
      try {
        const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    }));
    return records.filter(Boolean);
  } catch (e) {
    console.error('listAllAssets failed:', e.message);
    return [];
  }
}

module.exports = { listAllAssets };
