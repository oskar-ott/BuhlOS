// Supabase environment guard — server-only, no database connection here.
//
// Why this exists: the production Supabase project (wetctlrhsycfwhuxlarv)
// will eventually hold payroll-critical data, and PR previews are this
// repo's main verification surface. A single shared SUPABASE_DB_URL would
// mean every preview deployment writes production Postgres. This module is
// the hard stop: every future DB client, importer or migration script MUST
// call assertSupabaseAccess() before opening a connection. Nothing in the
// app calls it yet — the guard ships ahead of the first client on purpose.
//
// Policy (full contract + Vercel setup: docs/supabase-environment.md):
//   * fail closed — missing/invalid SUPABASE_* env always throws
//   * the production project ref is only reachable when SUPABASE_ENV is
//     exactly 'production' AND (on Vercel) VERCEL_ENV is 'production'
//   * production WRITES additionally require
//     SUPABASE_ALLOW_PRODUCTION_WRITES === 'true' (exact string)
//   * the project ref embedded in SUPABASE_DB_URL must agree with
//     SUPABASE_PROJECT_REF — a paste error in either direction throws
//   * server-only: refuses to run outside a Node runtime

const PRODUCTION_PROJECT_REF = "wetctlrhsycfwhuxlarv";

const SUPABASE_ENVS = Object.freeze([
  "production",
  "staging",
  "preview",
  "development",
  "local",
]);

const MODES = Object.freeze(["read", "write"]);

class SupabaseEnvError extends Error {
  /**
   * @param {string} code stable machine-checkable reason
   * @param {string} message human explanation
   */
  constructor(code, message) {
    super(`[supabase-env] ${code}: ${message}`);
    this.name = "SupabaseEnvError";
    this.code = code;
  }
}

// A hosted Supabase connection string embeds the project ref. Recognised:
//   direct    postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
//   supavisor postgresql://postgres.<ref>:pw@aws-0-<region>.pooler.supabase.com:6543/postgres
//   api url   https://<ref>.supabase.co
// Returns null when no ref is recognisable (localhost / self-hosted CLI
// stack) — legitimate for SUPABASE_ENV=local.
function extractProjectRef(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  const direct = url.match(/@db\.([a-z0-9]{15,})\.supabase\.(?:co|com)/i);
  if (direct) return direct[1].toLowerCase();
  const pooler = url.match(/^postgres(?:ql)?:\/\/postgres\.([a-z0-9]{15,})[:@]/i);
  if (pooler) return pooler[1].toLowerCase();
  const api = url.match(/^https:\/\/([a-z0-9]{15,})\.supabase\.(?:co|com)(?:[/:]|$)/i);
  if (api) return api[1].toLowerCase();
  return null;
}

function detectServerRuntime() {
  return typeof process !== "undefined" && Boolean(process.versions && process.versions.node);
}

/**
 * Pure policy check. Throws SupabaseEnvError on every unsafe combination;
 * returns a frozen decision object when access is allowed. Callers in app
 * code use assertSupabaseAccess() below; tests feed env objects in here.
 *
 * @param {Record<string, string | undefined>} env usually process.env
 * @param {{ mode?: 'read'|'write', isServerRuntime?: boolean }} [options]
 *   mode defaults to 'write' — the strictest interpretation, so a caller
 *   that forgets to declare read intent hits the stronger gate, never the
 *   weaker one. isServerRuntime is a test hook only.
 */
function evaluateSupabaseAccess(env, options = {}) {
  const mode = options.mode === undefined ? "write" : options.mode;
  const isServer =
    options.isServerRuntime === undefined ? detectServerRuntime() : options.isServerRuntime;

  if (!isServer) {
    throw new SupabaseEnvError(
      "BROWSER_CONTEXT",
      "supabase-env is server-only; refusing to evaluate database access outside a Node runtime"
    );
  }
  if (!MODES.includes(mode)) {
    throw new SupabaseEnvError(
      "INVALID_MODE",
      `mode must be one of ${MODES.join(", ")} (got ${JSON.stringify(mode)})`
    );
  }
  if (!env || typeof env !== "object") {
    throw new SupabaseEnvError("MISSING_ENV", "no environment object provided");
  }

  const supabaseEnv = env.SUPABASE_ENV;
  if (!supabaseEnv) {
    throw new SupabaseEnvError(
      "MISSING_ENV",
      "SUPABASE_ENV is not set — set one of " + SUPABASE_ENVS.join(", ")
    );
  }
  if (!SUPABASE_ENVS.includes(supabaseEnv)) {
    throw new SupabaseEnvError(
      "INVALID_ENV",
      `SUPABASE_ENV=${JSON.stringify(supabaseEnv)} is not one of ${SUPABASE_ENVS.join(", ")}`
    );
  }

  const projectRef = env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new SupabaseEnvError("MISSING_ENV", "SUPABASE_PROJECT_REF is not set");
  }

  const dbUrl = env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new SupabaseEnvError("MISSING_ENV", "SUPABASE_DB_URL is not set");
  }

  const urlProjectRef = extractProjectRef(dbUrl);
  if (urlProjectRef && urlProjectRef !== projectRef) {
    throw new SupabaseEnvError(
      "REF_URL_MISMATCH",
      `SUPABASE_DB_URL points at project "${urlProjectRef}" but SUPABASE_PROJECT_REF says ` +
        `"${projectRef}" — refusing to guess which one is intended`
    );
  }

  // Fail CLOSED on an unrecognisable connection-string host. If extractProjectRef
  // can't read a ref from the URL, we cannot prove the host isn't production — and
  // the production checks below are keyed off the ref, so a null ref would let an
  // unrecognised prod-fronting host (an IPv4, a custom proxy / PgBouncer) slip
  // EVERY production gate (isProductionProject would be false). That is a fail-OPEN
  // in a guard whose whole job is to fail closed. A null ref is only legitimate for
  // a local/dev stack (localhost / a custom local host the patterns don't match),
  // so we allow it ONLY for SUPABASE_ENV=local|development and refuse it everywhere
  // else (production/staging/preview must use a recognised Supabase host).
  if (!urlProjectRef && supabaseEnv !== "local" && supabaseEnv !== "development") {
    throw new SupabaseEnvError(
      "URL_REF_UNRECOGNISED",
      `could not identify the Supabase project from SUPABASE_DB_URL (its host is not a ` +
        `recognised Supabase pooler/direct/api shape) while SUPABASE_ENV=${supabaseEnv} — ` +
        `refusing to connect because an unrecognised host cannot be proven non-production ` +
        `(use SUPABASE_ENV=local or development for a local stack)`
    );
  }

  // Either signal naming production counts as production — a dev-claiming
  // SUPABASE_PROJECT_REF cannot launder a production connection string
  // (the mismatch check above already threw), and vice versa.
  const isProductionProject =
    projectRef === PRODUCTION_PROJECT_REF || urlProjectRef === PRODUCTION_PROJECT_REF;

  if (isProductionProject) {
    if (supabaseEnv !== "production") {
      throw new SupabaseEnvError(
        "PROD_REF_IN_NON_PROD_ENV",
        `refusing to touch the production project (${PRODUCTION_PROJECT_REF}) while ` +
          `SUPABASE_ENV=${supabaseEnv} — previews/dev/local must point at a dev project ` +
          `(see docs/supabase-environment.md)`
      );
    }
    const vercelEnv = env.VERCEL_ENV;
    if (vercelEnv && vercelEnv !== "production") {
      throw new SupabaseEnvError(
        "PROD_REF_IN_NON_PROD_RUNTIME",
        `refusing to touch the production project from a Vercel "${vercelEnv}" deployment ` +
          `even though SUPABASE_ENV claims production — fix the environment-scoped ` +
          `variables in Vercel so Preview/Development never carry production values`
      );
    }
    if (mode === "write" && env.SUPABASE_ALLOW_PRODUCTION_WRITES !== "true") {
      throw new SupabaseEnvError(
        "PROD_WRITES_NOT_ALLOWED",
        'write access to the production project requires SUPABASE_ALLOW_PRODUCTION_WRITES="true" ' +
          "(the exact lowercase string) — read access does not"
      );
    }
  }

  return Object.freeze({
    allowed: true,
    mode,
    supabaseEnv,
    projectRef,
    urlProjectRef,
    isProductionProject,
  });
}

/**
 * The guard real callers use: evaluates process.env. Call this before
 * opening ANY Supabase/Postgres connection (client, importer, script).
 */
function assertSupabaseAccess(options = {}) {
  return evaluateSupabaseAccess(process.env, options);
}

module.exports = {
  PRODUCTION_PROJECT_REF,
  SUPABASE_ENVS,
  MODES,
  SupabaseEnvError,
  extractProjectRef,
  evaluateSupabaseAccess,
  assertSupabaseAccess,
};
