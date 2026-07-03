-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#206): rooms and zones on floor plans
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- Pragmatic v1 per the issue: a vision pass for room-label text plus
-- APPROXIMATE bbox extents — precise wall-tracing polygons are a research
-- hole, and bboxes with manual redraw beat over-promising. Rooms follow the
-- legend review machine (suggested → accepted | edited | rejected), with
-- rename/redraw as human override COLUMNS that win on read; merge = redraw
-- one + reject the other, split = redraw + add — no new grammar.
--
--   * rooms — one row per detected/added room on a page raster. AI rows are
--     'suggested' with verbatim names and the model's honest confidence;
--     human rows are born 'accepted'. Re-extraction supersedes ONLY prior
--     'suggested' rows for that raster (human-touched rows persist).
--     NOTE: room names are NOT unique — "WIR" twice on one level is normal.
--   * room_assignment_overrides — a human pinning one device marker to a
--     room (or explicitly to UNZONED via null). Wins over geometry; keyed
--     by the #205 marker key ('d:<detectionId>' | 'r:<add reviewId>').
--     Geometry assignment itself is derived at read time (centre
--     point-in-bbox, smallest area wins, outside-all → unzoned) — never
--     stored, so redrawing a room re-groups instantly.
-- ============================================================================

-- ─── widen the run-log kind vocabulary ──────────────────────────────────────
alter table public.plan_sheet_extractions
  drop constraint plan_sheet_extractions_kind_check;
alter table public.plan_sheet_extractions
  add constraint plan_sheet_extractions_kind_check
  check (kind in ('page-understanding', 'legend-entries', 'schedule-lighting', 'schedule-switchboard', 'rooms'));

-- ─── rooms ───────────────────────────────────────────────────────────────────
create table public.rooms (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            text not null,   -- legacy job id (jobs.json)
  plan_id           text not null,
  page_index        integer not null check (page_index >= 0),
  page_sha256       text not null,
  origin            text not null check (origin in ('ai', 'human')),
  status            text not null default 'suggested'
                    check (status in ('suggested', 'accepted', 'edited', 'rejected', 'superseded')),
  name              text not null,   -- VERBATIM label from the drawing (or human-entered)
  human_name        text,            -- rename override — wins on read
  bbox              jsonb not null,  -- normalised 0..1 page box (approximate extent)
  human_bbox        jsonb,           -- redraw override — wins on read
  confidence        real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  extraction_id     uuid references public.plan_sheet_extractions(id),
  model             text,
  prompt_version    text,
  superseded_by     uuid,
  created_at        timestamptz not null default now(),
  created_by_label  text,
  reviewed_at       timestamptz,
  reviewed_by_label text,
  review_note       text,
  unique (tenant_id, id)
);
comment on table public.rooms is
  'Epic 5 (#206) rooms/zones on floor-plan rasters. AI suggestions carry verbatim drawing labels + approximate bbox extents (v1 is deliberately NOT wall-tracing); humans rename (human_name), redraw (human_bbox), reject, or add rooms. Effective name/bbox = human override > AI value. Device grouping derives at read time from effective boxes.';
create index rooms_job_idx on public.rooms (tenant_id, job_id);
create index rooms_page_idx
  on public.rooms (tenant_id, job_id, plan_id, page_index, page_sha256);

-- ─── room_assignment_overrides ───────────────────────────────────────────────
create table public.room_assignment_overrides (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  job_id             text not null,
  plan_id            text not null,
  page_index         integer not null check (page_index >= 0),
  page_sha256        text not null,
  marker_key         text not null,  -- #205 marker key: 'd:<id>' | 'r:<id>'
  room_id            uuid references public.rooms(id), -- null = explicitly unzoned
  corrected_at       timestamptz not null default now(),
  corrected_by_label text,
  unique (tenant_id, id),
  unique (tenant_id, job_id, plan_id, page_index, page_sha256, marker_key)
);
comment on table public.room_assignment_overrides is
  'Epic 5 (#206) human device-to-room pins. One row per marker; wins over geometric assignment. room_id null = the human explicitly parked the device in the unzoned bucket. Deleting the row returns the marker to automatic (point-in-bbox) grouping.';
create index room_assignment_overrides_page_idx
  on public.room_assignment_overrides (tenant_id, job_id, plan_id, page_index, page_sha256);

alter table public.rooms                     enable row level security;
alter table public.room_assignment_overrides enable row level security;
