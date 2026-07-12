# Supabase RLS access matrix — Phase 1 schema (issue #153)

**Status:** Drafted 2026-07-03 · policies written, **NOT applied** (production
cutover ceremony in flight — apply later via the normal migration workflow).
**Policy migration:** [supabase/migrations/20260703230000_phase1_rls_policies.sql](../../supabase/migrations/20260703230000_phase1_rls_policies.sql)
**Identity model:** [supabase-rls-identity-bridge-adr.md](supabase-rls-identity-bridge-adr.md)
**Schema + conventions:** [supabase/migrations/20260611142758_phase1_core_schema.sql](../../supabase/migrations/20260611142758_phase1_core_schema.sql)
(header documents the tenant_id + `UNIQUE (tenant_id, id)` composite-FK
pattern these policies lean on).
**Tier truth:** `api/_lib/auth.js` + `src/lib/auth/roles.ts` (kept in sync by
comment contract). **Relates to:** #153, #152 (import), #155, #160.

## The four tiers (there is no 'accounts' tier)

Policies never see raw role strings. The server normalises the fresh
users.json role through the canonical tier sets and mints a `tier` JWT claim:

| Tier claim | users.json roles it collapses (via `normaliseRole`) |
|---|---|
| `admin` | admin, boss, owner, manager, office, pm, estimator |
| `leading_hand` | leadinghand, leading_hand, leading-hand, lh (all spellings) |
| `field` | tradie, apprentice, labourer, electrician |
| `client` | client |

JWT claim shape (see the ADR): `sub` = `user_profiles.id` (the issue's
`user_id`), `tenant_id`, `tier` (the issue's `role(tier)` — renamed because
PostgREST reserves the `role` claim for the database role, which is always
`authenticated`), short `exp`.

## Phase A scope: reads only

This migration grants **SELECT only**. There are **zero INSERT/UPDATE/DELETE
policies** for `authenticated`: every write remains service-role-only
(deny-by-default), exactly as production behaves today. §Target write
semantics below documents what a future write-path migration would grant, so
it is a transcription job, not a design job. `anon` has no policies anywhere
and reads nothing. The service role bypasses RLS entirely — importers (#152)
and all existing API traffic are unaffected.

## Read matrix — 4 tiers × 31 tables

Legend: **All** = every row in the JWT tenant (admin includes soft-deleted /
draft / archived — the office sees history). **Member** = rows on jobs where
`is_job_member(job_id)` is true (a `job_members` row for the user on a
**live** job — not draft, not archived, not soft-deleted — mirroring the
`canViewDraftJobs`/`canViewArchivedJobs` admin-only gates in api/jobs.js).
**Parent** = row visible iff its parent row is visible under RLS
(visible-parent `EXISTS`; tenancy still checked on the child row itself).
**Self** = row ownership by JWT `sub`. **—** = no policy → zero rows.
Every non-admin read excludes `deleted_at IS NOT NULL` rows (soft-delete
exclusion), either directly or via its parent/`is_job_member`.

| # | Table | admin | leading_hand | field | client | Notes |
|---|---|---|---|---|---|---|
| 1 | tenants | Own tenant row | Own tenant row | Own tenant row | Own tenant row | Single shared policy (`id = tenant claim`) |
| 2 | user_profiles | All | Live+active in tenant | Live+active in tenant | Self only | Crew names render across Phil; no credential columns exist in PG |
| 3 | jobs | All | Member | Member | Linked (`client_user_id` = self) + live + not draft/archived | Client rule mirrors api/client-jobs-summary.js (#386 draft-leak fix) |
| 4 | job_members | All | Member (whole crew of own jobs) | Member | — | |
| 5 | site_area_groups | All | Member, live | Member, live | — | |
| 6 | site_areas | All | Member, live | Member, live | — | |
| 7 | job_task_templates | All | Member, live | Member, live | — | |
| 8 | tasks | All | Member, live | Member, live | — | |
| 9 | task_status_events | All | — | — | — | Transition history is an audit surface, not rendered in Phil — admin-or-nothing |
| 10 | task_comments | All | Parent (task) | Parent (task) | — | |
| 11 | evidence_files | All | Member, live | Member, live | — | Client proof-sharing is a future product decision, not a policy default |
| 12 | evidence_links | All | Parent (evidence_files) | Parent (evidence_files) | — | |
| 13 | snags | All | Member, live | Member, live | — | Client-visible snag counts stay server-composed |
| 14 | snag_comments | All | Parent (snag) | Parent (snag) | — | |
| 15 | observations | All | Member, live | Member, live | — | observations:read = job-scoped non-client (roles.ts) |
| 16 | material_requests | All | Member, live | Member, live | — | |
| 17 | material_request_items | All | Parent (material_requests) | Parent (material_requests) | — | |
| 18 | time_entries | All | Self, live | Self, live | — | LH **team** reads (approval) stay service-role-mediated pending the approval-scope decision |
| 19 | time_entry_allocations | All | Parent (own time_entries) | Parent (own time_entries) | — | |
| 20 | timesheet_approvals | All | Self | Self | — | A worker sees their own week-closeout status |
| 21 | payroll_runs | All | — | — | — | **Admin-or-nothing** (payroll) |
| 22 | itp_templates | All | Live in tenant | Live in tenant | — | Tenant-wide reference data; field records points on site |
| 23 | itp_template_items | All | Live + parent (template) | Live + parent (template) | — | |
| 24 | itp_instances | All | Member, live | Member, live | — | |
| 25 | itp_items | All | Live + parent (instance) | Live + parent (instance) | — | |
| 26 | itp_responses | All | Parent (instance) | Parent (instance) | — | Append-only, no deleted_at |
| 27 | documents | All | Member (or company doc), live, **status='current'** | Member (or company doc), live, **status='current'** | — | Mirrors canViewCurrentPlans; superseded/archived are office history |
| 28 | assets | All | Live in tenant | Live in tenant | — | gear:read = any authenticated non-client |
| 29 | asset_assignments | All | Self (holder) | Self (holder) | — | canViewAssignedGear: own gear + own history |
| 30 | audit_logs | All | — | — | — | **Admin-or-nothing** (append-only journal) |
| 31 | outbox_events | All | — | — | — | **Admin-or-nothing** (integration infra; arguably service-only — admin read kept for ops visibility) |

Tenant isolation appears in **every** policy (including admin's): each USING
clause requires `tenant_id = app_tenant_id()` (or `id =` for tenants). Child
tables trust their own `tenant_id` column — the composite
`(tenant_id, id)` FKs guarantee it matches the parent — so no parent joins
are needed for tenancy, only for visibility inheritance.

## Target write semantics (documented, NOT granted)

For the future per-domain write-path migrations, from the roles.ts capability
map. Until then every write is service-role-only.

| Capability | Grant when built |
|---|---|
| jobs:create | literal 'admin' only (narrower than the tier — canCreateJob) |
| jobs:write / evidence:create / snags:create / observations:create | admin any job; LH/field INSERT-UPDATE on member jobs (`canWrite`), `WITH CHECK` created_by/captured_by = self |
| tasks toggle | LH/field UPDATE status on member jobs; admin any |
| hours:create | LH/field INSERT/UPDATE own `time_entries` (+ allocations rewrite) while draft/submitted |
| hours:approve | staff (admin + LH-on-led-jobs — `job_members.role='lead'`); needs the approval-scope decision first |
| evidence:review / observations:review / observations:convert / gear:manage / employees:manage / settings:manage | admin tier only |
| Hard DELETE | nobody via RLS — the app soft-deletes; hard deletes stay service-role |
| Append-only tables (comments, events, responses, links, audit_logs, payroll_runs, outbox) | INSERT only where the owning flow lands; never UPDATE/DELETE |

## Advisor baseline

- The three pre-existing WARNs from the #153 audit comment are **already
  resolved** by
  [20260611212723_phase1_hardening.sql](../../supabase/migrations/20260611212723_phase1_hardening.sql)
  (applied 2026-06-12): `search_path` pinned on `tg_touch_updated_at` **and**
  `tg_touch_updated_at_bump_revision`; EXECUTE on the pre-existing
  `rls_auto_enable()` revoked from public/anon/authenticated. Nothing to redo.
- After applying the policy migration, the 31 `rls_enabled_no_policy` INFOs
  clear for policied tables (the post-Phase-1 tables below keep theirs —
  expected).
- **Accepted finding:** `is_job_member(uuid)` is SECURITY DEFINER and
  executable by `authenticated` (lint 0029 may flag it). This is required —
  policies evaluate it as the querying user — and safe: it is `stable`, pins
  `search_path = ''`, takes one uuid, and only returns a boolean about the
  caller's own membership. EXECUTE is revoked from `public` and `anon`.
- The claim helpers (`app_tenant_id`/`app_user_id`/`app_tier`) are SECURITY
  INVOKER and wrapped in `(select …)` inside policies (initplan — evaluated
  once per statement, avoiding the `auth_rls_initplan` per-row WARN pattern).

## Post-Phase-1 tables (not in the 31)

`job_types`, `contacts`, `suppliers`, `supplier_branches`,
`supplier_contacts`, `supplier_products`, `wholesalers` (Phase 2a
registries) and `sync_checks` (parity infra) were added after the Phase 1
brief. They are office/infra data with no field read path; they stay
**RLS-on, zero policies** (deny-by-default, service-role only) until a read
path needs them. Registry policies would be a trivial follow-up
(admin-tier tenant-scoped SELECT).

**`integration_connections`** (#892/#247 — `20260712100000_integration_connections.sql`, see
[integration-credential-storage-adr.md](integration-credential-storage-adr.md))
is stricter than the registries: **RLS-on, zero policies, permanently** — no
tier ever reads it through RLS, not even admin. It holds encrypted OAuth token
material; all access is service-role-mediated, and admin surfaces render only
derived status fields. Unlike the append-only tables, its row is UPDATEd in
place (token rotation via `refresh_version` CAS) and hard-DELETEd on
disconnect — dead ciphertext is a liability, not history.

## How to apply + verify (later — not during the cutover ceremony)

1. **Dev first.** Apply `20260703230000_phase1_rls_policies.sql` to the dev
   project (`frovgpywsopbeuekijmo`) via the normal workflow — `supabase db
   push` on the linked dev project, or MCP `apply_migration` with name
   `phase1_rls_policies` (keep the version = the filename timestamp so
   local/remote histories stay reconciled).
2. **Run the allow/deny suite** against dev (service-role seeds its own
   fixtures and cleans up; see the script header):

   ```sh
   RLS_TEST_SUPABASE_URL=https://<dev-ref>.supabase.co \
   RLS_TEST_SERVICE_ROLE_KEY=<dev service_role key> \
   RLS_TEST_ANON_KEY=<dev anon key> \
   RLS_TEST_JWT_SECRET=<dev JWT secret (legacy HS256)> \
   node scripts/rls-policy-tests.js
   ```

   The script **refuses to run** against the production ref
   (`wetctlrhsycfwhuxlarv`). It is on-demand only — not wired into CI.
3. **Re-run security advisors** on dev; expect: policied-table INFOs cleared,
   post-Phase-1-table INFOs remaining, plus at most the accepted
   `is_job_member` finding above. Anything else = stop and fix.
4. **Prod**, after the cutover ceremony completes: same versioned migration,
   never the dashboard; re-run advisors; confirm existing app traffic
   (service role) unaffected — the suite's service-role-insert check is the
   regression guard for #152/#160.
5. Line-by-line dashboard policy review against this matrix; then #153 can
   close.
