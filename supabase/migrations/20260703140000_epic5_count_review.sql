-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#205): human-verified device counts
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- The issue's state model, verbatim: raw detections (immutable, #204) →
-- review actions (append-only) → accepted counts (derived). A count is only
-- trustworthy when every counted instance can be seen, corrected and accepted
-- in place — so corrections never mutate detections, they are LAYERED as
-- actions, and the accepted number snapshots exactly which markers it counted.
--
--   * detection_reviews — one row per human action on the marker set:
--     'delete' (false positive), 'restore' (undo a delete), 'reclassify'
--     (right place, wrong type), 'add' (the AI missed one). Targets are
--     either an AI detection (target_detection_id) or a human-added marker
--     (target_review_id = the add-action's row). Adds carry their own
--     bbox + legend entry. Append-only: rows are never updated or deleted.
--   * accepted_counts — the sign-off: per (page raster, legend entry), the
--     count at accept time plus a basis snapshot of the exact marker keys
--     counted. Re-accepting supersedes (status flip only — history kept).
--     ONLY live accepted rows are exposed to takeoff assembly (#213);
--     raw/derived numbers stay behind the review surface.
-- ============================================================================

create table public.detection_reviews (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  job_id              text not null,   -- legacy job id (jobs.json)
  plan_id             text not null,
  page_index          integer not null check (page_index >= 0),
  page_sha256         text not null,
  action              text not null check (action in ('delete', 'restore', 'reclassify', 'add')),
  target_detection_id uuid references public.device_detections(id), -- AI marker
  target_review_id    uuid references public.detection_reviews(id), -- human-added marker (its add row)
  legend_entry_id     uuid references public.legend_entries(id),    -- add: the label; reclassify: the NEW label
  label               text,            -- denormalised effective label at action time
  bbox                jsonb,           -- add only: normalised 0..1 page box
  note                text,
  created_at          timestamptz not null default now(),
  created_by_label    text,
  unique (tenant_id, id),
  -- an add creates a marker (no target); every other action targets exactly one marker
  check ( (action = 'add') = (target_detection_id is null and target_review_id is null) ),
  check ( target_detection_id is null or target_review_id is null ),
  check ( action <> 'add' or (bbox is not null and legend_entry_id is not null) ),
  check ( action <> 'reclassify' or legend_entry_id is not null )
);
comment on table public.detection_reviews is
  'Epic 5 (#205) append-only human review actions over device-detection markers. Rows are never updated or deleted; the effective marker set is derived by replaying actions per target in created_at order. This correction stream (false positives / misses / reclassifications) is also the natural eval feedback loop for recognition quality.';
create index detection_reviews_job_idx
  on public.detection_reviews (tenant_id, job_id);
create index detection_reviews_page_idx
  on public.detection_reviews (tenant_id, job_id, plan_id, page_index, page_sha256);

create table public.accepted_counts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            text not null,
  plan_id           text not null,
  page_index        integer not null check (page_index >= 0),
  page_sha256       text not null,
  legend_entry_id   uuid not null references public.legend_entries(id),
  label             text not null,   -- denormalised effective label at accept time
  count             integer not null check (count >= 0),
  basis             jsonb not null,  -- {markers:[{key,source,bbox,...}], reviewIds:[...]} — exactly what was counted
  status            text not null default 'live' check (status in ('live', 'superseded')),
  superseded_by     uuid,
  accepted_at       timestamptz not null default now(),
  accepted_by_label text,
  unique (tenant_id, id)
);
comment on table public.accepted_counts is
  'Epic 5 (#205) human-accepted device counts — the ONLY count surface downstream consumers (takeoff assembly #213) may read. Each row snapshots the exact marker set counted (basis) with full provenance: acceptor, timestamp, page raster sha. Corrections after acceptance make the live row visibly stale until re-accepted.';
create index accepted_counts_job_idx
  on public.accepted_counts (tenant_id, job_id);
-- one live sign-off per (page raster, legend entry)
create unique index accepted_counts_live_uq
  on public.accepted_counts (tenant_id, job_id, plan_id, page_index, page_sha256, legend_entry_id)
  where status = 'live';

alter table public.detection_reviews enable row level security;
alter table public.accepted_counts   enable row level security;
