-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#212): cross-sheet references and entity links
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY.
--
-- A drawing set is a web, not a pile. Two deliberately small structures:
--
--   * sheet_refs — detected reference callouts ("refer E-501", detail
--     bubbles) with provenance. RESOLUTION IS NOT STORED: refs re-resolve
--     live against the sheet registry's effective sheet numbers on every
--     read, so correcting a sheet number fixes resolution without
--     re-extraction. Unresolved refs list honestly.
--   * entity_links — identity proposals across sheets (v1: 'same-board',
--     exact identifier matches from schedules #207 + board pins #211 —
--     generation is pure, NO model call). Proposals carry confidence and
--     NEVER take effect until a human confirms; rejected rows persist so
--     a rejected pair is never re-proposed. Confirmed links power the
--     duplicate-count warnings in counting flows and both-way navigation.
-- ============================================================================

-- ─── widen the run-log kind vocabulary ──────────────────────────────────────
alter table public.plan_sheet_extractions
  drop constraint plan_sheet_extractions_kind_check;
alter table public.plan_sheet_extractions
  add constraint plan_sheet_extractions_kind_check
  check (kind in ('page-understanding', 'legend-entries', 'schedule-lighting', 'schedule-switchboard', 'rooms', 'sheet-refs'));

-- ─── sheet_refs ──────────────────────────────────────────────────────────────
create table public.sheet_refs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  job_id              text not null,   -- legacy job id (jobs.json)
  plan_id             text not null,
  page_index          integer not null check (page_index >= 0),
  page_sha256         text not null,
  text                text not null,   -- the callout VERBATIM ("REFER E-501 FOR DETAILS")
  target_sheet_number text not null,   -- the sheet number the callout points at
  bbox                jsonb,           -- normalised 0..1 box around the callout (nullable)
  confidence          real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  extraction_id       uuid references public.plan_sheet_extractions(id),
  status              text not null default 'live' check (status in ('live', 'superseded')),
  superseded_by       uuid,
  created_at          timestamptz not null default now(),
  created_by_label    text,
  unique (tenant_id, id)
);
comment on table public.sheet_refs is
  'Epic 5 (#212) detected cross-sheet reference callouts with provenance. Resolution against the sheet registry happens at READ time (effective sheet numbers, human overrides win) — never stored, so corrections re-resolve instantly. Re-extraction supersedes the page''s previous refs.';
create index sheet_refs_job_idx on public.sheet_refs (tenant_id, job_id);
create index sheet_refs_page_idx
  on public.sheet_refs (tenant_id, job_id, plan_id, page_index, page_sha256);

-- ─── entity_links ────────────────────────────────────────────────────────────
create table public.entity_links (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  job_id           text not null,
  kind             text not null check (kind in ('same-board')),
  identifier       text not null,   -- normalised entity identifier ("DB-1")
  a_plan_id        text not null,   -- canonical ordering: (a) sorts before (b)
  a_page_index     integer not null check (a_page_index >= 0),
  b_plan_id        text not null,
  b_page_index     integer not null check (b_page_index >= 0),
  confidence       real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  evidence         text,            -- why this was proposed, human-readable
  origin           text not null check (origin in ('ai', 'human')),
  status           text not null default 'proposed' check (status in ('proposed', 'confirmed', 'rejected')),
  created_at       timestamptz not null default now(),
  created_by_label text,
  reviewed_at      timestamptz,
  reviewed_by_label text,
  unique (tenant_id, id),
  -- one row per (kind, identifier, unordered page pair) — rejections persist
  -- here precisely so the pair is never proposed again
  unique (tenant_id, job_id, kind, identifier, a_plan_id, a_page_index, b_plan_id, b_page_index)
);
comment on table public.entity_links is
  'Epic 5 (#212) cross-sheet identity links. v1 kind same-board from exact identifier matches (schedules + board pins) — generation is pure, no model call. Proposals NEVER take effect until confirmed; rejected rows persist to make rejection sticky. Confirmed links are navigable both ways and drive duplicate-count warnings wherever both sides carry accepted counts.';
create index entity_links_job_idx on public.entity_links (tenant_id, job_id);

alter table public.sheet_refs   enable row level security;
alter table public.entity_links enable row level security;
