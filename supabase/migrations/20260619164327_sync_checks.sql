-- sync_checks — the migration trust layer (#152). One row per drift-check RUN
-- per domain: did Blob and Postgres stay identical? Powers the manual runner
-- (scheduled later) and a small admin "Hours sync: IN SYNC" status view.
--
-- Additive, append-only audit. RLS auto-enabled (no policy) per the project
-- convention; reads are server-only (service role) for now.

create table public.sync_checks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  domain              text not null,                       -- e.g. 'hours'
  checked_at          timestamptz not null default now(),
  status              text not null check (status in ('pass', 'fail')),
  -- coverage
  blob_count          integer not null default 0,
  pg_count            integer not null default 0,
  blob_total          numeric not null default 0,          -- domain total (hours)
  pg_total            numeric not null default 0,
  allocations_checked boolean not null default false,
  -- drift breakdown
  matched             integer not null default 0,
  only_in_blob        integer not null default 0,
  only_in_pg          integer not null default 0,
  mismatched          integer not null default 0,
  -- fast equality + forensic detail
  blob_hash           text,
  pg_hash             text,
  details             jsonb not null default '{}'::jsonb,  -- the specific drifts
  duration_ms         integer,
  created_at          timestamptz not null default now()
);

-- latest-per-domain lookups for the status view
create index sync_checks_domain_at_idx on public.sync_checks (tenant_id, domain, checked_at desc);

alter table public.sync_checks enable row level security;
