-- Customer invoices, part 3 (customer_invoices flag, dark): an invoice that is
-- NOT tied to a job. Issue #1166. docs/customer-invoices.md → "An invoice
-- with no job". The boundary is unchanged: BuhlOS drafts, Xero owns the
-- invoice (docs/architecture/customer-invoicing-boundary-adr.md, rule 18).
--
-- Some money comes in monthly against a builder's payment schedule, not job
-- by job. The office raises one invoice for it. That invoice is an ordinary
-- itemised invoice kept in a reserved ledger: `job_legacy_id = '~no-job'`
-- (a job id is a slug of lower-case letters, digits and hyphens, so `~` can
-- never appear in a real one). No new table, no new kind.
--
-- What changes:
--   * customer_invoices   three columns holding the client chosen ON the
--                         invoice. A job's invoices keep using the job's
--                         linked client and leave these null.
--
-- Rules the schema enforces:
--   * the client columns are set together or not at all;
--   * they exist only on a no-job invoice;
--   * a no-job invoice is always itemised (there is no contract to take a
--     percentage of, and nothing to release retention from).
--
-- Numbering needs no change: a sent invoice's `seq` is already unique per
-- (tenant, job_legacy_id), so the ledger numbers 1, 2, 3 … on its own, and
-- `invoice_number` (GEN-0001 …) is already unique per tenant.
--
-- Additive only. Down path (documented, not executed):
--   alter table public.customer_invoices drop constraint customer_invoices_no_job_kind_check;
--   alter table public.customer_invoices drop constraint customer_invoices_client_scope_check;
--   alter table public.customer_invoices drop constraint customer_invoices_client_whole_check;
--   alter table public.customer_invoices drop column client_external_tenant_id;
--   alter table public.customer_invoices drop column client_contact_name;
--   alter table public.customer_invoices drop column client_contact_id;

alter table public.customer_invoices
  add column client_contact_id         text check (client_contact_id is null or char_length(client_contact_id) between 1 and 100),
  add column client_contact_name       text check (client_contact_name is null or char_length(client_contact_name) between 1 and 500),
  add column client_external_tenant_id text check (client_external_tenant_id is null or char_length(client_external_tenant_id) between 1 and 100);

alter table public.customer_invoices
  add constraint customer_invoices_client_whole_check
  check (
    (client_contact_id is null and client_contact_name is null and client_external_tenant_id is null)
    or (client_contact_id is not null and client_contact_name is not null and client_external_tenant_id is not null)
  );

alter table public.customer_invoices
  add constraint customer_invoices_client_scope_check
  check (client_contact_id is null or job_legacy_id = '~no-job');

alter table public.customer_invoices
  add constraint customer_invoices_no_job_kind_check
  check (job_legacy_id <> '~no-job' or kind = 'itemised');

comment on column public.customer_invoices.client_contact_id is
  '#1166: the Xero contact chosen ON a no-job invoice (job_legacy_id = ''~no-job''). Null on a job''s invoices, which use the job''s linked client.';
comment on column public.customer_invoices.client_contact_name is
  '#1166: Xero''s own name for client_contact_id, re-read from Xero when the client was chosen (never a name the browser sent).';
comment on column public.customer_invoices.client_external_tenant_id is
  '#1166: the Xero organisation client_contact_id belongs to. An invoice whose client was chosen in another organisation is not sent until the client is chosen again.';
