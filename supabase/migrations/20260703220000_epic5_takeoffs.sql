-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#213): takeoff assembly
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- Pure aggregation over the accepted seams — no model calls. The philosophy
-- line: the takeoff assembles ONLY from human-accepted extractions
-- (accepted device counts #205, accepted/edited schedule rows #202/#207,
-- accepted cable estimate runs #211 — the last always labelled estimate).
-- Supersedes the legacy blob prototype (numbers without locations); its one
-- right instinct — AI never overwrites human entries — survives as the
-- human_qty adjustment column that wins on read.
--
--   * takeoffs — versioned assemblies with a status machine:
--     draft → signed_off, superseded on replacement. At most one live
--     draft and one live signed_off per job: re-assembling supersedes the
--     draft; signing off supersedes the previous signed_off. SIGNED-OFF
--     TAKEOFFS ARE IMMUTABLE — adjust actions refuse; changes mean a new
--     version. Only the latest signed_off is exposed to Epic 7 quoting.
--   * takeoff_lines — line items with per-line provenance back to the
--     exact sheet/extraction rows they came from, estimate/flag honesty,
--     and recorded human adjustments (human_qty + note + who/when).
-- ============================================================================

create table public.takeoffs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  job_id             text not null,   -- legacy job id (jobs.json)
  version            integer not null check (version >= 1),
  status             text not null default 'draft'
                     check (status in ('draft', 'signed_off', 'superseded')),
  warnings           jsonb not null default '[]'::jsonb, -- duplicate-scope etc. at assembly time
  sources            jsonb not null default '{}'::jsonb, -- ids of the accepted rows assembled
  superseded_by      uuid,
  created_at         timestamptz not null default now(),
  created_by_label   text,
  signed_off_at      timestamptz,
  signed_off_by_label text,
  unique (tenant_id, id),
  unique (tenant_id, job_id, version)
);
comment on table public.takeoffs is
  'Epic 5 (#213) versioned takeoff assemblies from human-accepted extractions only. draft → signed_off; superseded on replacement; signed-off rows are immutable (new version instead of edits). The latest signed_off row is the ONLY takeoff surface Epic 7 quoting may read.';
create index takeoffs_job_idx on public.takeoffs (tenant_id, job_id);
create unique index takeoffs_live_draft_uq
  on public.takeoffs (tenant_id, job_id) where status = 'draft';
create unique index takeoffs_live_signed_uq
  on public.takeoffs (tenant_id, job_id) where status = 'signed_off';

create table public.takeoff_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  takeoff_id       uuid not null references public.takeoffs(id),
  line_index       integer not null check (line_index >= 0),
  source_type      text not null
                   check (source_type in ('device-count', 'schedule-row', 'cable-estimate', 'manual')),
  description      text not null,
  qty              numeric,         -- assembled quantity; null = source had none (flagged)
  human_qty        numeric,         -- estimator adjustment — wins on read, recorded
  unit             text not null,
  estimate         boolean not null default false, -- heuristic lines stay estimates all the way
  flagged          boolean not null default false,
  flag_reason      text,
  note             text,            -- adjustment note
  adjusted_at      timestamptz,
  adjusted_by_label text,
  provenance       jsonb not null,  -- {planId, pageIndex, acceptedCountId | rowId | cableRunId, …}
  unique (tenant_id, id)
);
comment on table public.takeoff_lines is
  'Epic 5 (#213) takeoff line items. Every line resolves back to the exact sheet/extraction rows via provenance; estimate and flagged states are visible all the way into quoting; human adjustments (human_qty, note) are recorded with who/when and win on read.';
create index takeoff_lines_takeoff_idx
  on public.takeoff_lines (tenant_id, takeoff_id, line_index);

alter table public.takeoffs      enable row level security;
alter table public.takeoff_lines enable row level security;
