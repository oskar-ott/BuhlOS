-- Supplier-invoice capture: who was at the counter (owner, 2026-09-28: "there
-- is sometimes a name added to the invoice for who was at the wholesaler").
--
--   purchaser_name        the name as printed ("Ordered by: DYLAN S")
--   purchaser_user_id     the employee it unambiguously matches (legacy id)
--   purchaser_worker_name that employee's full name at read time
--
-- Additive. Down path (documented, not executed): drop the three columns.

alter table public.supplier_invoices
  add column purchaser_name        text,
  add column purchaser_user_id     text,
  add column purchaser_worker_name text;

comment on column public.supplier_invoices.purchaser_name is
  'The person the wholesaler printed as ordering / collecting (as printed). Matched to an employee only when unambiguous; used as placement evidence via that worker''s timesheet when no IV number is printed.';
