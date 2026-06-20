// Type declarations for the CommonJS feature-flag registry
// (api/_lib/feature-flags.js) so src/ server code and tests consume it
// type-checked. Add new flag keys to FlagKey AND the JS REGISTRY together —
// an unknown key is a type error here and a thrown error at runtime.

export type FlagKey =
  | "supabase_dual_write"
  | "supabase_read_health"
  | "supabase_read_hours"
  | "supabase_read_jobs"
  | "admin_flags_readout";

export interface FlagDefinition {
  description: string;
  default: boolean;
  target: "global" | "admin-tier";
  /** YYYY-MM-DD — flags are temporary; CI fails past this date. */
  expires: string;
}

export interface FlagViewer {
  role?: string | null;
}

export declare const REGISTRY: Record<FlagKey, FlagDefinition>;
export declare const FLAGS_KEY: string;
export declare function isFlagOn(key: FlagKey): Promise<boolean>;
export declare function isFlagEnabled(key: FlagKey, viewer?: FlagViewer | null): Promise<boolean>;
export declare function flagsForViewer(viewer?: FlagViewer | null): Promise<Record<FlagKey, boolean>>;
export declare function listFlags(): Array<FlagDefinition & { key: FlagKey }>;
export declare function expiredFlags(now?: Date): Array<FlagDefinition & { key: FlagKey }>;
