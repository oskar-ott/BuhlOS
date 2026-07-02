-- ============================================================================
-- BuhlOS / Phil — Epic 5 (#197): plan-sheet page-understanding extraction store
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY — new tables, no changes to anything.
--
-- The first AI-extraction tables. A "page-understanding" run classifies each
-- rendered plan page (sheet type) and parses its title block (sheet number,
-- title, revision, scale), each field with a confidence. Three tables:
--
--   * plan_sheet_extractions — append-only log of raw AI runs, full provenance
--     (page sha256, model, prompt version, token usage, optional crop region).
--     Re-runs with a new prompt/model version add rows; nothing is rewritten.
--   * plan_sheets            — the CURRENT projection, one row per
--     (job, plan, page), upserted from the latest accepted extraction. This is
--     what the sheet registry (#199) and every later Epic 5 feature reads.
--   * plan_sheet_overrides   — human corrections, one row per field. Stored
--     SEPARATELY from AI values and always win on read (issue #197 AC). A
--     re-extraction never touches overrides, so corrections survive re-runs.
--
-- Conventions follow Phase 1/2 (uuid PKs, tenant_id, RLS enabled with NO
-- policies, TEXT+CHECK enums using the EXACT strings the app writes) with one
-- DELIBERATE deviation, same in kind as phase-2a's deferred FK wiring:
-- job_id / plan_id / page_index are the app's LEGACY TEXT identifiers, not
-- uuid FKs. Plans live only in Blob (jobs/<jobId>/plans-index.json — there is
-- no plans table to reference), and the jobs PG mirror is still dark-gated
-- (#152/J8), so a uuid job FK would break extraction writes for any job that
-- hasn't been mirrored. FK wiring is a later migration once those land.
--
-- created_by follows the contacts.created_by_label precedent: sessions carry
-- legacy user ids/usernames, so provenance is a TEXT label (no uuid guess).
-- ============================================================================

-- ─── plan_sheet_extractions (append-only AI run log) ────────────────────────
create table public.plan_sheet_extractions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  job_id                 text not null,   -- legacy job id (jobs.json)
  plan_id                text not null,   -- legacy plan id (plans-index.json)
  page_index             integer not null check (page_index >= 0),
  page_sha256            text not null,   -- raster identity at extraction time
  kind                   text not null default 'page-understanding'
                         check (kind in ('page-understanding')),
  model                  text not null,
  prompt_version         text not null,
  raw                    jsonb not null,  -- full validated model output
  sheet_type             text check (sheet_type is null or sheet_type in
                           ('floorPlan','schematic','schedule','legend','titleCover','detail','other')),
  sheet_type_confidence  real check (sheet_type_confidence is null or (sheet_type_confidence >= 0 and sheet_type_confidence <= 1)),
  sheet_number           text,
  sheet_number_confidence real check (sheet_number_confidence is null or (sheet_number_confidence >= 0 and sheet_number_confidence <= 1)),
  sheet_title            text,
  sheet_title_confidence real check (sheet_title_confidence is null or (sheet_title_confidence >= 0 and sheet_title_confidence <= 1)),
  revision               text,
  revision_confidence    real check (revision_confidence is null or (revision_confidence >= 0 and revision_confidence <= 1)),
  scale                  text,
  scale_confidence       real check (scale_confidence is null or (scale_confidence >= 0 and scale_confidence <= 1)),
  region                 jsonb,           -- optional title-block crop provenance {x,y,w,h} normalised 0..1
  input_tokens           integer,
  output_tokens          integer,
  created_at             timestamptz not null default now(),
  created_by_label       text,            -- legacy username (sessions carry no uuid)
  unique (tenant_id, id)
);
comment on table public.plan_sheet_extractions is
  'Epic 5 (#197) append-only page-understanding runs over rendered plan pages. job_id/plan_id are legacy text ids (plans are Blob-only; jobs mirror dark) — FK wiring is a later migration. raw holds the full validated model output; the typed columns are the queryable projection of it.';

-- Cache key: an unchanged page (sha256) analysed with the same kind + prompt +
-- model never runs twice — the handler serves the stored row instead.
create unique index plan_sheet_extractions_cache_uq
  on public.plan_sheet_extractions
  (tenant_id, job_id, plan_id, page_index, page_sha256, kind, prompt_version, model);
create index plan_sheet_extractions_job_idx
  on public.plan_sheet_extractions (tenant_id, job_id);

-- ─── plan_sheets (current projection, one row per page) ─────────────────────
create table public.plan_sheets (
  tenant_id              uuid not null references public.tenants(id),
  job_id                 text not null,
  plan_id                text not null,
  page_index             integer not null check (page_index >= 0),
  extraction_id          uuid references public.plan_sheet_extractions(id),
  page_sha256            text not null,
  sheet_type             text check (sheet_type is null or sheet_type in
                           ('floorPlan','schematic','schedule','legend','titleCover','detail','other')),
  sheet_type_confidence  real check (sheet_type_confidence is null or (sheet_type_confidence >= 0 and sheet_type_confidence <= 1)),
  sheet_number           text,
  sheet_number_confidence real check (sheet_number_confidence is null or (sheet_number_confidence >= 0 and sheet_number_confidence <= 1)),
  sheet_title            text,
  sheet_title_confidence real check (sheet_title_confidence is null or (sheet_title_confidence >= 0 and sheet_title_confidence <= 1)),
  revision               text,
  revision_confidence    real check (revision_confidence is null or (revision_confidence >= 0 and revision_confidence <= 1)),
  scale                  text,
  scale_confidence       real check (scale_confidence is null or (scale_confidence >= 0 and scale_confidence <= 1)),
  model                  text,
  prompt_version         text,
  updated_at             timestamptz not null default now(),
  primary key (tenant_id, job_id, plan_id, page_index)
);
comment on table public.plan_sheets is
  'Epic 5 (#197) current sheet understanding per (job, plan document, page) — the projection the #199 registry reads. AI values only; human overrides live in plan_sheet_overrides and win on read. needs-review is DERIVED at read time (override-aware confidence threshold), never stored, so it can''t go stale.';

-- ─── plan_sheet_overrides (human corrections — always win on read) ──────────
create table public.plan_sheet_overrides (
  tenant_id      uuid not null references public.tenants(id),
  job_id         text not null,
  plan_id        text not null,
  page_index     integer not null check (page_index >= 0),
  field          text not null check (field in
                   ('sheetType','sheetNumber','sheetTitle','revision','scale')),
  value          text,            -- null = human confirms "this field is absent"
  corrected_by   text not null,   -- legacy username
  corrected_by_user_id text,      -- legacy user id
  corrected_at   timestamptz not null default now(),
  primary key (tenant_id, job_id, plan_id, page_index, field)
);
comment on table public.plan_sheet_overrides is
  'Epic 5 (#197) human review corrections, one row per corrected field. Keyed to the page, NOT the extraction, so re-running extraction (new prompt/model) never loses a correction. field values are the EXACT camelCase strings the app writes. value null is an explicit human "absent" — distinct from having no override row.';

-- ─── RLS: enabled, NO policies (Phase 1 convention) ─────────────────────────
-- The app reaches Postgres through the guarded direct connection
-- (api/_lib/supabase-db.js); PostgREST/anon access stays fully denied.
alter table public.plan_sheet_extractions enable row level security;
alter table public.plan_sheets            enable row level security;
alter table public.plan_sheet_overrides   enable row level security;
