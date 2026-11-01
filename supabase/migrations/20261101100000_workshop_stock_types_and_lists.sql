-- Workshop Stock — item TYPES with their own fields, and SHOPPING LISTS
-- (owner pull 2026-11-01, after the first week of real use). docs/workshop-stock.md.
--
-- 1. Types. "Switches aren't interchangeable: a Clipsal Iconic 2 gang white plate
--    is not a Classic one — but today all of that is shoved in the name." An item
--    now carries a TYPE (`category`: switches, led_strip, cable, …) and the fields
--    that type needs (`specs`: range, gang, colour temperature, voltage, width,
--    length, …) as a flat object of short texts. The type catalogue and its
--    fields live in the app (src/domains/workshop-stock/types.ts) — the database
--    only keeps the shape honest: a lower-case key, an object of strings. Brand
--    and colour stay in their own columns (matching and the online check use
--    them); a type just names them among its fields.
--
-- 2. Shopping lists. "On a job or in the workshop: see what we need to get from
--    the wholesaler and what we have in the workshop — a list they can go back to
--    and use to go through and find everything." A list is a plan, not a record
--    of stock: it never moves a balance. A line is either a workshop item (with
--    how many are needed) or plain text for something we don't stock. Ticking a
--    workshop line is done by TAKING it — the take (an ordinary ledger movement)
--    and the tick land in one transaction, and undoing the take un-ticks it.
--    Lists and lines carry CLIENT-generated ids, so a retried save is the same
--    row (insert … on conflict) — no idempotency table needed. Lists can be
--    deleted (they are plans; the stock ledger is untouched).
--
-- Deploy order is free, like 20261026100000: the app reads the new columns
-- through to_jsonb(i) (null/absent until this is applied) and only offers types
-- and lists once it sees them (store.hasTypes / store.hasLists, re-checked every
-- minute). Re-runnable.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.workshop_stock_list_lines;
--   drop table if exists public.workshop_stock_lists;
--   alter table public.workshop_stock_items drop column if exists specs;
--   alter table public.workshop_stock_items drop column if exists category;

-- ── types ────────────────────────────────────────────────────────────────────

alter table public.workshop_stock_items
  add column if not exists category text
    check (category is null or category ~ '^[a-z][a-z0-9_]{1,31}$');

alter table public.workshop_stock_items
  add column if not exists specs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(specs) = 'object');

create index if not exists workshop_stock_items_category_idx
  on public.workshop_stock_items (tenant_id, category)
  where archived_at is null;

comment on column public.workshop_stock_items.category is
  'The item''s type (switches, led_strip, cable, …) — the app''s type catalogue decides which fields it has. Null = not sorted yet.';
comment on column public.workshop_stock_items.specs is
  'The type''s own fields as short texts, e.g. {"range":"Iconic","gang":"2 gang"} or {"cct":"4000K","voltage":"24V","width":"10mm"}. Brand and colour stay in their columns.';

-- ── shopping lists ───────────────────────────────────────────────────────────

create table if not exists public.workshop_stock_lists (
  -- generated on the phone: a retried "start a list" is the same row
  id               uuid primary key,
  tenant_id        uuid not null references public.tenants(id),
  name             text not null check (char_length(name) between 1 and 80),
  -- informational, like a movement's job note: never a job cost
  job_legacy_id    text check (job_legacy_id is null or char_length(job_legacy_id) between 1 and 120),
  job_label        text check (job_label is null or char_length(job_label) between 1 and 160),
  owner_legacy_id  text not null,
  owner_name       text,
  done_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id)
);

create index if not exists workshop_stock_lists_open_idx
  on public.workshop_stock_lists (tenant_id, done_at, updated_at desc);

comment on table public.workshop_stock_lists is
  'Workshop Stock shopping lists: what someone needs for a job — from the workshop or the wholesaler. A plan, never a stock record.';

create table if not exists public.workshop_stock_list_lines (
  id                uuid primary key,
  tenant_id         uuid not null references public.tenants(id),
  list_id           uuid not null,
  -- a workshop item, or null for something we don't stock (then `text` says what)
  item_id           uuid,
  text              text check (text is null or char_length(text) between 1 and 160),
  -- how many are needed: thousandths of the item's unit (or of `unit` for text lines)
  quantity_milli    bigint check (quantity_milli is null or quantity_milli > 0),
  unit              text check (unit is null or unit in ('each', 'metre', 'length', 'bag', 'box', 'roll', 'pack')),
  got_at            timestamptz,
  got_by_legacy_id  text,
  got_by_name       text,
  -- the take that collected it from the workshop (null when got another way)
  movement_id       uuid,
  position          integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, list_id) references public.workshop_stock_lists (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references public.workshop_stock_items (tenant_id, id),
  foreign key (tenant_id, movement_id) references public.workshop_stock_movements (tenant_id, id),
  check (item_id is not null or text is not null),
  check ((got_at is null) = (got_by_legacy_id is null)),
  check (movement_id is null or got_at is not null)
);

create index if not exists workshop_stock_list_lines_list_idx
  on public.workshop_stock_list_lines (tenant_id, list_id, position);

create index if not exists workshop_stock_list_lines_movement_idx
  on public.workshop_stock_list_lines (tenant_id, movement_id)
  where movement_id is not null;

comment on table public.workshop_stock_list_lines is
  'One thing on a shopping list: a workshop item with how many are needed, or plain text for something we don''t stock. Ticked by taking it (movement_id) or by hand.';

-- RLS on, NO policies — service-role-mediated only (house pattern).
alter table public.workshop_stock_lists enable row level security;
alter table public.workshop_stock_list_lines enable row level security;
