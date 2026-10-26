-- Workshop Stock — a photo of WHERE an item lives (owner pull 2026-10-26:
-- "when someone adds an item i want an option to take a photo for the location
-- if it isnt in a general place and when someone wants to check it out they
-- look at the photo to help find it"). docs/workshop-stock.md.
--
-- One nullable column on the item, pointing at a row in the existing photo
-- table (same storage, same authenticated proxy, same tenant-scoped composite
-- key as the product photo). A location photo is claimed exactly like the
-- product photo — pending → 'item' — so the expiry clean-up (which only ever
-- touches pending/retired rows) never removes one an item still points at; a
-- replaced or removed one is retired and expires a day later. Its changes are
-- written to the item's history as the existing 'photo_changed' event with
-- detail.slot = 'location' (the events table's check list is unchanged).
--
-- Deploy order is free: the app reads the column through to_jsonb(i), which is
-- null while the column doesn't exist, and only offers / writes the location
-- photo once it sees the column (store.hasLocationPhoto). Apply this, and the
-- option appears on the phone and in the office within a minute.
--
-- Additive only. Down path (documented, not executed):
--   alter table public.workshop_stock_items drop constraint if exists workshop_stock_items_location_photo_fk;
--   alter table public.workshop_stock_items drop column if exists location_photo_id;

alter table public.workshop_stock_items
  add column if not exists location_photo_id uuid;

-- guarded so the file can be applied twice without failing
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workshop_stock_items_location_photo_fk'
      and conrelid = 'public.workshop_stock_items'::regclass
  ) then
    alter table public.workshop_stock_items
      add constraint workshop_stock_items_location_photo_fk
      foreign key (tenant_id, location_photo_id) references public.workshop_stock_photos (tenant_id, id);
  end if;
end $$;

comment on column public.workshop_stock_items.location_photo_id is
  'Optional photo of where the item lives (a hard-to-find spot), shown to whoever comes to take it. Same photo table and proxy as photo_id; claimed pending → item.';
