-- Workshop Stock (owner pull 2026-10-09; launch-gate flag `workshop_stock`,
-- docs/workshop-stock.md): quantities of electrical materials and consumables
-- kept in the workshop — GPOs, switches, breakers, conduit, cable, fittings,
-- fixings. Deliberately NOT gear: no custody, no serials, no test-and-tag; an
-- item is a quantity on a shelf, and stock leaving is a movement, not a loan.
--
-- The rules this schema enforces itself (defence in depth under the app):
--   * the movement LEDGER is the truth; items.balance_milli is a cache that is
--     only ever changed by the ledger trigger, in the same statement as the
--     movement insert — the two cannot drift, and a direct balance UPDATE raises
--   * quantities are integer thousandths of the item's base unit (bigint, no
--     floating point); a movement must fit the unit's precision (whole units;
--     metres to 0.1) and can never take the balance below zero
--   * movements are APPEND-ONLY: update/delete raise. A mistake is undone by a
--     compensating 'reversal' row, and one movement can be reversed once
--     (partial unique index); a movement that a later count has absorbed can't
--     be reversed at all (the count already corrected it)
--   * every write carries a client idempotency key, unique per tenant; the
--     request hash beside it lets the app refuse a reused key with a different
--     payload
--   * an item's unit cannot change once it has movement history; items are
--     archived, never deleted, so history survives
--   * tenant-scoped everywhere with COMPOSITE foreign keys (tenant_id, id), so
--     a row can never point at another tenant's item, photo or movement
--   * RLS on, NO policies — service-role-mediated only (house pattern)
--
-- Photos: binaries live in Vercel Blob under workshop-stock/<tenant>/…; the
-- rows carry the pathname/URL, which is NEVER sent to a browser (served only
-- through the authenticated proxy in api/workshop-stock.js). Recognition
-- photos for "take stock" are not stored at all. A product photo uploaded
-- while adding stock is 'pending' until an item claims it and expires after a
-- day otherwise (cleaned up by the API).
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.workshop_stock_usage;
--   drop table if exists public.workshop_stock_lookup_cache;
--   drop table if exists public.workshop_stock_item_events;
--   drop table if exists public.workshop_stock_movements;
--   drop table if exists public.workshop_stock_identifiers;
--   drop table if exists public.workshop_stock_items;
--   drop table if exists public.workshop_stock_photos;
--   drop function if exists public.tg_workshop_stock_movement_apply();
--   drop function if exists public.tg_workshop_stock_item_guard();
--   drop function if exists public.tg_workshop_stock_append_only();

-- ── photos ───────────────────────────────────────────────────────────────────

create table public.workshop_stock_photos (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id),
  purpose                text not null check (purpose in ('pending', 'item', 'retired')),
  blob_url               text not null,
  blob_pathname          text not null,
  content_type           text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size              integer not null check (byte_size > 0 and byte_size <= 4000000),
  width                  integer not null check (width between 1 and 10000),
  height                 integer not null check (height between 1 and 10000),
  sha256                 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_legacy_id  text not null,
  uploaded_by_name       text,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz,
  deleted_at             timestamptz,
  -- what the photo reader transcribed (image-derived, kept apart from listing
  -- evidence and from what the worker confirmed); null when not read
  reading                jsonb,
  unique (tenant_id, id),
  check (purpose = 'item' or expires_at is not null)
);

create index workshop_stock_photos_expiry_idx
  on public.workshop_stock_photos (tenant_id, expires_at)
  where purpose <> 'item' and deleted_at is null;

comment on table public.workshop_stock_photos is
  'Workshop Stock product photos. Binary in Vercel Blob (URL server-only; served through the authenticated proxy). pending → item when an item claims it; pending/retired rows expire and are deleted.';

-- ── items ────────────────────────────────────────────────────────────────────

create table public.workshop_stock_items (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenants(id),
  name                       text not null check (char_length(name) between 1 and 160),
  brand                      text check (brand is null or char_length(brand) between 1 and 60),
  -- the maker's catalogue code AS PRINTED (punctuation and leading zeroes kept)
  manufacturer_code          text check (manufacturer_code is null or char_length(manufacturer_code) between 2 and 48),
  -- a wholesaler's own code, never confused with the maker's
  supplier_sku               text check (supplier_sku is null or char_length(supplier_sku) between 2 and 48),
  supplier_name              text check (supplier_name is null or char_length(supplier_name) between 1 and 60),
  variant                    text check (variant is null or char_length(variant) between 1 and 160),
  colour_finish              text check (colour_finish is null or char_length(colour_finish) between 1 and 40),
  base_unit                  text not null check (base_unit in ('each', 'metre', 'length', 'bag', 'box', 'roll', 'pack')),
  location                   text check (location is null or char_length(location) between 1 and 60),
  photo_id                   uuid,
  default_pack_unit          text check (default_pack_unit is null or default_pack_unit in ('box', 'pack', 'bag', 'roll', 'length', 'carton', 'coil', 'reel')),
  default_pack_size_milli    bigint check (default_pack_size_milli is null or default_pack_size_milli > 0),
  -- ledger cache — written ONLY by tg_workshop_stock_movement_apply
  balance_milli              bigint not null default 0 check (balance_milli >= 0),
  estimated                  boolean not null default false,
  version                    integer not null default 0 check (version >= 0),
  last_movement_at           timestamptz,
  last_counted_at            timestamptz,
  last_counted_by_legacy_id  text,
  last_counted_by_name       text,
  -- catalogue edits are compare-and-set on meta_revision (two office edits never silently overwrite)
  meta_revision              integer not null default 1 check (meta_revision >= 1),
  verification_status        text not null default 'unverified' check (verification_status in ('manufacturer_code_matched', 'possible_match', 'unverified')),
  verification               jsonb,
  provenance                 jsonb not null default '{}'::jsonb,
  archived_at                timestamptz,
  archived_by_legacy_id      text,
  archived_by_name           text,
  created_by_legacy_id       text not null,
  created_by_name            text,
  updated_by_legacy_id       text,
  updated_by_name            text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, photo_id) references public.workshop_stock_photos (tenant_id, id),
  check ((default_pack_unit is null) = (default_pack_size_milli is null))
);

create index workshop_stock_items_list_idx
  on public.workshop_stock_items (tenant_id, name)
  where archived_at is null;

comment on table public.workshop_stock_items is
  'Workshop Stock catalogue: one row per stocked product. balance_milli is the RECORDED quantity (thousandths of base_unit) — a ledger cache, not a guarantee of what is on the shelf.';

-- ── identifiers (codes / barcodes the item is recognised by) ─────────────────

create table public.workshop_stock_identifiers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  item_id               uuid not null,
  kind                  text not null check (kind in ('manufacturer_code', 'supplier_sku', 'barcode')),
  value                 text not null check (char_length(value) between 2 and 48),
  -- exact comparison key: uppercased, whitespace removed, punctuation KEPT (barcodes: 14-digit GTIN)
  value_key             text not null check (char_length(value_key) between 2 and 48),
  -- where the value is unique: the brand (maker codes), the supplier (SKUs), '' (barcodes)
  scope                 text not null default '',
  -- a confirmed pack conversion for this identifier (e.g. the BOX barcode = 10 each)
  pack_unit             text check (pack_unit is null or pack_unit in ('box', 'pack', 'bag', 'roll', 'length', 'carton', 'coil', 'reel')),
  pack_size_milli       bigint check (pack_size_milli is null or pack_size_milli > 0),
  retired_at            timestamptz,
  created_by_legacy_id  text not null,
  created_by_name       text,
  created_at            timestamptz not null default now(),
  foreign key (tenant_id, item_id) references public.workshop_stock_items (tenant_id, id),
  check ((pack_unit is null) = (pack_size_milli is null))
);

-- one live owner per code/barcode: the duplicate-item guard
create unique index workshop_stock_identifiers_live_uidx
  on public.workshop_stock_identifiers (tenant_id, kind, scope, value_key)
  where retired_at is null;

create index workshop_stock_identifiers_item_idx
  on public.workshop_stock_identifiers (tenant_id, item_id);

comment on table public.workshop_stock_identifiers is
  'Codes and barcodes a workshop item is recognised by. Manufacturer codes and supplier SKUs are separate kinds; value keeps the code exactly as printed. One live owner per (kind, scope, value_key).';

-- ── movements (the ledger) ───────────────────────────────────────────────────

create table public.workshop_stock_movements (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  item_id               uuid not null,
  kind                  text not null check (kind in ('opening', 'add', 'take', 'return', 'count', 'reversal')),
  -- signed change in thousandths of the item's base unit
  quantity_milli        bigint not null,
  -- stamped by the ledger trigger
  balance_after_milli   bigint not null default 0 check (balance_after_milli >= 0),
  item_version_after    integer not null default 0,
  counted_milli         bigint check (counted_milli is null or counted_milli >= 0),
  pack_count            integer check (pack_count is null or pack_count between 1 and 1000),
  pack_unit             text check (pack_unit is null or char_length(pack_unit) between 1 and 20),
  pack_size_milli       bigint check (pack_size_milli is null or pack_size_milli > 0),
  estimated             boolean not null default false,
  -- informational only: never a job cost (stock was costed when it was bought)
  job_legacy_id         text check (job_legacy_id is null or char_length(job_legacy_id) between 1 and 120),
  job_label             text check (job_label is null or char_length(job_label) between 1 and 160),
  reason                text check (reason is null or char_length(reason) between 1 and 200),
  note                  text check (note is null or char_length(note) between 1 and 200),
  reverses_movement_id  uuid,
  actor_legacy_id       text not null,
  actor_name            text,
  actor_role            text,
  idempotency_key       text not null check (char_length(idempotency_key) between 8 and 100),
  request_hash          text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references public.workshop_stock_items (tenant_id, id),
  foreign key (tenant_id, reverses_movement_id) references public.workshop_stock_movements (tenant_id, id),
  check ((kind = 'reversal') = (reverses_movement_id is not null)),
  check ((kind = 'count') = (counted_milli is not null)),
  check (kind <> 'take' or quantity_milli < 0),
  check (kind not in ('add', 'return') or quantity_milli > 0),
  check (kind <> 'opening' or quantity_milli >= 0),
  check ((pack_count is null) = (pack_size_milli is null))
);

create unique index workshop_stock_movements_idempotency_uidx
  on public.workshop_stock_movements (tenant_id, idempotency_key);

-- a movement can be reversed once
create unique index workshop_stock_movements_one_reversal_uidx
  on public.workshop_stock_movements (reverses_movement_id)
  where reverses_movement_id is not null;

-- one opening balance per item
create unique index workshop_stock_movements_one_opening_uidx
  on public.workshop_stock_movements (item_id)
  where kind = 'opening';

create index workshop_stock_movements_item_idx
  on public.workshop_stock_movements (tenant_id, item_id, created_at desc);

create index workshop_stock_movements_recent_idx
  on public.workshop_stock_movements (tenant_id, created_at desc);

comment on table public.workshop_stock_movements is
  'Workshop Stock ledger: append-only, server-timestamped, actor-stamped quantity movements. Never updated or deleted — a mistake is a compensating reversal. A job reference is informational and never a job cost.';

-- ── catalogue history ────────────────────────────────────────────────────────

create table public.workshop_stock_item_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  item_id          uuid not null,
  event            text not null check (event in ('created', 'updated', 'archived', 'restored', 'identifier_added', 'identifier_removed', 'photo_changed', 'verification_recorded')),
  detail           jsonb not null default '{}'::jsonb,
  actor_legacy_id  text not null,
  actor_name       text,
  actor_role       text,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, item_id) references public.workshop_stock_items (tenant_id, id)
);

create index workshop_stock_item_events_item_idx
  on public.workshop_stock_item_events (tenant_id, item_id, created_at desc);

comment on table public.workshop_stock_item_events is
  'Append-only history of catalogue changes to a workshop item (edits with before/after, archive, identifiers, photo, verification).';

-- ── lookup cache + usage ceiling ─────────────────────────────────────────────

create table public.workshop_stock_lookup_cache (
  tenant_id   uuid not null references public.tenants(id),
  brand_key   text not null default '',
  code_key    text not null check (char_length(code_key) between 2 and 48),
  status      text not null check (status in ('manufacturer_code_matched', 'possible_match', 'no_match')),
  result      jsonb not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (tenant_id, brand_key, code_key)
);

comment on table public.workshop_stock_lookup_cache is
  'Cached external product-code lookups (retrieved evidence summary only — never raw pages), so a repeat check does not search again.';

create table public.workshop_stock_usage (
  tenant_id  uuid not null references public.tenants(id),
  day        date not null,
  kind       text not null check (kind in ('photo_read', 'lookup')),
  count      integer not null default 0 check (count >= 0),
  primary key (tenant_id, day, kind)
);

comment on table public.workshop_stock_usage is
  'Daily per-tenant counters for paid AI calls (photo reads, online lookups): the cost ceiling the API enforces.';

-- ── ledger trigger: the balance moves with the movement, atomically ──────────

create or replace function public.tg_workshop_stock_movement_apply()
returns trigger language plpgsql as $$
declare
  it record;
  orig record;
  step bigint;
  next_balance bigint;
begin
  select id, base_unit, balance_milli, version, archived_at, estimated
    into it
    from public.workshop_stock_items
    where id = new.item_id and tenant_id = new.tenant_id
    for update;
  if not found then
    raise exception 'workshop stock item % not found', new.item_id using errcode = 'foreign_key_violation';
  end if;
  if it.archived_at is not null then
    raise exception 'workshop stock item % is archived', new.item_id using errcode = 'check_violation';
  end if;

  step := case it.base_unit when 'metre' then 100 else 1000 end;
  if new.quantity_milli % step <> 0
     or (new.counted_milli is not null and new.counted_milli % step <> 0)
     or (new.pack_size_milli is not null and new.pack_size_milli % step <> 0) then
    raise exception 'quantity does not fit the % unit', it.base_unit using errcode = 'check_violation';
  end if;
  if new.pack_count is not null and new.pack_count::bigint * new.pack_size_milli <> abs(new.quantity_milli) then
    raise exception 'pack conversion does not add up' using errcode = 'check_violation';
  end if;

  if new.kind = 'count' and new.quantity_milli <> new.counted_milli - it.balance_milli then
    raise exception 'count does not match the current balance — re-read and retry' using errcode = 'check_violation';
  end if;

  if new.kind = 'reversal' then
    select id, item_id, kind, quantity_milli, item_version_after
      into orig
      from public.workshop_stock_movements
      where id = new.reverses_movement_id and tenant_id = new.tenant_id;
    if not found or orig.item_id <> new.item_id then
      raise exception 'reversal must reverse a movement of the same item' using errcode = 'check_violation';
    end if;
    if orig.kind = 'reversal' then
      raise exception 'a reversal cannot itself be reversed' using errcode = 'check_violation';
    end if;
    if new.quantity_milli <> -orig.quantity_milli then
      raise exception 'reversal must exactly compensate the original movement' using errcode = 'check_violation';
    end if;
    -- A count re-bases the balance on what was physically on the shelf, so it has
    -- already absorbed every movement before it: undoing one of those would
    -- correct the same thing twice. (A count that was itself undone no longer
    -- stands, so it doesn't block.)
    if exists (
      select 1 from public.workshop_stock_movements c
       where c.tenant_id = new.tenant_id and c.item_id = new.item_id and c.kind = 'count'
         and c.item_version_after > orig.item_version_after
         and not exists (
           select 1 from public.workshop_stock_movements r
            where r.tenant_id = c.tenant_id and r.reverses_movement_id = c.id)
    ) then
      raise exception 'counted since: the count already corrected this movement' using errcode = 'check_violation';
    end if;
  end if;

  next_balance := it.balance_milli + new.quantity_milli;
  if next_balance < 0 then
    raise exception 'insufficient recorded stock' using errcode = 'check_violation';
  end if;

  new.created_at := now();
  new.balance_after_milli := next_balance;
  new.item_version_after := it.version + 1;

  perform set_config('workshop_stock.ledger_write', 'on', true);
  update public.workshop_stock_items set
    balance_milli = next_balance,
    version = it.version + 1,
    last_movement_at = new.created_at,
    estimated = case
      when new.kind in ('count', 'opening') then new.estimated
      when new.kind = 'reversal' then it.estimated
      else it.estimated or new.estimated
    end,
    last_counted_at = case when new.kind = 'count' or (new.kind = 'opening' and not new.estimated) then new.created_at else last_counted_at end,
    last_counted_by_legacy_id = case when new.kind = 'count' or (new.kind = 'opening' and not new.estimated) then new.actor_legacy_id else last_counted_by_legacy_id end,
    last_counted_by_name = case when new.kind = 'count' or (new.kind = 'opening' and not new.estimated) then new.actor_name else last_counted_by_name end
  where id = it.id;
  perform set_config('workshop_stock.ledger_write', 'off', true);
  return new;
end $$;

create trigger workshop_stock_movements_apply
  before insert on public.workshop_stock_movements
  for each row execute function public.tg_workshop_stock_movement_apply();

-- ── item guard: balances only through the ledger; unit frozen once used ──────

create or replace function public.tg_workshop_stock_item_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'workshop stock items are archived, never deleted';
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'workshop stock item identity is immutable';
  end if;
  if (new.balance_milli is distinct from old.balance_milli
      or new.version is distinct from old.version
      or new.last_movement_at is distinct from old.last_movement_at
      or new.last_counted_at is distinct from old.last_counted_at)
     and coalesce(current_setting('workshop_stock.ledger_write', true), 'off') <> 'on' then
    raise exception 'workshop stock balances change only through the movement ledger';
  end if;
  -- a zero opening balance means nothing in any unit; any real quantity does
  if new.base_unit is distinct from old.base_unit
     and exists (select 1 from public.workshop_stock_movements m
                 where m.tenant_id = old.tenant_id and m.item_id = old.id
                   and (m.quantity_milli <> 0 or coalesce(m.counted_milli, 0) <> 0)) then
    raise exception 'the unit of an item with movement history cannot change';
  end if;
  return new;
end $$;

create trigger workshop_stock_items_guard
  before update or delete on public.workshop_stock_items
  for each row execute function public.tg_workshop_stock_item_guard();

create trigger workshop_stock_items_touch
  before update on public.workshop_stock_items
  for each row execute function public.tg_touch_updated_at();

-- ── append-only guards ───────────────────────────────────────────────────────

create or replace function public.tg_workshop_stock_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only — record a reversal instead of changing history', tg_table_name;
end $$;

create trigger workshop_stock_movements_append_only
  before update or delete on public.workshop_stock_movements
  for each row execute function public.tg_workshop_stock_append_only();

create trigger workshop_stock_item_events_append_only
  before update or delete on public.workshop_stock_item_events
  for each row execute function public.tg_workshop_stock_append_only();

-- RLS on, NO policies — service-role-mediated only (house pattern).
alter table public.workshop_stock_photos enable row level security;
alter table public.workshop_stock_items enable row level security;
alter table public.workshop_stock_identifiers enable row level security;
alter table public.workshop_stock_movements enable row level security;
alter table public.workshop_stock_item_events enable row level security;
alter table public.workshop_stock_lookup_cache enable row level security;
alter table public.workshop_stock_usage enable row level security;
