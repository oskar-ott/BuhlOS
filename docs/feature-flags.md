# Feature flags (#155)

Merge unfinished work **dark**, stage it to the admin tier first, switch off
a misbehaving feature without a revert deploy. Backs the standing rule:
half-broken UI is hidden or labelled, never shipped live.

## The registry

One source of truth: [api/_lib/feature-flags.js](../api/_lib/feature-flags.js)
(+ `.d.ts` for typed `src/` consumption — add new keys to **both**, same PR).
Every flag declares a description, a `default`, a target, and
an **expiry date** — flags are temporary by default, and
`npm run check:flag-expiry` (CI) fails the build once a flag outlives its
date: delete it (and the dead branch it guarded) or consciously extend it.

The `default` is **`false`** for the usual *launch-gate* flag (dark until
turned on). The one exception is a *kill-switch* flag — `killSwitch: true`
with `default: true` — a feature that is **already live**, wrapped so the owner
can turn it **off** without a revert. See [Two flag kinds](#two-flag-kinds).
Non-protected feature flags also carry presentation metadata (`label`, `domain`,
`surface`) that drives the Owner Console's feature board (`FLAG_PRESENTATION`).

| Flag | Target | Expires | What it gates |
|---|---|---|---|
| `supabase_dual_write` | global | 2026-09-30 | Mirror blob writes into Supabase per migrated domain (#152) |
| `admin_flags_readout` | admin-tier | 2026-09-30 | The active-flags readout card on /command-centre |
| `admin_job_field_view` | admin-tier | 2026-09-25 | The Office/Field view toggle + read-only Phil job render on `/v2/jobs/[jobId]` (mobile-admin redesign) |
| `admin_proof_review` | admin-tier | 2026-09-25 | The office Proof-to-sign-off approve/send-back surface + Command Centre queue (#503) |
| `itp` | global | 2027-06-30 | Per-job ITP / QA — hold/witness/record + office sign-off (#474/#476). **Hidden by the 2026-07 lean reset** (was a kill-switch); the owner can re-enable it from `/owner` |
| `signup_link` | global | 2027-06-30 | Crew sign-up link — shareable `/onboarding/<code>` for the group chat; public `api/signup.js` (resolve/submit), admin link + review queue on `/employees` (`api/employees.js?action=signup*`). A submission is pending until an admin approves (approval = account + welcome email E5); default OFF |
| `itp_simple` | global | 2026-12-31 | Simple mobile ITP builder in Phil (#912, lean-reset step 6) — job-scoped areas + photos rendered to a plain PDF at `/phil/jobs/[jobId]/itp-reports` + `api/itp-simple`. Metadata Supabase-first, binaries in Blob. Independent of the heavy `itp` system; default OFF |
| `supabase_read_health` | global | 2026-12-31 | `GET /api/supabase-health` — the read-only Supabase connectivity proving slice (#533) |
| `supabase_read_hours` | global | 2026-12-31 | Serve the hours display read (`listUserEntries`) from Postgres with a Blob fallback (#152) |
| `supabase_dual_write_jobs` | global | 2026-12-31 | Mirror one job's `jobs.json` structure write into Postgres, best-effort, Blob authoritative (#152, J8) |
| `supabase_dual_write_tasks` | global | 2026-12-31 | Reconcile task status from `data.json` into Postgres (cron, off request path), Blob authoritative (#152, J9) |
| `supabase_dual_write_evidence` | global | 2026-12-31 | Reconcile evidence metadata from `data.json` into Postgres evidence_files/links (cron, off request path), Blob authoritative (#152) |
| `supabase_read_jobs` | global | 2026-12-31 | Serve the ADMIN jobs read from Postgres, per-job parity-gated, with a Blob fallback (#152, J5/J6) |
| `supabase_read_job_detail` | global | 2026-12-31 | Serve the ADMIN single-job GET (`/api/jobs?id=`) from Postgres structure + a per-job `admin-extras.json` projection, freshness+parity-gated, with a full Blob fallback — skips the `jobs.json` monolith (#152) |
| `supabase_read_phil_jobs` | global | 2026-12-31 | Serve the FIELD/Phil jobs read from Postgres, per-job parity-gated, visible-scoped, with a Blob fallback (#152, J7) |
| `supabase_read_phil_tasks` | global | 2026-12-31 | Serve the FIELD task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J10) |
| `supabase_source_tasks` | global | 2026-12-31 | Write task status to Postgres with CAS at request time (`/api/task-toggle`) + Blob write-through; parity-gated read (#152, PG-as-source Stage A) |
| `supabase_read_admin_tasks` | global | 2026-12-31 | Serve the ADMIN task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J11) |
| `supabase_read_admin_evidence` | global | 2026-12-31 | Serve the ADMIN evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |
| `supabase_read_phil_evidence` | global | 2026-12-31 | Serve the FIELD/Phil evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |
| `phil_sharpened` | global | 2026-12-31 | Phil field-surface redesign ("sharpened"): 5-slot global nav (Today·Jobs·Capture·Hours·Gear, account on the header avatar) + screen re-skins. Behavioural change to the ratified Phil package — flips only via governance (P15) |
| `phil_job_rooms` | global | 2026-12-31 | In-job four-rooms navigation (Now·Work·Proof·Site + Capture) on `/phil/jobs/[jobId]` — the #133 tabbed-job experiment, judged by the tabs criterion. Requires `phil_sharpened` |
| `xero_connection` | admin-tier | 2026-12-31 | The Xero payroll foundation — connection, reference sync, worker + work-type mappings, immutable payroll batches on `/hours/period` (#247/#610/#248/#611/#893/#894). No Xero write exists behind this flag; the timesheet push (#249) gets its own independent gate |
| `xero_payroll_export` | admin-tier | 2026-12-31 | The first Xero WRITE — export a LOCKED payroll batch to Xero Payroll AU as DRAFT timesheets with per-worker readback reconciliation (#249). Independent of `xero_connection`; default OFF. DRAFT timesheets only — no pay runs / approval / STP / tax / super / payslips (payroll-boundary ADR #609). Gates the Preview/Export/Retry/Reconcile controls on `/hours/period`; the batch-CSV download stays available without it |

## Flipping a flag

Resolution order — first hit wins:

1. **Env var** `FLAG_<SNAKE_UPPER>` (`FLAG_SUPABASE_DUAL_WRITE=1`) — set in
   Vercel env, takes effect on the next deploy. Beats everything, both
   directions (an env `0` force-disables a blob-enabled flag).
2. **Runtime override** — the `flags.json` blob:
   `{ "flags": { "supabase_dual_write": true } }`. No deploy needed; rides
   the 5s `readBlob` TTL cache so it costs nothing on hot paths. (It's in the
   backup manifest like every canonical store.)
3. **Registry default** — `false` for a launch-gate flag (dark by default),
   `true` for a kill-switch flag (live by default; see below).

**Targeting applies on top:** an `admin-tier` flag is only ever on for
admin-tier viewers (tier-aware `isAdminRole` — the role-literal guard applies
here like everywhere). `global` ignores the viewer.

**Owner Console controls flags (#760).** `/owner` (`docs/owner-console.md`)
displays every flag's resolved state, **source** (env > blob > default), target,
and expiry classification — and for non-protected flags it now **toggles** them
at runtime via `POST /api/owner-flags` (owner-gated, CAS-guarded on `flags.json`,
audited with the `feature_flag.toggled` action). The feature flags are presented
as a **feature board** grouped by `domain` (the `FLAG_PRESENTATION` metadata),
with an optional `reason` recorded in the audit metadata when the owner *reduces*
a feature's exposure. Two dials per flag: **Live to customers** (the `flags.json`
baseline) and **Preview for me** (an owner-only `ownerPreview` override). Protected data-plane flags (`supabase_*`,
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

## Two flag kinds

There are exactly two shapes. The kind is declared on the flag, not inferred:

- **Launch-gate flag** (the default, and the overwhelming majority):
  `default: false`. Merges unfinished work dark; the owner or an env var turns
  it on when it's ready. This is the safe shape — nothing a customer can see
  ships accidentally.
- **Kill-switch flag:** `killSwitch: true, default: true`. For a feature that
  is **already live** and that the owner needs to be able to switch **off**
  (e.g. it's misbehaving, or a customer isn't ready for it) without a revert
  deploy. `killSwitch: true` is the **only** way a flag defaults on, and it
  must be set explicitly per flag — so "no customer-visible feature turns on by
  accident" still holds. `hours` is the canonical one: the hours workflow is
  live, so gating it behind a plain `default: false` flag would hide it on the
  very next deploy.

A feature can move **between** kinds: the 2026-07 **lean reset** reclassified
most kill-switches back to dark launch-gates (`default: false`, `killSwitch`
removed) — the sanctioned way to *archive* a shipped feature without deleting
it. See "Feature kill-switches" below.

The resolver is identical for both — `isFlagOn` / `isFlagEnabled` already honour
`def.default`, so a kill-switch is just a flag whose default happens to be
`true`. The distinction is governance, not mechanism: `killSwitch` is what the
`check:flag-expiry` guard and the owner-facing board read to explain *why* a
flag is on out of the box, and the "dark by default" test asserts every
non-`killSwitch` flag is `default: false`.

> **Constitution Gate.** Allowing a flag to default on is a change to
> flag governance (this file is the governing doc). It is bounded on purpose:
> only an explicit `killSwitch: true` flag may do it; everything else stays
> dark by default.

## Feature kill-switches — the owner controls the whole interface (#760)

Every shipped feature carries a flag the owner can control from `/owner`.
**Since the 2026-07 lean reset** (`docs/product/02-lean-reset.md`), only the
lean core remains a default-ON kill-switch: **jobs, hours, evidence,
employees, gear**. Everything else — observations, material requests,
expenses, quotes, defects, dayworks, reports, ITPs, snags, photos gallery,
scope, job control, closeout, documents, circuit schedules, diary, job
activity, … — is **hidden**: reclassified to a dark launch-gate
(`default: false`), archived-not-deleted, re-enable from `/owner` any time.
Each such flag gates the feature at **three layers**, so
turning it off removes the feature everywhere — not just visually:

1. **Navigation** — `src/components/admin/nav.ts` tags each sidebar item with
   its `flag`; `AdminShell` (server) resolves `flagsForViewer` once and passes
   the hidden hrefs to the sidebar, ⌘K palette and mobile IA (`visibleNavGroups`
   / `FLAGGED_ITEMS`). Job-hub sections are tagged in `JobInterfaceSectionNav`
   and resolved in the hub page. Command Centre queue cards gate the same way.
2. **Route** — each RSC page calls `notFound()` when its flag is off (so a
   deep-link 404s, not just the nav link vanishing).
3. **API** — each serverless handler returns `404` when off, on **every**
   request path, using `isFlagEnabled(flag, <viewer>)` **after** auth (so owner
   preview still reaches the data — see owner-preview above).

`jobs` / `hours` / `evidence` are marked **core** (`FLAG_PRESENTATION[key].core`)
— the board warns before the owner turns one off, and their shared APIs
(`/api/jobs`, the time-entry endpoints) stay live as infrastructure; the office
*surfaces* are what gate. `Command centre` and `/owner` itself are never gated,
so the owner can't self-lock.
