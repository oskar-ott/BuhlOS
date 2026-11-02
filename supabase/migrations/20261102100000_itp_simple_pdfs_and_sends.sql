-- ITP builder redesign (developer handoff 2026-11-02): many PDFs per ITP,
-- a send log, and the per-person "walkthrough seen" flag. Builds on
-- 20260718100000_itp_simple_reports.sql; nothing there changes.
--
--   * itp_simple_pdfs — one row per PDF a worker has made from an ITP. Each
--     PDF covers the areas it was made from (area_ids) and carries a
--     SNAPSHOT of what it printed (snapshot: areas → photos with captions)
--     so "Rename" can re-render the header without touching the photo pages
--     and "out of date" is worked out honestly from the PDF's OWN areas
--     (content_key = fingerprint of the photos + captions it holds; stale =
--     the live fingerprint of those areas differs). "Make again" replaces
--     the file on the same row (drawn as replacing; open decision noted).
--   * itp_simple_sends — every send: which PDF, to whom (office/email),
--     the PDF's name AT THE TIME, when, and the result. Feeds the "Sent"
--     badges and the "Used on this job" address chips. A failed send is
--     logged too (P7: the app says what happened).
--   * itp_simple_user_prefs — walkthrough_seen_at per person (the only
--     per-user setting the redesign adds). Supabase-first like the rest.
--
-- The legacy report columns pdf_url / pdf_generated_at keep being stamped
-- with the LATEST pdf so anything reading them still sees the newest file.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.itp_simple_user_prefs;
--   drop table if exists public.itp_simple_sends;
--   drop table if exists public.itp_simple_pdfs;

create table public.itp_simple_pdfs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id),
  report_id      uuid not null references public.itp_simple_reports(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  -- true while the name is the automatic one ("All areas" / the area names)
  -- so a rename can go "back to the area names" and the default can follow
  -- a later Make again; false once the worker typed a name.
  name_is_auto   boolean not null default true,
  area_ids       uuid[] not null default '{}',
  snapshot       jsonb not null default '{}'::jsonb,
  content_key    text not null default '',
  area_count     integer not null default 0,
  photo_count    integer not null default 0,
  blob_url       text not null,
  blob_pathname  text,
  byte_size      integer,
  made_at        timestamptz not null default now(),
  made_by_legacy_id text,
  made_by_name   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index itp_simple_pdfs_report_idx
  on public.itp_simple_pdfs (report_id, made_at desc);

comment on table public.itp_simple_pdfs is
  'PDFs made from a simple ITP (several per report). area_ids + snapshot say what each one holds; content_key is the fingerprint used for "out of date". File in Vercel Blob.';

create table public.itp_simple_sends (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  report_id        uuid not null references public.itp_simple_reports(id) on delete cascade,
  pdf_id           uuid references public.itp_simple_pdfs(id) on delete set null,
  job_legacy_id    text not null,
  kind             text not null check (kind in ('office', 'email')),
  recipient        text not null,
  pdf_name         text not null,
  attached         boolean not null default true,
  result           text not null check (result in ('sent', 'failed')),
  failure          text,
  sent_by_legacy_id text,
  sent_by_name     text,
  sent_at          timestamptz not null default now()
);

create index itp_simple_sends_report_idx
  on public.itp_simple_sends (report_id, sent_at desc);
create index itp_simple_sends_job_idx
  on public.itp_simple_sends (tenant_id, job_legacy_id, sent_at desc);

comment on table public.itp_simple_sends is
  'Send log for simple ITP PDFs: who it went to, when, which PDF (name at the time) and whether the mail service accepted it. "sent" = handed to the mail service, never "delivered".';

create table public.itp_simple_user_prefs (
  tenant_id           uuid not null references public.tenants(id),
  user_legacy_id      text not null,
  walkthrough_seen_at timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, user_legacy_id)
);

comment on table public.itp_simple_user_prefs is
  'Per-person ITP builder prefs. walkthrough_seen_at: set once Skip / Got it was tapped on the first-open walkthrough.';

create trigger itp_simple_pdfs_touch
  before update on public.itp_simple_pdfs
  for each row execute function public.tg_touch_updated_at();

create trigger itp_simple_user_prefs_touch
  before update on public.itp_simple_user_prefs
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — service-role-mediated only (house pattern).
alter table public.itp_simple_pdfs enable row level security;
alter table public.itp_simple_sends enable row level security;
alter table public.itp_simple_user_prefs enable row level security;
