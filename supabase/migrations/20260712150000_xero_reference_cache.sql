-- #610 — Xero payroll reference-data cache (read-only, NEVER authoritative).
-- Per the payroll-boundary ADR clause 4: BuhlOS caches selected Xero reference
-- data for MAPPING/VALIDATION ONLY; Xero stays the source of truth. The cache
-- is tenant-scoped AND Xero-organisation-scoped (a reconnect to a different
-- org must never mix reference sets), timestamped, wholesale-replaced per
-- sync, and visibly stale when old.
--
-- Data minimisation (ADR clause 5): `payload` holds an explicit ALLOW-LIST of
-- mapping-relevant fields built in api/_lib/xero/reference-sync.js — never a
-- raw Xero response. No TFNs, bank details, dates of birth, addresses or pay
-- amounts are ever stored.
--
-- xero_reference_syncs is the append-only per-fetch outcome log — the record
-- the #251 sync-health surface will read. A failed fetch is a logged row,
-- never an empty cache that could read as "the org has no employees".
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.xero_reference_syncs;
--   drop table if exists public.xero_reference_items;

create table public.xero_reference_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  -- the Xero organisation this cache row belongs to
  external_tenant_id   text not null,
  kind                 text not null check (kind in (
                         'employee',
                         'payroll_calendar',
                         'earnings_rate',
                         'leave_type',
                         'deduction_type',
                         'reimbursement_type',
                         'tracking_category'
                       )),
  xero_id              text not null,
  name                 text not null,
  -- employee Status != TERMINATED / pay-item CurrentRecord — feeds the
  -- mapping children's inactive/stale-link detection (#248/#611)
  active               boolean not null default true,
  -- minimised allow-listed fields only (see header)
  payload              jsonb,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (tenant_id, external_tenant_id, kind, xero_id),
  unique (tenant_id, id)
);

create index xero_reference_items_kind_idx
  on public.xero_reference_items (tenant_id, external_tenant_id, kind);

comment on table public.xero_reference_items is
  '#610: read-only cache of Xero payroll reference data (employees, calendars, pay items, tracking categories) for mapping/validation only — NEVER authoritative; wholesale-replaced per sync; payload is an allow-list, never a raw response.';

create trigger xero_reference_items_touch
  before update on public.xero_reference_items
  for each row execute function public.tg_touch_updated_at();

create table public.xero_reference_syncs (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  external_tenant_id   text not null,
  -- the fetch group: employees | calendars | pay_items | tracking_categories
  sync_group           text not null check (sync_group in (
                         'employees', 'calendars', 'pay_items', 'tracking_categories'
                       )),
  status               text not null check (status in ('ok', 'failed')),
  item_count           integer,
  error_category       text,
  correlation_id       text,
  actor_legacy_id      text,
  actor_name           text,
  created_at           timestamptz not null default now(),

  unique (tenant_id, id)
);

create index xero_reference_syncs_group_idx
  on public.xero_reference_syncs (tenant_id, external_tenant_id, sync_group, created_at desc);

comment on table public.xero_reference_syncs is
  '#610: append-only per-group Xero reference-fetch outcome log (ok/failed, count, error category, correlation id) — the record the #251 sync-health surface reads. Never UPDATEd.';

-- RLS on, NO policies — office/infra cache, service-role-mediated only
-- (same class as the Phase 2a registries; see supabase-rls-access-matrix.md).
alter table public.xero_reference_items enable row level security;
alter table public.xero_reference_syncs enable row level security;
