// Type surface for the CommonJS Supabase Postgres connection helper
// (api/_lib/supabase-db.js) so src/ tests and future server code consume it
// type-checked. Policy + connection shape: docs/supabase-environment.md.

import type { SupabaseAccessDecision } from "./supabase-env";

/** Transaction-pooler-safe Postgres.js options (Supavisor :6543). */
export declare const POOL_OPTIONS: Readonly<{
  max: 1;
  prepare: false;
  idle_timeout: 20;
  connect_timeout: 10;
}>;

export interface CreateDbClientOptions {
  /** Defaults to 'write' — the strictest guard. */
  mode?: "read" | "write";
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** postgres() factory; injected in tests so no real connection opens. */
  factory?: (url: string, opts: typeof POOL_OPTIONS) => unknown;
}

export interface CreatedDbClient {
  client: unknown;
  decision: SupabaseAccessDecision;
  projectRef: string;
}

/** Build a guarded client. Throws SupabaseEnvError on any unsafe env. */
export declare function createDbClient(options?: CreateDbClientOptions): CreatedDbClient;

/** Process-wide singleton client (built guarded on first call). */
export declare function getDb(options?: CreateDbClientOptions): unknown;

/** Close + reset the singleton. Safe to call when none is open. */
export declare function closeDb(): Promise<void>;
