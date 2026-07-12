-- #893 — durable payroll batches: the immutable snapshot the first Xero
-- write (#249) will retry from, and the record reconciliation (#250)
-- verifies against. Payroll batches are FINANCIAL RECORDS:
--
--   * a batch snapshots everything at creation — source entries (+ their
--     export stamps), worker→employee and worktype→earnings-rate mappings,
--     per-day units, jobs — so no later mutation of live data changes what
--     a batch says
--   * once LOCKED a batch and its items are IMMUTABLE — enforced here by
--     triggers (defence-in-depth under the app-level CAS), not just by app
--     discipline. Historical payroll is never mutated; changes happen in a
--     CORRECTION batch (supersedes_batch_id chain, revision + 1)
--   * payroll_batch_events is the append-only in-store history (the
--     cross-surface audit journal carries the same verbs)
--   * status transitions are app-driven via CAS (update ... where status=)
--     — 'validating'/'exporting' are transient in-request phases and are
--     deliberately NOT persisted states
--
-- The CSV export path (api/time-entries-export.js) is UNTOUCHED — the ADR's
-- permanent fallback. Batches do not stamp entries; stamping remains the
-- CSV-finalise/export concern.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.payroll_batch_events;
--   drop table if exists public.payroll_batch_items;
--   drop table if exists public.payroll_batches;
--   drop function if exists public.tg_payroll_batch_guard;
--   drop function if exists public.tg_payroll_batch_items_guard;

create table public.payroll_batches (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  -- the Xero organisation the batch's mapping snapshots were taken against
  external_tenant_id    text not null,
  period_start          date not null,
  period_end            date not null,
  status                text not null default 'blocked' check (status in (
                          -- pre-lock (mutable): validation decides which
                          'blocked', 'ready',
                          -- locked and beyond (immutable)
                          'locked', 'exporting', 'partially_exported',
                          'exported', 'reconciled', 'correction_required'
                        )),
  -- deterministic sha-256 over the sorted source tuples; recomputed and
  -- compared at lock time so a batch can never lock over drifted source data
  source_hash           text not null,
  -- the last validation run: { ready, errors: [...], warnings: [...] }
  validation            jsonb,
  -- correction chain: a correction batch points at the batch it supersedes
  supersedes_batch_id   uuid references public.payroll_batches(id),
  revision              integer not null default 1,
  item_count            integer not null default 0,
  total_hours           numeric(9,2) not null default 0,
  created_by_legacy_id  text,
  created_by_name       text,
  locked_by_legacy_id   text,
  locked_by_name        text,
  locked_at             timestamptz,
  validated_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  check (period_start <= period_end),
  unique (tenant_id, id)
);

create index payroll_batches_period_idx
  on public.payroll_batches (tenant_id, period_start, period_end, created_at desc);

comment on table public.payroll_batches is
  '#893: durable payroll batches — creation-time snapshots of source hours + mappings; immutable once locked (trigger-enforced); corrections supersede, never mutate; the store #249 exports from and #250 reconciles against.';

create table public.payroll_batch_items (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  batch_id               uuid not null references public.payroll_batches(id) on delete cascade,
  worker_id              text not null,
  worker_name            text not null,
  -- mapping snapshots AT CREATION (by immutable Xero ids; #250 verifies
  -- against these, immune to later remaps)
  employee_id            text,
  employee_name          text,
  earnings_rate_id       text,
  earnings_rate_name     text,
  work_type              text not null check (work_type in ('ordinary', 'overtime')),
  entry_date             date not null,
  job_id                 text,
  job_name               text,
  hours                  numeric(7,2) not null check (hours > 0),
  -- source provenance: the entry blob + its export stamp at snapshot time
  source_entry_ref       text not null,   -- users/<workerId>/time-entries/<date>.json
  source_export_id       text,            -- exportId already on the entry, if any
  source_status          text not null,   -- entry status at snapshot (approved)
  created_at             timestamptz not null default now(),

  -- one item per worker × day × job × classification inside a batch
  unique (batch_id, worker_id, entry_date, job_id, work_type),
  unique (tenant_id, id)
);

create index payroll_batch_items_batch_idx
  on public.payroll_batch_items (batch_id, worker_id, entry_date);

comment on table public.payroll_batch_items is
  '#893: per-item batch snapshot (worker × day × job × work type) with employee + earnings-rate mapping snapshots and source provenance. Immutable once the owning batch locks (trigger-enforced).';

create table public.payroll_batch_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  batch_id    uuid not null references public.payroll_batches(id) on delete cascade,
  event       text not null check (event in (
                'created', 'revalidated', 'locked', 'unlocked', 'deleted',
                'correction_created', 'superseded'
              )),
  actor_legacy_id text,
  actor_name  text,
  detail      jsonb,
  created_at  timestamptz not null default now(),

  unique (tenant_id, id)
);

create index payroll_batch_events_batch_idx
  on public.payroll_batch_events (batch_id, created_at);

comment on table public.payroll_batch_events is
  '#893: append-only per-batch history (created/revalidated/locked/unlocked/correction). Never UPDATEd or DELETEd (except via batch cascade of an unlocked batch).';

-- ── Immutability guards (defence-in-depth under the app-level CAS) ──────────

-- Batches: once locked, only sanctioned STATUS transitions may update the row
-- (unlock, and the #249/#250 export/reconcile progression + audit fields);
-- the snapshot columns are frozen forever. Unlocked batches may be deleted;
-- locked-and-beyond batches may not.
create or replace function public.tg_payroll_batch_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status not in ('blocked', 'ready') then
      raise exception 'payroll batch % is % and cannot be deleted — create a correction batch', old.id, old.status;
    end if;
    return old;
  end if;
  -- UPDATE
  if old.status not in ('blocked', 'ready') then
    -- frozen snapshot columns
    if new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.source_hash is distinct from old.source_hash
       or new.item_count is distinct from old.item_count
       or new.total_hours is distinct from old.total_hours
       or new.revision is distinct from old.revision
       or new.supersedes_batch_id is distinct from old.supersedes_batch_id
       or new.external_tenant_id is distinct from old.external_tenant_id
       or new.created_by_legacy_id is distinct from old.created_by_legacy_id then
      raise exception 'payroll batch % is % — its snapshot is immutable', old.id, old.status;
    end if;
    -- a locked-or-later batch must be CHANGING state (or lock metadata via
    -- unlock); a same-status content update has nothing legitimate to touch
    if new.status = old.status
       and new.validation is not distinct from old.validation
       and new.locked_at is not distinct from old.locked_at then
      raise exception 'payroll batch % is % — no mutation permitted', old.id, old.status;
    end if;
  end if;
  return new;
end $$;

create trigger payroll_batches_guard
  before update or delete on public.payroll_batches
  for each row execute function public.tg_payroll_batch_guard();

-- Items: frozen the moment their batch leaves the pre-lock states. (INSERTs
-- only happen at batch creation; deletes ride the cascade of an unlocked
-- batch delete.)
create or replace function public.tg_payroll_batch_items_guard()
returns trigger language plpgsql as $$
declare
  batch_status text;
begin
  select status into batch_status from public.payroll_batches
    where id = coalesce(new.batch_id, old.batch_id);
  if batch_status is not null and batch_status not in ('blocked', 'ready') then
    raise exception 'payroll batch items are immutable once the batch is % — create a correction batch', batch_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger payroll_batch_items_guard
  before insert or update or delete on public.payroll_batch_items
  for each row execute function public.tg_payroll_batch_items_guard();

create trigger payroll_batches_touch
  before update on public.payroll_batches
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — financial records, service-role-mediated only.
alter table public.payroll_batches enable row level security;
alter table public.payroll_batch_items enable row level security;
alter table public.payroll_batch_events enable row level security;
