# Feature flags (#155)

Merge unfinished work **dark**, stage it to the admin tier first, switch off
a misbehaving feature without a revert deploy. Backs the standing rule:
half-broken UI is hidden or labelled, never shipped live.

## The registry

One source of truth: [api/_lib/feature-flags.js](../api/_lib/feature-flags.js)
(+ `.d.ts` for typed `src/` consumption — add new keys to **both**, same PR).
Every flag declares a description, `default: false` (always), a target, and
an **expiry date** — flags are temporary by default, and
`npm run check:flag-expiry` (CI) fails the build once a flag outlives its
date: delete it (and the dead branch it guarded) or consciously extend it.

| Flag | Target | Expires | What it gates |
|---|---|---|---|
| `supabase_dual_write` | global | 2026-09-30 | Mirror blob writes into Supabase per migrated domain (#152) |
| `admin_flags_readout` | admin-tier | 2026-09-30 | The active-flags readout card on /command-centre |
| `admin_job_field_view` | admin-tier | 2026-09-25 | The Office/Field view toggle + read-only Phil job render on `/v2/jobs/[jobId]` (mobile-admin redesign) |
| `admin_proof_review` | admin-tier | 2026-09-25 | The office Proof-to-sign-off approve/send-back surface + Command Centre queue (#503) |
| `supabase_read_health` | global | 2026-12-31 | `GET /api/supabase-health` — the read-only Supabase connectivity proving slice (#533) |
| `supabase_read_hours` | global | 2026-12-31 | Serve the hours display read (`listUserEntries`) from Postgres with a Blob fallback (#152) |
| `supabase_dual_write_jobs` | global | 2026-12-31 | Mirror one job's `jobs.json` structure write into Postgres, best-effort, Blob authoritative (#152, J8) |
| `supabase_dual_write_tasks` | global | 2026-12-31 | Reconcile task status from `data.json` into Postgres (cron, off request path), Blob authoritative (#152, J9) |
| `supabase_dual_write_evidence` | global | 2026-12-31 | Reconcile evidence metadata from `data.json` into Postgres evidence_files/links (cron, off request path), Blob authoritative (#152) |
| `supabase_read_jobs` | global | 2026-12-31 | Serve the ADMIN jobs read from Postgres, per-job parity-gated, with a Blob fallback (#152, J5/J6) |
| `supabase_read_phil_jobs` | global | 2026-12-31 | Serve the FIELD/Phil jobs read from Postgres, per-job parity-gated, visible-scoped, with a Blob fallback (#152, J7) |
| `supabase_read_phil_tasks` | global | 2026-12-31 | Serve the FIELD task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J10) |
| `supabase_source_tasks` | global | 2026-12-31 | Write task status to Postgres with CAS at request time (`/api/task-toggle`) + Blob write-through; parity-gated read (#152, PG-as-source Stage A) |
| `supabase_read_admin_tasks` | global | 2026-12-31 | Serve the ADMIN task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J11) |
| `supabase_read_admin_evidence` | global | 2026-12-31 | Serve the ADMIN evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |
| `supabase_read_phil_evidence` | global | 2026-12-31 | Serve the FIELD/Phil evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |

## Flipping a flag

Resolution order — first hit wins:

1. **Env var** `FLAG_<SNAKE_UPPER>` (`FLAG_SUPABASE_DUAL_WRITE=1`) — set in
   Vercel env, takes effect on the next deploy. Beats everything, both
   directions (an env `0` force-disables a blob-enabled flag).
2. **Runtime override** — the `flags.json` blob:
   `{ "flags": { "supabase_dual_write": true } }`. No deploy needed; rides
   the 5s `readBlob` TTL cache so it costs nothing on hot paths. (It's in the
   backup manifest like every canonical store.)
3. **Registry default** — always `false`. Dark by default.

**Targeting applies on top:** an `admin-tier` flag is only ever on for
admin-tier viewers (tier-aware `isAdminRole` — the role-literal guard applies
here like everywhere). `global` ignores the viewer.

**Owner Console controls flags (#760).** `/owner` (`docs/owner-console.md`)
displays every flag's resolved state, **source** (env > blob > default), target,
and expiry classification — and for non-protected flags it now **toggles** them
at runtime via `POST /api/owner-flags` (owner-gated, CAS-guarded on `flags.json`,
audited with the `feature_flag.toggled` action). Two dials per flag: **Live to
customers** (the `flags.json` baseline) and **Preview for me** (an owner-only
`ownerPreview` override). Protected data-plane flags (`supabase_*`,
`phil_jobs_summary_read`) stay read-only there, and env (`FLAG_*`) always wins.
The viewer-aware resolver `isFlagEnabled` applies owner-preview **only** for the
stored `owner` role; the data-plane `isFlagOn`/`isFlagOnSync` path never reads
`ownerPreview`. Per-feature config knobs ride the same surface via
`PUT /api/owner-settings` (#760 PR2). You can still flip a flag per-environment
via the env var or the blob as above.

## Using a flag

```js
// api/*.js (CJS)
const { isFlagEnabled } = require('./_lib/feature-flags');
if (await isFlagEnabled('supabase_dual_write')) { /* dark path */ }
```

```ts
// src/ server components / route handlers
import { isFlagEnabled, flagsForViewer } from "../../../../api/_lib/feature-flags.js";
const show = await isFlagEnabled("admin_flags_readout", session);
```

Client components never read flags directly — a server component resolves
`flagsForViewer(session)` and passes the booleans down. Never serialize the
raw `flags.json` blob to a client.

Unknown flag names **throw** at runtime and fail typecheck (`FlagKey` union)
— a typo can't silently resolve to off.

## Conventions

- Name by feature, snake_case, no `enable_`/`new_` prefixes.
- Default off, expiry ≤ ~90 days out. The expiry guard is the cleanup nag.
- A flag guards ONE coherent feature; if you need two flags for one feature,
  the feature is two features.
- Pilot: `admin_flags_readout` is the worked example — the readout it gates
  is itself dark by default and admin-tier-targeted in the same build.
