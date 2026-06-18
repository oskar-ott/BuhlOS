# Supabase environment safety

The production Supabase project is **`wetctlrhsycfwhuxlarv`** (ap-southeast-2).
It currently holds the Phase 1 schema (31 tables, RLS on, zero policies, zero
rows) and will eventually hold payroll-critical data. PR previews are this
repo's main verification surface, so the single most dangerous
misconfiguration is a preview or local run pointed at the production
database. The guard in [`api/_lib/supabase-env.js`](../api/_lib/supabase-env.js)
makes that combination throw instead of write.

> **Operator setup:** the ordered checklist to stand up connectivity (CLI link,
> dev project, per-env Vercel wiring, Pro upgrade) lives in
> [supabase-foundation-runbook.md](supabase-foundation-runbook.md). This doc is the
> contract; that doc is the step-by-step with acceptance gates.

## Non-negotiables

- **Production Vercel points at production Supabase only.**
- **Vercel Preview points at a dev/staging Supabase project — never production.**
- **Local development points at a local Supabase stack or a dev project — never production.**
- Production writes additionally require the explicit opt-in
  `SUPABASE_ALLOW_PRODUCTION_WRITES=true` (exact lowercase string).
- Database URLs and any service-role credentials are **server-only**. They are
  read inside `api/*` / server code and never sent to the browser.
- **Never** create `NEXT_PUBLIC_*` variants of any database secret.
- **Importer execution must not happen without this guard** — every DB
  client, importer or script calls `assertSupabaseAccess()` before opening a
  connection. (The guard ships ahead of the first client; nothing calls it
  yet, and no DB client dependency exists in the repo yet.)

## Environment variable contract

| Variable | Required | Values / shape | Notes |
|---|---|---|---|
| `SUPABASE_ENV` | yes | `production` \| `staging` \| `preview` \| `development` \| `local` | Declares which database tier this process *believes* it talks to. Missing/invalid → guard throws. |
| `SUPABASE_PROJECT_REF` | yes | project ref string | `wetctlrhsycfwhuxlarv` is production. Anything else is treated as non-production. |
| `SUPABASE_DB_URL` | yes | Postgres connection string | Runtime traffic should use the Supavisor transaction pooler (port 6543). The guard cross-checks the ref embedded in this URL against `SUPABASE_PROJECT_REF` — a paste error in either direction throws. |
| `SUPABASE_ALLOW_PRODUCTION_WRITES` | prod writes only | exactly `true` | Only ever set in the Vercel **Production** environment (and deliberate operator shells). Leave unset everywhere else. |
| `SUPABASE_READONLY_DB_URL` | optional, later | Postgres connection string | For read-only proving slices / reporting if a separate role is provisioned. |
| `SUPABASE_SERVICE_ROLE_KEY` | not now | — | Prefer the direct Postgres URL for server SQL. Only add if a Data-API use case appears; server-only if ever added. |
| `SUPABASE_ANON_KEY` | not now | — | Only relevant in the far-future browser/RLS phase. Not part of this contract today. |

## Vercel setup (per-environment scoping)

Set the variables separately per environment in the Vercel dashboard — never
as a single shared value:

| Vercel environment | `SUPABASE_ENV` | `SUPABASE_PROJECT_REF` / `SUPABASE_DB_URL` | `SUPABASE_ALLOW_PRODUCTION_WRITES` |
|---|---|---|---|
| Production | `production` | production project (`wetctlrhsycfwhuxlarv`) | `true` (only once dual-write work actually starts) |
| Preview | `preview` | dev/staging project (to be created — does not exist yet) | unset |
| Development | `development` | dev project or local stack | unset |

Defence in depth: even if production values leak into the Preview scope, the
guard also reads Vercel's own `VERCEL_ENV` — a preview/development deployment
carrying the production ref throws `PROD_REF_IN_NON_PROD_RUNTIME` regardless
of what `SUPABASE_ENV` claims.

## Operator scripts (future importers)

Importers and one-off scripts run outside Vercel (`VERCEL_ENV` absent).
Production access from an operator shell is a deliberate double opt-in:
`SUPABASE_ENV=production` **and** `SUPABASE_ALLOW_PRODUCTION_WRITES=true`
(plus the production ref/URL). Anything less throws. Dev-project runs need no
flags beyond the dev ref/URL.

## Using the guard

```js
const { assertSupabaseAccess } = require("./_lib/supabase-env");

// before opening any connection:
const decision = assertSupabaseAccess({ mode: "read" }); // or { mode: "write" }
```

`mode` defaults to `"write"` — the strictest gate — so forgetting to declare
read intent can only over-protect. Error codes are stable and tested
(`src/domains/platform/supabase-env.test.ts`): `MISSING_ENV`, `INVALID_ENV`,
`INVALID_MODE`, `REF_URL_MISMATCH`, `PROD_REF_IN_NON_PROD_ENV`,
`PROD_REF_IN_NON_PROD_RUNTIME`, `PROD_WRITES_NOT_ALLOWED`, `BROWSER_CONTEXT`.

## Current status (2026-06-12)

- Guard + tests exist; **nothing calls the guard yet** — no DB client
  dependency, no `SUPABASE_*` variables are set in any environment, and no
  production route touches Postgres.
- The dev/staging Supabase project does not exist yet; create it before
  wiring Preview variables.
- The feature-flag registry already defines `supabase_dual_write`
  (dark by default) for the eventual cutover
  ([docs/feature-flags.md](feature-flags.md)).
- Migration files are committed and version-aligned under
  [`supabase/migrations/`](../supabase/migrations/); applied state and
  roadmap context live in
  [docs/supabase-migration-research-audit.md](supabase-migration-research-audit.md).
- Test/smoke awareness: vitest and Playwright runs set no `SUPABASE_*`
  variables, so any accidental guard call in tests fails closed
  (`MISSING_ENV`). Preview smoke runs will use the Preview-scoped dev-project
  variables once they exist.
