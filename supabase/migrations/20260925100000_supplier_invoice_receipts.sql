-- Receipt capture from the field (owner pull 2026-09-25): a worker who pays by
-- card at Bunnings or a trade counter photographs the receipt on the phone,
-- picks the job, and the photo is read (OCR) into the same supplier-invoice
-- pipeline — so it lands in the office inbox, the job's Materials breakdown
-- and the Money card like any invoice.
--
--   * supplier_invoices.source gains 'receipt'
--   * paid_personally — the worker paid with their own money (the office
--     reimburses through payroll; BuhlOS does not pay anyone)
--   * worker_note     — an optional one-liner from the worker
--
-- Additive. Down path (documented, not executed): restore the source check
-- after `update … set source = 'upload' where source = 'receipt'`, then drop
-- the two columns.

alter table public.supplier_invoices
  drop constraint supplier_invoices_source_check;
alter table public.supplier_invoices
  add constraint supplier_invoices_source_check
  check (source in ('email','upload','receipt'));

alter table public.supplier_invoices
  add column paid_personally boolean not null default false,
  add column worker_note     text;

comment on column public.supplier_invoices.paid_personally is
  'Receipt paid with the worker''s own money — the office reimburses through payroll; BuhlOS records it, never pays it.';
