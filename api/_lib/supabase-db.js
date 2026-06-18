// Supabase Postgres connection helper — server-only, lazy, guarded.
//
// This is the ONE chokepoint for opening a Postgres connection. Every future
// caller (importer, operator script, server route) goes through here; the
// connection is only ever created AFTER the environment guard in
// ./supabase-env passes, so a misconfigured preview / local / test run can
// never reach the production project (wetctlrhsycfwhuxlarv). Importing this
// module opens nothing — the client is built lazily on first getDb().
//
// Client: Postgres.js (`postgres`) in transaction-pooler-safe mode, the shape
// the migration roadmap settled on (docs/supabase-environment.md,
// docs/supabase-migration-research-audit.md §4.4):
//   * max: 1            — one connection per warm serverless invocation
//   * prepare: false    — Supavisor transaction mode (port 6543) forbids
//                         prepared statements
//   * idle_timeout: 20  — Postgres.js closes its own idle connection, so no
//                         Vercel attachDatabasePool step is needed
//   * connect_timeout: 10
//
// No feature code lives here. Nothing in the app calls getDb() yet — the
// helper ships ahead of the first consumer on purpose, exactly like the
// supabase-env guard it sits behind.

const { evaluateSupabaseAccess } = require("./supabase-env");

// Transaction-pooler-safe defaults (Supavisor :6543). Frozen so a caller
// cannot mutate the shared object.
const POOL_OPTIONS = Object.freeze({
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Process-wide singleton: { client, decision }. Reused across warm
// invocations so we hold at most one pooled connection per instance.
let singleton = null;

/**
 * Build a Postgres.js client after the env guard passes.
 *
 * Pure, injectable seam: callers (and tests) may pass `env` and `factory`
 * so no real connection is ever opened in unit tests. The guard runs FIRST
 * — it throws SupabaseEnvError on every unsafe combination (missing env,
 * production ref from a non-production env/runtime, prod write without the
 * explicit opt-in, ref/URL mismatch, browser context) before any network
 * touch.
 *
 * @param {object} [options]
 * @param {'read'|'write'} [options.mode] defaults to 'write' (strictest gate)
 * @param {Record<string, string | undefined>} [options.env] defaults to process.env
 * @param {(url: string, opts: object) => any} [options.factory] postgres() factory; injected in tests
 * @returns {{ client: any, decision: object, projectRef: string }}
 */
function createDbClient(options = {}) {
  const mode = options.mode === undefined ? "write" : options.mode;
  const env = options.env || process.env;

  // Fail closed before touching the network.
  const decision = evaluateSupabaseAccess(env, { mode });

  const url = env.SUPABASE_DB_URL;
  // SUPABASE_DB_URL presence is already enforced by the guard above; this is
  // belt-and-braces so a future guard change can never hand us an empty URL.
  if (!url) {
    throw new Error("[supabase-db] SUPABASE_DB_URL missing after guard passed");
  }

  // Lazily require the driver only on the real path, so importing this module
  // (and running the unit tests, which inject a factory) needs no live driver
  // and never opens a socket.
  const make = options.factory || require("postgres");
  const client = make(url, POOL_OPTIONS);

  return { client, decision, projectRef: decision.projectRef };
}

/**
 * Process-wide singleton client. Builds one on first call (guarded), then
 * returns the same instance. Pass `env`/`factory` only in tests.
 *
 * @param {object} [options] same shape as createDbClient
 * @returns {any} the Postgres.js client (a tagged-template `sql` function)
 */
function getDb(options = {}) {
  if (singleton) return singleton.client;
  singleton = createDbClient(options);
  return singleton.client;
}

/**
 * Close the singleton connection and reset. Safe to call when none is open.
 * Importers/scripts should call this in a finally block.
 */
async function closeDb() {
  if (!singleton) return;
  const { client } = singleton;
  singleton = null;
  if (client && typeof client.end === "function") {
    await client.end({ timeout: 5 });
  }
}

module.exports = {
  POOL_OPTIONS,
  createDbClient,
  getDb,
  closeDb,
};
