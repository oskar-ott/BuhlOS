// THROWAWAY verification endpoint — NEVER merged. Proves a DEPLOYED Vercel
// serverless function can run the hours dual-write mirror (write to the dev
// Supabase pooler) end-to-end. It mirrors an EXISTING dev blob entry, so the
// upsert is an idempotent no-op (no data written, no cleanup). Branch-scoped
// Preview env supplies the dev SUPABASE_* + FLAG_SUPABASE_DUAL_WRITE=1.
const { list } = require('@vercel/blob');
const { mirrorTimeEntry } = require('./_lib/hours-mirror');
const { closeDb } = require('./_lib/supabase-db');

module.exports = async (req, res) => {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const r = await list({ prefix: 'users/', token, limit: 1000 });
    const re = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;
    const b = (r.blobs || []).map((x) => ({ m: re.exec(x.pathname), u: x.url })).find((x) => x.m);
    if (!b) return res.status(200).json({ ok: false, reason: 'no blob entry to mirror' });
    const entry = await (await fetch(b.u + '?t=' + Date.now(), { cache: 'no-store' })).json();
    const result = await mirrorTimeEntry(b.m[1], entry);
    return res.status(200).json({
      ok: true,
      serverless: true,
      supabaseEnv: process.env.SUPABASE_ENV || null,
      projectRef: process.env.SUPABASE_PROJECT_REF || null,
      result,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message });
  } finally {
    await closeDb();
  }
};
