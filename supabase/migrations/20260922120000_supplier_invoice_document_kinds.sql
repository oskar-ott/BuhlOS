-- Supplier-invoice capture: inbound coverage (owner direction 2026-09-22,
-- docs/invoice-capture.md "What arrives that is not a PDF invoice").
--
--   * more document types: delivery dockets, order confirmations, remittance
--     advices, purchase orders and other non-invoice paperwork are recognised
--     and set aside automatically (status excluded, excluded_reason
--     not_an_invoice:<type>) instead of clogging the review queue
--   * documents may be images (a photo of a docket) as well as PDFs — `kind`
--     tells the review screen how to show them
--   * an email with no usable attachment (a "view your invoice" link, an
--     Outlook forward-as-attachment .eml, a zip) becomes a review item that
--     carries the links and an excerpt of the email text, so nothing is
--     silently dropped
--
-- Additive only. Down path (documented, not executed):
--   alter table public.supplier_invoices drop column source_links, drop column source_text_excerpt;
--   alter table public.supplier_invoice_documents drop column kind;
--   (and restore the previous document_type check)

alter table public.supplier_invoices
  drop constraint supplier_invoices_document_type_check;
alter table public.supplier_invoices
  add constraint supplier_invoices_document_type_check
  check (document_type in ('invoice','tax_invoice','credit_note','statement','quote',
                           'delivery_docket','order_confirmation','remittance','purchase_order','other','unknown'));

alter table public.supplier_invoices
  add column source_links         jsonb not null default '[]'::jsonb,
  add column source_text_excerpt  text;

comment on column public.supplier_invoices.source_links is
  'https links found in an email that carried no usable attachment (bounded, for the reviewer to open) — supporting evidence only.';

alter table public.supplier_invoice_documents
  add column kind text not null default 'pdf'
    check (kind in ('pdf','image'));

comment on column public.supplier_invoice_documents.kind is
  'pdf = text extraction runs; image = a photo/scan, shown to the reviewer for manual entry.';
