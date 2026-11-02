-- Workshop Stock — the location matrix and the camera table's read counter
-- (owner pull 2026-11-02: "create a matrix of where everything [goes] eg iconic
-- switches go rack c shelf 2 bin 4 so it can automatically assign it to that
-- location"). docs/workshop-stock.md.
--
-- One row per company: the racks and the "these words go in this bin" rules, as
-- one JSON document (validated by the API's Zod body, saved whole with a
-- compare-and-set on `revision`). It is office configuration read as one thing,
-- at most a few hundred rules, and nothing joins into it — an item keeps only the
-- location TEXT it was given, so changing the matrix never moves recorded stock.
--
-- The camera table reads labels in bulk, so its reads get their own daily counter
-- ('intake_read') and never use up the crew's photo reads for the day.
--
-- Deploy order is free: until this is applied the matrix API answers
-- available:false and the two office screens say so; nothing else changes.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.workshop_stock_location_matrix;
--   delete from public.workshop_stock_usage where kind = 'intake_read';
--   alter table public.workshop_stock_usage drop constraint if exists workshop_stock_usage_kind_check;
--   alter table public.workshop_stock_usage add constraint workshop_stock_usage_kind_check check (kind in ('photo_read', 'lookup'));

create table if not exists public.workshop_stock_location_matrix (
  tenant_id            uuid primary key references public.tenants(id),
  matrix               jsonb not null,
  revision             integer not null default 1 check (revision >= 1),
  updated_by_legacy_id text,
  updated_by_name      text,
  updated_at           timestamptz not null default now()
);

comment on table public.workshop_stock_location_matrix is
  'Where stock goes: racks + word rules, one JSON document per company. Used to fill in an item''s location at the camera table; never rewrites a location already recorded.';

alter table public.workshop_stock_location_matrix enable row level security;

alter table public.workshop_stock_usage drop constraint if exists workshop_stock_usage_kind_check;
alter table public.workshop_stock_usage
  add constraint workshop_stock_usage_kind_check check (kind in ('photo_read', 'lookup', 'intake_read'));
