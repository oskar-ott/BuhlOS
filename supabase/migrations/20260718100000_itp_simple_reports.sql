-- #912 — simple mobile ITP builder (lean-reset step 6): the field's minimum
-- honest QA artifact. A report is job-scoped; areas are FREE TEXT named by
-- the worker on the walk (deliberately NOT the jobs area/task facets — no
-- area-array coupling, no taskInstanceId claims); photos hang off areas.
--
--   * metadata Supabase-first (product-owner directive 2026-07-18): these
--     tables ARE the store — no Blob JSON mirror
--   * binaries stay in Vercel Blob (photos + generated PDFs under
--     jobs/<jobId>/itp-simple/); rows carry the URLs only
--   * no status machine: a report is always editable; "generate PDF" stamps
--     pdf_url/pdf_generated_at with the latest artifact (P7: the record is
--     what was captured, not a workflow state)
--   * soft-delete on reports only (deleted_at); areas/photos hard-delete
--     with their parent via FK cascade
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.itp_simple_photos;
--   drop table if exists public.itp_simple_areas;
--   drop table if exists public.itp_simple_reports;

create table public.itp_simple_reports (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  -- resolved public.jobs row when the legacy id maps; the app operates on
  -- legacy job ids, so job_legacy_id is the lookup key either way
  job_id                 uuid references public.jobs(id),
  job_legacy_id          text not null,
  title                  text not null check (char_length(title) between 1 and 120),
  pdf_url                text,
  pdf_generated_at       timestamptz,
  created_by_legacy_id   text,
  created_by_name        text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create index itp_simple_reports_job_idx
  on public.itp_simple_reports (tenant_id, job_legacy_id, created_at desc)
  where deleted_at is null;

comment on table public.itp_simple_reports is
  'Simple mobile ITP reports (#912): job-scoped, built on the phone, rendered to a plain PDF. Metadata source of truth; binaries in Vercel Blob.';

create table public.itp_simple_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  report_id   uuid not null references public.itp_simple_reports(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index itp_simple_areas_report_idx
  on public.itp_simple_areas (report_id, position, created_at);

comment on table public.itp_simple_areas is
  'Free-text areas inside a simple ITP report — named by the worker on the walk, deliberately independent of the jobs area facets.';

create table public.itp_simple_photos (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  area_id             uuid not null references public.itp_simple_areas(id) on delete cascade,
  blob_url            text not null,
  blob_pathname       text,
  caption             text check (caption is null or char_length(caption) <= 200),
  taken_by_legacy_id  text,
  taken_by_name       text,
  created_at          timestamptz not null default now()
);

create index itp_simple_photos_area_idx
  on public.itp_simple_photos (area_id, created_at);

comment on table public.itp_simple_photos is
  'Photo metadata for simple ITP areas. Binary lives in Vercel Blob (jobs/<jobId>/itp-simple/); this row carries the URL.';

create trigger itp_simple_reports_touch
  before update on public.itp_simple_reports
  for each row execute function public.tg_touch_updated_at();

create trigger itp_simple_areas_touch
  before update on public.itp_simple_areas
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — service-role-mediated only (house pattern).
alter table public.itp_simple_reports enable row level security;
alter table public.itp_simple_areas enable row level security;
alter table public.itp_simple_photos enable row level security;
