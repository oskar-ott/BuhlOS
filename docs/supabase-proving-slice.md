# Supabase read-only proving slice (#533)

The first place the deployed app actually reads Supabase Postgres — built as
conservatively as possible so it proves the runtime path without putting any
real data or production project at risk.

## What it is

`GET /api/supabase-health` ([api/supabase-health.js](../api/supabase-health.js)) —
an admin-only diagnostic that connects to Supabase through the shipped client
([api/_lib/supabase-db.js](../api/_lib/supabase-db.js)) and reports a few health
facts (public table count, migration count, server version). Nothing else in
the app touches the database yet; this endpoint is the proof that the
`supabase-env guard → Supavisor transaction pooler → Postgres.js` path works on
a real Vercel deployment.

## Four locks (why it's safe to merge)

1. **Admin only** — `requireAuth(req, res, { roles: ['admin'] })`; field/LH/client → 403, anon → 401.
2. **Dark by default** — gated by the `supabase_read_health` feature flag
   ([docs/feature-flags.md](feature-flags.md)). Off → the endpoint returns
   `{ enabled: false }` and never opens a connection. Merging changes nothing live.
3. **Read-only** — three `SELECT`s (counts + `version()`), no writes, no business data.
4. **Guarded** — `getDb()` runs the [env guard](supabase-environment.md) before
   connecting. A preview/dev runtime can only reach a non-production project; a
   production runtime with no `SUPABASE_*` wired throws and is reported as
   `{ ok: false }` (HTTP 502) — never a silent connection or write.

## Responses

| Condition | HTTP | Body |
|---|---|---|
| Flag off | 200 | `{ enabled: false }` |
| Flag on, healthy | 200 | `{ enabled: true, ok: true, supabaseEnv, projectRef, publicTables, migrations, server, asOf }` |
| Flag on, connect/auth failure | 502 | `{ enabled: true, ok: false, error }` |

## Verifying on a PR preview

Previews are the verification surface (local `next dev` can't run `api/*.js`).
For the preview that should exercise this, set — **scoped to the PR branch, dev
project only**:

- `SUPABASE_ENV=preview`
- `SUPABASE_PROJECT_REF=frovgpywsopbeuekijmo` (Buhlos-dev)
- `SUPABASE_DB_URL=` the dev Supavisor transaction-pooler URL (port 6543; any
  `%`/`#`/`&` in the password percent-encoded)
- `FLAG_SUPABASE_READ_HEALTH=1`

Then sign in as an admin and hit `/api/supabase-health`. A healthy response
shows a non-zero `publicTables` (31 base tables at the dev schema today),
a `migrations` count (2 today), and a `PostgreSQL …` server string. Those
figures are read live from the dev database and will drift if its schema
changes — they're a liveness signal, not invariants.

Production is intentionally left unwired; the flag stays off there.

## Where this sits in the migration

This is the read precursor to the per-domain dual-write rollout
(`supabase_dual_write`, #152). It proves connectivity and the client/guard
contract; the first *data* proving slice (read a migrated domain and compare to
the blob) and the importers come next, against the dev project first.
