-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#204): locational device detection
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- The core fix over the Phase-9 prototype: detection must be LOCATIONAL
-- (symbol type + bbox + confidence per instance) or the human-verify loop is
-- impossible — a bare number ("47 GPOs") can only be recounted or trusted
-- blindly. Detections here are RAW AI OUTPUT, immutable and clearly
-- unverified; nothing flows into counts or takeoffs until the #205 overlay
-- review accepts them.
--
--   * detection_runs — one row per (page, TILE, prompt, model): floor plans
--     at takeoff density exceed single-call comprehension, so the browser
--     tiles the page into overlapping windows and each tile is its own
--     cached vision call (the shared plan_sheet_extractions log is keyed
--     per page and can't hold per-tile rows). raw holds the model output in
--     tile coordinates; detections are stored page-normalised.
--   * device_detections — kind 'device': a located instance of a REVIEWED
--     legend entry (the project's own vocabulary — never a generic guess).
--     kind 'uncertain-region': a dense/overlapping area the model flagged
--     instead of guessing (issue AC). Seam duplicates from overlapping
--     tiles are dropped at insert time (IoU + same entry).
-- ============================================================================

create table public.detection_runs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  job_id           text not null,   -- legacy job id (jobs.json)
  plan_id          text not null,
  page_index       integer not null check (page_index >= 0),
  page_sha256      text not null,
  tile_key         text not null,   -- "x,y,w,h" of the tile, 4dp — the cache key part
  tile_region      jsonb not null,  -- the same box, structured
  prompt_version   text not null,
  model            text not null,
  raw              jsonb not null,  -- full validated model output (tile coordinates)
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now(),
  created_by_label text,
  unique (tenant_id, id)
);
comment on table public.detection_runs is
  'Epic 5 (#204) per-tile device-detection vision runs. Tiling is client-side (overlapping windows cropped in the browser); each tile caches independently by (page sha, tile, prompt, model) so an unchanged tile never bills twice.';
create unique index detection_runs_cache_uq
  on public.detection_runs (tenant_id, job_id, plan_id, page_index, page_sha256, tile_key, prompt_version, model);
create index detection_runs_job_idx
  on public.detection_runs (tenant_id, job_id);

create table public.device_detections (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  job_id           text not null,
  plan_id          text not null,
  page_index       integer not null check (page_index >= 0),
  page_sha256      text not null,
  run_id           uuid not null references public.detection_runs(id),
  kind             text not null default 'device' check (kind in ('device', 'uncertain-region')),
  legend_entry_id  uuid references public.legend_entries(id), -- null for uncertain-region
  label            text,            -- denormalised effective label at detection time
  bbox             jsonb not null,  -- normalised 0..1 PAGE coordinates (mapped from the tile)
  confidence       real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  note             text,            -- uncertain-region explanation
  created_at       timestamptz not null default now(),
  unique (tenant_id, id)
);
comment on table public.device_detections is
  'Epic 5 (#204) raw locational detections — IMMUTABLE, clearly unverified. kind=device instances reference the reviewed legend vocabulary; kind=uncertain-region marks dense areas the model flagged instead of guessing (P7). The #205 overlay review layer (append-only actions + accepted counts) is the ONLY path into takeoffs.';
create index device_detections_page_idx
  on public.device_detections (tenant_id, job_id, plan_id, page_index);

alter table public.detection_runs   enable row level security;
alter table public.device_detections enable row level security;
