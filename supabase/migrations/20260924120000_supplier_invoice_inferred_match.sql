-- Supplier-invoice capture: evidence placement (owner direction 2026-09-24).
-- A document with NO IV reference may be placed against a job from evidence it
-- does print — delivery address, job name, job ref — with match_status
-- 'inferred' and the evidence stored in match_reason. Additive: one more
-- status value. Down path (documented, not executed): restore the previous
-- check after `update … set match_status = 'none' where match_status = 'inferred'`.

alter table public.supplier_invoices
  drop constraint supplier_invoices_match_status_check;
alter table public.supplier_invoices
  add constraint supplier_invoices_match_status_check
  check (match_status in ('none','exact','ambiguous','not_found','multi_reference','manual','inferred'));
