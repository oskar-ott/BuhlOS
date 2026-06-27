# Supabase foundation — operator runbook (#532)

> **Audience:** an operator with Supabase org access **and** Vercel project
> access. This is the ordered checklist to stand up Supabase connectivity safely.
> The **repo side is already done** (guard, client, migrations, dry-runs — see
> "Repo state" below); every remaining step is an **operator/cloud action** that
> cannot be done from the repo and must not be faked. Pair this with the contract
> in [supabase-environment.md](supabase-environment.md) — that doc is authoritative
> for variable names, values and the guard's error codes; this doc is the
> ordered "do these, in this order, and check this gate" list.

## Repo state (already on `main` — do NOT redo)

- **Fail-closed env guard** `api/_lib/supabase-env.js` (`assertSupabaseAccess`),
  tested (`src/domains/platform/supabase-env.test.ts`). Nothing calls it yet by
  design.
- **Guarded Postgres client** `api/_lib/supabase-db.js` (lazy singleton,
  transaction-pooler config), guarded before any network touch (#531).
- **Migrations** committed + version-aligned:
  `supabase/migrations/20260611142758_phase1_core_schema.sql` (applied to
  production 2026-06-11) and `20260611212723_phase1_hardening.sql` (**drafted,
  not yet applied** — step 2).
- **Dry-run parity** validated against live Blob data:
  [supabase-structure-dry-run-report.md](supabase-structure-dry-run-report.md),
  [supabase-hours-dry-run-report.md](supabase-hours-dry-run-report.md),
  importer strategy in [supabase-importer-plan.md](supabase-importer-plan.md).
- **Feature flag** `supabase_dual_write` exists, **dark by default** (#152,
  [feature-flags.md](feature-flags.md)). Do not flip it as part of foundation.

Production project ref: **`wetctlrhsycfwhuxlarv`** (ap-southeast-2). It holds the
Phase-1 schema, RLS on, **zero rows**.

## Steps (each has an acceptance gate — do not proceed past a red gate)

### 1. Link the Supabase CLI to production

```bash
# requires the Supabase CLI installed locally and an access token
supabase init                      # creates supabase/config.toml (currently absent)
supabase link --project-ref wetctlrhsycfwhuxlarv
supabase migration list            # local vs remote
```

- **Gate 1:** `supabase migration list` shows the two committed migrations and
  marks `20260611142758_phase1_core_schema` as applied on remote.
- Commit the generated `supabase/config.toml` (repo currently has none) in a
  follow-up PR so the link is reproducible. It carries no secrets.

### 2. Apply the drafted hardening migration to production

```bash
supabase db push                   # applies 20260611212723_phase1_hardening.sql
```

- **Gate 2:** `supabase migration list` shows the hardening migration applied;
  `supabase db lint` / the project **advisors** report no new security warnings
  (search_path pins + RPC `REVOKE` are the point of this migration).

### 3. Create the dev/staging Supabase project

The org currently has **one** project (production). Create a **second, free-tier**
project for Preview/Development, then apply the same migrations to it:

```bash
supabase link --project-ref <dev-ref>
supabase db push                   # both migrations onto the dev project
```

- **Gate 3:** the dev project lists both migrations applied and has the 31-table
  Phase-1 schema (RLS on). Record `<dev-ref>` for step 4.

### 4. Wire Vercel environment variables (per-environment, never shared)

Set these **separately per Vercel environment** (Production / Preview /
Development) per [supabase-environment.md](supabase-environment.md#environment-variable-contract).
Summary:

| Vercel env | `SUPABASE_ENV` | `SUPABASE_PROJECT_REF` / `SUPABASE_DB_URL` | `SUPABASE_ALLOW_PRODUCTION_WRITES` |
|---|---|---|---|
| Production | `production` | `wetctlrhsycfwhuxlarv` / prod pooler URL | `true` **only when dual-write actually starts** |
| Preview | `preview` | `<dev-ref>` / dev pooler URL | unset |
| Development | `development` | `<dev-ref>` or local stack | unset |

- Use the **Supavisor transaction pooler** (port 6543) for `SUPABASE_DB_URL`.
- **Never** create `NEXT_PUBLIC_*` variants. DB URLs are server-only.
- **Gate 4 (defence-in-depth check):** confirm the guard fails closed. With a
  temporary preview deploy, set the **production** ref in the Preview scope and
  verify the app throws `PROD_REF_IN_NON_PROD_RUNTIME` (Vercel's own `VERCEL_ENV`
  catches it regardless of what `SUPABASE_ENV` claims). Then revert to `<dev-ref>`.
  This proves a preview can never reach production data.

### 5. Upgrade production to Pro (before any real data lands)

- Free tier has no daily backups / PITR. Upgrade the **production** project to
  **Pro** before the first real-data seed or dual-write.
- **Gate 5:** daily backups enabled on `wetctlrhsycfwhuxlarv` (PITR add-on if
  required by the data-retention decision). Billing owner sign-off recorded.

## What is still operator-owned (cannot be a code PR)

- Supabase CLI auth + project linking (steps 1–3).
- Creating the dev project + its credentials.
- Vercel per-environment variable values (real connection strings + the prod
  write opt-in) — secrets, never committed.
- The Pro upgrade + billing decision.

## After this runbook

Foundation complete → the next slice is **`supabase_dual_write` behind the flag**,
one domain at a time (hours first, per the dry-run parity), still dark by default.
That is tracked separately (#152/#533) and is **not** part of standing up
connectivity.

Once the dual-write + read overlays are merged (they now are, all dark), the
**operator** sequence to actually turn them on in production — backfill, enable
dual-write, then flip the read flags tier-by-tier under the readiness probes, with
instant rollback — lives in
[architecture/supabase-read-enablement-runbook.md](architecture/supabase-read-enablement-runbook.md).
