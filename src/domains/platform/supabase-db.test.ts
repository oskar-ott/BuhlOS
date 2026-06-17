import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Guarded Postgres connection helper (api/_lib/supabase-db.js). These are
 * pure unit tests: a fake `postgres` factory is injected everywhere, so NO
 * real database connection is ever opened and the `postgres` driver does not
 * need to be installed for the suite to run. The contract under test is that
 * the env guard runs FIRST (the production project must be unreachable from
 * previews/local/tests) and that the client is built with the
 * transaction-pooler-safe options the roadmap settled on.
 */

const requireFromHere = createRequire(import.meta.url);

type PoolOptions = {
  max: number;
  prepare: boolean;
  idle_timeout: number;
  connect_timeout: number;
};

type FakeClient = { end: (opts?: unknown) => Promise<void>; __id: number };

type DbModule = {
  POOL_OPTIONS: PoolOptions;
  createDbClient: (options?: {
    mode?: "read" | "write";
    env?: Record<string, string | undefined>;
    factory?: (url: string, opts: PoolOptions) => unknown;
  }) => { client: unknown; decision: { projectRef: string }; projectRef: string };
  getDb: (options?: {
    mode?: "read" | "write";
    env?: Record<string, string | undefined>;
    factory?: (url: string, opts: PoolOptions) => unknown;
  }) => unknown;
  closeDb: () => Promise<void>;
};

const guard = requireFromHere("../../../api/_lib/supabase-env.js") as {
  PRODUCTION_PROJECT_REF: string;
};
const db = requireFromHere("../../../api/_lib/supabase-db.js") as DbModule;

const PROD_REF = guard.PRODUCTION_PROJECT_REF;
const DEV_REF = "devprojectref0123456"; // 20 chars, plausible non-production ref

function poolerUrl(ref: string): string {
  return `postgresql://postgres.${ref}:secret@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`;
}

/** A valid non-production (preview) environment for the guard. */
function devEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SUPABASE_ENV: "preview",
    SUPABASE_PROJECT_REF: DEV_REF,
    SUPABASE_DB_URL: poolerUrl(DEV_REF),
    ...overrides,
  };
}

let nextId = 1;
/** Records every connection attempt; proves whether a client was built. */
function fakeFactory() {
  const calls: Array<{ url: string; opts: PoolOptions; client: FakeClient }> = [];
  const factory = (url: string, opts: PoolOptions): FakeClient => {
    const client: FakeClient = { __id: nextId++, end: vi.fn(async () => {}) };
    calls.push({ url, opts, client });
    return client;
  };
  return { factory, calls };
}

afterEach(async () => {
  // Reset the module singleton between tests.
  await db.closeDb();
  vi.restoreAllMocks();
});

describe("supabase-db connection helper", () => {
  it("fails closed before connecting when env is missing", () => {
    const { factory, calls } = fakeFactory();
    expect(() => db.createDbClient({ env: {}, factory })).toThrow(/supabase-env/);
    expect(calls).toHaveLength(0); // never attempted a connection
  });

  it("refuses the production project from a non-production env (never connects)", () => {
    const { factory, calls } = fakeFactory();
    expect(() =>
      db.createDbClient({
        env: devEnv({ SUPABASE_PROJECT_REF: PROD_REF, SUPABASE_DB_URL: poolerUrl(PROD_REF) }),
        factory,
      })
    ).toThrow(/PROD_REF_IN_NON_PROD_ENV/);
    expect(calls).toHaveLength(0);
  });

  it("builds a client with transaction-pooler-safe options once the guard passes", () => {
    const { factory, calls } = fakeFactory();
    const { client, projectRef } = db.createDbClient({ env: devEnv(), factory });
    expect(client).toBeDefined();
    expect(projectRef).toBe(DEV_REF);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected a connection attempt");
    expect(call.url).toBe(poolerUrl(DEV_REF));
    expect(call.opts).toMatchObject({
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });

  it("exposes frozen pool options matching the roadmap shape", () => {
    expect(db.POOL_OPTIONS).toMatchObject({
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    expect(Object.isFrozen(db.POOL_OPTIONS)).toBe(true);
  });

  it("allows read mode on production without the write opt-in", () => {
    // Production read from a production-claiming env/runtime: write would need
    // SUPABASE_ALLOW_PRODUCTION_WRITES, read does not.
    const { factory, calls } = fakeFactory();
    const prodReadEnv = {
      SUPABASE_ENV: "production",
      SUPABASE_PROJECT_REF: PROD_REF,
      SUPABASE_DB_URL: poolerUrl(PROD_REF),
      // no VERCEL_ENV (operator shell), no SUPABASE_ALLOW_PRODUCTION_WRITES
    };
    expect(() => db.createDbClient({ mode: "read", env: prodReadEnv, factory })).not.toThrow();
    expect(calls).toHaveLength(1);
    // ...but a write against the same env is refused.
    expect(() => db.createDbClient({ mode: "write", env: prodReadEnv, factory })).toThrow(
      /PROD_WRITES_NOT_ALLOWED/
    );
  });

  it("getDb returns a single shared instance until closed", async () => {
    const { factory, calls } = fakeFactory();
    const a = db.getDb({ env: devEnv(), factory });
    const b = db.getDb({ env: devEnv(), factory });
    expect(a).toBe(b);
    expect(calls).toHaveLength(1); // singleton: built once
    const built = calls[0];
    if (!built) throw new Error("expected first client");

    await db.closeDb();
    expect(built.client.end as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();

    const c = db.getDb({ env: devEnv(), factory });
    expect(c).not.toBe(a); // rebuilt after close
    expect(calls).toHaveLength(2);
  });

  it("is inert under the test/CI process env (no SUPABASE_* set → throws, no connection)", () => {
    // The suite sets no SUPABASE_* vars, so a default-env call fails closed.
    const { factory, calls } = fakeFactory();
    expect(() => db.createDbClient({ factory })).toThrow(/supabase-env/);
    expect(calls).toHaveLength(0);
  });
});
