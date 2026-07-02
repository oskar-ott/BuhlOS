// Type declarations for the CommonJS feature-flag registry
// (api/_lib/feature-flags.js) so src/ server code and tests consume it
// type-checked. Add new flag keys to FlagKey AND the JS REGISTRY together —
// an unknown key is a type error here and a thrown error at runtime.

export type FlagKey =
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
  | "admin_flags_readout"
  | "admin_job_field_view"
  | "admin_proof_review"
  | "job_doc_import"
  | "safety_docs"
  | "certificates_register"
  | "rfi_register"
  | "variations_register"
  | "progress_claims"
  | "minutes_register"
  | "site_instructions_register"
  | "ai_assistant"
  // 2026-07 standalone AI batch (#246/#262/#267/#347/#373) — dark launch-gates
  | "ai_photo_labels"
  | "ai_snag_suggestions"
  | "ai_insights_digest"
  | "ai_quote_drafts"
  | "ai_contract_obligations"
  | "ai_office_daily_summary" // #171 office daily summary — dark launch-gate
  | "itp"
  // #760 owner feature-control kill-switches (LIVE features, default ON)
  | "jobs"
  | "hours"
  | "evidence"
  | "observations_inbox"
  | "material_requests"
  | "expenses"
  | "quotes"
  | "defects"
  | "dayworks"
  | "employees"
  | "gear"
  | "reports"
  | "job_photos"
  | "snags"
  | "scope_reconciliation"
  | "job_control"
  | "closeout"
  | "documents"
  | "circuit_schedule"
  | "diary"
  | "job_activity";

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
