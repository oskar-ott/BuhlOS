// Supabase connectivity health — the read-only "proving slice" (#533).
//
//   GET /api/supabase-health
//
// The FIRST place the deployed app actually talks to Supabase Postgres.
// Everything about it is deliberately conservative:
//   * admin-tier only (requireAuth { roles: ['admin'] });
//   * DARK by default behind the `supabase_read_health` flag — returns
//     { enabled: false } until the flag is switched on (env FLAG_… or the
//     flags.json blob), so merging this changes nothing live;
//   * READ-ONLY — three SELECTs, no writes, no business data;
//   * GUARDED — getDb() runs the supabase-env guard first, so a misconfigured
//     or production runtime fails closed (caught → 502) and can never write.
//
// Why it exists: prove, on a real Vercel deployment (PR previews are this
// repo's verification surface — local `next dev` can't run api/*.js), that the
// env guard → Supavisor transaction pooler → Postgres.js client path works
// end-to-end, BEFORE any domain dual-write (#152) rides on it.
//
// Response (flag on, healthy):
//   { enabled: true, ok: true, supabaseEnv, projectRef, publicTables,
//     migrations, server, asOf }
// Response (flag off):         { enabled: false }
// Response (connect failure):  { enabled: true, ok: false, error }   (HTTP 502)
//
// Permissions: admin only. Dark by default.

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { isFlagOn } = require('./_lib/feature-flags');
const { getDb } = require('./_lib/supabase-db');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  // Dark by default: inert until the flag is explicitly enabled.
  if (!(await isFlagOn('supabase_read_health'))) {
    return res.status(200).json({ enabled: false });
  }

  try {
    // getDb() runs the env guard BEFORE connecting — a non-production runtime
    // can only ever reach a non-production project, and a production runtime
    // with no SUPABASE_* wired throws here and is reported as a failure,
    // never a silent connection or write.
    const sql = getDb({ mode: 'read' });
    const [tables, migrations, version] = await Promise.all([
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
      sql`select count(*)::int as n from supabase_migrations.schema_migrations`,
      sql`select version() as v`,
    ]);
    return res.status(200).json({
      enabled: true,
      ok: true,
      supabaseEnv: process.env.SUPABASE_ENV || null,
      projectRef: process.env.SUPABASE_PROJECT_REF || null,
      publicTables: tables[0].n,
      migrations: migrations[0].n,
      server: String(version[0].v).split(' on ')[0],
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    // Honest failure — never fake a healthy connection (P7).
    const message =
      err && err.code ? `${err.code}: ${err.message}` : (err && err.message) || 'unknown error';
    return res.status(502).json({ enabled: true, ok: false, error: message });
  }
};
