-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#203): revision diff store
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- "Rev C arrived — what changed?" An aligned image diff (api/_lib/page-diff.js,
-- classic CV, no model call) produces changed regions on the newer revision;
-- a human walks each region and marks it reviewed/dismissed. Honesty is
-- structural: every diff row stores its BASIS (alignment quality, threshold,
-- title-block mask, algo version) — "no changes" never appears without it,
-- and un-alignable pairs are refused upstream (nothing stored).
--
--   * page_diffs   — one row per compared pair (base = older revision's page,
--     head = newer; regions are in head coordinates). Byte-identical pages
--     store identical=true and never fetch images. Cache: one live row per
--     (base sha, head sha, algo); re-running with a newer algo supersedes.
--   * diff_regions — the review queue: pending → reviewed | dismissed
--     (flippable — review state is human bookkeeping, not AI provenance).
-- ============================================================================

create table public.page_diffs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  job_id             text not null,   -- legacy job id (jobs.json)
  base_plan_id       text not null,
  base_page_index    integer not null check (base_page_index >= 0),
  base_page_sha256   text not null,
  head_plan_id       text not null,
  head_page_index    integer not null check (head_page_index >= 0),
  head_page_sha256   text not null,
  algo_version       text not null,
  identical          boolean not null default false,
  alignment          jsonb,           -- {dx, dy, quality}
  basis              jsonb not null,  -- threshold/mask/etc — the honesty payload
  region_count       integer not null default 0,
  status             text not null default 'live' check (status in ('live', 'superseded')),
  superseded_by      uuid references public.page_diffs(id),
  created_at         timestamptz not null default now(),
  created_by_label   text,
  unique (tenant_id, id)
);
comment on table public.page_diffs is
  'Epic 5 (#203) revision diffs between two rendered page rasters (head = newer; regions in head coordinates). basis carries the diff''s honesty payload — alignment quality, threshold, title-block mask, algo — so "no changes" is never claimed without its basis. Un-comparable pairs are refused by the engine and never stored.';
create unique index page_diffs_cache_uq
  on public.page_diffs (tenant_id, job_id, base_page_sha256, head_page_sha256, algo_version)
  where status = 'live';
create index page_diffs_job_idx
  on public.page_diffs (tenant_id, job_id)
  where status = 'live';

create table public.diff_regions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  diff_id           uuid not null references public.page_diffs(id),
  job_id            text not null,
  region_index      integer not null check (region_index >= 0),
  bbox              jsonb not null,  -- normalised 0..1 on the HEAD page
  area_cells        integer,
  status            text not null default 'pending'
                    check (status in ('pending', 'reviewed', 'dismissed')),
  reviewed_at       timestamptz,
  reviewed_by_label text,
  review_note       text,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id)
);
comment on table public.diff_regions is
  'Epic 5 (#203) changed regions awaiting human walk-through. pending → reviewed | dismissed, flippable — this is reviewer bookkeeping (who has looked at what), not AI provenance.';
create index diff_regions_diff_idx
  on public.diff_regions (tenant_id, diff_id);

alter table public.page_diffs   enable row level security;
alter table public.diff_regions enable row level security;
