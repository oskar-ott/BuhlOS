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
 * returns the same instance — but RE-RUNS the env guard with THIS caller's
 * mode on every call, including cache hits, so the per-mode gate (notably the
 * production-write opt-in) is enforced per call, never just when the singleton
 * was first built. Pass `env`/`factory` only in tests.
 *
 * @param {object} [options] same shape as createDbClient
 * @returns {any} the Postgres.js client (a tagged-template `sql` function)
 * @throws {SupabaseEnvError} when this call's mode/env fails the guard, even
 *   on a cache hit (e.g. a write caller arriving after a read-built singleton
 *   without SUPABASE_ALLOW_PRODUCTION_WRITES)
 */
function getDb(options = {}) {
  if (singleton) {
    // Cache hit. The singleton holds ONE connection for the whole warm
    // instance, but the env guard is PER-MODE: a read caller cleared a weaker
    // gate than a write caller must. So re-run the guard with this caller's
    // mode every time and never trust that the mode which built the singleton
    // is the mode now asking. The guard is pure and network-free, so this is
    // effectively free. Without it a read-built singleton would be handed to a
    // later write caller without the production-write opt-in
    // (SUPABASE_ALLOW_PRODUCTION_WRITES) ever being re-checked — the per-mode
    // gate would silently degrade to per-process.
    const mode = options.mode === undefined ? "write" : options.mode;
    const env = options.env || process.env;
    const decision = evaluateSupabaseAccess(env, { mode });

    // The re-evaluated env must still describe the project the cached client
    // actually connected to. In a real serverless instance process.env is
    // fixed, so this only diverges if the env changed under us — refuse rather
    // than hand back a client pointed at a different project.
    if (decision.projectRef !== singleton.decision.projectRef) {
      throw new Error(
        `[supabase-db] cached client connected to project ${singleton.decision.projectRef} ` +
          `but this call resolves to ${decision.projectRef} — refusing to reuse it`
      );
    }
    return singleton.client;
  }
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
