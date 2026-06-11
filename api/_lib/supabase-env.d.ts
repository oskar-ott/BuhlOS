// Type declarations for the CommonJS Supabase environment guard
// (api/_lib/supabase-env.js) so src/ tests and future server code consume
// it type-checked. Policy + Vercel setup: docs/supabase-environment.md.

export type SupabaseEnvName = "production" | "staging" | "preview" | "development" | "local";
export type SupabaseAccessMode = "read" | "write";

export interface SupabaseAccessOptions {
  /** Defaults to "write" — the strictest mode — when omitted. */
  mode?: SupabaseAccessMode;
  /** Test hook only: overrides Node-runtime detection. */
  isServerRuntime?: boolean;
}

export interface SupabaseAccessDecision {
  allowed: true;
  mode: SupabaseAccessMode;
  supabaseEnv: SupabaseEnvName;
  projectRef: string;
  /** Ref extracted from SUPABASE_DB_URL, or null for local/self-hosted URLs. */
  urlProjectRef: string | null;
  isProductionProject: boolean;
}

export declare class SupabaseEnvError extends Error {
  /**
   * Stable machine-checkable reason: BROWSER_CONTEXT | INVALID_MODE |
   * MISSING_ENV | INVALID_ENV | REF_URL_MISMATCH | PROD_REF_IN_NON_PROD_ENV |
   * PROD_REF_IN_NON_PROD_RUNTIME | PROD_WRITES_NOT_ALLOWED
   */
  code: string;
}

export declare const PRODUCTION_PROJECT_REF: "wetctlrhsycfwhuxlarv";
export declare const SUPABASE_ENVS: readonly SupabaseEnvName[];
export declare const MODES: readonly SupabaseAccessMode[];

export declare function extractProjectRef(url: string | null | undefined): string | null;

export declare function evaluateSupabaseAccess(
  env: Record<string, string | undefined>,
  options?: SupabaseAccessOptions
): SupabaseAccessDecision;

export declare function assertSupabaseAccess(
  options?: SupabaseAccessOptions
): SupabaseAccessDecision;
