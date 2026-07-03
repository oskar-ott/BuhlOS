-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#211): heuristic cable-run estimates
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- Pure geometry + factors — no model calls, no AI spend. An estimate is
-- valuable only while its assumptions are explicit and harmful the moment
-- it pretends to be a measurement, so every run stores its FULL input
-- snapshot (calibration, board pins, marker positions, factor set) and is
-- reproducible from that alone.
--
--   * board_pins — manually-pinned switchboard positions per page raster
--     (the issue's accepted v1 input). Multiple boards per sheet; each
--     device runs to its NEAREST board (Manhattan).
--   * sheet_calibrations — the metric anchor: two points + the real
--     distance between them (a grid bay, a dimensioned wall). Page rasters
--     carry no physical size, so the title-block scale ALONE cannot yield
--     lengths — it rides as a cross-check; the calibration is the measured
--     source ("verify the parsed scale against a known dimension"). One
--     live calibration per raster, replaced on re-calibrate. No
--     calibration → NO estimate, flagged — never a unit-guessed number.
--   * cable_estimate_runs — one row per computation: factors + inputs
--     snapshot + per-device/per-board results, status draft → accepted
--     (explicit human acceptance is the ONLY path toward takeoff #213;
--     re-computing supersedes and demands re-acceptance).
-- ============================================================================

create table public.board_pins (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            text not null,   -- legacy job id (jobs.json)
  plan_id           text not null,
  page_index        integer not null check (page_index >= 0),
  page_sha256       text not null,
  board_identifier  text not null,   -- 'DB-1', 'MSB', … (free text, per sheet)
  point             jsonb not null,  -- normalised 0..1 page point {x, y}
  created_at        timestamptz not null default now(),
  created_by_label  text,
  unique (tenant_id, id),
  unique (tenant_id, job_id, plan_id, page_index, page_sha256, board_identifier)
);
comment on table public.board_pins is
  'Epic 5 (#211) manually-pinned switchboard locations on floor-plan rasters — the v1 board input for cable-run estimates. Devices run to their nearest pin by Manhattan distance.';
create index board_pins_page_idx
  on public.board_pins (tenant_id, job_id, plan_id, page_index, page_sha256);

create table public.sheet_calibrations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            text not null,
  plan_id           text not null,
  page_index        integer not null check (page_index >= 0),
  page_sha256       text not null,
  point_a           jsonb not null,  -- normalised {x, y}
  point_b           jsonb not null,
  real_mm           real not null check (real_mm > 0),
  raster_aspect     real not null check (raster_aspect > 0), -- height / width
  mm_per_norm_x     real not null check (mm_per_norm_x > 0), -- derived, stored for reproducibility
  mm_per_norm_y     real not null check (mm_per_norm_y > 0),
  title_scale_text  text,            -- the sheet''s effective title-block scale at calibration time (cross-check display)
  created_at        timestamptz not null default now(),
  created_by_label  text,
  unique (tenant_id, id),
  unique (tenant_id, job_id, plan_id, page_index, page_sha256)
);
comment on table public.sheet_calibrations is
  'Epic 5 (#211) human scale calibration per page raster: two points + their real-world distance. The ONLY metric anchor for cable estimates (rasters carry no physical size); the parsed title-block scale is recorded alongside as a cross-check, never as the source. Re-calibrating replaces the row.';

create table public.cable_estimate_runs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            text not null,
  plan_id           text not null,
  page_index        integer not null check (page_index >= 0),
  page_sha256       text not null,
  status            text not null default 'draft' check (status in ('draft', 'accepted', 'superseded')),
  factors           jsonb not null,  -- the applied assumption set {routingFactor, riseDropMm, slackFactor}
  inputs            jsonb not null,  -- FULL snapshot: calibration, pins, marker keys+positions — reproducible
  results           jsonb not null,  -- {perDevice:[…], boards:[…], totalMm, deviceCount}
  superseded_by     uuid,
  created_at        timestamptz not null default now(),
  created_by_label  text,
  accepted_at       timestamptz,
  accepted_by_label text,
  unique (tenant_id, id)
);
comment on table public.cable_estimate_runs is
  'Epic 5 (#211) heuristic cable-run estimate computations — labelled ESTIMATE everywhere they surface. Draft until a human explicitly accepts; recomputing supersedes the live run (acceptance does not carry over). Only accepted runs are readable by takeoff assembly (#213). Every run is reproducible from its inputs snapshot.';
create index cable_estimate_runs_job_idx
  on public.cable_estimate_runs (tenant_id, job_id);
-- one live (non-superseded) run per raster
create unique index cable_estimate_runs_live_uq
  on public.cable_estimate_runs (tenant_id, job_id, plan_id, page_index, page_sha256)
  where status <> 'superseded';

alter table public.board_pins           enable row level security;
alter table public.sheet_calibrations   enable row level security;
alter table public.cable_estimate_runs  enable row level security;
