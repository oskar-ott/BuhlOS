-- Supplier-invoice capture (invoice_capture flag, dark): supplier invoices
-- emailed to the office are forwarded to a BuhlOS inbound address, their PDF
-- attachments captured, the wholesaler's printed IV job reference matched
-- EXACTLY against jobs.json `code` (IV####), and — only after an office user
-- confirms — the ex-GST amount allocated to that job's supplier-invoice cost.
--
-- Concepts (one table each):
--   * supplier_invoices              the invoice record + extraction + match
--   * supplier_invoice_documents     the original PDF(s) — Blob bytes, PG metadata
--   * supplier_invoice_allocations   confirmed job-cost allocations (signed cents)
--   * supplier_invoice_attempts      processing attempts (extraction runs)
--   * supplier_invoice_events        per-invoice audit history (append-only)
--   * supplier_invoice_inbound_events  webhook receipts (replay guard + quarantine)
--
-- Rules the schema enforces:
--   * MONEY IS INTEGER CENTS (bigint); never floats.
--   * the supplier's invoice number (supplier_invoice_number) and the BuhlOS
--     IV job reference (iv_reference_raw / iv_reference_normalised) are
--     separate columns and never combined.
--   * one ACTIVE allocation per invoice (partial unique index) — a second
--     confirm cannot double-count; multi-job splits later = drop that index.
--   * webhook replay: one row per svix message id; one document per
--     (provider email id, provider attachment id).
--   * metadata Supabase-first (product-owner directive 2026-07-18); binaries
--     in Vercel Blob under invoices/<tenant>/<invoice>/; rows carry pathnames.
--   * RLS on, NO policies — service-role-mediated only (house pattern).
--   * tenant-scoped everywhere (single tenant today, slug 'buhl').
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.supplier_invoice_inbound_events;
--   drop table if exists public.supplier_invoice_events;
--   drop table if exists public.supplier_invoice_attempts;
--   drop table if exists public.supplier_invoice_allocations;
--   drop table if exists public.supplier_invoice_documents;
--   drop table if exists public.supplier_invoices;

create table public.supplier_invoices (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),

  -- supplier identity
  supplier_name             text,
  supplier_key              text,          -- conservative normalisation of supplier_name (lookup only)
  supplier_abn              text check (supplier_abn is null or supplier_abn ~ '^[0-9]{11}$'),

  -- the SUPPLIER's own document identity (NOT the IV job reference)
  supplier_invoice_number   text,
  document_type             text not null default 'unknown'
    check (document_type in ('invoice','tax_invoice','credit_note','statement','quote','unknown')),
  invoice_date              date,
  currency                  text not null default 'AUD' check (char_length(currency) = 3),

  -- money: integer cents, magnitudes (sign comes from document_type at allocation)
  subtotal_ex_gst_cents     bigint check (subtotal_ex_gst_cents is null or subtotal_ex_gst_cents >= 0),
  gst_cents                 bigint check (gst_cents is null or gst_cents >= 0),
  total_inc_gst_cents       bigint check (total_inc_gst_cents is null or total_inc_gst_cents >= 0),
  totals_consistent         boolean,       -- null = not enough figures to check

  -- the BuhlOS IV JOB REFERENCE printed by the wholesaler (NOT the invoice number)
  iv_reference_raw          text,
  iv_reference_normalised   text,
  iv_candidates             jsonb not null default '[]'::jsonb,  -- [{raw, normalised, label, source}]

  -- match
  matched_job_legacy_id     text,
  matched_job_id            uuid references public.jobs(id),
  match_status              text not null default 'none'
    check (match_status in ('none','exact','ambiguous','not_found','multi_reference','manual')),
  match_reason              jsonb,         -- {raw, normalised, label, source, field, matchCount, jobStatus, ...}

  -- processing
  status                    text not null default 'received'
    check (status in ('received','processing','matched','needs_review','confirmed','duplicate','excluded','failed','archived')),
  review_reasons            jsonb not null default '[]'::jsonb,  -- machine codes the reviewer sees
  failure_code              text,          -- stable code, never an exception message
  extraction_method         text,          -- 'pdf_text' | 'pdf_text+ai' | 'manual' | 'none'
  extraction_confidence     jsonb not null default '{}'::jsonb, -- per-field {value, confidence, provenance}
  extracted_text_excerpt    text,          -- bounded excerpt of the PDF text layer (review aid)
  attempt_count             integer not null default 0,
  next_attempt_at           timestamptz,

  -- duplicate linkage
  duplicate_of_id           uuid references public.supplier_invoices(id),
  duplicate_reason          text,          -- 'checksum' | 'supplier_invoice_number' | 'manual'

  -- source
  source                    text not null check (source in ('email','upload')),
  source_email_id           text,          -- Resend received-email id
  source_message_id         text,          -- RFC 5322 Message-ID (supporting evidence)
  source_subject            text,          -- bounded, sanitised (supporting evidence only)
  source_from               text,          -- NOT proof of legitimacy (forwarding rewrites it)

  -- people + times
  created_by_legacy_id      text,
  created_by_name           text,
  reviewed_at               timestamptz,
  reviewed_by_legacy_id     text,
  reviewed_by_name          text,
  confirmed_at              timestamptz,
  confirmed_by_legacy_id    text,
  confirmed_by_name         text,
  excluded_reason           text,
  archived_at               timestamptz,
  archived_by_legacy_id     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index supplier_invoices_tenant_status_idx
  on public.supplier_invoices (tenant_id, status, created_at desc);
create index supplier_invoices_job_idx
  on public.supplier_invoices (tenant_id, matched_job_legacy_id)
  where matched_job_legacy_id is not null;
create index supplier_invoices_supplier_number_idx
  on public.supplier_invoices (tenant_id, supplier_key, supplier_invoice_number)
  where supplier_key is not null and supplier_invoice_number is not null;
create index supplier_invoices_iv_idx
  on public.supplier_invoices (tenant_id, iv_reference_normalised)
  where iv_reference_normalised is not null;
create index supplier_invoices_pending_idx
  on public.supplier_invoices (tenant_id, next_attempt_at)
  where status in ('received','processing');

comment on table public.supplier_invoices is
  'Supplier-invoice capture (invoice_capture, dark). One row per captured supplier document. supplier_invoice_number = the supplier''s own number; iv_reference_* = the BuhlOS IV job reference printed by the wholesaler — never the same field. Money in integer cents. Metadata source of truth; PDFs in Vercel Blob.';

create table public.supplier_invoice_documents (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),
  invoice_id                uuid not null references public.supplier_invoices(id),
  source                    text not null check (source in ('email','upload')),
  provider_email_id         text,
  provider_attachment_id    text,
  original_filename         text not null,   -- sanitised, bounded
  content_type              text not null,
  byte_size                 integer not null check (byte_size >= 0),
  sha256                    text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  blob_pathname             text not null,
  blob_url                  text not null,   -- never sent to a client; served through the authed proxy
  page_count                integer,
  has_text_layer            boolean,
  uploaded_by_legacy_id     text,
  uploaded_by_name          text,
  created_at                timestamptz not null default now()
);

-- provider identity is the first replay guard: the same attachment of the same
-- received email can only ever land once.
create unique index supplier_invoice_documents_provider_uidx
  on public.supplier_invoice_documents (tenant_id, provider_email_id, provider_attachment_id)
  where provider_email_id is not null and provider_attachment_id is not null;
create index supplier_invoice_documents_sha_idx
  on public.supplier_invoice_documents (tenant_id, sha256);
create index supplier_invoice_documents_invoice_idx
  on public.supplier_invoice_documents (invoice_id);

comment on table public.supplier_invoice_documents is
  'Original supplier-invoice PDFs: bytes in Vercel Blob (invoices/<tenant>/<invoice>/), metadata + sha256 here. Never hard-deleted by the UI.';

create table public.supplier_invoice_allocations (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),
  invoice_id                uuid not null references public.supplier_invoices(id),
  job_legacy_id             text not null,
  job_id                    uuid references public.jobs(id),
  -- SIGNED cents: an invoice contributes +subtotal, a credit note -subtotal
  amount_ex_gst_cents       bigint not null,
  gst_cents                 bigint,
  total_inc_gst_cents       bigint,
  status                    text not null default 'active' check (status in ('active','reversed')),
  confirmed_by_legacy_id    text,
  confirmed_by_name         text,
  confirmed_at              timestamptz not null default now(),
  reversed_at               timestamptz,
  reversed_by_legacy_id     text,
  reversed_by_name          text,
  reversal_reason           text,
  created_at                timestamptz not null default now()
);

-- ONE active allocation per invoice: confirming twice cannot count twice.
-- (Future multi-job split: drop this index and add a per-invoice sum check.)
create unique index supplier_invoice_allocations_one_active_uidx
  on public.supplier_invoice_allocations (invoice_id)
  where status = 'active';
create index supplier_invoice_allocations_job_idx
  on public.supplier_invoice_allocations (tenant_id, job_legacy_id)
  where status = 'active';

comment on table public.supplier_invoice_allocations is
  'Confirmed supplier-invoice job-cost allocations. A job''s supplier-invoice cost = sum(amount_ex_gst_cents) over ACTIVE rows — never a cached number. Reversal keeps the row (status reversed) for audit.';

create table public.supplier_invoice_attempts (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),
  invoice_id                uuid not null references public.supplier_invoices(id),
  attempt_no                integer not null,
  trigger                   text not null,   -- 'upload' | 'webhook' | 'sweep' | 'retry' | 'inbox'
  started_at                timestamptz not null default now(),
  finished_at               timestamptz,
  outcome                   text,            -- 'ok' | 'failed' | 'timeout'
  failure_code              text,
  extraction_method         text
);
create index supplier_invoice_attempts_invoice_idx
  on public.supplier_invoice_attempts (invoice_id, attempt_no);

create table public.supplier_invoice_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id),
  invoice_id                uuid not null references public.supplier_invoices(id),
  event                     text not null,
  actor_legacy_id           text,
  actor_name                text,
  actor_role                text,
  detail                    jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now()
);
create index supplier_invoice_events_invoice_idx
  on public.supplier_invoice_events (invoice_id, created_at);

comment on table public.supplier_invoice_events is
  'Append-only per-invoice history (received, extracted, matched, corrected, confirmed, excluded, archived, reassigned, …). Never UPDATEd or DELETEd.';

create table public.supplier_invoice_inbound_events (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid references public.tenants(id),
  svix_message_id           text not null,
  provider_email_id         text,
  to_address_matched        boolean not null default false,
  from_address              text,
  subject                   text,
  attachment_count          integer not null default 0,
  status                    text not null
    check (status in ('received','quarantined','processed','ignored','failed')),
  failure_code              text,
  created_at                timestamptz not null default now(),
  processed_at              timestamptz
);
-- replay guard: the same webhook delivery is recorded once.
create unique index supplier_invoice_inbound_events_svix_uidx
  on public.supplier_invoice_inbound_events (svix_message_id);
create index supplier_invoice_inbound_events_email_idx
  on public.supplier_invoice_inbound_events (provider_email_id);

comment on table public.supplier_invoice_inbound_events is
  'Resend email.received webhook receipts. One row per svix message id (replay-safe). status quarantined = received while invoice_capture was OFF: nothing fetched, nothing lost — reprocessable once the flag is on.';

create trigger supplier_invoices_touch
  before update on public.supplier_invoices
  for each row execute function public.tg_touch_updated_at();

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_documents enable row level security;
alter table public.supplier_invoice_allocations enable row level security;
alter table public.supplier_invoice_attempts enable row level security;
alter table public.supplier_invoice_events enable row level security;
alter table public.supplier_invoice_inbound_events enable row level security;
