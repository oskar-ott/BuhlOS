-- Workshop Stock — CATEGORIES THE OFFICE MAKES (owner pull 2026-11-03: "i want
-- to be able to create new catagories when the need comes up"). docs/workshop-stock.md.
--
-- The built-in categories (Switches & GPOs, LED strip, Cable, …) live in the
-- app (src/domains/workshop-stock/types.ts). This table holds the ones the
-- office adds: a name, what they're counted in, and their own fields (each
-- becomes a filter when the crew browse that category). Items keep pointing at
-- a category by key exactly as before (workshop_stock_items.category, specs) —
-- an office category's key is `c_<slug>`, which can never collide with a
-- built-in one. Office only (the API checks the role); the crew pick from the
-- list.
--
-- Fields are a JSON array of { "key": "power", "label": "Power" }. A field is
-- only ever added or renamed, never re-keyed, so values already saved on items
-- stay readable.
--
-- Deploy order is free, like 20261101100000: the app looks for this table
-- (store.hasCustomTypes, re-checked every minute) and offers the Categories
-- panel only once it exists. Re-runnable.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.workshop_stock_types;

create table if not exists public.workshop_stock_types (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  key                 text not null check (key ~ '^c_[a-z0-9_]{1,29}$'),
  label               text not null check (char_length(label) between 1 and 40),
  unit                text not null default 'each'
                        check (unit in ('each', 'metre', 'length', 'bag', 'box', 'roll', 'pack')),
  fields              jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 8),
  created_by_legacy_id text not null,
  created_by_name     text,
  updated_by_legacy_id text,
  updated_by_name     text,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, key)
);

-- one live category per name (case-insensitive) — no "Solar" and "solar"
create unique index if not exists workshop_stock_types_label_idx
  on public.workshop_stock_types (tenant_id, lower(label))
  where archived_at is null;

comment on table public.workshop_stock_types is
  'Workshop Stock categories the office adds, alongside the built-in ones in the app. Items point at one by key (c_<slug>) in workshop_stock_items.category.';
comment on column public.workshop_stock_types.fields is
  'The category''s own fields, in order: [{"key":"power","label":"Power"}]. Values live in workshop_stock_items.specs under these keys. Added or renamed, never re-keyed.';

-- RLS on, NO policies — service-role-mediated only (house pattern).
alter table public.workshop_stock_types enable row level security;
