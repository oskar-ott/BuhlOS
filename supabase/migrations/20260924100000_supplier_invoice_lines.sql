-- Supplier-invoice capture: LINE ITEMS + material categories (owner pull
-- 2026-09-24: "see all the materials used on a job and a breakdown — cable,
-- fixings, lights…; when an invoice comes in a lot of detail is pulled").
--
--   * supplier_invoice_lines   — one row per printed line: qty, unit, unit
--                                price, line total (integer cents, ex GST as
--                                printed), the description, and a category
--                                from a fixed taxonomy (api/_lib/invoices/
--                                categories.js) with its source
--   * supplier_line_categories — the office's re-filing decisions, remembered
--                                per supplier + description so the next
--                                invoice files itself ('learned')
--   * supplier_invoices gains lines_total_cents / lines_consistent so the
--                                review screen can say whether the lines add
--                                up to the printed subtotal
--
-- Additive only. Down path (documented, not executed):
--   drop table public.supplier_line_categories; drop table public.supplier_invoice_lines;
--   alter table public.supplier_invoices drop column lines_total_cents, drop column lines_consistent;

create table public.supplier_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  invoice_id          uuid not null references public.supplier_invoices(id) on delete cascade,
  line_no             integer not null,
  description         text not null,
  description_key     text not null,
  quantity            numeric(12,3),
  unit                text,
  unit_price_cents    bigint,
  line_total_cents    bigint,
  category            text not null default 'other'
    check (category in ('cable','conduit','fixings','switchgear','boards','lighting','accessories','data','consumables','tools','testing','freight','other')),
  category_source     text not null default 'rule' check (category_source in ('rule','learned','ai','manual')),
  confidence          text not null default 'medium' check (confidence in ('high','medium','low')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (invoice_id, line_no)
);
create index supplier_invoice_lines_invoice_idx on public.supplier_invoice_lines (tenant_id, invoice_id);
create trigger supplier_invoice_lines_touch
  before update on public.supplier_invoice_lines
  for each row execute function public.tg_touch_updated_at();
comment on table public.supplier_invoice_lines is
  'Line items read from a supplier invoice (integer cents as printed, normally ex GST). Category = material bucket; category_source says who decided (rule / learned / ai / manual). A job''s materials breakdown = these rows joined through ACTIVE allocations.';

create table public.supplier_line_categories (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  supplier_key        text not null default '',
  description_key     text not null,
  category            text not null
    check (category in ('cable','conduit','fixings','switchgear','boards','lighting','accessories','data','consumables','tools','testing','freight','other')),
  set_by_legacy_id    text,
  set_by_name         text,
  set_at              timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, supplier_key, description_key)
);
create trigger supplier_line_categories_touch
  before update on public.supplier_line_categories
  for each row execute function public.tg_touch_updated_at();
comment on table public.supplier_line_categories is
  'Remembered category decisions: the office re-files a line once and the same product from the same supplier files itself next time (supplier_key '''' = any supplier).';

alter table public.supplier_invoices
  add column lines_total_cents  bigint,
  add column lines_consistent   boolean;

alter table public.supplier_invoice_lines enable row level security;
alter table public.supplier_line_categories enable row level security;
