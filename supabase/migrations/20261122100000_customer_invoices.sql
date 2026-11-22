-- Customer stage invoices (customer_invoices flag, dark): a job's payment
-- stages are listed in BuhlOS, each one is sent to Xero as a DRAFT sales
-- invoice, and Xero's own status and amounts are mirrored back onto the row.
-- Governing record: docs/architecture/customer-invoicing-boundary-adr.md
-- ("BuhlOS drafts, Xero owns the invoice"). Issues #1148 (stages), #1149
-- (client link + defaults), #1150 (send), #1151 (paid status).
--
-- NOT supplier invoices (20260915100000_supplier_invoices.sql) — those are
-- bills coming IN. These are invoices going OUT to the job's client.
--
-- Concepts (one table each):
--   * customer_invoice_settings      org-level defaults per Xero organisation
--                                    (sales account, tax rate, payment terms)
--   * customer_invoice_job_profiles  per-job: linked Xero contact, retention %
--   * customer_invoices              one row per stage invoice + its Xero mirror
--   * customer_invoice_attempts      one IMMUTABLE row per send attempt
--   * customer_invoice_events        append-only per-invoice history
--
-- Rules the schema enforces:
--   * MONEY IS INTEGER CENTS (bigint); never floats. Percentages are basis
--     points (int; 500 = 5%).
--   * jobs are keyed by job_legacy_id (the jobs.json id) — the house bridge.
--   * a stage has no number until it is sent: seq + invoice_number are null
--     while planned, then unique per job / per tenant. Numbers are never reused.
--   * attempts refuse UPDATE (trigger). Events are never updated by the app.
--   * events carry NO foreign key to attempts: the `pending` event is written
--     BEFORE the attempt row exists (payroll lesson, 20260719020000).
--   * RLS on, NO policies — service-role-mediated only (house pattern).
--   * tenant-scoped everywhere (single tenant today, slug 'buhl').
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.customer_invoice_events;
--   drop table if exists public.customer_invoice_attempts;
--   drop table if exists public.customer_invoices;
--   drop table if exists public.customer_invoice_job_profiles;
--   drop table if exists public.customer_invoice_settings;
--   drop function if exists public.tg_customer_invoice_attempt_immutable();

-- ── org-level defaults ──────────────────────────────────────────────────────
create table public.customer_invoice_settings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  -- the Xero organisation these defaults were chosen FROM (its chart of
  -- accounts); a different organisation gets its own row.
  external_tenant_id   text not null,

  sales_account_code   text,
  sales_account_name   text,
  tax_type             text,
  tax_name             text,
  tax_rate_bp          integer check (tax_rate_bp is null or (tax_rate_bp >= 0 and tax_rate_bp <= 10000)),
  payment_terms_days   integer check (payment_terms_days is null or (payment_terms_days >= 0 and payment_terms_days <= 365)),

  version              integer not null default 1,
  updated_by_legacy_id text,
  updated_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, external_tenant_id)
);

comment on table public.customer_invoice_settings is
  '#1149: default sales account, tax rate and payment terms for customer stage invoices, one row per (tenant, Xero organisation). Names and the rate are SNAPSHOTS taken when a person picked them from Xero''s own lists; Xero stays the source.';

-- ── per-job profile ─────────────────────────────────────────────────────────
create table public.customer_invoice_job_profiles (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id),
  job_legacy_id        text not null,

  -- the client's Xero contact, linked by a person (never guessed at send time)
  xero_contact_id      text,
  xero_contact_name    text,
  external_tenant_id   text,           -- the Xero organisation the contact belongs to

  -- retention held back from each stage, basis points (0 = none)
  retention_bp         integer not null default 0 check (retention_bp >= 0 and retention_bp <= 10000),

  version              integer not null default 1,
  updated_by_legacy_id text,
  updated_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, job_legacy_id)
);

comment on table public.customer_invoice_job_profiles is
  '#1148/#1149: per-job invoicing profile — the linked Xero contact (id + name snapshot + organisation) and the retention % held from each stage.';

-- ── the stage invoice ───────────────────────────────────────────────────────
create table public.customer_invoices (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id),
  job_legacy_id               text not null,

  kind                        text not null default 'stage'
    check (kind in ('stage','retention_release')),
  sort_order                  integer not null default 0,

  -- assigned at SEND, never before, never reused
  seq                         integer check (seq is null or seq >= 1),
  invoice_number              text,

  -- content (BuhlOS-owned while planned; frozen once sent)
  title                       text not null check (char_length(title) between 1 and 200),
  basis                       text not null default 'amount' check (basis in ('amount','percent')),
  percent_bp                  integer check (percent_bp is null or (percent_bp > 0 and percent_bp <= 10000)),
  -- the stage's own amount when basis = 'amount' (ex GST)
  amount_cents                bigint check (amount_cents is null or amount_cents >= 0),
  -- extra lines, e.g. an approved variation: [{ "description": text, "amountCents": int }]
  extra_lines                 jsonb not null default '[]'::jsonb,
  -- per-stage retention override; null = use the job profile's
  retention_bp                integer check (retention_bp is null or (retention_bp >= 0 and retention_bp <= 10000)),
  planned_date                date,
  note                        text check (note is null or char_length(note) <= 1000),

  -- SNAPSHOT taken at send: what was actually put on the invoice (ex GST)
  gross_cents                 bigint check (gross_cents is null or gross_cents >= 0),
  retention_cents             bigint check (retention_cents is null or retention_cents >= 0),
  net_cents                   bigint,
  invoice_date                date,
  due_date                    date,
  reference                   text check (reference is null or char_length(reference) <= 255),
  content_hash                text,

  state                       text not null default 'planned'
    check (state in ('planned','sending','sent','failed','cancelled')),
  failure_category            text,
  failure_detail              text,

  -- the Xero mirror (Xero's figures win for anything sent)
  external_tenant_id          text,
  xero_contact_id             text,
  xero_contact_name           text,
  xero_invoice_id             text,
  xero_status                 text
    check (xero_status is null or xero_status in ('DRAFT','SUBMITTED','AUTHORISED','PAID','VOIDED','DELETED')),
  xero_subtotal_cents         bigint,
  xero_tax_cents              bigint,
  xero_total_cents            bigint,
  xero_amount_due_cents       bigint,
  xero_amount_paid_cents      bigint,
  xero_amount_credited_cents  bigint,
  xero_due_date               date,
  xero_fully_paid_on          date,
  xero_updated_at             timestamptz,
  last_checked_at             timestamptz,
  -- non-null when Xero's invoice no longer matches what BuhlOS sent
  drift                       jsonb,

  version                     integer not null default 1,
  created_by_legacy_id        text,
  created_by_name             text,
  sent_by_legacy_id           text,
  sent_by_name                text,
  sent_at                     timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  unique (tenant_id, id),

  -- a percent stage carries a percentage, an amount stage carries an amount
  check ((basis = 'percent' and percent_bp is not null) or (basis = 'amount' and amount_cents is not null)),
  -- a number exists exactly when a sequence does
  check ((seq is null) = (invoice_number is null)),
  -- planned / cancelled-before-send rows have no number; a sent row always has one
  check (state <> 'sent' or (seq is not null and xero_invoice_id is not null))
);

create index customer_invoices_job_idx
  on public.customer_invoices (tenant_id, job_legacy_id, sort_order, created_at);
-- one number per job, one invoice number per tenant — the DB-level never-twice.
create unique index customer_invoices_job_seq_uidx
  on public.customer_invoices (tenant_id, job_legacy_id, seq) where seq is not null;
create unique index customer_invoices_number_uidx
  on public.customer_invoices (tenant_id, invoice_number) where invoice_number is not null;
create unique index customer_invoices_xero_id_uidx
  on public.customer_invoices (tenant_id, external_tenant_id, xero_invoice_id) where xero_invoice_id is not null;
-- the status check walks open sent invoices
create index customer_invoices_open_idx
  on public.customer_invoices (tenant_id, external_tenant_id, last_checked_at)
  where state = 'sent' and xero_invoice_id is not null;

comment on table public.customer_invoices is
  '#1148/#1150/#1151: one row per customer stage invoice. Content is BuhlOS-owned while state = planned and frozen once sent; the xero_* columns mirror Xero''s own status and amounts (Xero owns the invoice). seq + invoice_number are assigned at send and never reused.';

-- ── send attempts (immutable) ───────────────────────────────────────────────
create table public.customer_invoice_attempts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id),
  invoice_id          uuid not null references public.customer_invoices(id) on delete cascade,
  external_tenant_id  text not null,
  invoice_number      text not null,
  content_hash        text not null,
  request_hash        text,
  idempotency_key     text,
  xero_invoice_id     text,
  correlation_id      text,
  http_status         integer,
  outcome             text not null
    check (outcome in ('accepted','adopted','rejected','error','blocked')),
  error_category      text,
  error_detail        text,
  actor_legacy_id     text,
  actor_name          text,
  created_at          timestamptz not null default now(),

  unique (tenant_id, id)
);

create index customer_invoice_attempts_invoice_idx
  on public.customer_invoice_attempts (invoice_id, created_at desc);

comment on table public.customer_invoice_attempts is
  '#1150: one IMMUTABLE row per attempt to create a draft invoice in Xero (hashes, idempotency key, Xero InvoiceID / correlation id, outcome). adopted = the invoice was found in Xero by number after an unknown outcome and taken over without a second create.';

create or replace function public.tg_customer_invoice_attempt_immutable()
returns trigger language plpgsql
set search_path = public
as $$
begin
  raise exception 'customer invoice attempts are immutable (attempt %) — record a new attempt or event instead', old.id;
end $$;

create trigger customer_invoice_attempts_immutable
  before update on public.customer_invoice_attempts
  for each row execute function public.tg_customer_invoice_attempt_immutable();

-- ── per-invoice history (append-only) ───────────────────────────────────────
create table public.customer_invoice_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id),
  -- null for job-level events (profile / settings changes)
  invoice_id       uuid references public.customer_invoices(id) on delete cascade,
  job_legacy_id    text,
  -- NO foreign key: `pending` is written before the attempt row exists.
  attempt_id       uuid,
  event            text not null check (event in (
                     'created','edited','removed','cancelled',
                     'profile_updated','settings_updated',
                     'pending',                -- about to call Xero
                     'accepted_by_xero',       -- Xero returned an InvoiceID
                     'adopted',                -- found in Xero by number, taken over
                     'rejected',               -- Xero refused / transport error
                     'retry_required',         -- transient failure
                     'verified_against_xero',  -- read-back matched what was sent
                     'drifted',                -- read-back / later check did NOT match
                     'status_changed',         -- Xero status or amounts moved
                     'raised_again'            -- a new stage was made from this one
                   )),
  detail           jsonb,
  actor_legacy_id  text,
  actor_name       text,
  created_at       timestamptz not null default now(),

  unique (tenant_id, id)
);

create index customer_invoice_events_invoice_idx
  on public.customer_invoice_events (invoice_id, created_at);
create index customer_invoice_events_job_idx
  on public.customer_invoice_events (tenant_id, job_legacy_id, created_at desc);

comment on table public.customer_invoice_events is
  '#1148/#1150/#1151: append-only history per stage invoice (and per job for profile changes). accepted_by_xero and verified_against_xero are distinct — a create that returned 200 is not yet a matched read-back.';

create trigger customer_invoice_settings_touch
  before update on public.customer_invoice_settings
  for each row execute function public.tg_touch_updated_at();
create trigger customer_invoice_job_profiles_touch
  before update on public.customer_invoice_job_profiles
  for each row execute function public.tg_touch_updated_at();
create trigger customer_invoices_touch
  before update on public.customer_invoices
  for each row execute function public.tg_touch_updated_at();

-- RLS on, NO policies — money records, service-role-mediated only.
alter table public.customer_invoice_settings enable row level security;
alter table public.customer_invoice_job_profiles enable row level security;
alter table public.customer_invoices enable row level security;
alter table public.customer_invoice_attempts enable row level security;
alter table public.customer_invoice_events enable row level security;
