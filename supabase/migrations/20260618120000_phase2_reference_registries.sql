-- ============================================================================
-- BuhlOS / Phil — Phase 2a: reference & procurement registries
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). ADDITIVE ONLY — new tables, no changes to Phase 1.
--
-- Models the deferred blob-only registries that Phase 1 left as free text:
--   * job_types   ← job-types.json        (jobs.type / jobs.job_type_label)
--   * contacts    ← jobs/<jobId>/contacts.json (PER-JOB; project/supplier + legacy email-list)
--   * suppliers (+ branches + contacts + products)
--                 ← suppliers.json + suppliers/<id>/products.json
--   * wholesalers ← wholesalers.json       (lightweight pricing-email register)
--
-- Conventions are IDENTICAL to Phase 1 (20260611142758_phase1_core_schema):
-- uuid PKs, tenant_id + unique (tenant_id, id), legacy_id partial unique,
-- created/updated_at + created/updated_by, revision (optimistic concurrency),
-- deleted_at/deleted_by soft delete (legacy `archived` / status='archived'
-- maps here), tenant-scoped composite FKs, TEXT+CHECK enums using the EXACT
-- strings the app writes, RLS enabled with NO policies. The trigger functions
-- tg_touch_updated_at[_bump_revision] already exist from Phase 1.
--
-- DELIBERATELY NOT here: wiring jobs.job_type_id / material_requests.supplier_id
-- as FKs onto existing tables — that's a later "reference wiring" migration.
-- This slice only introduces the registries.
-- ============================================================================

-- ─── job_types (job-types.json: { jobTypes: [{ id, name }] }) ───────────────
create table public.job_types (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  legacy_id   text,                              -- jt_xxxxxxxx
  name        text not null,
  sort_order  integer not null default 0,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  updated_by  uuid references public.user_profiles(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.user_profiles(id),
  unique (tenant_id, id)
);
comment on table public.job_types is
  'Job-type registry (job-types.json). Phase 1 denormalised this as jobs.job_type_label; jobs.type holds the legacy jt_ id. FK wiring is a later migration.';
create unique index job_types_legacy_uq on public.job_types (tenant_id, legacy_id) where legacy_id is not null;
create index job_types_live_idx on public.job_types (tenant_id) where deleted_at is null;

-- ─── contacts (contacts.json) ───────────────────────────────────────────────
-- Two shapes coexist: categorised (category project|supplier) and a legacy
-- email-list entry (no category) added by the snag-email picker. category is
-- NULLABLE so legacy rows import without guessing a value.
create table public.contacts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id),
  job_id         uuid not null,                   -- contacts are stored per-job (jobs/<jobId>/contacts.json)
  legacy_id      text,
  category       text check (category is null or category in ('project','supplier')),
  name           text not null,
  company        text check (company is null or char_length(company) <= 200),
  role           text check (role is null or char_length(role) <= 120),
  contact_person text,
  description    text,
  phone          text check (phone is null or char_length(phone) <= 60),
  email          text,
  notes          text check (notes is null or char_length(notes) <= 2000),
  revision       integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.user_profiles(id),
  created_by_label text,                          -- legacy email-list `addedBy` username (pre-uuid provenance)
  updated_by     uuid references public.user_profiles(id),
  deleted_at     timestamptz,
  deleted_by     uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id) references public.jobs (tenant_id, id)
);
comment on table public.contacts is
  'Per-job customer/builder/supplier contacts (jobs/<jobId>/contacts.json). category null = a legacy email-list entry from the snag-email picker (its addedBy/addedAt map to created_by_label/created_at).';
-- legacy ids (c_<date36><rand>) are unique only WITHIN a job file → scope by job
create unique index contacts_legacy_uq on public.contacts (tenant_id, job_id, legacy_id) where legacy_id is not null;
create index contacts_job_idx on public.contacts (tenant_id, job_id) where deleted_at is null;
create index contacts_category_idx on public.contacts (tenant_id, category) where deleted_at is null;

-- ─── suppliers (+ branches + contacts + products) ───────────────────────────
create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  legacy_id     text,                            -- sup_xxxxxxxx
  name          text not null,
  supplier_type text check (supplier_type is null or supplier_type in
                  ('wholesaler','supplier','manufacturer','distributor','other')),
  website_url   text check (website_url is null or char_length(website_url) <= 500),
  preferred     boolean not null default false,
  categories     text[] not null default '{}',   -- free-text tags (≤20, app-enforced)
  notes          text,
  account_number text check (account_number is null or char_length(account_number) <= 60),
  payment_terms  text check (payment_terms is null or char_length(payment_terms) <= 60),
  revision       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.user_profiles(id),
  updated_by    uuid references public.user_profiles(id),
  deleted_at    timestamptz,                     -- legacy status='archived' maps here
  deleted_by    uuid references public.user_profiles(id),
  unique (tenant_id, id)
);
comment on table public.suppliers is
  'Supplier register (suppliers.json). status active|archived maps to deleted_at. branches/contacts/products are child tables.';
create unique index suppliers_legacy_uq on public.suppliers (tenant_id, legacy_id) where legacy_id is not null;
create index suppliers_live_idx on public.suppliers (tenant_id) where deleted_at is null;
create index suppliers_preferred_idx on public.suppliers (tenant_id) where preferred and deleted_at is null;

create table public.supplier_branches (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id),
  supplier_id  uuid not null,
  legacy_id    text,                             -- branch_xxxxxxxx
  name         text not null check (char_length(name) <= 120),
  address      text check (address is null or char_length(address) <= 300),
  phone        text check (phone is null or char_length(phone) <= 60),
  email        text check (email is null or char_length(email) <= 200),
  notes        text check (notes is null or char_length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.user_profiles(id),
  updated_by   uuid references public.user_profiles(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id)
);
create unique index supplier_branches_legacy_uq
  on public.supplier_branches (tenant_id, supplier_id, legacy_id) where legacy_id is not null;
create index supplier_branches_supplier_idx
  on public.supplier_branches (tenant_id, supplier_id) where deleted_at is null;

create table public.supplier_contacts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id),
  supplier_id  uuid not null,
  legacy_id    text,                             -- scon_xxxxxxxx
  name         text not null check (char_length(name) <= 120),
  role         text check (role is null or char_length(role) <= 120),
  phone        text check (phone is null or char_length(phone) <= 60),
  email        text check (email is null or char_length(email) <= 200),
  branch_id    uuid,                              -- contact's branch; legacy branchId resolved to uuid at import. nullable — delete-branch unlinks.
  notes        text check (notes is null or char_length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.user_profiles(id),
  updated_by   uuid references public.user_profiles(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id),
  foreign key (tenant_id, branch_id)  references public.supplier_branches (tenant_id, id)
);
create unique index supplier_contacts_legacy_uq
  on public.supplier_contacts (tenant_id, supplier_id, legacy_id) where legacy_id is not null;
create index supplier_contacts_supplier_idx
  on public.supplier_contacts (tenant_id, supplier_id) where deleted_at is null;

-- products live in a per-supplier blob (suppliers/<id>/products.json). prices
-- are REFERENCE values only (api/supplier-products.js).
create table public.supplier_products (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  supplier_id     uuid not null,
  legacy_id       text,
  name            text not null,
  brand           text check (brand is null or char_length(brand) <= 100),
  part_number     text check (part_number is null or char_length(part_number) <= 100),
  description     text check (description is null or char_length(description) <= 2000),
  category        text check (category is null or char_length(category) <= 100),
  unit            text check (unit is null or char_length(unit) <= 20),  -- free text: the app stores arbitrary units (VALID_UNITS is a UI hint, not enforced)
  price           numeric(12,2) check (price is null or price >= 0),
  price_note      text check (price_note is null or char_length(price_note) <= 200),
  public_url      text,
  image_url       text,
  datasheet_url   text,
  source          text not null default 'manual' check (source in ('manual','url_lookup','import')),
  source_url      text,
  last_checked_at timestamptz,
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.user_profiles(id),
  updated_by      uuid references public.user_profiles(id),
  deleted_at      timestamptz,                   -- legacy archived=true maps here
  deleted_by      uuid references public.user_profiles(id),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id)
);
create unique index supplier_products_legacy_uq
  on public.supplier_products (tenant_id, supplier_id, legacy_id) where legacy_id is not null;
create index supplier_products_supplier_idx
  on public.supplier_products (tenant_id, supplier_id) where deleted_at is null;

-- ─── wholesalers (wholesalers.json — lightweight pricing-email register) ─────
create table public.wholesalers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id),
  legacy_id   text,
  name        text not null,
  email       text,
  branch      text,
  notes       text,
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.user_profiles(id),
  updated_by  uuid references public.user_profiles(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.user_profiles(id),
  unique (tenant_id, id)
);
comment on table public.wholesalers is
  'Lightweight pricing-email register (wholesalers.json) used by the Materials List pricing modal. Distinct from the richer suppliers table.';
create unique index wholesalers_legacy_uq on public.wholesalers (tenant_id, legacy_id) where legacy_id is not null;
create index wholesalers_live_idx on public.wholesalers (tenant_id) where deleted_at is null;

-- ─── updated_at / revision triggers (functions exist from Phase 1) ──────────
create trigger trg_job_types_rev before update on public.job_types
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_contacts_rev before update on public.contacts
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_suppliers_rev before update on public.suppliers
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_supplier_products_rev before update on public.supplier_products
  for each row execute function public.tg_touch_updated_at_bump_revision();
create trigger trg_wholesalers_rev before update on public.wholesalers
  for each row execute function public.tg_touch_updated_at_bump_revision();
-- child detail rows: touch updated_at only (no revision column)
create trigger trg_supplier_branches_touch before update on public.supplier_branches
  for each row execute function public.tg_touch_updated_at();
create trigger trg_supplier_contacts_touch before update on public.supplier_contacts
  for each row execute function public.tg_touch_updated_at();

-- ─── RLS: enable everywhere, NO policies (service role bypasses; anon → 0 rows)
alter table public.job_types         enable row level security;
alter table public.contacts          enable row level security;
alter table public.suppliers         enable row level security;
alter table public.supplier_branches enable row level security;
alter table public.supplier_contacts enable row level security;
alter table public.supplier_products enable row level security;
alter table public.wholesalers       enable row level security;
