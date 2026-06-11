-- ============================================================================
-- BuhlOS / Phil — Phase 1 core schema (review-approved; applied 2026-06-11)
-- Target: Supabase project wetctlrhsycfwhuxlarv (ap-southeast-2), Postgres 17
--
-- Scope: structured operational data only. Vercel Blob remains the binary
-- store (photos, plan files, PDFs); this schema stores METADATA + Blob URLs.
-- Auth is unchanged (bcryptjs + cookie sessions against users.json) — no
-- password hashes here, no Supabase Auth coupling. All access goes through
-- existing server-side API routes using the service-role connection.
--
-- Conventions
--   * uuid PKs via gen_random_uuid(); legacy blob ids preserved in legacy_id
--     (nanoid/slug/date36 ids live in URLs today — the import map is critical).
--   * every tenant-owned table: tenant_id + created_at/updated_at +
--     created_by/updated_by; mutable tables add revision (optimistic
--     concurrency: UPDATE ... WHERE id=$1 AND revision=$2) and
--     deleted_at/deleted_by (soft delete; current "archived" flags map here).
--   * cross-tenant integrity: parents expose UNIQUE (tenant_id, id); children
--     reference (tenant_id, parent_id) so a row can never point across
--     tenants. The (tenant_id, id) unique index doubles as the tenant index.
--   * status enums are TEXT + CHECK using the EXACT strings the app writes
--     today (incl. 'roughIn'/'fitOff', ITP 'in-progress'/'signed-off') so the
--     dual-write/cutover layer needs zero value translation. Renames are a
--     cheap later migration.
--   * RLS is ENABLED on every table with NO policies: the anon/publishable
--     PostgREST surface returns nothing; the server's service role bypasses
--     RLS. Real policies arrive with the (later) Supabase Auth phase.
--   * append-only tables (comments, events, responses, links, audit, payroll
--     runs) have created_* only — no updated_at, no revision, never UPDATEd.
--   * historical/compliance ACTION rows carry an immutable *_label name
--     snapshot beside the uuid: joins give the current name, the label
--     preserves the name as written at action time. Plain created_by/
--     updated_by audit columns on mutable tables stay uuid-only.
-- ============================================================================

-- ─── helper triggers ────────────────────────────────────────────────────────

create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.tg_touch_updated_at_bump_revision()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.revision := coalesce(old.revision, 1) + 1;
  return new;
end $$;

-- ─── tenants ────────────────────────────────────────────────────────────────

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── user_profiles (maps users.json; NOT the auth store) ───────────────────

create table public.user_profiles (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  legacy_user_id  text,                          -- users.json id
  username        text not null,                 -- login/display handle today
  display_name    text,
  email           text,
  phone           text,
  role            text not null check (role in
                    ('admin','boss','owner','manager','office','pm','estimator',
                     'leadinghand','tradie','apprentice','labourer','electrician','client')),
  is_active       boolean not null default true, -- users.json `disabled` => false
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.user_profiles(id),
  updated_by      uuid references public.user_profiles(id),
  deleted_at      timestamptz,                   -- users.json `archived` maps here
  deleted_by      uuid references public.user_profiles(id),
  unique (tenant_id, id)
);
comment on table public.user_profiles is
  'App users mirrored from users.json. Auth (bcryptjs hash) deliberately stays in users.json for Phase 1 — no credential columns here.';

create unique index user_profiles_legacy_uq
  on public.user_profiles (tenant_id, legacy_user_id) where legacy_user_id is not null;
create unique index user_profiles_username_uq
  on public.user_profiles (tenant_id, lower(username)) where deleted_at is null;

-- ─── jobs ───────────────────────────────────────────────────────────────────

create table public.jobs (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),
  legacy_id                 text,               -- jobs.json id (slug-like, in URLs)
  name                      text not null,
  ref                       text,
  status                    text not null default 'draft' check (status in
                              ('draft','active','on_hold','complete','archived')),
  client_user_id            uuid,
  job_type_label            text,               -- job-types registry deferred; denormalised label
  external_ref              text,               -- serviceM8JobId today
  -- site context (Phil "Site details" card)
  site_address              text,
  site_contact_name         text,
  site_contact_phone        text,
  access_notes              text,
  parking_notes             text,
  safety_notes              text,
  induction_required        boolean,
  -- schedule
  start_date                date,
  due_date                  date,
  programmed_duration_days  integer,
  -- per-job feature toggles (config, not operational data)
  modules                   jsonb not null default '{}'::jsonb,
  revision                  integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references public.user_profiles(id),
  updated_by                uuid references public.user_profiles(id),
  deleted_at                timestamptz,
  deleted_by                uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, client_user_id) references public.user_profiles (tenant_id, id)
);

create unique index jobs_legacy_uq on public.jobs (tenant_id, legacy_id) where legacy_id is not null;
create index jobs_status_idx     on public.jobs (tenant_id, status) where deleted_at is null;
create index jobs_updated_idx    on public.jobs (tenant_id, updated_at desc);

-- ─── job_members (from users.json assignedJobIds) ───────────────────────────

create table public.job_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  job_id      uuid not null,
  user_id     uuid not null,
  role        text not null default 'member' check (role in ('member','lead')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  unique (tenant_id, job_id, user_id),
  foreign key (tenant_id, job_id)  references public.jobs (tenant_id, id),
  foreign key (tenant_id, user_id) references public.user_profiles (tenant_id, id)
);
comment on table public.job_members is
  'Replaces users.json assignedJobIds. Phil job visibility = rows here. role=lead covers the leading-hand "_jobLedByMe" approver scope.';

create index job_members_user_idx on public.job_members (tenant_id, user_id);

-- ─── site_area_groups / site_areas (job structure) ──────────────────────────

create table public.site_area_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  job_id      uuid not null,
  legacy_id   text,                              -- ag_xxxxxxxx
  name        text not null,
  sort_order  integer not null default 0,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  updated_by  uuid references public.user_profiles(id),
  deleted_at  timestamptz,                       -- legacy `archived`
  deleted_by  uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id) references public.jobs (tenant_id, id)
);

create unique index site_area_groups_legacy_uq
  on public.site_area_groups (tenant_id, legacy_id) where legacy_id is not null;
create index site_area_groups_job_idx on public.site_area_groups (tenant_id, job_id);

create table public.site_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  job_id      uuid not null,
  group_id    uuid,
  legacy_id   text,                              -- ar_xxxxxxxx
  name        text not null,
  space_type  text check (space_type is null or char_length(space_type) <= 60),
  sort_order  integer not null default 0,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  updated_by  uuid references public.user_profiles(id),
  deleted_at  timestamptz,                       -- legacy `archived`
  deleted_by  uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)   references public.jobs (tenant_id, id),
  foreign key (tenant_id, group_id) references public.site_area_groups (tenant_id, id)
);

create unique index site_areas_legacy_uq
  on public.site_areas (tenant_id, legacy_id) where legacy_id is not null;
create index site_areas_job_idx on public.site_areas (tenant_id, job_id);

-- ─── job task plan (templates) + field task instances (+ events + comments) ──
-- Two layers from day one:
--   * job_task_templates — the PLAN the BuhlOS job builder edits. site_area_id
--     NULL = the job-level default list; set = a per-area override (both are
--     real in jobs.json today: job.roughInTasks/fitOffTasks vs area overrides).
--   * tasks — per-(area, stage) field EXECUTION instances Phil toggles with
--     atomic row updates. name is a snapshot at instantiation; import expands
--     effectiveTasks() × the data.json taskState map. task_template_id is
--     null for imported one-off / orphaned tasks.

create table public.job_task_templates (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  job_id                uuid not null,
  site_area_id          uuid,                    -- NULL = job-level default; set = area override
  stage                 text not null check (stage in ('roughIn','fitOff')),
  legacy_id             text,                    -- jobs.json template task id
  name                  text not null,
  description           text,
  required_photo_count  integer not null default 0 check (required_photo_count >= 0),
  requires_note         boolean not null default false,
  is_active             boolean not null default true,
  sort_order            integer not null default 0,
  revision              integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references public.user_profiles(id),
  updated_by            uuid references public.user_profiles(id),
  deleted_at            timestamptz,             -- legacy `archived` template
  deleted_by            uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)       references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id) references public.site_areas (tenant_id, id)
);
comment on table public.job_task_templates is
  'The job-builder task PLAN. site_area_id NULL = job-level default list; set = per-area override (maps jobs.json roughInTasks/fitOffTasks at both levels). required_photo_count/requires_note are new evidence-requirement capabilities.';

create unique index job_task_templates_job_legacy_uq
  on public.job_task_templates (tenant_id, job_id, stage, legacy_id)
  where site_area_id is null and legacy_id is not null;
create unique index job_task_templates_area_legacy_uq
  on public.job_task_templates (tenant_id, site_area_id, stage, legacy_id)
  where site_area_id is not null and legacy_id is not null;
create index job_task_templates_job_idx
  on public.job_task_templates (tenant_id, job_id, stage);

create table public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  job_id              uuid not null,
  site_area_id        uuid,                      -- null reserved for future job-level tasks
  task_template_id    uuid,                      -- null = imported one-off / ad-hoc task
  stage               text not null check (stage in ('roughIn','fitOff')),
  legacy_template_id  text,                      -- jobs.json template task id (non-unique; import join)
  name                text not null,             -- snapshot at instantiation
  status              text not null default 'not_started' check (status in
                        ('not_started','in_progress','complete')),
  assigned_to         uuid,                      -- new capability (unused at import)
  completed_at        timestamptz,               -- set on → complete; cleared on undo
  completed_by        uuid references public.user_profiles(id),
  sort_order          integer not null default 0,
  revision            integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.user_profiles(id),
  updated_by          uuid references public.user_profiles(id),
  deleted_at          timestamptz,               -- legacy `archived` task
  deleted_by          uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)           references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id)     references public.site_areas (tenant_id, id),
  foreign key (tenant_id, task_template_id) references public.job_task_templates (tenant_id, id),
  foreign key (tenant_id, assigned_to)      references public.user_profiles (tenant_id, id)
);

create unique index tasks_area_stage_template_uq
  on public.tasks (tenant_id, site_area_id, stage, legacy_template_id)
  where site_area_id is not null and legacy_template_id is not null;
create unique index tasks_area_template_instance_uq
  on public.tasks (tenant_id, site_area_id, task_template_id)
  where site_area_id is not null and task_template_id is not null;
create index tasks_job_status_idx   on public.tasks (tenant_id, job_id, status);
create index tasks_area_idx         on public.tasks (tenant_id, site_area_id);
create index tasks_template_idx     on public.tasks (tenant_id, task_template_id) where task_template_id is not null;
create index tasks_assigned_idx     on public.tasks (tenant_id, assigned_to) where assigned_to is not null;
create index tasks_updated_idx      on public.tasks (tenant_id, updated_at desc);

create table public.task_status_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id),
  task_id      uuid not null,
  from_status  text,
  to_status    text not null,
  source       text,                             -- 'phil' | 'admin' | 'system'
  actor_label  text,                             -- name as written at action time
  created_at   timestamptz not null default now(),
  created_by   uuid references public.user_profiles(id),
  foreign key (tenant_id, task_id) references public.tasks (tenant_id, id)
);
comment on table public.task_status_events is 'Append-only task transition history (replaces silent task-toggle overwrites).';

create index task_status_events_task_idx
  on public.task_status_events (tenant_id, task_id, created_at);

create table public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  task_id     uuid not null,
  body        text not null check (char_length(body) <= 2000),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  foreign key (tenant_id, task_id) references public.tasks (tenant_id, id)
);
comment on table public.task_comments is 'Append-only. New capability — no blob equivalent today.';

create index task_comments_task_idx on public.task_comments (tenant_id, task_id, created_at);

-- ─── evidence_files (metadata + Blob refs ONLY; binaries stay in Blob) ──────

create table public.evidence_files (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  job_id              uuid not null,
  legacy_id           text,
  kind                text not null check (kind in ('photo','note')),
  -- photo payload (Blob references only)
  photo_blob_id       text,
  blob_url            text,
  thumbnail_url       text,
  -- note payload
  note                text check (note is null or char_length(note) <= 280),
  -- capture context
  site_area_id        uuid,
  task_id             uuid,
  stage               text check (stage in ('roughIn','fitOff')),
  captured_by         uuid,
  captured_by_label   text,                      -- name as written at capture time
  captured_at         timestamptz not null,
  client_captured_at  timestamptz,               -- offline-capture clock
  exif_lat            double precision,
  exif_lng            double precision,
  -- lifecycle (server statuses only; client-only uploading/pending_sync never persist)
  status              text not null default 'submitted' check (status in
                        ('submitted','reviewed','rejected')),
  source              text not null check (source in ('phil','admin','system')),
  reviewed_by         uuid references public.user_profiles(id),
  reviewed_by_label   text,                      -- name as written at review time
  reviewed_at         timestamptz,
  rejection_reason    text check (rejection_reason is null or char_length(rejection_reason) <= 500),
  -- entity relationships live in evidence_links (junction) — no link columns here
  revision            integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.user_profiles(id),
  updated_by          uuid references public.user_profiles(id),
  deleted_at          timestamptz,
  deleted_by          uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)       references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id) references public.site_areas (tenant_id, id),
  foreign key (tenant_id, task_id)      references public.tasks (tenant_id, id),
  foreign key (tenant_id, captured_by)  references public.user_profiles (tenant_id, id),
  check ((kind = 'photo' and blob_url is not null) or (kind = 'note' and note is not null))
);
comment on table public.evidence_files is
  'Evidence metadata. kind=note rows carry text only (no blob). Binary photos remain in Vercel Blob; only URLs/paths here.';

create unique index evidence_files_legacy_uq
  on public.evidence_files (tenant_id, legacy_id) where legacy_id is not null;
create index evidence_files_job_idx
  on public.evidence_files (tenant_id, job_id, captured_at desc);
create index evidence_files_review_queue_idx
  on public.evidence_files (tenant_id, job_id) where status = 'submitted' and deleted_at is null;

-- One evidence item ↔ many entities (snag attachments, ITP proof, conversion
-- provenance). linked_entity_id is polymorphic — no FK is possible; the server
-- write path owns referential integrity. Every target table keeps
-- unique (tenant_id, id), so a per-type constraint retrofit stays cheap.
create table public.evidence_links (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  evidence_file_id    uuid not null,
  linked_entity_type  text not null check (linked_entity_type in
                        ('job','task','snag','observation','material_request','itp_response')),
  linked_entity_id    uuid not null,
  link_role           text not null default 'attachment',  -- 'attachment' | 'converted_from' | 'proof' | … (open set)
  created_at          timestamptz not null default now(),
  created_by          uuid references public.user_profiles(id),
  foreign key (tenant_id, evidence_file_id) references public.evidence_files (tenant_id, id)
);
comment on table public.evidence_links is
  'General evidence↔entity junction (replaces per-pair link tables and one-way linked_* columns). Import maps snagsV2.evidenceIds[], observations.linkedEvidenceId and materialRequests.linkedEvidenceId here.';

create unique index evidence_links_dedupe_uq
  on public.evidence_links (evidence_file_id, linked_entity_type, linked_entity_id, link_role);
create index evidence_links_entity_idx
  on public.evidence_links (tenant_id, linked_entity_type, linked_entity_id);
create index evidence_links_file_idx
  on public.evidence_links (tenant_id, evidence_file_id);

-- ─── snags (+ comments + evidence links) ────────────────────────────────────

create table public.snags (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  job_id            uuid not null,
  legacy_id         text,
  title             text not null check (char_length(title) <= 120),
  description       text check (description is null or char_length(description) <= 1000),
  status            text not null default 'open' check (status in
                      ('open','in_progress','resolved','verified','closed','rejected')),
  priority          text not null default 'normal' check (priority in
                      ('low','normal','high','urgent')),
  source            text not null check (source in ('phil','admin','system')),
  stage             text check (stage in ('roughIn','fitOff')),
  site_area_id      uuid,
  task_id           uuid,
  assigned_to       uuid,
  -- transition stamps (current shape; *_label = name as written at action time)
  acknowledged_at        timestamptz,
  acknowledged_by        uuid references public.user_profiles(id),
  acknowledged_by_label  text,
  resolved_at            timestamptz,
  resolved_by            uuid references public.user_profiles(id),
  resolved_by_label      text,
  verified_at            timestamptz,
  verified_by            uuid references public.user_profiles(id),
  verified_by_label      text,
  closed_at              timestamptz,
  closed_by              uuid references public.user_profiles(id),
  closed_by_label        text,
  rejected_at            timestamptz,
  rejected_by            uuid references public.user_profiles(id),
  rejected_by_label      text,
  rejection_reason  text check (rejection_reason is null or char_length(rejection_reason) <= 500),
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.user_profiles(id),
  updated_by        uuid references public.user_profiles(id),
  deleted_at        timestamptz,
  deleted_by        uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)       references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id) references public.site_areas (tenant_id, id),
  foreign key (tenant_id, task_id)      references public.tasks (tenant_id, id),
  foreign key (tenant_id, assigned_to)  references public.user_profiles (tenant_id, id)
);

create unique index snags_legacy_uq on public.snags (tenant_id, legacy_id) where legacy_id is not null;
create index snags_job_status_idx on public.snags (tenant_id, job_id, status);
create index snags_assigned_idx   on public.snags (tenant_id, assigned_to) where assigned_to is not null;
create index snags_created_idx    on public.snags (tenant_id, created_at desc);

create table public.snag_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  snag_id     uuid not null,
  body        text not null check (char_length(body) <= 2000),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  foreign key (tenant_id, snag_id) references public.snags (tenant_id, id)
);
comment on table public.snag_comments is 'Append-only. New capability — no blob equivalent today.';

create index snag_comments_snag_idx on public.snag_comments (tenant_id, snag_id, created_at);

-- ─── observations (capture inbox; convert-to-snag / material-request) ───────

create table public.observations (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id),
  job_id                      uuid not null,
  legacy_id                   text,
  type                        text not null check (type in
                                ('note','blocker','rfi','variation','defect','safety',
                                 'material_request','plan_mismatch','client_instruction','evidence')),
  title                       text not null check (char_length(title) <= 140),
  description                 text check (description is null or char_length(description) <= 2000),
  status                      text not null default 'new' check (status in
                                ('new','needs_action','in_review','converted','resolved','record_only')),
  priority                    text not null default 'normal' check (priority in
                                ('low','normal','high','urgent')),
  source                      text not null check (source in ('phil','buhlos','system')),
  requires_action             boolean not null default false,
  stage                       text check (stage in ('roughIn','fitOff')),
  site_area_id                uuid,
  task_id                     uuid,
  assigned_to                 uuid,
  due_date                    date,
  photo_urls                  text[] not null default '{}',  -- Blob URLs (≤10, app-enforced)
  linked_snag_id              uuid,                          -- evidence provenance lives in evidence_links
  linked_material_request_id  uuid,              -- FK added after material_requests (circular)
  converted_to                text check (converted_to in
                                ('rfi','variation','defect','snag','material_request','task')),
  resolution_note             text check (resolution_note is null or char_length(resolution_note) <= 1000),
  resolved_at                 timestamptz,
  resolved_by                 uuid references public.user_profiles(id),
  revision                    integer not null default 1,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid references public.user_profiles(id),
  updated_by                  uuid references public.user_profiles(id),
  deleted_at                  timestamptz,
  deleted_by                  uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)             references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id)       references public.site_areas (tenant_id, id),
  foreign key (tenant_id, task_id)            references public.tasks (tenant_id, id),
  foreign key (tenant_id, assigned_to)    references public.user_profiles (tenant_id, id),
  foreign key (tenant_id, linked_snag_id) references public.snags (tenant_id, id)
);
comment on table public.observations is
  'Field-capture inbox (Evidence + Snags + Observations model). Addition beyond the Phase 1 brief list — load-bearing in production convert flows.';

create unique index observations_legacy_uq
  on public.observations (tenant_id, legacy_id) where legacy_id is not null;
create index observations_status_idx on public.observations (tenant_id, status, created_at desc);
create index observations_job_idx    on public.observations (tenant_id, job_id, status);

-- ─── material_requests (+ line items) ───────────────────────────────────────
-- Current blob shape is single-line (item/quantity/unit on the request).
-- Phase 1 splits header + items per the brief; import maps 1 request → 1 item.

create table public.material_requests (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  job_id                 uuid not null,
  legacy_id              text,
  status                 text not null default 'requested' check (status in
                           ('requested','approved','ordered','delivered','cancelled')),
  urgency                text not null default 'normal' check (urgency in
                           ('low','normal','high','urgent')),
  source                 text not null check (source in ('observation','buhlos','system')),
  stage                  text check (stage in ('roughIn','fitOff')),
  site_area_id           uuid,
  task_id                uuid,
  description            text check (description is null or char_length(description) <= 2000),
  linked_observation_id  uuid,                   -- evidence provenance lives in evidence_links
  requested_by           uuid,
  requested_at           timestamptz not null default now(),
  approved_by            uuid references public.user_profiles(id),
  approved_at            timestamptz,
  ordered_by             uuid references public.user_profiles(id),
  ordered_at             timestamptz,
  supplier               text check (supplier is null or char_length(supplier) <= 120),
  supplier_note          text,
  order_ref              text check (order_ref is null or char_length(order_ref) <= 60),
  delivered_by           uuid references public.user_profiles(id),
  delivered_at           timestamptz,
  delivery_note          text,
  cancelled_by           uuid references public.user_profiles(id),
  cancelled_at           timestamptz,
  cancel_reason          text,
  revision               integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references public.user_profiles(id),
  updated_by             uuid references public.user_profiles(id),
  deleted_at             timestamptz,
  deleted_by             uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)                references public.jobs (tenant_id, id),
  foreign key (tenant_id, site_area_id)          references public.site_areas (tenant_id, id),
  foreign key (tenant_id, task_id)               references public.tasks (tenant_id, id),
  foreign key (tenant_id, requested_by)          references public.user_profiles (tenant_id, id),
  foreign key (tenant_id, linked_observation_id) references public.observations (tenant_id, id)
);

create unique index material_requests_legacy_uq
  on public.material_requests (tenant_id, legacy_id) where legacy_id is not null;
create index material_requests_job_status_idx
  on public.material_requests (tenant_id, job_id, status);
create index material_requests_status_idx
  on public.material_requests (tenant_id, status, requested_at desc);

create table public.material_request_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  material_request_id  uuid not null,
  item                 text not null check (char_length(item) <= 200),
  quantity             numeric(12,3) not null check (quantity > 0 and quantity <= 10000000),
  unit                 text not null check (char_length(unit) <= 24),
  note                 text check (note is null or char_length(note) <= 1000),
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references public.user_profiles(id),
  foreign key (tenant_id, material_request_id) references public.material_requests (tenant_id, id)
);

create index material_request_items_request_idx
  on public.material_request_items (tenant_id, material_request_id);

-- close the observations ↔ material_requests circular reference
alter table public.observations
  add constraint observations_linked_material_request_fk
  foreign key (tenant_id, linked_material_request_id)
  references public.material_requests (tenant_id, id);

-- ─── time_entries (+ allocations) and weekly closeout ───────────────────────
-- Current model: ONE entry per user per day (API returns 409 on duplicates),
-- holding ≥1 job allocations (jobId nullable = "Internal / no job").

create table public.time_entries (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  user_id           uuid not null,
  legacy_id         text,
  work_date         date not null,
  start_time        time,
  end_time          time,
  break_minutes     integer check (break_minutes is null or break_minutes >= 0),
  total_hours       numeric(4,2) not null check (total_hours > 0 and total_hours <= 16),
  ordinary_hours    numeric(4,2) not null check (ordinary_hours >= 0),
  overtime_hours    numeric(4,2) not null check (overtime_hours >= 0),
  ot_overridden     boolean not null default false,
  notes             text check (notes is null or char_length(notes) <= 500),
  status            text not null default 'draft' check (status in
                      ('draft','submitted','approved','rejected')),
  submitted_at      timestamptz,
  approved_by       uuid references public.user_profiles(id),
  approved_at       timestamptz,
  rejected_by       uuid references public.user_profiles(id),
  rejected_at       timestamptz,
  rejected_reason   text,
  source            text,                        -- e.g. 'phil', 'admin'
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.user_profiles(id),   -- legacy enteredByUserId
  updated_by        uuid references public.user_profiles(id),
  deleted_at        timestamptz,
  deleted_by        uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references public.user_profiles (tenant_id, id),
  check (abs((ordinary_hours + overtime_hours) - total_hours) < 0.011)
);

create unique index time_entries_legacy_uq
  on public.time_entries (tenant_id, legacy_id) where legacy_id is not null;
create unique index time_entries_user_date_uq
  on public.time_entries (tenant_id, user_id, work_date) where deleted_at is null;
create index time_entries_status_idx on public.time_entries (tenant_id, status, work_date);
create index time_entries_date_idx   on public.time_entries (tenant_id, work_date);

create table public.time_entry_allocations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id),
  time_entry_id  uuid not null,
  job_id         uuid,                           -- NULL = "Internal (no job)" — real today
  hours          numeric(4,2) not null check (hours > 0),
  notes          text check (notes is null or char_length(notes) <= 500),
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, time_entry_id) references public.time_entries (tenant_id, id) on delete cascade,
  foreign key (tenant_id, job_id)        references public.jobs (tenant_id, id)
);
comment on table public.time_entry_allocations is
  'Job split for a day entry. Rewritten wholesale (delete+insert in one tx) when the entry is edited; sum(hours)=entry.total_hours is app-enforced.';

create index time_entry_allocations_entry_idx on public.time_entry_allocations (time_entry_id);
create index time_entry_allocations_job_idx   on public.time_entry_allocations (tenant_id, job_id, time_entry_id);

create table public.timesheet_approvals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  user_id          uuid not null,
  week_start_date  date not null check (extract(isodow from week_start_date) = 1),
  status           text not null default 'open' check (status in ('open','closed')),
  approved_hours   numeric(6,2),                 -- snapshot at close
  note             text,
  closed_by        uuid references public.user_profiles(id),
  closed_by_label  text,                         -- name as written at closeout
  closed_at        timestamptz,
  revision         integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.user_profiles(id),
  updated_by       uuid references public.user_profiles(id),
  unique (tenant_id, user_id, week_start_date),
  foreign key (tenant_id, user_id) references public.user_profiles (tenant_id, id)
);
comment on table public.timesheet_approvals is
  'Durable per-worker weekly closeout. Today /hours/weekly is a pure projection — this table is empty at import and starts filling when closeout writes land.';

create index timesheet_approvals_status_idx
  on public.timesheet_approvals (tenant_id, status, week_start_date);

create table public.payroll_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id),
  legacy_export_id text,
  content_hash   text,
  range_from     date not null,
  range_to       date not null,
  status_filter  text,
  user_id        uuid,
  job_id         uuid,
  row_count      integer not null default 0,
  summary        jsonb not null default '{}'::jsonb,
  exported_by        uuid references public.user_profiles(id),
  exported_by_label  text,                       -- legacy actorName stamp
  exported_at        timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, user_id) references public.user_profiles (tenant_id, id),
  foreign key (tenant_id, job_id)  references public.jobs (tenant_id, id)
);
comment on table public.payroll_runs is
  'Append-only export log (maps payroll-runs.json). Payroll evidence belongs in a transactional store; future Xero-style exports hang off this + outbox_events.';

create unique index payroll_runs_legacy_uq
  on public.payroll_runs (tenant_id, legacy_export_id) where legacy_export_id is not null;
create index payroll_runs_at_idx on public.payroll_runs (tenant_id, exported_at desc);

-- ─── ITP (templates → instances → items → responses) ────────────────────────
-- Statuses/scopes keep the app's exact kebab-case strings.

create table public.itp_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  legacy_id   text,                              -- tpl_xxxxxxxx
  name        text not null,
  category    text,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  updated_by  uuid references public.user_profiles(id),
  deleted_at  timestamptz,                       -- legacy archive (soft)
  deleted_by  uuid references public.user_profiles(id),
  unique (tenant_id, id)
);

create unique index itp_templates_legacy_uq
  on public.itp_templates (tenant_id, legacy_id) where legacy_id is not null;
create index itp_templates_live_idx on public.itp_templates (tenant_id) where deleted_at is null;

create table public.itp_template_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  template_id   uuid not null,
  legacy_id     text,
  label         text not null,
  point_type    text not null check (point_type in ('photo','value','signoff','note')),
  required      boolean not null default true,
  unit          text,                            -- point_type=value ("V", "Ω")
  min_value     numeric,
  max_value     numeric,
  witness_role  text check (witness_role in ('builder','admin','lh')),
  sort_order    integer not null default 0,
  revision      integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.user_profiles(id),
  updated_by    uuid references public.user_profiles(id),
  deleted_at    timestamptz,
  deleted_by    uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, template_id) references public.itp_templates (tenant_id, id)
);

create unique index itp_template_items_legacy_uq
  on public.itp_template_items (tenant_id, template_id, legacy_id) where legacy_id is not null;
create index itp_template_items_template_idx
  on public.itp_template_items (tenant_id, template_id);

create table public.itp_instances (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id),
  job_id         uuid not null,
  template_id    uuid,                           -- nullable: template may be soft-deleted later
  legacy_id      text,
  name           text not null,                  -- templateSnapshot.name at attach
  category       text,
  scope          text not null default 'job' check (scope in ('job','level','area','switchboard')),
  scope_ref      text,                           -- legacy scopeId (levels/switchboards not yet relational)
  site_area_id   uuid,                           -- resolved when scope='area'
  status         text not null default 'pending' check (status in
                   ('pending','in-progress','witnessed','signed-off')),
  signed_off_by        uuid references public.user_profiles(id),
  signed_off_by_label  text,                     -- legacy signedOffBy is a username string
  signed_off_at        timestamptz,
  revision       integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.user_profiles(id),
  updated_by     uuid references public.user_profiles(id),
  deleted_at     timestamptz,                    -- legacy archived/archivedAt/archivedBy
  deleted_by     uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id)       references public.jobs (tenant_id, id),
  foreign key (tenant_id, template_id)  references public.itp_templates (tenant_id, id),
  foreign key (tenant_id, site_area_id) references public.site_areas (tenant_id, id)
);

create unique index itp_instances_legacy_uq
  on public.itp_instances (tenant_id, legacy_id) where legacy_id is not null;
create index itp_instances_job_status_idx
  on public.itp_instances (tenant_id, job_id, status);

-- per-instance snapshot of template points (immutable record of what was checked)
create table public.itp_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id),
  instance_id       uuid not null,
  template_item_id  uuid,
  legacy_id         text,                        -- snapshot point id
  label             text not null,
  point_type        text not null check (point_type in ('photo','value','signoff','note')),
  required          boolean not null default true,
  unit              text,
  min_value         numeric,
  max_value         numeric,
  witness_role      text check (witness_role in ('builder','admin','lh')),
  sort_order        integer not null default 0,
  revision          integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.user_profiles(id),
  updated_by        uuid references public.user_profiles(id),
  deleted_at        timestamptz,
  deleted_by        uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, instance_id)      references public.itp_instances (tenant_id, id),
  foreign key (tenant_id, template_item_id) references public.itp_template_items (tenant_id, id)
);

create unique index itp_items_legacy_uq
  on public.itp_items (tenant_id, instance_id, legacy_id) where legacy_id is not null;
create index itp_items_instance_idx on public.itp_items (tenant_id, instance_id);

-- append-only: each record-point action is a row; current state = latest per item.
-- (Today the blob keeps only the latest result per point — import creates one row.)
create table public.itp_responses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  instance_id   uuid not null,
  itp_item_id   uuid not null,
  value_number  numeric,                         -- point_type=value
  value_text    text,                            -- point_type=note / freeform
  photo_url     text check (photo_url is null or char_length(photo_url) <= 400),
  note          text check (note is null or char_length(note) <= 500),
  responded_by        uuid,
  responded_by_label  text,                      -- legacy byUsername server stamp, immutable
  responded_at        timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, instance_id)  references public.itp_instances (tenant_id, id),
  foreign key (tenant_id, itp_item_id)  references public.itp_items (tenant_id, id),
  foreign key (tenant_id, responded_by) references public.user_profiles (tenant_id, id)
);

create index itp_responses_item_idx
  on public.itp_responses (tenant_id, itp_item_id, responded_at desc);
create index itp_responses_instance_idx
  on public.itp_responses (tenant_id, instance_id);

-- ─── documents (plans/doc register; metadata + Blob refs ONLY) ──────────────

create table public.documents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  job_id           uuid,                         -- nullable in current shape
  legacy_id        text,
  file_name        text check (file_name is null or char_length(file_name) <= 200),
  blob_path        text,
  blob_url         text not null,
  mime_type        text,
  size_bytes       bigint,
  drawing_number   text,
  revision_label   text,                         -- drawing revision ("A", "B", …)
  title            text,
  level_label      text,
  category         text,                         -- free text today; viewer collapses unknown → 'other'
  status           text not null default 'current' check (status in
                     ('current','superseded','archived')),
  notes            text check (notes is null or char_length(notes) <= 1000),
  supersedes_id    uuid references public.documents(id),
  superseded_by_id uuid references public.documents(id),
  uploaded_by      uuid references public.user_profiles(id),
  uploaded_at      timestamptz,
  revision         integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.user_profiles(id),
  updated_by       uuid references public.user_profiles(id),
  deleted_at       timestamptz,
  deleted_by       uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id) references public.jobs (tenant_id, id)
);
comment on table public.documents is
  'Doc/plan register metadata. Files (PDFs, per-page PNG renders) stay in Vercel Blob; only paths/URLs here.';

create unique index documents_legacy_uq
  on public.documents (tenant_id, legacy_id) where legacy_id is not null;
create index documents_job_status_idx on public.documents (tenant_id, job_id, status);

-- ─── assets (gear) + assignments ────────────────────────────────────────────

create table public.assets (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  legacy_id          text,
  name               text not null,
  asset_type         text not null check (asset_type in
                       ('vehicle','key','tool','accessory','ppe','other')),
  identifier         text,                       -- serial / rego / SKU
  notes              text,
  condition          text not null default 'good' check (condition in
                       ('good','damaged','missing')),
  last_condition_at  timestamptz,
  last_condition_by  uuid references public.user_profiles(id),
  last_checked_at    timestamptz,
  last_checked_by    uuid references public.user_profiles(id),
  ownership          text not null default 'owned' check (ownership in ('owned','hired')),
  hire_end_date      date,
  hire_rate_ex_gst   numeric(10,2),
  hire_supplier      text,
  revision           integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.user_profiles(id),
  updated_by         uuid references public.user_profiles(id),
  deleted_at         timestamptz,                -- legacy `archived` (derived status 'retired')
  deleted_by         uuid references public.user_profiles(id),
  unique (tenant_id, id)
);
comment on table public.assets is
  'Gear register. Display status (available/assigned/damaged/missing/retired) stays DERIVED from condition + open assignment + deleted_at — never stored.';

create unique index assets_legacy_uq on public.assets (tenant_id, legacy_id) where legacy_id is not null;
create index assets_live_idx on public.assets (tenant_id) where deleted_at is null;

create table public.asset_assignments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  asset_id            uuid not null,
  holder_user_id      uuid,                      -- null when held by depot/other
  holder_label        text,                      -- 'Depot' or display label for non-user holders
  assigned_at         timestamptz not null default now(),
  expected_return_at  timestamptz,
  returned_at         timestamptz,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.user_profiles(id),   -- who performed the transfer
  updated_by          uuid references public.user_profiles(id),
  foreign key (tenant_id, asset_id)       references public.assets (tenant_id, id),
  foreign key (tenant_id, holder_user_id) references public.user_profiles (tenant_id, id),
  check (holder_user_id is not null or holder_label is not null)
);
comment on table public.asset_assignments is
  'Holder history (maps currentHolder* + assets/<id>/history.json transfers). Current holder = the single open row (returned_at IS NULL).';

create unique index asset_assignments_open_uq
  on public.asset_assignments (asset_id) where returned_at is null;
create index asset_assignments_asset_idx
  on public.asset_assignments (tenant_id, asset_id, assigned_at desc);
create index asset_assignments_holder_idx
  on public.asset_assignments (tenant_id, holder_user_id) where returned_at is null;

-- ─── audit_logs (append-only) ───────────────────────────────────────────────

create table public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id),
  legacy_id    text,                             -- al_xxxxxxxx
  action       text not null,                    -- dotted verbs ('snag.transitioned', …); open set
  actor_id     uuid references public.user_profiles(id),
  actor_label  text,                             -- immutable as-written name/role stamp
  job_id       uuid,
  entity_type  text not null,
  entity_id    text not null,                    -- TEXT: spans legacy nanoid era + uuid era
  summary      text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
comment on table public.audit_logs is
  'Append-only journal (maps audit/<yyyy-mm>.json). Never UPDATE/DELETE. entity_id is text so imported pre-Postgres history keeps its original ids.';

create unique index audit_logs_legacy_uq
  on public.audit_logs (tenant_id, legacy_id) where legacy_id is not null;
create index audit_logs_entity_idx
  on public.audit_logs (tenant_id, entity_type, entity_id, created_at desc);
create index audit_logs_created_idx
  on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_job_idx
  on public.audit_logs (tenant_id, job_id, created_at desc) where job_id is not null;

-- ─── outbox_events (integrations / sync / notifications / exports) ──────────

create table public.outbox_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  event_type       text not null,                -- e.g. 'time_entry.approved', 'snag.created'
  aggregate_type   text,
  aggregate_id     text,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in
                     ('pending','processing','delivered','failed','dead')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz,
  processed_at     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.outbox_events is
  'Transactional outbox: write in the same tx as the domain change; a dispatcher delivers to integrations (push, Xero-style exports, sync) and marks status.';

create index outbox_events_tenant_status_idx
  on public.outbox_events (tenant_id, status, created_at);
create index outbox_events_dispatch_idx
  on public.outbox_events (status, next_attempt_at) where status = 'pending';

-- ─── updated_at / revision triggers ─────────────────────────────────────────

create trigger trg_tenants_touch before update on public.tenants
  for each row execute function public.tg_touch_updated_at();
create trigger trg_job_members_touch before update on public.job_members
  for each row execute function public.tg_touch_updated_at();
create trigger trg_material_request_items_touch before update on public.material_request_items
  for each row execute function public.tg_touch_updated_at();
create trigger trg_asset_assignments_touch before update on public.asset_assignments
  for each row execute function public.tg_touch_updated_at();
create trigger trg_outbox_events_touch before update on public.outbox_events
  for each row execute function public.tg_touch_updated_at();

create trigger trg_user_profiles_rev before update on public.user_profiles
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_jobs_rev before update on public.jobs
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_site_area_groups_rev before update on public.site_area_groups
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_site_areas_rev before update on public.site_areas
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_job_task_templates_rev before update on public.job_task_templates
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_tasks_rev before update on public.tasks
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_evidence_files_rev before update on public.evidence_files
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_snags_rev before update on public.snags
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_observations_rev before update on public.observations
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_material_requests_rev before update on public.material_requests
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_time_entries_rev before update on public.time_entries
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_timesheet_approvals_rev before update on public.timesheet_approvals
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_itp_templates_rev before update on public.itp_templates
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_itp_template_items_rev before update on public.itp_template_items
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_itp_instances_rev before update on public.itp_instances
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_itp_items_rev before update on public.itp_items
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_documents_rev before update on public.documents
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_assets_rev before update on public.assets
  for each row execute function public.tg_touch_updated_at_bump_revision();

-- ─── RLS: enable everywhere, define NO policies ─────────────────────────────
-- Server-side API routes use the service-role connection (bypasses RLS).
-- anon / publishable keys hit PostgREST and get zero rows. Real policies
-- arrive only with a future Supabase Auth phase.

alter table public.tenants                enable row level security;
alter table public.user_profiles          enable row level security;
alter table public.jobs                   enable row level security;
alter table public.job_members            enable row level security;
alter table public.site_area_groups       enable row level security;
alter table public.site_areas             enable row level security;
alter table public.job_task_templates     enable row level security;
alter table public.tasks                  enable row level security;
alter table public.task_status_events     enable row level security;
alter table public.task_comments          enable row level security;
alter table public.evidence_files         enable row level security;
alter table public.evidence_links         enable row level security;
alter table public.snags                  enable row level security;
alter table public.snag_comments          enable row level security;
alter table public.observations           enable row level security;
alter table public.material_requests      enable row level security;
alter table public.material_request_items enable row level security;
alter table public.time_entries           enable row level security;
alter table public.time_entry_allocations enable row level security;
alter table public.timesheet_approvals    enable row level security;
alter table public.payroll_runs           enable row level security;
alter table public.itp_templates          enable row level security;
alter table public.itp_template_items     enable row level security;
alter table public.itp_instances          enable row level security;
alter table public.itp_items              enable row level security;
alter table public.itp_responses          enable row level security;
alter table public.documents              enable row level security;
alter table public.assets                 enable row level security;
alter table public.asset_assignments      enable row level security;
alter table public.audit_logs             enable row level security;
alter table public.outbox_events          enable row level security;
