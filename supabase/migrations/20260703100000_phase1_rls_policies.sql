-- ============================================================================
-- BuhlOS / Phil — Phase 1 RLS policies (issue #153)
-- Target: same projects as Phase 1 (dev frovgpywsopbeuekijmo, prod
-- wetctlrhsycfwhuxlarv). NOT YET APPLIED — merged as a repo artifact while the
-- production cutover ceremony is in flight; apply later via the normal
-- versioned-migration workflow (dev first, advisors re-run, then prod).
--
-- Spec: docs/architecture/supabase-rls-access-matrix.md (the matrix maps 1:1
-- to the policies below — review them side by side). Identity model:
-- docs/architecture/supabase-rls-identity-bridge-adr.md.
--
-- Design rules (from the #153 audit comment):
--   * Policies key on the FOUR canonical tiers (api/_lib/auth.js +
--     src/lib/auth/roles.ts): admin / leading_hand / field / client. The
--     server mints the `tier` claim via normaliseRole + the tier sets —
--     raw role strings ('boss', 'lh', …) NEVER appear in SQL.
--   * JWT claims read here: sub (user_profiles.id), tenant_id, tier.
--     PostgREST reserves the `role` claim for the DATABASE role
--     ('authenticated'), so the tier lives in its own claim.
--   * Tenant isolation in EVERY policy. Child rows carry tenant_id
--     (composite (tenant_id, id) FKs guarantee it matches the parent), so
--     policies trust the child's tenant_id instead of joining parents for
--     tenancy.
--   * Exactly ONE security-definer helper: is_job_member(job_id), reused by
--     every job-scoped table. It encodes "member of a LIVE job" (not draft,
--     not archived, not soft-deleted) so the api/jobs.js status gating
--     (canViewDraftJobs/canViewArchivedJobs = admin tier only) cannot be
--     bypassed through any child table.
--   * THIS MIGRATION GRANTS READS ONLY. No INSERT/UPDATE/DELETE policies
--     exist for `authenticated`: every write stays service-role-only
--     (deny-by-default), exactly as production behaves today. Target write
--     semantics are documented (not granted) in the access-matrix doc.
--   * anon gets nothing: every policy is `to authenticated`.
--   * Soft-deleted rows (deleted_at) are excluded from every non-admin read.
--   * The 3 pre-existing advisor WARNs were already fixed by
--     20260611212723_phase1_hardening.sql — nothing to redo here. One new
--     advisor finding is EXPECTED and accepted: is_job_member is a
--     SECURITY DEFINER function executable by `authenticated` (lint 0029);
--     policies evaluate it as the querying user, so that grant is required.
--     Accepted in the matrix doc §Advisor baseline.
-- ============================================================================

-- ─── claim helpers (SECURITY INVOKER — they only read the request JWT) ──────

create or replace function public.app_tenant_id()
returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(coalesce(auth.jwt() ->> 'tenant_id', ''), '')::uuid
$$;
comment on function public.app_tenant_id() is
  'tenant_id claim of the server-minted request JWT (null for anon/service paths). See supabase-rls-identity-bridge-adr.md.';

create or replace function public.app_user_id()
returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(coalesce(auth.jwt() ->> 'sub', ''), '')::uuid
$$;
comment on function public.app_user_id() is
  'sub claim (public.user_profiles.id) of the server-minted request JWT.';

create or replace function public.app_tier()
returns text
language sql stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'tier', '')
$$;
comment on function public.app_tier() is
  'Normalised role TIER claim: admin | leading_hand | field | client. Minted server-side from the fresh users.json record via the api/_lib/auth.js tier sets — never a raw role string.';

-- ─── the ONE security-definer helper ────────────────────────────────────────
-- SECURITY DEFINER so it reads job_members/jobs without re-entering RLS
-- (no recursion, one plan to tune). "Member" means: a job_members row for
-- the current user on a job that is LIVE — not soft-deleted and not in an
-- office-only status (draft/archived), mirroring api/jobs.js visibility.

create or replace function public.is_job_member(p_job_id uuid)
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.job_members jm
    join public.jobs j
      on j.tenant_id = jm.tenant_id
     and j.id        = jm.job_id
    where jm.tenant_id = public.app_tenant_id()
      and jm.job_id    = p_job_id
      and jm.user_id   = public.app_user_id()
      and j.deleted_at is null
      and j.status not in ('draft','archived')
  )
$$;
comment on function public.is_job_member(uuid) is
  'True iff the request user (JWT sub) has a job_members row on p_job_id within the JWT tenant AND the job is live (not draft/archived/soft-deleted). The single assignment-scoping predicate reused by every job-scoped policy.';

-- Function EXECUTE hygiene: policies run these as the querying user, so
-- `authenticated` needs EXECUTE; nobody else does (service_role bypasses RLS
-- but may call them in tests).
revoke execute on function public.app_tenant_id()      from public, anon;
revoke execute on function public.app_user_id()        from public, anon;
revoke execute on function public.app_tier()           from public, anon;
revoke execute on function public.is_job_member(uuid)  from public, anon;
grant  execute on function public.app_tenant_id()      to authenticated, service_role;
grant  execute on function public.app_user_id()        to authenticated, service_role;
grant  execute on function public.app_tier()           to authenticated, service_role;
grant  execute on function public.is_job_member(uuid)  to authenticated, service_role;

-- ============================================================================
-- Policies. Naming: <table>_select_<audience>.
--   admin  = tier 'admin' — whole tenant, INCLUDING soft-deleted rows
--   worker = tiers 'leading_hand' + 'field' (identical read scope today;
--            they differ only in write capabilities, which are not granted)
--   client = tier 'client'
--   self   = row ownership (user_id / holder_user_id = JWT sub)
-- Claim helpers are wrapped in (select …) so they evaluate once per
-- statement (initplan), not once per row.
-- ============================================================================

-- ─── tenants — every authenticated principal reads its OWN tenant row ───────

create policy tenants_select_own on public.tenants
  for select to authenticated
  using (id = (select public.app_tenant_id()));

-- ─── user_profiles ───────────────────────────────────────────────────────────
-- Crew names render all over Phil (snag stamps, evidence "captured by",
-- crew cards) → workers read the live tenant directory. Clients read only
-- their own row.

create policy user_profiles_select_admin on public.user_profiles
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy user_profiles_select_worker on public.user_profiles
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null
     and is_active);

create policy user_profiles_select_client_self on public.user_profiles
  for select to authenticated
  using ((select public.app_tier()) = 'client'
     and tenant_id = (select public.app_tenant_id())
     and id = (select public.app_user_id()));

-- ─── jobs ────────────────────────────────────────────────────────────────────
-- Draft + archived are office-only (canViewDraftJobs/canViewArchivedJobs =
-- admin tier). Worker visibility = is_job_member (live jobs only). Client
-- visibility = jobs.client_user_id, same status gate (api/client-jobs-summary.js).

create policy jobs_select_admin on public.jobs
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy jobs_select_worker on public.jobs
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(id)));

create policy jobs_select_client on public.jobs
  for select to authenticated
  using ((select public.app_tier()) = 'client'
     and tenant_id = (select public.app_tenant_id())
     and client_user_id = (select public.app_user_id())
     and deleted_at is null
     and status not in ('draft','archived'));

-- ─── job_members — workers see the crew of jobs they are on ─────────────────

create policy job_members_select_admin on public.job_members
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy job_members_select_worker on public.job_members
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id)));

-- ─── job structure: site_area_groups / site_areas / job_task_templates ──────

create policy site_area_groups_select_admin on public.site_area_groups
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy site_area_groups_select_worker on public.site_area_groups
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy site_areas_select_admin on public.site_areas
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy site_areas_select_worker on public.site_areas
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy job_task_templates_select_admin on public.job_task_templates
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy job_task_templates_select_worker on public.job_task_templates
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

-- ─── tasks + task history/comments ──────────────────────────────────────────
-- task_status_events is admin-only: transition history is an audit surface,
-- not rendered in Phil (see matrix). task_comments follow the visible-parent
-- pattern: a comment is readable iff the task row is readable under RLS.

create policy tasks_select_admin on public.tasks
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy tasks_select_worker on public.tasks
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy task_status_events_select_admin on public.task_status_events
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy task_comments_select_admin on public.task_comments
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy task_comments_select_worker on public.task_comments
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.tasks t
       where t.tenant_id = task_comments.tenant_id
         and t.id        = task_comments.task_id
     ));

-- ─── evidence_files / evidence_links ────────────────────────────────────────

create policy evidence_files_select_admin on public.evidence_files
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy evidence_files_select_worker on public.evidence_files
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy evidence_links_select_admin on public.evidence_links
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy evidence_links_select_worker on public.evidence_links
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.evidence_files ef
       where ef.tenant_id = evidence_links.tenant_id
         and ef.id        = evidence_links.evidence_file_id
     ));

-- ─── snags / snag_comments ───────────────────────────────────────────────────

create policy snags_select_admin on public.snags
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy snags_select_worker on public.snags
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy snag_comments_select_admin on public.snag_comments
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy snag_comments_select_worker on public.snag_comments
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.snags s
       where s.tenant_id = snag_comments.tenant_id
         and s.id        = snag_comments.snag_id
     ));

-- ─── observations ────────────────────────────────────────────────────────────
-- observations:read is job-scoped + non-client (roles.ts capability map).

create policy observations_select_admin on public.observations
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy observations_select_worker on public.observations
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

-- ─── material_requests / material_request_items ─────────────────────────────

create policy material_requests_select_admin on public.material_requests
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy material_requests_select_worker on public.material_requests
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy material_request_items_select_admin on public.material_request_items
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy material_request_items_select_worker on public.material_request_items
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.material_requests mr
       where mr.tenant_id = material_request_items.tenant_id
         and mr.id        = material_request_items.material_request_id
     ));

-- ─── hours: time_entries / allocations / weekly closeout / payroll ──────────
-- Workers read their OWN entries only. LH team-approval reads stay a
-- server-mediated (service-role) flow until the approval-scope decision —
-- see matrix §Hours. payroll_runs is admin-or-nothing.

create policy time_entries_select_admin on public.time_entries
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy time_entries_select_self on public.time_entries
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and user_id = (select public.app_user_id())
     and deleted_at is null);

create policy time_entry_allocations_select_admin on public.time_entry_allocations
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy time_entry_allocations_select_self on public.time_entry_allocations
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.time_entries te
       where te.tenant_id = time_entry_allocations.tenant_id
         and te.id        = time_entry_allocations.time_entry_id
     ));

create policy timesheet_approvals_select_admin on public.timesheet_approvals
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy timesheet_approvals_select_self on public.timesheet_approvals
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and user_id = (select public.app_user_id()));

create policy payroll_runs_select_admin on public.payroll_runs
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

-- ─── ITP: templates / template items / instances / items / responses ────────
-- Templates are tenant-wide reference data (field records points on site);
-- instances are job-scoped; items/responses follow their visible instance.

create policy itp_templates_select_admin on public.itp_templates
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy itp_templates_select_worker on public.itp_templates
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null);

create policy itp_template_items_select_admin on public.itp_template_items
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy itp_template_items_select_worker on public.itp_template_items
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null
     and exists (
       select 1 from public.itp_templates tpl
       where tpl.tenant_id = itp_template_items.tenant_id
         and tpl.id        = itp_template_items.template_id
     ));

create policy itp_instances_select_admin on public.itp_instances
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy itp_instances_select_worker on public.itp_instances
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and (select public.is_job_member(job_id))
     and deleted_at is null);

create policy itp_items_select_admin on public.itp_items
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy itp_items_select_worker on public.itp_items
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null
     and exists (
       select 1 from public.itp_instances i
       where i.tenant_id = itp_items.tenant_id
         and i.id        = itp_items.instance_id
     ));

create policy itp_responses_select_admin on public.itp_responses
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy itp_responses_select_worker on public.itp_responses
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and exists (
       select 1 from public.itp_instances i
       where i.tenant_id = itp_responses.tenant_id
         and i.id        = itp_responses.instance_id
     ));

-- ─── documents ───────────────────────────────────────────────────────────────
-- canViewCurrentPlans: workers see CURRENT docs only (superseded/archived are
-- office history). Job docs need membership; job_id-null docs are
-- company-level reference.

create policy documents_select_admin on public.documents
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy documents_select_worker on public.documents
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null
     and status = 'current'
     and (job_id is null or (select public.is_job_member(job_id))));

-- ─── gear: assets / asset_assignments ───────────────────────────────────────
-- gear:read = any authenticated non-client (roles.ts); workers see the live
-- register plus their own assignment history (canViewAssignedGear).

create policy assets_select_admin on public.assets
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy assets_select_worker on public.assets
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and deleted_at is null);

create policy asset_assignments_select_admin on public.asset_assignments
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy asset_assignments_select_self on public.asset_assignments
  for select to authenticated
  using ((select public.app_tier()) in ('leading_hand','field')
     and tenant_id = (select public.app_tenant_id())
     and holder_user_id = (select public.app_user_id()));

-- ─── audit_logs / outbox_events — admin-or-nothing ──────────────────────────

create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

create policy outbox_events_select_admin on public.outbox_events
  for select to authenticated
  using ((select public.app_tier()) = 'admin'
     and tenant_id = (select public.app_tenant_id()));

-- ============================================================================
-- Deliberately NO policies (deny-by-default stands) for:
--   * every INSERT/UPDATE/DELETE for `authenticated` — writes remain
--     service-role-only until per-domain write-path decisions;
--   * anon — no policy targets it anywhere;
--   * client tier beyond tenants/user_profiles(self)/jobs(linked) — the
--     client portal is a server-composed projection today;
--   * the post-Phase-1 tables (job_types, contacts, suppliers,
--     supplier_branches, supplier_contacts, supplier_products, wholesalers,
--     sync_checks) — office/infra data with no field read path; they keep
--     RLS-on-zero-policies. See matrix §Post-Phase-1 tables.
-- ============================================================================
