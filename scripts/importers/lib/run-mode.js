// Importer run-mode resolution — PURE, guard-enforced.
//
// Dry-run is the default and the only implemented mode. `--write` must
// FIRST pass the Supabase environment guard in write mode (so an unsafe
// target throws the guard's loud error), and even then throws
// WRITE_NOT_IMPLEMENTED — this scaffold performs no database writes.

function resolveRunMode(argv, env, guard) {
  const wantsWrite = Array.isArray(argv) && argv.includes('--write');
  if (!wantsWrite) return { mode: 'dry-run' };

  // Throws SupabaseEnvError unless env explicitly permits production writes
  // (or targets a non-production project). Never bypassed.
  guard.evaluateSupabaseAccess(env, { mode: 'write' });

  const err = new Error(
    '[importer] WRITE_NOT_IMPLEMENTED: this scaffold is dry-run only — no Supabase writes exist yet'
  );
  err.code = 'WRITE_NOT_IMPLEMENTED';
  throw err;
}

// Human-readable target lines for the report header. Dry-run needs no
// Supabase access, so unset env is fine and said so explicitly.
function describeTarget(env) {
  const supabaseEnv = env.SUPABASE_ENV || '(not set)';
  const ref = env.SUPABASE_PROJECT_REF || '(not set)';
  const note =
    env.SUPABASE_ENV || env.SUPABASE_PROJECT_REF
      ? ''
      : ' — fine for dry-run; no Supabase access happens';
  return [`SUPABASE_ENV:         ${supabaseEnv}`, `SUPABASE_PROJECT_REF: ${ref}${note}`];
}

module.exports = { resolveRunMode, describeTarget };
