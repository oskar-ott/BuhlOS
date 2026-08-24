# BuhlOS / Phil — Market Readiness v1

> **Purpose:** the durable, evidence-backed release gate for putting BuhlOS in the
> hands of a **paying external electrical contractor**. This supersedes the
> stale `ROLL_OUT_STATUS.md` / `KNOWN_LIMITATIONS.md` verdict (snapshot
> `main @ 55ca30c`, 2026-06-05, pre-lean-reset — it still says "Payroll/Xero NOT
> BUILT", which is false). Read this first; treat the older pack as history.

| | |
| --- | --- |
| **Snapshot** | `main @ 2fe6907e`, 2026-08-24 |
| **Method** | Repo + code + production config + Supabase + Blob evidence (read-only). Adversarial auth/IDOR, payroll money-path, and hidden-surface reviews. No production data mutated; no direct prod deploy. |
| **Companion (stale)** | [ROLL_OUT_STATUS](./ROLL_OUT_STATUS.md) · [KNOWN_LIMITATIONS](./KNOWN_LIMITATIONS.md) — pre-lean-reset, do not rely on their verdicts |

---

## 1 · Executive verdict

**READY FOR A FOUNDER-SUPPORTED EXTERNAL DESIGN PARTNER — on a dedicated,
per-company deployment only. NOT ready for shared-instance private beta, and NOT
ready for public self-serve.**

The lean core (hours → approval → Xero draft timesheets, jobs, evidence/photos,
employees, gear, simple ITP) is genuinely sound: auth and object-scoping survived
an adversarial pass with **no P0/P1**, hours are stored collision-free per worker,
the Xero export is unusually well-defended, and there is a real backup/restore
story. The blocker to *multi-company* use is not a bug — it is the **architecture**:
the product is **single-tenant by construction** at every layer, so a second
company cannot share this instance safely, and there is no company-provisioning
path. A second contractor is served today only by **standing up a separate
deployment** (own Blob store, own Supabase tenant, own env) — a legitimate
design-partner model that this document gates.

---

## 2 · Verified live product boundary (2026-08-24)

Feature-flag resolution in production (env override > blob override > registry
default), not the registry defaults:

**Live (kill-switches ON):** `jobs`, `hours`, `evidence`, `employees`, `gear`,
`job_photos`.
**Live (blob-override ON):** `xero_connection`, `xero_payroll_export`,
`itp_simple`, `signup_link`, `job_materials_spend`.
**Live (env ON):** `phil_sharpened`, `phil_job_rooms`, `phil_jobs_summary_read`.
**Dark (correct):** every other flag — `quotes`, `snags`, `defects`, `dayworks`,
`observations`, `material_requests`, `servicem8_sync`, `job_builder_redesign`,
all `ai_*`, heavy ITP/QA, client portal. The 2026-07-27 gut left almost no
user-facing residue; the two dead builder buttons it did leave are fixed in the
PR that accompanies this doc.

> **Caveat — Supabase cutover state is env-dependent and was not fully
> verifiable from this checkout.** `prev.env` (stale) sets many
> `FLAG_SUPABASE_READ_*` / `_DUAL_WRITE_*` to on; the true current Vercel
> production env for these was not readable here. Blob remains the documented
> source of truth regardless (§5). Confirm the live Supabase read/dual-write
> posture from the Vercel dashboard before relying on it.

---

## 3 · The tenancy gate (the defining constraint)

**BuhlOS is single-tenant by construction. Evidence:**

- **Auth** — the session cookie payload is `{ userId, role, exp }`. There is **no
  company/tenant field** anywhere (`src/lib/auth/session.ts`, `api/_lib/auth.js`).
- **Blob store (authoritative)** — global keys with no tenant dimension:
  `jobs.json`, `users.json`, `users/<id>/time-entries/<date>.json`,
  `jobs/<id>/…`. A grep for tenant/company scoping in the store returns nothing.
- **Postgres** — the API connects with a **privileged `SUPABASE_DB_URL`** (a
  service-level connection, `api/_lib/supabase-db.js`), so RLS is **not** the
  app-layer enforcement boundary; and every query is scoped to a **hardcoded
  single tenant**: `select id from public.tenants where slug = 'buhl'`
  (`api/_lib/hours-read.js`). `public.tenants` holds **1 row**.
- **No provisioning path** — nothing creates a company/tenant. PR #781 provisions
  an *owner login*, not a company.

**Consequences (launch gates):**

| Scenario | Verdict | Why |
|---|---|---|
| Public self-serve SaaS | **FAIL — P0** | Cannot onboard companies; no tenant model, no provisioning. |
| Shared-instance private beta (2nd company on THIS deployment) | **FAIL — P0** | No tenants exist; company B's data would live in the same global `jobs.json` / `users.json` as company A — every worker and admin would see everything. |
| **Dedicated deployment per customer** (own Blob + Supabase tenant + env), founder-provisioned | **PLAUSIBLE** | Isolation is the deployment boundary, not an app boundary. Requires the provisioning runbook (§9) and the per-instance gates below. |

This is not a defect to "fix" in a session; multi-tenancy is a deliberate future
architecture (`docs/architecture/*`, Supabase strangler #152/#153). Until it
lands and is enforced with a **per-request tenant identity**, the only safe
external model is one instance per customer.

---

## 4 · Security verdict (adversarial pass)

**No P0/P1.** Every money/hours/cost-rate/employee/payroll endpoint enforces its
role tier server-side; cross-user object access is scoped; roles cannot be
self-escalated (the `users.js` PUT allowlist omits `role`; `VALID_ROLES` excludes
`owner`); sessions are HMAC-verified (`timingSafeEqual`) and fail closed without
`SESSION_SECRET`; cookies are `HttpOnly + Secure + SameSite=lax`; invite/signup
tokens are bcrypt-hashed, single-use, expiry/revoke-checked, and public signup is
restricted to field roles.

Hardening items (this PR closes the first; the rest are issues):
- **Fixed here:** a field worker could read a **job-target audit feed**
  (`?targetType=job`) carrying `job.material_spend_added` entries (supplier +
  date; the $ amount is excluded from the journal by design). The field-role
  narrowing was evidence-only; it now filters non-evidence targets to
  actor-only. (`api/audit-log.js`.)
- **Watch-item (issue):** `decodeSessionCookie` does **not** verify the HMAC;
  `middleware.ts` and ~40 server pages gate on it. Not a breach today — every
  sensitive byte comes from an HMAC-verifying `api/*` call, so a forged cookie
  yields an empty/error shell — but a future server page that renders sensitive
  data from an in-process `api/_lib` read gated only by the decoded role would
  become a real bypass. Resolve identity via the verifying path before any
  in-process sensitive read.
- **By design (on record):** "every worker works every job" — `assignedJobIds`
  is **not** an access boundary for field-tier job data (structure, evidence
  create, photos, task state, hours attribution to any active job). Money is
  redacted and other workers' *live* hours stay scoped, so sensitive categories
  don't leak. Sessions are stateless 30-day tokens with no server-side
  revocation; disabling a user and role changes take effect live, but a password
  change does not invalidate existing cookies.

---

## 5 · Data-safety verdict

- **Source of truth: Vercel Blob**, last-write-wins JSON documents. **Nothing is
  a transactional system of record** — the central, standing caveat.
- **Hours are collision-safe under load:** stored per-user-per-day
  (`users/<id>/time-entries/<date>.json`), so a whole crew logging simultaneously
  **never collides**. Durability against a stale read is backed by a per-worker
  localStorage saved-entries journal + merge overlay, a per-user append-only
  audit journal (`users/<id>/time-entries-audit/<yyyy-mm>.json`), and daily
  backups.
- **Residual last-write-wins on shared docs (#934, P1):** `jobs/<id>/tags.json`,
  `leave-requests.json`, and the `jobs.json` create path still write without the
  `expectedRev` CAS the other stores use — a concurrent second writer can clobber
  the first. Audited and accepted at 10-user scale; must be closed before broad
  release.
- **Backups/recovery (defensible):** daily cron snapshot of every canonical store
  to `backups/<date>/` with retention pruning (`api/backup-snapshot.js`); a
  dry-run-by-default restore script that first copies the live doc to
  `backups/pre-restore-<ts>/` (`scripts/backup-restore.js`); runbook in
  `docs/backups.md`. **Gap:** Supabase PITR is a human step (#897/#532) — confirm
  it is enabled per env; a restore drill has not been run recently.
- **Scale latent (#935, P1):** several hours endpoints still
  `list({ prefix:'users/', limit:5000 })` without pagination; at ~50 blobs/week
  the 5000 cap is ~2 years out, but it silently truncates rather than erroring.
  The per-job money read, two core walks, and (2026-08-24, PR #1036) the
  payroll row engine are paginated; the rest remain.
- **INCIDENT + FIX (2026-08-24, wk34, PR #1036):** the payroll print-out
  silently dropped freshly-approved days — just-overwritten day blobs served
  their pre-approval content from the CDN, still read "submitted", and the
  approved filter removed real hours with no error. Fixed at the ONE row
  engine (`api/_lib/payroll-inputs.js`): every entry read is verified against
  the blob's last-PUT time vs the entry's own write stamps; a stale read is
  retried briefly, then the WHOLE collection refuses with a 503 naming the
  affected days; unreadable blobs refuse the same way. Every payroll artifact
  (CSV, PDF, timesheet email, Xero batch create/lock) inherits the guarantee:
  **complete, or it does not exist.** Note for the "just read Supabase"
  instinct: at incident time PG *lagged* Blob (dual-write gated off in the
  live env; approvals reach PG via the daily sync), so a PG-first read would
  have been worse — the #152 strangler stays the long-term cure behind its
  documented flip prerequisites.

---

## 6 · Xero payroll verdict (money path)

**Draft-timesheet export only — the pay run stays in Xero. Well-defended, with
one serious concurrency gap.**

**Verified safe (mostly trigger-backed):** batch immutability (DB triggers
`tg_payroll_batch_guard` / `_items_guard` freeze the snapshot once locked);
org-scoping (export refuses `org_mismatch`; mappings are org-scoped; reconnect to
a different org resets the link so prior-org employees read unmapped and block);
mapping completeness (unmapped worker / earnings-rate / calendar → **named
blocker**, never a silent drop); accepted-vs-verified readback (a POST 200 is not
"exported" until a readback field-compare passes; a crash between accept and
readback re-runs **readback only, never a second POST**); XML-error-body parsing;
token refresh under CAS; period alignment (client-supplied Sydney date + exact
calendar-period equality, else block); and the legacy CSV finalise path is now
`410` (POST), closing the dual-path double-pay trap.

**P0 — concurrent export can double-POST a batch (issue filed).** Idempotency is
an app-level `SELECT` over a **non-unique** index with no advisory lock / no
`FOR UPDATE` / no unique constraint, and the admission logic admits a second
runner while status is already `exporting`/`partially_exported`
(`api/_lib/xero/timesheet-export.js`). Two concurrent export requests — the
mobile closeout finale and the desktop panel both firing, a refresh-then-reclick,
a second admin, or a network retry — can each POST a draft timesheet per
employee → **duplicate draft timesheets**. Caught only by (a) DRAFT-only (a human
still assembles the pay run in Xero, so a duplicate is *catchable*, not
auto-paid) and (b) a single-session frontend `busy` guard. **Production has zero
existing duplicate accepted attempts** (verified), so the definitive fix — a
partial unique index on `payroll_batch_timesheet_attempts
(external_tenant_id, employee_id, period_start, period_end) WHERE
outcome='accepted'` — would apply cleanly, but it is a reviewed prod migration,
not a drive-by. **Interim gate: export must be a single-operator, single-session
action, and duplicate drafts must be checked in Xero before the pay run is built.**

---

## 7 · Journey verification

| Journey | Result | Evidence |
|---|---|---|
| A — New company usable | **FAIL** | No provisioning / no tenant model (§3). Per-company deployment only, via runbook (§9). |
| B — New worker onboarding | **PASS (code)** | `signup.js`/`invites.js` — bcrypt single-use tokens, expiry/revoke, duplicate-email block, field-role-only public signup; disabled/archived users can't authenticate. Not walked on a device this session. |
| C — Create a job | **PASS (code)** | admin/LH gated; slug dedupe converges same-job double-create; concurrent *different*-job create is the #934 gap. |
| D — Worker records hours | **PASS (code + fixed)** | per-user-per-day keys; standard-day + custom OT + split + day-types; 14-day backdate; **weekend backfill fixed 2026-08-24 (#1030)**; saved-entries journal prevents vanish. |
| E — Boss reviews the week | **PARTIAL** | Works; `/hours/weekly` (board) and `/hours/approvals` (queue) coexist — potential operator confusion, and #1022 (3-step pay run redesign) is an open PR. Decide the single approval path. |
| F — Payroll export | **PARTIAL — P0 open** | Strong except the concurrent double-POST (§6). |
| G — Capture / photos | **PASS (code)** | evidence per-job, field GET scoped to own captures, writes behind `canWrite`; dead snag lightbox link fixed here. Upload failure modes not device-walked. |
| H — Tags / gear | **PARTIAL** | tags write without CAS (#934); **Gear nav lands on a "Coming soon" placeholder** on a primary Phil tab — decision issue (§8). |
| I — Simple ITP | **NOT WALKED** | `itp_simple` live on Phil (`/phil/jobs/[id]/itp-reports`); mobile ergonomics + PDF retrieval not device-verified this session. |

---

## 8 · Blockers by severity

**P0 — external launch blockers**
1. **Tenancy / no multi-company isolation or provisioning** (§3). Gate: per-company deployment only until a per-request tenant identity + enforcement lands.
2. **Xero concurrent double-export** (§6). Gate: single-operator export + Xero duplicate check until the DB unique index (or admission lease) ships.

**P1 — before charging broadly**
3. Shared-store last-write-wins — tags / leave / job-create (#934).
4. Hours-walk 5000-blob cap, unpaginated (#935).
5. Approval-path duplication (`/hours/weekly` vs `/hours/approvals`; #1022 open) — pick one.
6. **Gear primary tab shows "Coming soon"** — decision: ship the register or flip the `gear` kill-switch off (removes the nav slot). A live nav slot to an unbuilt feature is the one clear breach of the "hide what isn't built" rule.
7. Unverified-cookie server-page trust — hardening before any sensitive in-process page read (§4).
8. Supabase PITR + a restore drill (#897/#532); confirm the live Supabase read/dual-write posture (§2 caveat).

**P2 — private-beta polish**
9. Field-worker access to legacy `hours.js` GET (stale/empty store) — 403 it.
10. Stale `middleware.ts` PROTECTED entries + orphaned dark-route components (dead code, non-user-facing).
11. Push (VAPID) is dark — don't build launch-critical flows on push (current flows don't).

---

## 9 · Provisioning runbook — a new design-partner company (per-deployment model)

Until multi-tenancy lands, each customer = its own deployment. Repeatable steps
(founder-run; several are human-only):

1. New Vercel project (or a fresh env scope) + its **own** `BLOB_READ_WRITE_TOKEN`
   (separate Blob store — the isolation boundary).
2. Its own Supabase project (or a genuinely separate tenant row + verified RLS)
   and `SUPABASE_DB_URL`; enable **PITR** (§5).
3. Env: `SESSION_SECRET` (unique per deployment), `EMAIL_FROM` + `RESEND_API_KEY`
   (email works; **VAPID push is dark**), feature-flag env to match the live
   boundary (§2), Xero app creds if that customer uses the export.
4. Seed `users.json` with the owner/admin; create the owner login (PR #781 path).
5. Confirm the daily backup cron is active for the new store.
6. Xero: the customer connects their **own** org; verify org id + worker mappings
   before the first export; keep export single-operator (§6).

**A second company must never be added to an existing deployment** until §3 is
resolved.

---

## 10 · Definition of the next gates

- **Founder-supported design partner (per-deployment):** achievable now once (a)
  the Xero export is run single-operator with the duplicate-check discipline (or
  the unique index ships), (b) the provisioning runbook is walked once end-to-end,
  and (c) the critical mobile journeys (D/E/G/I) are device-verified on the
  partner's own instance.
- **Broader paid release:** requires closing the P1 set (esp. #934, the approval
  path, the Gear decision) and the Xero unique-index fix merged.
- **Public self-serve:** requires real multi-tenancy — per-request tenant
  identity, tenant-scoped storage, enforced isolation, self-serve provisioning,
  billing, and a data export/deletion process. Out of scope for v1.

---

## 11 · Change log against this gate

- 2026-08-24 (`hardening/market-readiness-residue`): removed two dead Job Builder
  Deliver buttons (`/itps`, `/rfis` — gutted routes); fixed the admin search
  placeholder ("snags" was a dark feature); removed the dead photo-lightbox snag
  link; closed the field-role job-target audit read (§4). No architecture change.
