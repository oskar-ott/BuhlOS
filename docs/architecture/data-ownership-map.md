# Data ownership map — Blob → Supabase Postgres

> Companion to [supabase-storage-migration-adr.md](supabase-storage-migration-adr.md).
> Authoritative contract for **which store owns which domain** during and after the
> strangler. "Owner today" is **Vercel Blob unless noted** — only `GET /api/supabase-health`
> touches Postgres so far (38 tables, 0 rows). This is *schema intent*, not live ownership.

## 0. Task-identity reconciliation (read this before writing any importer)

The schema is **task-led**: `public.tasks` is the spine (own `uuid` id; `site_area_id`
nullable; facets reference `task_id`). The Blob shape is area-owned
(`dwellings[areaId][stage].tasks[taskId]`). **The importer MUST NOT invent a third
task-identity mapping.** The single source of truth for "one instance per
(area, stage, template)" is the canonical task index (`ct_<hash>`,
`src/domains/jobs/task-index.ts` + `src/domains/job-control/task-ref-compat.ts`). The required pinning:

```
tasks.id (uuid, the row PK)
   ↕ resolved at import from
ct_<hash> (canonical task identity — the ONLY tuple→instance authority)
   ↕ derived from
(site_area_id, stage, legacy_template_id)   ← the labelled compatibility bridge
```

`taskInstanceId` is a target term that exists nowhere in code; `tasks.id` is its
eventual home. Deepening area-owned task arrays is forbidden (anti-creep law).

## 1. MODELLED — canonical table exists (38 tables)

| Domain | Canonical table(s) | Note |
|---|---|---|
| Organisation | `tenants` | single-tenant today; `tenant_id` on every table |
| Users / Workers / Roles | `user_profiles`, `job_members` | role is a profile attribute; auth stays in `users.json` |
| Jobs | `jobs` | |
| Areas / groups | `site_area_groups`, `site_areas` | **facets, not task owners** |
| Stages | `tasks.stage` (column) | correct — stage is a task facet, not a table |
| Task plan | `job_task_templates` | `site_area_id` null = job default, set = area override |
| **Task instances** | **`tasks`** | the spine; `task_template_id` null = ad-hoc |
| Task status / history | `tasks.status`, `task_status_events` | |
| Task notes | `task_comments` | |
| Evidence / photos (metadata) | `evidence_files`, `evidence_links` | polymorphic junction; **bytes stay in Blob** |
| Proof requirements | `job_task_templates.required_photo_count`/`requires_note` | area/package-granular today |
| Snags / defects | `snags`, `snag_comments` | |
| Observations | `observations` | `convertedTo` enum stubs rfi/variation (no modules yet) |
| Materials (requests) | `material_requests`, `material_request_items` | |
| ITP / QA | `itp_templates`, `itp_template_items`, `itp_instances`, `itp_items`, `itp_responses` | |
| Timesheets | `time_entries`, `time_entry_allocations` | BuhlOS-owned operational time; feeds Xero Payroll timesheets (AU) — see [payroll-boundary-adr.md](payroll-boundary-adr.md) |
| Timesheet approvals | `timesheet_approvals` | BuhlOS-owned; Xero is never asked to approve — see [payroll-boundary-adr.md](payroll-boundary-adr.md) |
| Payroll runs | `payroll_runs` | export/push **batches + Xero sync-state**, **not** Xero pay runs (Xero-owned) — see [payroll-boundary-adr.md](payroll-boundary-adr.md) |
| Plans/docs register | `documents` | register only — no revision chain yet |
| Gear / vans / keys / tools | `assets`, `asset_assignments` | one polymorphic asset table |
| Audit logs | `audit_logs` | |
| Integration credentials | `integration_connections` | provider-generic OAuth connection state (first: Xero, #247); token columns AES-256-GCM ciphertext only; service-role-only forever — see [integration-credential-storage-adr.md](integration-credential-storage-adr.md) |
| Xero reference cache | `xero_reference_items`, `xero_reference_syncs` | #610: read-only payroll reference snapshot (employees/calendars/pay items/tracking categories) for mapping/validation only — **NEVER authoritative** (payroll-boundary ADR clause 4); allow-listed payloads (no PII); syncs log is append-only (feeds #251) |
| Xero mappings | `xero_mappings` | #248: the epic-wide explicit mapping store (worker↔employee now; #611 work-type↔earnings-rate and #254 job↔tracking-option kinds later). Admin-confirmed links by immutable Xero id + confirm-time snapshots; 1:1 both directions for worker links; org-scoped with visible mismatch; unlink hard-deletes (audit journal keeps history) |
| Payroll batches | `payroll_batches`, `payroll_batch_items`, `payroll_batch_events` | #893: durable creation-time snapshots (source hours + worker/earnings mappings by immutable Xero ids) — **immutable once locked (DB-trigger-enforced)**; corrections supersede via `supersedes_batch_id`, never mutate; events are append-only. The store #249 will export from and #250 reconciles against. No Xero writes exist yet |
| Notifications / outbox | `outbox_events` | job-runner spine ([#160]) |
| Job types | `job_types` *(Phase 2a)* | **FK not wired — see §3** |
| Suppliers / contacts | `suppliers` (+`supplier_branches`/`supplier_contacts`/`supplier_products`), `wholesalers`, `contacts` *(Phase 2a)* | **FK not wired — see §3**; `contacts` is **per-job** (`jobs/<jobId>/contacts.json`) |

## 2. FREE-TEXT / DEFERRED (table may exist but is unwired, or kept as an attribute)

- **Pricing** — blob (`pricing.json`, `*-estimate.json`); `supplier_products` is the start of a price book but unpopulated.
- **Job type** — `jobs.job_type_label` (text) is still authoritative; `job_types` orphaned until FK.
- **Supplier on a request** — `material_requests.supplier` / `assets.hire_supplier` (text) authoritative; `suppliers` orphaned until FK.
- **Notification prefs** — `user_profiles.notificationPrefs` object inside `users.json` (attribute is acceptable).
- **Plan markups / as-built** — blob `jobs/<jobId>/drawing-markups.json` (+ `src/domains/plan-markups`).

## 3. FK-wiring debt (deferred from Phase 2a — concrete, low-risk, additive)

Phase 2a added the *referenced* registries but **not** the *referencing* FK columns,
so the free-text columns remain authoritative and nothing joins to the registries:

1. `jobs.job_type_id` → `job_types` (keep `job_type_label` as fallback)
2. `material_requests.supplier_id` → `suppliers`
3. `assets.hire_supplier_id` → `suppliers`

**Plan:** add the three nullable FK columns as a reviewed migration; backfill by
name during each domain's dual-write cutover; keep the text columns until backfill
is proven. Also persist **`task_dependencies`** (task→task edge) and
**`task_blockers`** keyed on `tasks.id` (today they are derived read-models) — never
as area arrays.

## 4. NOT MODELLED YET → next migration clusters

| Cluster | Tables | MVP first | Phase |
|---|---|---|---|
| **A. Commercial** (the #120 originate→quote gap) | `quotes`, `quote_lines`, `quote_revisions`, `variations` (+ work_at_risk), `dayworks_dockets`, price-book join to `supplier_products` | `quotes`+`quote_lines`+`variations` | 2b |
| **B. Field-ops facets** | `drawing_revisions`, `plan_markups`/`as_built`, `rfis` (graduate the `observations` stub), gear-scan log | `drawing_revisions`+`plan_markups` | 3 |
| **C. Workforce compliance** | `worker_licences` (+expiry), `leave_requests`, labour-`tags`/`temps` | `worker_licences`+`leave_requests` | 3 |
| **D. Platform / access** | `push_subscriptions` (extract from `users.json`), `access_requests`, `invites`, `notification_prefs` (or keep attribute), `site_visits` (keep derived) | `push_subscriptions`+`access_requests`+`invites` | 4 |
| **E. Analytics** | `feature_events` (telemetry — none today) | none required | 5 |

**Reports/KPIs and Site-visits are projections — they stay derived, never tables.**

## 5. Binary bytes

Photo/PDF **bytes stay in Vercel Blob**; Postgres holds only metadata + refs
(`evidence_files`, `documents`). A future decision (its own issue) may move bytes
to Supabase Storage for resumable uploads + image transforms — out of scope here.
