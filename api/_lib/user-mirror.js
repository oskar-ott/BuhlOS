// Signup/invite user mirror (#152) — create the public.user_profiles row the
// moment a NEW login is created, so Postgres knows every worker from day one.
//
// WHY (prod incident 2026-08-09): user_profiles was populated by the one-time
// June structure import; the crew-link signup flow (and invite accept) wrote
// only users.json. Every later joiner was invisible to PG — their hours were
// never mirrored (hours-mirror skips unknown users as 'tenant/user not
// mirrored'), and the supabase_read_hours rung trusted the resulting empty
// list, serving them a blank week. The read rung now falls back for unmapped
// workers (hours-read.js guard); THIS module closes the front door so new
// workers are mapped from the start instead of accumulating as fallbacks.
//
// Posture — identical to hours-mirror: Blob stays authoritative, the mirror is
// best-effort and NEVER throws; a PG failure can never break account creation.
// Gated the same way: no SUPABASE_DB_URL → skip; supabase_dual_write off →
// skip; missing tenant → skip. A real PG error returns {reason:'error'} so the
// caller's recordMirrorDrift lands it on the owner-console errors panel.
//
// Idempotent: upsert on user_profiles(tenant_id, legacy_user_id) with an
// IS DISTINCT FROM guard (the importer's convention) — a re-fired signup or a
// later structure-import re-run writes nothing and churns no revision.

const { getDb } = require('./supabase-db');
const { isFlagOn } = require('./feature-flags');

// Mirror of the user_profiles role CHECK (migration
// user_profiles_role_add_subcontractor). An unknown role is quarantined
// (skipped with a visible reason), never guessed — structure-import keeps the
// same rule via VALID_USER_ROLES.
const PG_USER_ROLES = [
  'admin', 'boss', 'owner', 'manager', 'office', 'pm', 'estimator',
  'leadinghand', 'tradie', 'apprentice', 'labourer', 'electrician', 'client',
  'subcontractor',
];

const MIRROR_TIMEOUT_MS = 4000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mirror one NEW login into public.user_profiles. Best-effort — NEVER throws.
 * `user` is the users.json row ({id, username, name, role, email, createdAt});
 * `extras.phone` carries the employee's phone (users.json has no phone field).
 * @returns {Promise<{mirrored:boolean, reason?:string, error?:string}>}
 */
async function mirrorSignupUser(user, extras = {}, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  try {
    if (!user || !user.id || !(user.username || user.name)) {
      return { mirrored: false, reason: 'no user/id/username' };
    }
    // Cheap prod short-circuit BEFORE the flag's blob read (hours-mirror rule).
    if (!process.env.SUPABASE_DB_URL) return { mirrored: false, reason: 'no supabase env' };
    if (!(await flagOn('supabase_dual_write'))) return { mirrored: false, reason: 'flag off' };
    if (!PG_USER_ROLES.includes(user.role)) {
      console.warn(`[user-mirror] skipping role "${user.role}" — fails the user_profiles CHECK`);
      return { mirrored: false, reason: `role "${user.role}" not mirrorable` };
    }
    return await withTimeout(mirrorWrite(db, user, extras), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorSignupUser');
  } catch (err) {
    console.error('[user-mirror] best-effort PG mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorWrite(db, user, extras) {
  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const t = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!t.length) return { mirrored: false, reason: 'tenant not mirrored' };
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  await sql`
    insert into public.user_profiles
      (tenant_id, legacy_user_id, username, display_name, email, phone, role, is_active, created_at)
    values (
      ${t[0].id}, ${user.id}, ${user.username || user.name},
      ${str(user.name)}, ${str(user.email)}, ${str(extras.phone)},
      ${user.role}, true, ${str(user.createdAt) || new Date().toISOString()}
    )
    on conflict (tenant_id, legacy_user_id) where legacy_user_id is not null do update set
      username = excluded.username,
      display_name = excluded.display_name,
      email = excluded.email,
      phone = excluded.phone,
      role = excluded.role,
      is_active = excluded.is_active
    where (
      user_profiles.username, user_profiles.display_name, user_profiles.email,
      user_profiles.phone, user_profiles.role, user_profiles.is_active
    ) is distinct from (
      excluded.username, excluded.display_name, excluded.email,
      excluded.phone, excluded.role, excluded.is_active
    )
  `;
  return { mirrored: true };
}

module.exports = { mirrorSignupUser, PG_USER_ROLES };
