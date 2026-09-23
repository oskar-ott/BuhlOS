-- Supplier-invoice capture: stray replies to the app's own sender addresses
-- (timesheets@, office@, pay@, onboarding@ on the inbound domain) used to be
-- recorded `ignored` and lost, because Resend receiving takes ALL mail for the
-- domain. The webhook now forwards them to the accounts recipient list and
-- records the receipt as `forwarded` (owner direction 2026-09-23,
-- docs/invoice-capture.md "Stray replies"). Additive: one more status value.
--
-- Down path (documented, not executed): restore the previous check after
-- `update … set status = 'ignored' where status = 'forwarded'`.

alter table public.supplier_invoice_inbound_events
  drop constraint supplier_invoice_inbound_events_status_check;
alter table public.supplier_invoice_inbound_events
  add constraint supplier_invoice_inbound_events_status_check
  check (status in ('received','quarantined','processed','ignored','failed','forwarded'));
