-- ============================================================================
-- BuhlOS / Phil — Phase 2a follow-up: wire the registry FKs onto existing tables
-- Target: dev frovgpywsopbeuekijmo + prod wetctlrhsycfwhuxlarv.
-- ADDITIVE ONLY — three nullable, tenant-scoped composite FK columns. No backfill.
--
-- Phase 2a (20260618120000) introduced the registries (job_types, suppliers) but
-- deliberately deferred the *referencing* FK columns, so the denormalised
-- free-text columns stayed authoritative and nothing joined to the registries.
-- This migration adds the FK columns. The free-text columns
-- (jobs.job_type_label, material_requests.supplier, assets.hire_supplier) REMAIN
-- and stay authoritative until each domain's dual-write cutover backfills the id
-- by name — see docs/architecture/data-ownership-map.md §3.
--
-- Conventions: tenant-scoped composite FK (tenant_id, <fk>) → parent (tenant_id, id),
-- matching Phase 1 — a row can never reference across tenants. Columns are
-- NULLABLE (MATCH SIMPLE: the FK is not enforced while the id is null, so existing
-- rows and un-backfilled rows are valid). No index yet (per the Phase-1 advisor
-- discipline: don't pre-index FKs; add when the read/join paths land).
-- ============================================================================

-- jobs.job_type_id → job_types  (free-text fallback: jobs.job_type_label / jobs.type legacy id)
alter table public.jobs
  add column job_type_id uuid;
alter table public.jobs
  add constraint jobs_job_type_fk
  foreign key (tenant_id, job_type_id) references public.job_types (tenant_id, id);
comment on column public.jobs.job_type_id is
  'FK to job_types; null until backfilled by name from job_type_label at cutover. job_type_label stays authoritative meanwhile.';

-- material_requests.supplier_id → suppliers  (free-text fallback: material_requests.supplier)
alter table public.material_requests
  add column supplier_id uuid;
alter table public.material_requests
  add constraint material_requests_supplier_fk
  foreign key (tenant_id, supplier_id) references public.suppliers (tenant_id, id);
comment on column public.material_requests.supplier_id is
  'FK to suppliers; null until backfilled by name from the supplier text column at cutover.';

-- assets.hire_supplier_id → suppliers  (free-text fallback: assets.hire_supplier)
alter table public.assets
  add column hire_supplier_id uuid;
alter table public.assets
  add constraint assets_hire_supplier_fk
  foreign key (tenant_id, hire_supplier_id) references public.suppliers (tenant_id, id);
comment on column public.assets.hire_supplier_id is
  'FK to suppliers for hired gear; null until backfilled by name from hire_supplier at cutover.';
