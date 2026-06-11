import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SupabaseAccessDecision,
  SupabaseAccessOptions,
  SupabaseEnvError as SupabaseEnvErrorType,
} from "../../../api/_lib/supabase-env";

/**
 * Environment-safety guard for all future Supabase access. The production
 * project (wetctlrhsycfwhuxlarv) must be unreachable from previews, local
 * runs and tests; production writes need an explicit extra opt-in. Pure
 * policy tests — no database connection is ever opened.
 */

const requireFromHere = createRequire(import.meta.url);

type GuardModule = {
  PRODUCTION_PROJECT_REF: string;
  SUPABASE_ENVS: readonly string[];
  SupabaseEnvError: new (code: string, message: string) => SupabaseEnvErrorType;
  extractProjectRef: (url: string | null | undefined) => string | null;
  evaluateSupabaseAccess: (
    env: Record<string, string | undefined>,
    options?: SupabaseAccessOptions
  ) => SupabaseAccessDecision;
  assertSupabaseAccess: (options?: SupabaseAccessOptions) => SupabaseAccessDecision;
};

const guard = requireFromHere("../../../api/_lib/supabase-env.js") as GuardModule;

const PROD_REF = guard.PRODUCTION_PROJECT_REF;
const DEV_REF = "devprojectref0123456"; // 20 chars, plausible non-production ref

function poolerUrl(ref: string): string {
  return `postgresql://postgres.${ref}:secret@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`;
}

function directUrl(ref: string): string {
  return `postgresql://postgres:secret@db.${ref}.supabase.co:5432/postgres`;
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SUPABASE_ENV: "production",
    SUPABASE_PROJECT_REF: PROD_REF,
    SUPABASE_DB_URL: poolerUrl(PROD_REF),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected SupabaseEnvError ${code} to be thrown`).toBeInstanceOf(
    guard.SupabaseEnvError
  );
  expect((thrown as SupabaseEnvErrorType).code).toBe(code);
}

describe("supabase-env guard — production project protection", () => {
  it.each(["preview", "development", "staging", "local"] as const)(
    "throws when the production ref is used with SUPABASE_ENV=%s",
    (supabaseEnv) => {
      expectCode(
        () => guard.evaluateSupabaseAccess(baseEnv({ SUPABASE_ENV: supabaseEnv })),
        "PROD_REF_IN_NON_PROD_ENV"
      );
    }
  );

  it("passes for production ref + production env + writes explicitly allowed", () => {
    const decision = guard.evaluateSupabaseAccess(
      baseEnv({ SUPABASE_ALLOW_PRODUCTION_WRITES: "true" }),
      { mode: "write" }
    );
    expect(decision.allowed).toBe(true);
    expect(decision.isProductionProject).toBe(true);
    expect(decision.mode).toBe("write");
    expect(decision.urlProjectRef).toBe(PROD_REF);
  });

  it("throws for production write mode without the explicit allow flag", () => {
    expectCode(
      () => guard.evaluateSupabaseAccess(baseEnv(), { mode: "write" }),
      "PROD_WRITES_NOT_ALLOWED"
    );
  });

  it("defaults to write mode (strictest) when mode is omitted", () => {
    expectCode(() => guard.evaluateSupabaseAccess(baseEnv()), "PROD_WRITES_NOT_ALLOWED");
  });

  it("requires the allow flag to be the exact lowercase string 'true'", () => {
    for (const value of ["TRUE", "1", "yes", " true"]) {
      expectCode(
        () =>
          guard.evaluateSupabaseAccess(baseEnv({ SUPABASE_ALLOW_PRODUCTION_WRITES: value }), {
            mode: "write",
          }),
        "PROD_WRITES_NOT_ALLOWED"
      );
    }
  });

  it("allows production reads without the write flag", () => {
    const decision = guard.evaluateSupabaseAccess(baseEnv(), { mode: "read" });
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("read");
  });

  it("throws when a Vercel preview deployment carries production values", () => {
    // The copied-env accident: SUPABASE_ENV claims production, but the
    // actual Vercel runtime is a preview deployment.
    expectCode(
      () =>
        guard.evaluateSupabaseAccess(
          baseEnv({ SUPABASE_ALLOW_PRODUCTION_WRITES: "true", VERCEL_ENV: "preview" }),
          { mode: "read" }
        ),
      "PROD_REF_IN_NON_PROD_RUNTIME"
    );
  });

  it("passes on the real Vercel production runtime", () => {
    const decision = guard.evaluateSupabaseAccess(
      baseEnv({ SUPABASE_ALLOW_PRODUCTION_WRITES: "true", VERCEL_ENV: "production" }),
      { mode: "write" }
    );
    expect(decision.allowed).toBe(true);
  });

  it("throws when a dev-claiming ref is paired with a production connection string", () => {
    expectCode(
      () =>
        guard.evaluateSupabaseAccess(
          baseEnv({
            SUPABASE_ENV: "preview",
            SUPABASE_PROJECT_REF: DEV_REF,
            SUPABASE_DB_URL: poolerUrl(PROD_REF),
          })
        ),
      "REF_URL_MISMATCH"
    );
  });

  it("throws when a production ref is paired with a dev connection string", () => {
    expectCode(
      () => guard.evaluateSupabaseAccess(baseEnv({ SUPABASE_DB_URL: directUrl(DEV_REF) })),
      "REF_URL_MISMATCH"
    );
  });
});

describe("supabase-env guard — non-production projects", () => {
  it.each(guard.SUPABASE_ENVS.map((e) => [e]))(
    "passes for a dev project ref with SUPABASE_ENV=%s",
    (supabaseEnv) => {
      const decision = guard.evaluateSupabaseAccess({
        SUPABASE_ENV: supabaseEnv,
        SUPABASE_PROJECT_REF: DEV_REF,
        SUPABASE_DB_URL: poolerUrl(DEV_REF),
      });
      expect(decision.allowed).toBe(true);
      expect(decision.isProductionProject).toBe(false);
    }
  );

  it("passes for a local CLI stack URL with no embedded ref", () => {
    const decision = guard.evaluateSupabaseAccess({
      SUPABASE_ENV: "local",
      SUPABASE_PROJECT_REF: "local-stack",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.urlProjectRef).toBeNull();
  });
});

describe("supabase-env guard — fail closed", () => {
  it("throws when SUPABASE_ENV is missing", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).SUPABASE_ENV;
    expectCode(() => guard.evaluateSupabaseAccess(env), "MISSING_ENV");
  });

  it("throws when SUPABASE_ENV is invalid", () => {
    expectCode(
      () => guard.evaluateSupabaseAccess(baseEnv({ SUPABASE_ENV: "prod" })),
      "INVALID_ENV"
    );
  });

  it("throws when SUPABASE_PROJECT_REF is missing", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).SUPABASE_PROJECT_REF;
    expectCode(() => guard.evaluateSupabaseAccess(env), "MISSING_ENV");
  });

  it("throws when SUPABASE_DB_URL is missing", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).SUPABASE_DB_URL;
    expectCode(() => guard.evaluateSupabaseAccess(env), "MISSING_ENV");
  });

  it("throws on an invalid mode", () => {
    expectCode(
      () =>
        guard.evaluateSupabaseAccess(baseEnv(), {
          mode: "readonly" as unknown as SupabaseAccessOptions["mode"],
        }),
      "INVALID_MODE"
    );
  });

  it("throws outside a server runtime (browser context)", () => {
    expectCode(
      () => guard.evaluateSupabaseAccess(baseEnv(), { isServerRuntime: false }),
      "BROWSER_CONTEXT"
    );
  });
});

describe("supabase-env guard — extractProjectRef", () => {
  it("extracts the ref from a Supavisor pooler URL", () => {
    expect(guard.extractProjectRef(poolerUrl(PROD_REF))).toBe(PROD_REF);
  });

  it("extracts the ref from a direct connection URL", () => {
    expect(guard.extractProjectRef(directUrl(DEV_REF))).toBe(DEV_REF);
  });

  it("extracts the ref from an API URL", () => {
    expect(guard.extractProjectRef(`https://${PROD_REF}.supabase.co`)).toBe(PROD_REF);
  });

  it("returns null for localhost and unrelated URLs", () => {
    expect(
      guard.extractProjectRef("postgresql://postgres:postgres@127.0.0.1:54322/postgres")
    ).toBeNull();
    expect(guard.extractProjectRef("https://example.com")).toBeNull();
    expect(guard.extractProjectRef("")).toBeNull();
    expect(guard.extractProjectRef(null)).toBeNull();
  });
});

describe("supabase-env guard — assertSupabaseAccess reads process.env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks the production ref under a preview SUPABASE_ENV from process.env", () => {
    vi.stubEnv("SUPABASE_ENV", "preview");
    vi.stubEnv("SUPABASE_PROJECT_REF", PROD_REF);
    vi.stubEnv("SUPABASE_DB_URL", poolerUrl(PROD_REF));
    expectCode(() => guard.assertSupabaseAccess({ mode: "read" }), "PROD_REF_IN_NON_PROD_ENV");
  });

  it("allows a dev project under a preview SUPABASE_ENV from process.env", () => {
    vi.stubEnv("SUPABASE_ENV", "preview");
    vi.stubEnv("SUPABASE_PROJECT_REF", DEV_REF);
    vi.stubEnv("SUPABASE_DB_URL", poolerUrl(DEV_REF));
    const decision = guard.assertSupabaseAccess({ mode: "write" });
    expect(decision.allowed).toBe(true);
    expect(decision.isProductionProject).toBe(false);
  });
});
