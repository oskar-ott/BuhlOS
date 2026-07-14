-- #249 — draft-timesheet export state for the first Xero WRITE. Two tables,
-- a clean immutable/append-only split (no row is ever mutated in place):
--
--   * payroll_batch_timesheet_attempts — ONE IMMUTABLE ROW PER POST ATTEMPT.
--     Written before the Xero call with the request/content hashes, updated by
--     NOTHING afterwards (trigger-enforced). The Xero response fields
--     (xero_timesheet_id, correlation_id, http_status, outcome) are recorded on
--     the SAME insert once the request returns — an attempt row is the durable
--     "we posted worker X for batch Y" record the epic forbids ever losing.
--   * payroll_batch_timesheet_events — APPEND-ONLY lifecycle referencing an
--     attempt: pending → accepted_by_xero → verified_against_xero (a POST 200 is
--     NOT reconciled until the readback matches), or rejected / drifted /
--     retry_required. Per-worker current status = the latest event.
--
-- Idempotency: the latest accepted attempt for (external_tenant_id, employee_id,
-- period_start, period_end) carries the content_hash + xero_timesheet_id; an
-- unchanged re-export skips, a changed one is BLOCKED into a correction (never a
-- blind overwrite-by-match). The immutable payroll_batches snapshot + these rows
-- are authoritative; the legacy time-entry exportId stamp is only a bridge.
--
-- Financial records: RLS on, NO policies (service-role only), same as the batch
-- tables. Additive only. Down path (documented, not executed):
--   drop table if exists public.payroll_batch_timesheet_events;
--   drop table if exists public.payroll_batch_timesheet_attempts;
--   drop function if exists public.tg_ts_attempt_immutable;

create table public.payroll_batch_timesheet_attempts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  batch_id              uuid not null references public.payroll_batches(id) on delete cascade,
  -- the Xero organisation the push targeted (matches the batch snapshot's org)
  external_tenant_id    text not null,
  worker_id             text not null,
  worker_name           text not null,
  employee_id           text,            -- null only on a 'blocked' (unmapped) attempt
  period_start          date not null,
  period_end            date not null,
  -- deterministic hash of the built timesheet payload (idempotency key together
  -- with employee_id + period); request_hash is the exact bytes posted
  content_hash          text not null,
  request_hash          text,
  -- captured from the Xero response (null when nothing was sent)
  xero_timesheet_id     text,
  correlation_id        text,
  http_status           integer,
  outcome               text not null check (outcome in (
                          'accepted',   -- 2xx from Xero, TimesheetID captured
                          'rejected',   -- Xero validation refused it (named)
                          'error',      -- transport/auth/rate-limit/etc
                          'skipped',    -- idempotent no-op (unchanged, already accepted)
                          'blocked'     -- pre-flight blocker; never sent to Xero
                        )),
  error_category        text,           -- the shared XeroError category on failure
  error_detail          text,           -- operator-safe context (never secrets/bodies)
  actor_legacy_id       text,
  actor_name            text,
  created_at            timestamptz not null default now(),

  unique (tenant_id, id)
);

create index payroll_ts_attempts_batch_idx
  on public.payroll_batch_timesheet_attempts (batch_id, worker_id, created_at desc);
create index payroll_ts_attempts_idem_idx
  on public.payroll_batch_timesheet_attempts (external_tenant_id, employee_id, period_start, period_end, created_at desc);

comment on table public.payroll_batch_timesheet_attempts is
  '#249: one IMMUTABLE row per Xero draft-timesheet POST attempt (hashes, Xero TimesheetID/correlation-id, outcome). Never updated; the durable "we posted" record. Idempotency + no-overwrite-by-match key off the latest accepted row per (org, employee, period).';

-- Attempts are historical facts: refuse UPDATE outright (deletes only ride the
-- batch cascade). Defence-in-depth under the app never issuing an update.
create or replace function public.tg_ts_attempt_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'payroll timesheet attempts are immutable (attempt %) — record a new attempt or event instead', old.id;
end $$;

create trigger payroll_ts_attempts_immutable
  before update on public.payroll_batch_timesheet_attempts
  for each row execute function public.tg_ts_attempt_immutable();

create table public.payroll_batch_timesheet_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id),
  batch_id     uuid not null references public.payroll_batches(id) on delete cascade,
  attempt_id   uuid references public.payroll_batch_timesheet_attempts(id) on delete cascade,
  worker_id    text not null,
  event        text not null check (event in (
                 'pending',                 -- attempt written, about to POST
                 'accepted_by_xero',        -- POST returned a TimesheetID
                 'rejected',                -- Xero refused (validation) / transport error
                 'verified_against_xero',   -- readback matched the sent payload
                 'drifted',                 -- readback did NOT match (loud)
                 'retry_required'           -- transient failure, retry the worker
               )),
  detail       jsonb,
  created_at   timestamptz not null default now(),

  unique (tenant_id, id)
);

create index payroll_ts_events_attempt_idx
  on public.payroll_batch_timesheet_events (attempt_id, created_at);
create index payroll_ts_events_batch_worker_idx
  on public.payroll_batch_timesheet_events (batch_id, worker_id, created_at desc);

comment on table public.payroll_batch_timesheet_events is
  '#249: append-only per-worker export lifecycle (pending → accepted_by_xero → verified_against_xero, or rejected/drifted/retry_required). Never UPDATEd/DELETEd except via batch cascade. accepted_by_xero and verified_against_xero are distinct — a POST 200 alone is not reconciled.';

-- RLS on, NO policies — financial records, service-role-mediated only.
alter table public.payroll_batch_timesheet_attempts enable row level security;
alter table public.payroll_batch_timesheet_events enable row level security;
