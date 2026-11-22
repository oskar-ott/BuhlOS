-- Customer stage invoices (#1151): remember that a sent stage has been RAISED
-- AGAIN.
--
-- When Xero shows a sent stage's invoice as DELETED or VOIDED, the office can
-- raise the stage again under the next number. Numbers are never reused, and
-- the dead invoice stays on the job as history
-- (docs/architecture/customer-invoicing-boundary-adr.md rule 7) — so the old
-- row must stay visible, and must not offer "Raise again" a second time.
-- `replaced_by_id` is that marker: it points at the new stage.
--
-- (A stage whose number turned out to be TAKEN in Xero before anything was
-- created — #1150 — is different: it is cancelled and drops off the list,
-- because no invoice of ours ever existed under it.)
--
-- Additive only. Down path (documented, not executed):
--   alter table public.customer_invoices drop column if exists replaced_by_id;

alter table public.customer_invoices
  add column replaced_by_id uuid references public.customer_invoices(id) on delete set null;

comment on column public.customer_invoices.replaced_by_id is
  '#1151: set when this SENT stage (deleted or voided in Xero) was raised again — points at the new planned stage. The old row stays as history and can''t be raised a second time.';
