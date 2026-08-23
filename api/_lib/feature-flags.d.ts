// Type declarations for the CommonJS feature-flag registry
// (api/_lib/feature-flags.js) so src/ server code and tests consume it
// type-checked. Add new flag keys to FlagKey AND the JS REGISTRY together —
// an unknown key is a type error here and a thrown error at runtime.

export type FlagKey =
  // Supabase migration + perf data-plane levers (protected: env/ops only)
  | "supabase_dual_write"
  | "supabase_dual_write_jobs"
  | "supabase_dual_write_tasks"
  | "supabase_dual_write_evidence"
  | "supabase_read_health"
  | "supabase_read_hours"
  | "supabase_read_jobs"
  | "supabase_read_job_detail"
  | "supabase_read_phil_jobs"
  | "supabase_read_phil_tasks"
  | "supabase_source_tasks"
  | "supabase_source_hours"
  | "supabase_read_admin_tasks"
  | "supabase_read_admin_evidence"
  | "supabase_read_phil_evidence"
  | "phil_jobs_summary_read" // Phil field job-LIST read from the summary projection — protected
  // Dark launch-gates
  | "admin_flags_readout"
  | "servicem8_sync" // daily ServiceM8 → BuhlOS job sync; needs SERVICEM8_API_KEY
  | "phil_sharpened" // Phil field-surface redesign campaign — flips via governance (P15)
  | "phil_job_rooms" // #133 in-job four-rooms experiment — requires phil_sharpened
  | "xero_connection" // #247 Xero OAuth connection foundation
  | "xero_payroll_export" // #249 first Xero WRITE — draft-timesheet export; independent write gate
  | "signup_link" // crew sign-up link — /onboarding/<code> + the employees review queue
  | "itp_simple" // #912 simple mobile ITP builder
  | "job_materials_spend" // owner pull 2026-08-23 — per-job materials spend ledger on the admin job hub
  // #760 owner feature-control kill-switches (LIVE features, default ON).
  // The 2026-07 lean reset + gut left only the lean core here; every other
  // feature's flag was deleted with its code (docs/product/02-lean-reset.md).
  | "jobs"
  | "hours"
  | "evidence"
  | "employees"
  | "gear"
  | "job_photos";

export interface FlagDefinition {
  description: string;
  default: boolean;
  target: "global" | "admin-tier";
  /** YYYY-MM-DD — flags are temporary; CI fails past this date. */
  expires: string;
  /** #760: a kill-switch flag is a LIVE feature (default true) the owner can turn
   *  off — the only way a flag defaults on. Absent/false = dark-by-default gate. */
  killSwitch?: boolean;
}

export interface FlagViewer {
  role?: string | null;
}

/** #760: owner Feature Control Board presentation for a (non-protected) flag. */
export interface FlagPresentation {
  label: string;
  domain: string;
  surface: "BuhlOS" | "Phil" | "Shared";
  /** #760: load-bearing spine feature (jobs/hours/evidence) — the board warns
   *  before the owner turns it off. */
  core?: boolean;
  /** #760: where "Open to test" on the board deep-links so the owner can try a
   *  previewed/live feature. Job-scoped features point at /v2/jobs. */
  previewHref?: string;
}

export declare const REGISTRY: Record<FlagKey, FlagDefinition>;
export declare const FLAGS_KEY: string;
export declare function presentationOf(key: string): FlagPresentation | null;
export declare function isFlagOn(key: FlagKey): Promise<boolean>;
export declare function isFlagEnabled(key: FlagKey, viewer?: FlagViewer | null): Promise<boolean>;
export declare function flagsForViewer(viewer?: FlagViewer | null): Promise<Record<FlagKey, boolean>>;
/** Operational data-plane flags that must never be toggled from the owner UI. */
export declare function isProtectedFlag(key: string): boolean;
export declare function listFlags(): Array<FlagDefinition & { key: FlagKey }>;
export declare function expiredFlags(now?: Date): Array<FlagDefinition & { key: FlagKey }>;
