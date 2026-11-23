-- Customer invoices, part 2 (customer_invoices flag, dark): itemised invoices
-- for small jobs, filling them from the job's own hours and materials, a
-- variations register, and optional payment-claim wording.
-- Plan: docs/product/job-invoicing-part-2-plan.md. Issues #1161 (itemised),
-- #1162 (from hours and materials), #1163 (variations), #1164 (payment claim).
-- The boundary is unchanged: BuhlOS drafts, Xero owns the invoice
-- (docs/architecture/customer-invoicing-boundary-adr.md).
--
-- What changes:
--   * customer_invoices            a third kind, `itemised`, whose lines live
--                                  in `items`; `sent_footer` keeps wording
--                                  added at send (frozen, so a retry is
--                                  identical)
--   * customer_invoice_job_profiles  the per-job payment-claim switch
--   * customer_invoice_prefs       the business's own invoicing habits: usual
--                                  materials markup, usual charges, how hours
--                                  are rounded. One row per tenant. NOT tied
--                                  to a Xero organisation (they are not Xero's)
--   * customer_invoice_variations  the variations register
--   * customer_invoice_events      accepts the new history events
--
-- `items` is a JSON array, one object per line:
--   { id, type: 'line'|'note', description,
--     quantityMilli, unit, unitCents,        -- a charge: quantity in
--                                            -- THOUSANDTHS, price in cents
--     source: 'manual'|'labour'|'material'|'variation',
--     costCents,                             -- what it cost the business
--     refs: [ … ] }                          -- what job data it bills
-- Cost and refs are BuhlOS's own and are never sent to Xero. What is "already
-- on an invoice" is READ from these refs, never kept as a separate flag, so
-- it cannot drift from the invoices themselves.
--
-- Rules the schema enforces:
--   * MONEY IS INTEGER CENTS; percentages are basis points.
--   * a variation number is unique per job and never reused (a removed
--     variation keeps its row, marked removed).
--   * an approved variation always has an approved amount.
--   * RLS on, NO policies — service-role-mediated only (house pattern).
--
-- Additive only. Down path (documented, not executed):
--   drop table if exists public.customer_invoice_variations;
--   drop table if exists public.customer_invoice_prefs;
--   alter table public.customer_invoice_job_profiles drop column if exists payment_claim;
--   alter table public.customer_invoices drop column if exists sent_footer;
--   alter table public.customer_invoices drop column if exists items;
--   (and put the two CHECK constraints back to their earlier lists)

-- ── the itemised invoice ────────────────────────────────────────────────────
alter table public.customer_invoices
  add column items jsonb not null default '[]'::jsonb,
  add column sent_footer text check (sent_footer is null or char_length(sent_footer) <= 2000);

alter table public.customer_invoices drop constraint customer_invoices_kind_check;
alter table public.customer_invoices
  add constraint customer_invoices_kind_check
  check (kind in ('stage','retention_release','itemised'));

comment on column public.customer_invoices.items is
  '#1161/#1162: an ITEMISED invoice''s lines — charges (quantity in thousandths x unit price in cents) and wording-only notes. Each charge may carry its cost and what job data it bills (hours, supplier lines, a variation); those never go to Xero.';
comment on column public.customer_invoices.sent_footer is
  '#1164: wording added to the invoice at send (the payment-claim statement and claimed-to-date figures). Frozen with the rest of the snapshot so a retry sends exactly the same lines.';

-- ── per-job payment-claim switch ────────────────────────────────────────────
alter table public.customer_invoice_job_profiles
  add column payment_claim boolean not null default false;

comment on column public.customer_invoice_job_profiles.payment_claim is
  '#1164: when true, invoices sent for this job carry the statement that they are a payment claim under the Building and Construction Industry Security of Payment Act 2009 (SA). Off by default; the office decides per job.';

-- ── the business''s invoicing habits ─────────────────────────────────────────
create table public.customer_invoice_prefs (
  tenant_id             uuid primary key references public.tenants(id),
  -- usual markup on materials, basis points (2500 = 25%). Null until the
  -- office sets one — no default ships.
  materials_markup_bp   integer check (materials_markup_bp is null or (materials_markup_bp >= 0 and materials_markup_bp <= 100000)),
  -- pulled hours are rounded UP to this many minutes per line (0 = as logged)
  labour_round_minutes  integer not null default 0 check (labour_round_minutes in (0, 15, 30, 60)),
  -- the usual charges: [{ id, name, unit, unitCents, kind: 'labour'|'other' }]
  usual_charges         jsonb not null default '[]'::jsonb,
  version               integer not null default 1,
  updated_by_legacy_id  text,
  updated_by_name       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.customer_invoice_prefs is
  '#1162: how this business invoices — its usual materials markup, its usual charges (call-out fee, hourly rates, travel) and how pulled hours are rounded. One row per tenant; nothing here is Xero''s.';

create trigger customer_invoice_prefs_touch
  before update on public.customer_invoice_prefs
  for each row execute function public.tg_touch_updated_at();

-- ── variations ──────────────────────────────────────────────────────────────
create table public.customer_invoice_variations (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id),
  job_legacy_id         text not null,
  -- V1, V2 … per job; never reused
  seq                   integer not null check (seq >= 1),

  title                 text not null check (char_length(title) between 1 and 200),
  detail                text check (detail is null or char_length(detail) <= 2000),
  -- who asked for it, and when (the builder''s site manager, an email, an SI)
  requested_by          text check (requested_by is null or char_length(requested_by) <= 200),
  requested_on          date,

  -- the price put to the client (ex GST); null = not priced yet
  quoted_cents          bigint check (quoted_cents is null or quoted_cents >= 0),

  status                text not null default 'proposed'
    check (status in ('proposed','approved','declined')),
  -- what was approved (may differ from the quote); the figure that counts
  approved_cents        bigint check (approved_cents is null or approved_cents >= 0),
  -- how it was approved: an email, a site instruction number, a name
  approval_ref          text check (approval_ref is null or char_length(approval_ref) <= 300),
  decided_on            date,
  decided_by_legacy_id  text,
  decided_by_name       text,

  -- a removed variation keeps its row so its number is never handed out again
  removed_at            timestamptz,

  version               integer not null default 1,
  created_by_legacy_id  text,
  created_by_name       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (tenant_id, id),
  unique (tenant_id, job_legacy_id, seq),
  -- an approved variation always says how much was approved
  check (status <> 'approved' or approved_cents is not null)
);

create index customer_invoice_variations_job_idx
  on public.customer_invoice_variations (tenant_id, job_legacy_id, seq);

comment on table public.customer_invoice_variations is
  '#1163: a job''s variations register — what was asked for, by whom, the price put, and whether it was approved (with the approved amount and how it was approved). Approved variations add to the contract. Whether one has been BILLED is read from the invoices'' own lines, not stored here.';

create trigger customer_invoice_variations_touch
  before update on public.customer_invoice_variations
  for each row execute function public.tg_touch_updated_at();

-- ── history: the new events ─────────────────────────────────────────────────
alter table public.customer_invoice_events drop constraint customer_invoice_events_event_check;
alter table public.customer_invoice_events
  add constraint customer_invoice_events_event_check
  check (event in (
    'created','edited','removed','cancelled',
    'profile_updated','settings_updated',
    'pending','accepted_by_xero','adopted','rejected','retry_required',
    'verified_against_xero','drifted','status_changed','raised_again',
    -- part 2
    'prefs_updated',
    'variation_added','variation_edited','variation_approved',
    'variation_declined','variation_reopened','variation_removed','variation_billed'
  ));

-- RLS on, NO policies — money records, service-role-mediated only.
alter table public.customer_invoice_prefs enable row level security;
alter table public.customer_invoice_variations enable row level security;
