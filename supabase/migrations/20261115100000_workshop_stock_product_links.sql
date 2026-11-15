-- Workshop Stock — product links on an item (owner pull 2026-11-15: "a product
-- link when viewing items that have been added — basically a link to the
-- product page in an online wholesaler and if available the product spec on
-- the manufacturer's page"). docs/workshop-stock.md → "Product links".
--
-- Two nullable text columns on the item:
--   product_url  the item's page at an online wholesaler
--   spec_url     the maker's own product / spec page, when there is one
-- Filled from the server's own online check when a worker accepts it (or the
-- office records it) — never over a link a person set — and typed or cleared
-- by the office. The API only ever stores http(s) links (links.js).
--
-- Deploy order is free: the app reads the columns through to_jsonb(i), which
-- is null while they don't exist, and only offers / writes the links once it
-- sees both (store.hasLinks). Apply this, and the links appear within a minute.
--
-- Additive only. Down path (documented, not executed):
--   alter table public.workshop_stock_items drop column if exists spec_url;
--   alter table public.workshop_stock_items drop column if exists product_url;

alter table public.workshop_stock_items
  add column if not exists product_url text,
  add column if not exists spec_url text;

-- guarded so the file can be applied twice without failing
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workshop_stock_items_links_len'
      and conrelid = 'public.workshop_stock_items'::regclass
  ) then
    alter table public.workshop_stock_items
      add constraint workshop_stock_items_links_len
      check ((product_url is null or length(product_url) <= 600) and (spec_url is null or length(spec_url) <= 600));
  end if;
end $$;

comment on column public.workshop_stock_items.product_url is
  'The item''s page at an online wholesaler (http/https). From an accepted online check, or set by the office.';
comment on column public.workshop_stock_items.spec_url is
  'The maker''s own product / spec page (http/https), when there is one. From an accepted online check, or set by the office.';
