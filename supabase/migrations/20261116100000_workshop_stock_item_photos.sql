-- Workshop Stock — more photos of an item (owner pull 2026-11-16: "i want to be
-- able to add multiple photos of items"). docs/workshop-stock.md → "More photos
-- of an item".
--
-- The item's main photo stays where it is (workshop_stock_items.photo_id — the
-- catalogue card, the list thumbnail, the photo matching reads against). This
-- table holds the OTHER photos of the item, in order: the back of the box, the
-- terminals, the rating plate. Each points at a row in the existing photo table
-- (same storage, same authenticated proxy, same tenant-scoped composite keys),
-- claimed pending → 'item' exactly like the main photo — so the expiry clean-up
-- (which only ever touches pending/retired rows) never removes one an item
-- still shows. A removed photo is retired and expires a day later. Changes are
-- written to the item's history as the existing 'photo_changed' event with
-- detail.slot = 'gallery' (the events table's check list is unchanged).
--
-- A photo is on an item once at most, and never both its main photo and one of
-- these (the store keeps that: "make main" swaps the two in one transaction).
--
-- Deploy order is free: the store only reads or writes this table once it sees
-- it (store.hasItemPhotos); before that every item simply has no more photos.
-- RLS on, no policies (service-role only — the house pattern).
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.workshop_stock_item_photos;

create table if not exists public.workshop_stock_item_photos (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  item_id             uuid not null,
  photo_id            uuid not null,
  position            integer not null default 0 check (position >= 0),
  added_by_legacy_id  text not null,
  added_by_name       text,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, item_id, photo_id),
  foreign key (tenant_id, item_id) references public.workshop_stock_items (tenant_id, id),
  foreign key (tenant_id, photo_id) references public.workshop_stock_photos (tenant_id, id)
);

create index if not exists workshop_stock_item_photos_item_idx
  on public.workshop_stock_item_photos (tenant_id, item_id, position);

create index if not exists workshop_stock_item_photos_photo_idx
  on public.workshop_stock_item_photos (tenant_id, photo_id);

alter table public.workshop_stock_item_photos enable row level security;

comment on table public.workshop_stock_item_photos is
  'Workshop Stock: an item''s photos beyond its main one (items.photo_id), in order. Photos claimed pending → item; removed ones are retired and expire.';
