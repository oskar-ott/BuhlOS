-- #248 — xero_mappings: the EPIC-WIDE explicit mapping store (designed once,
-- per the issue): worker ↔ Xero employee now; work type ↔ earnings rate
-- (#611) and job ↔ tracking option (#254) land as further `kind`s on the
-- same table. Payroll-boundary ADR: links are explicit confirmed Xero IDs —
-- never name-guessed, never auto-created; only an admin confirm writes a row.
--
-- Postgres, not the issue's original `xero/mappings.json` blob sketch: the
-- audit comment's 5s-blob-cache hazard ("a just-confirmed link invisible to
-- an export for up to 5s") dissolves here — every read is fresh by
-- construction, and #893's batch snapshots read mappings from the same store.
--
-- Org scoping: rows carry the Xero organisation they were confirmed against.
-- The mapping board reads ALL of the tenant's rows and flags any whose org
-- differs from the current connection as org-mismatched (visible, never
-- silently hidden), satisfying the reconnect-to-different-org AC.
--
-- Unlink HARD-DELETES the row; the audit journal carries who/when history.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.xero_mappings;

create table public.xero_mappings (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  -- the Xero organisation this link was confirmed against
  external_tenant_id     text not null,
  kind                   text not null check (kind in (
                           'worker_employee',
                           'worktype_earnings_rate',
                           'job_tracking_option'
                         )),
  -- the BuhlOS side (worker id / work-type key / job id — legacy text ids)
  local_id               text not null,
  -- the Xero side, ALWAYS the immutable id (EmployeeID / EarningsRateID / …)
  xero_id                text not null,
  -- display snapshots at confirm time, so later Xero-side drift is showable
  xero_name_snapshot     text,
  xero_status_snapshot   text,
  -- provenance of the confirmed link: which signal suggested it (every row
  -- still required an explicit admin confirm — this is history, not a gate)
  source                 text not null default 'manual' check (source in (
                           'manual', 'email_suggestion', 'name_suggestion', 'legacy_import'
                         )),
  linked_by_legacy_id    text,
  linked_by_name         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- one link per BuhlOS record per kind per org
  unique (tenant_id, external_tenant_id, kind, local_id),
  unique (tenant_id, id)
);

-- 1:1 the OTHER direction for worker↔employee links only: one Xero employee
-- can never be linked to two workers (hours on someone else's payslip).
-- Deliberately NOT enforced for future kinds — two work types MAY map to one
-- earnings rate if #611 decides so.
create unique index xero_mappings_worker_employee_unique
  on public.xero_mappings (tenant_id, external_tenant_id, xero_id)
  where kind = 'worker_employee';

comment on table public.xero_mappings is
  '#248: epic-wide explicit Xero mapping store (worker↔employee now; #611/#254 kinds later). Links by immutable Xero id with confirm-time name/status snapshots; admin-confirmed only, never auto-linked; unlink hard-deletes (audit journal keeps history); org-scoped with visible mismatch on reconnect-to-different-org.';

create trigger xero_mappings_touch
  before update on public.xero_mappings
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — pairs identities with payroll; service-role only.
alter table public.xero_mappings enable row level security;
