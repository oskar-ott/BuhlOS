-- Supplier-invoice capture: automatic booking of CLEAN invoices after a grace
-- window (owner decision 2026-09-22, docs/invoice-capture.md "Auto-booking").
--
-- A matched invoice that passes every deterministic check (labelled IV
-- reference, one active job, all three figures printed and reconciled,
-- supplier previously human-confirmed, under the cap, not a duplicate, not
-- touched by a person) is marked eligible with an auto_confirm_at time; the
-- sweep books it once that time passes unless someone has put it on hold.
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.supplier_invoice_supplier_prefs;
--   alter table public.supplier_invoices
--     drop column auto_confirm_eligible, drop column auto_confirm_at,
--     drop column auto_confirm_checks, drop column held_at, drop column held_by_name;

alter table public.supplier_invoices
  add column auto_confirm_eligible  boolean not null default false,
  add column auto_confirm_at        timestamptz,
  add column auto_confirm_checks    jsonb not null default '[]'::jsonb,
  add column held_at                timestamptz,
  add column held_by_name           text;

create index supplier_invoices_auto_confirm_due_idx
  on public.supplier_invoices (tenant_id, auto_confirm_at)
  where auto_confirm_eligible and status = 'matched' and held_at is null;

comment on column public.supplier_invoices.auto_confirm_at is
  'When the sweep may book this invoice automatically (null = never). Cleared by any human edit, hold, or status change.';

-- Per-supplier office preference: "always review this supplier" (revocable
-- trust for a wholesaler whose layout the reader keeps misreading).
create table public.supplier_invoice_supplier_prefs (
  tenant_id       uuid not null references public.tenants(id),
  supplier_key    text not null,
  always_review   boolean not null default false,
  set_by_name     text,
  set_at          timestamptz not null default now(),
  primary key (tenant_id, supplier_key)
);

comment on table public.supplier_invoice_supplier_prefs is
  'Office preferences per supplier key: always_review = never auto-book this supplier''s invoices.';

alter table public.supplier_invoice_supplier_prefs enable row level security;
