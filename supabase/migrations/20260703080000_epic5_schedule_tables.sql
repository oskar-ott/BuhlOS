-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#202, machinery shared with #207): schedule tables
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE except the kind CHECK widening.
--
-- Tables are the most tractable extraction target in the epic — lighting
-- schedules (#202) first, switchboard schedules (#207) on the SAME machinery.
-- The schema is deliberately table-type-agnostic (the issue's explicit
-- direction): a detected table + its rows with per-cell {value, confidence},
-- a canonical column map per kind on top.
--
--   * plan_sheet_extractions.kind gains 'schedule-lighting' and
--     'schedule-switchboard' — schedule runs share the append-only run log
--     and its sha256/prompt/model cache.
--   * schedule_tables — one row per detected table. Lifecycle live →
--     superseded: re-extracting a page (new raster / prompt bump) inserts a
--     NEW table and marks the old one superseded — reviewed history is never
--     rewritten. board_identifier is the #207 grouping key (null for
--     lighting); multi-page boards stitch AT READ TIME by that key.
--   * schedule_rows — per row: cells jsonb {col: {value, confidence}} as the
--     AI read them (verbatim; null cells flagged, never invented) plus
--     human_cells jsonb corrections that WIN on read. Row review follows the
--     house machine (suggested → accepted | edited | rejected, live rows
--     still rejectable) — cell-level accuracy is measurable per prompt/model
--     because the raw read and the corrections are stored separately.
--
-- NOTE row identity is per table VERSION: superseding a table retires its
-- rows (they stay for the audit trail). Unlike page-keyed #197 overrides,
-- schedule corrections do not survive a re-extraction — rows have no stable
-- cross-run identity. The UI warns before re-running a reviewed table.
-- ============================================================================

-- ─── widen the run-log kind vocabulary ──────────────────────────────────────
alter table public.plan_sheet_extractions
  drop constraint plan_sheet_extractions_kind_check;
alter table public.plan_sheet_extractions
  add constraint plan_sheet_extractions_kind_check
  check (kind in ('page-understanding', 'legend-entries', 'schedule-lighting', 'schedule-switchboard'));

-- ─── schedule_tables ─────────────────────────────────────────────────────────
create table public.schedule_tables (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  job_id           text not null,   -- legacy job id (jobs.json)
  plan_id          text not null,
  page_index       integer not null check (page_index >= 0),
  page_sha256      text not null,
  table_kind       text not null check (table_kind in ('lighting', 'switchboard')),
  board_identifier text,            -- #207: the board this table belongs to (e.g. "DB-1")
  region           jsonb,           -- table bbox, normalised 0..1 on the page
  headers          jsonb,           -- raw header cells exactly as read
  column_map       jsonb,           -- raw header → canonical column
  extraction_id    uuid references public.plan_sheet_extractions(id),
  status           text not null default 'live' check (status in ('live', 'superseded')),
  superseded_by    uuid references public.schedule_tables(id),
  row_count        integer not null default 0,
  model            text,
  prompt_version   text,
  created_at       timestamptz not null default now(),
  created_by_label text,
  unique (tenant_id, id)
);
comment on table public.schedule_tables is
  'Epic 5 (#202/#207) detected schedule tables, one per table per extraction run. Re-runs insert a NEW table and supersede the old — reviewed rows are never rewritten. board_identifier groups multi-page switchboard schedules into one logical board at read time.';
create index schedule_tables_job_idx
  on public.schedule_tables (tenant_id, job_id, table_kind)
  where status = 'live';

-- ─── schedule_rows ───────────────────────────────────────────────────────────
create table public.schedule_rows (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  table_id          uuid not null references public.schedule_tables(id),
  job_id            text not null,
  row_index         integer not null check (row_index >= 0),
  cells             jsonb not null,  -- { col: {value: text|null, confidence: real} } — verbatim AI read
  human_cells       jsonb,           -- { col: text|null } — corrections, win on read
  row_region        jsonb,           -- row bbox for the side-by-side source view
  status            text not null default 'suggested'
                    check (status in ('suggested', 'accepted', 'edited', 'rejected')),
  reviewed_at       timestamptz,
  reviewed_by_label text,
  review_note       text,
  created_at        timestamptz not null default now(),
  unique (tenant_id, id)
);
comment on table public.schedule_rows is
  'Epic 5 (#202/#207) schedule rows. cells hold the AI''s verbatim per-cell read with confidence (null = unreadable, flagged, never invented); human_cells hold corrections and win on read. Row review: suggested→accepted|edited|rejected, live rows still rejectable. Cell accuracy = corrected cells vs total, measurable per prompt/model.';
create index schedule_rows_table_idx
  on public.schedule_rows (tenant_id, table_id);
create index schedule_rows_job_idx
  on public.schedule_rows (tenant_id, job_id);

alter table public.schedule_tables enable row level security;
alter table public.schedule_rows   enable row level security;
