-- Job numbers issued by BuhlOS (job_code_auto flag, dark; #1152).
--
-- A job's short reference is `IV` + 4 digits — what a worker reads out at the
-- wholesaler and what supplier invoices are matched on. Until now the number
-- came from ServiceM8 and was typed in, or the phone worked out "the next
-- 7000 number" from one worker's own job list (two workers could be handed
-- the same one). BuhlOS now issues the next number itself, starting at
-- IV4000 (owner decision 2026-11-22) — above ServiceM8's numbers — and
-- running to IV9999, the end of the 4-digit format.
--
-- Why Postgres: jobs live in jobs.json (Blob), which has no compare-and-swap
-- and can be read up to a minute stale. Two creates at the same instant must
-- get two different numbers, so the counter and the claim live here.
--
--   * job_code_counters  one row per tenant + series: the next number to try.
--                        Locked FOR UPDATE while a number is issued.
--   * job_code_claims    one row per number ever given out or typed in while
--                        the flag is on. UNIQUE (tenant_id, code) is the rule
--                        that makes a duplicate impossible. A claim is never
--                        deleted when its job is: a number is not reused.
--
-- jobs are keyed by job_legacy_id (the jobs.json id) — the house bridge.
-- RLS on, NO policies — service-role-mediated only (house pattern).
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.job_code_claims;
--   drop table if exists public.job_code_counters;

create table public.job_code_counters (
  tenant_id   uuid not null references public.tenants(id),
  -- which run of numbers this counts; 'IV' = IV4000 … IV9999
  series      text not null check (series in ('IV')),
  next_value  integer not null check (next_value >= 4000 and next_value <= 10000),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, series)
);

comment on table public.job_code_counters is
  'The next BuhlOS-issued job number to try, per tenant and series. Row-locked while a number is issued (api/_lib/job-codes.js).';

create table public.job_code_claims (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  code                 text not null check (code ~ '^IV[0-9]{4}$'),
  -- the job the number was given to (jobs.json id). Null only for a number
  -- that was issued and then never reached a job.
  job_legacy_id        text,
  -- 'issued' = BuhlOS picked it; 'typed' = a person typed it at create
  source               text not null check (source in ('issued', 'typed')),
  claimed_by_legacy_id text,
  claimed_by_name      text,
  created_at           timestamptz not null default now(),
  unique (tenant_id, code)
);

create index job_code_claims_job_idx on public.job_code_claims (tenant_id, job_legacy_id);

comment on table public.job_code_claims is
  'Every job number given out by BuhlOS or typed in while job_code_auto is on. UNIQUE (tenant_id, code): a number can belong to one job only, and is never reused.';

alter table public.job_code_counters enable row level security;
alter table public.job_code_claims enable row level security;
