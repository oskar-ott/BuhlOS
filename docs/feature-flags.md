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
`npm run check:flag-docs` (CI) keeps the registry, the `.d.ts` `FlagKey`
union and the table below in step: a registry flag with no row here, a row
for a flag that no longer exists, or a Kind / Target / Expires cell that
disagrees with the registry fails the build. The table is therefore the
complete, current set — kill-switches included.

The `default` is **`false`** for the usual *launch-gate* flag (dark until
turned on). The one exception is a *kill-switch* flag — `killSwitch: true`
with `default: true` — a feature that is **already live**, wrapped so the owner
can turn it **off** without a revert. See [Two flag kinds](#two-flag-kinds).
Non-protected feature flags also carry presentation metadata (`label`, `domain`,
`surface`) that drives the Owner Console's feature board (`FLAG_PRESENTATION`).

| Flag | Kind | Target | Expires | What it gates |
|---|---|---|---|---|
| `supabase_dual_write` | launch-gate | global | 2026-10-31 | Mirror blob writes into Supabase per migrated domain (#152) |
| `admin_flags_readout` | launch-gate | admin-tier | 2026-10-31 | The active-flags readout card on /command-centre |
| `signup_link` | launch-gate | global | 2027-06-30 | Crew sign-up link — shareable `/onboarding/<code>` for the group chat; public `api/signup.js` (resolve/submit), admin link + review queue on `/employees` (`api/employees.js?action=signup*`). A submission is pending until an admin approves (approval = account + welcome email E5); default OFF |
| `itp_simple` | launch-gate | global | 2026-12-31 | Simple mobile ITP builder in Phil (#912, lean-reset step 6) — job-scoped areas + photos rendered to a plain PDF at `/phil/jobs/[jobId]/itp-reports` + `api/itp-simple`. Metadata Supabase-first, binaries in Blob; default OFF |
| `job_materials_spend` | launch-gate | admin-tier | 2026-11-30 | Per-job **materials spend ledger** on the admin job hub (owner pull 2026-08-23): date / supplier / amount ex GST typed by the office, feeding the Money card's Materials figure through `api/job-profitability` (`materialSource: 'ledger'`). `api/job-materials.js` + the hub Materials card (`docs/job-materials-spend.md`); default OFF |
| `invoice_capture` | launch-gate | admin-tier | 2026-12-31 | **Supplier-invoice capture** — dark, unproven, NOT lean core: inbound email (Resend Inbound, Svix-verified, quarantined while off) + manual upload → original PDF kept in Blob, metadata Supabase-first → the wholesaler's printed IV job reference matched **exactly** against `jobs.json` `code` → office confirms → ex-GST cost on the job (`/invoices`, `api/invoices.js`, `/api/inbound/invoices`, hub card, sweep cron). `docs/invoice-capture.md`; default OFF |
| `receipt_capture` | launch-gate | global | 2027-03-31 | **Receipts from the field** — the My Day "Log a receipt" tile: photo + job on the phone → read by Claude vision → the supplier-invoice inbox → confirmed ex-GST cost on the job (`api/invoices.js?action=receipt`). Global target so field workers see the tile; needs `invoice_capture` on as well (the office reviews receipts in the invoice inbox) and `ANTHROPIC_API_KEY` for the photo read. Default OFF; `docs/invoice-capture.md` |
| `job_purchases` | launch-gate | global | 2027-04-30 | **Recent purchases on the job** — what was bought from the wholesalers (date, supplier, who bought it, the items), newest first, on the office job page and the field job page (`api/invoices.js?action=job-purchases`). Global target so leading hands and the crew see it; **prices and the job total only for the office tier** (stripped server-side). Needs `invoice_capture` on (it reads the confirmed supplier invoices). Default OFF; `docs/invoice-capture.md` |
| `workshop_stock` | launch-gate | global | 2027-01-07 | **Workshop Stock** (owner pull 2026-10-09) — the workshop's materials and consumables: searchable list with shelf/bin and recorded quantity, photo-assisted **Add stock** / **Take stock** / **Return**, office count corrections, catalogue and archive, append-only movement ledger with Undo (`api/workshop-stock.js`, `/phil/stock` via the More screen, `/stock` in People & gear). Postgres-first (migration `20261009100000_workshop_stock.sql`). Separate from gear. Photo reading + the online code check need `ANTHROPIC_API_KEY` and fall back to manual search/entry without it. Default OFF; `docs/workshop-stock.md` |
| `supabase_read_health` | launch-gate | global | 2026-12-31 | `GET /api/supabase-health` — the read-only Supabase connectivity proving slice (#533) |
| `supabase_read_hours` | launch-gate | global | 2026-12-31 | Serve the hours display read (`listUserEntries`) from Postgres with a Blob fallback (#152) |
| `supabase_dual_write_jobs` | launch-gate | global | 2026-12-31 | Mirror one job's `jobs.json` structure write into Postgres, best-effort, Blob authoritative (#152, J8) |
| `supabase_dual_write_tasks` | launch-gate | global | 2026-12-31 | Reconcile task status from `data.json` into Postgres (cron, off request path), Blob authoritative (#152, J9) |
| `supabase_dual_write_evidence` | launch-gate | global | 2026-12-31 | Reconcile evidence metadata from `data.json` into Postgres evidence_files/links (cron, off request path), Blob authoritative (#152) |
| `supabase_read_jobs` | launch-gate | global | 2026-12-31 | Serve the ADMIN jobs read from Postgres, per-job parity-gated, with a Blob fallback (#152, J5/J6) |
| `supabase_read_job_detail` | launch-gate | global | 2026-12-31 | Serve the ADMIN single-job GET (`/api/jobs?id=`) from Postgres structure + a per-job `admin-extras.json` projection, freshness+parity-gated, with a full Blob fallback — skips the `jobs.json` monolith (#152) |
| `supabase_read_phil_jobs` | launch-gate | global | 2026-12-31 | Serve the FIELD/Phil jobs read from Postgres, per-job parity-gated, visible-scoped, with a Blob fallback (#152, J7) |
| `supabase_read_phil_tasks` | launch-gate | global | 2026-12-31 | Serve the FIELD task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J10) |
| `supabase_source_tasks` | launch-gate | global | 2026-12-31 | Write task status to Postgres with CAS at request time (`/api/task-toggle`) + Blob write-through; parity-gated read (#152, PG-as-source Stage A) |
| `supabase_source_hours` | launch-gate | global | 2026-12-31 | Designate the synchronous hours mirror as the source-authoritative Postgres write (with `supabase_dual_write`), Blob write-through, parity-gated read (#152, PG-as-source Stage A). Protected; env-only; default OFF |
| `supabase_read_admin_tasks` | launch-gate | global | 2026-12-31 | Serve the ADMIN task-status read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152, J11) |
| `supabase_read_admin_evidence` | launch-gate | global | 2026-12-31 | Serve the ADMIN evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |
| `supabase_read_phil_evidence` | launch-gate | global | 2026-12-31 | Serve the FIELD/Phil evidence-metadata read (`/api/data`) from Postgres, per-job parity-gated, with a Blob fallback (#152) |
| `phil_sharpened` | launch-gate | global | 2026-12-31 | Phil field-surface redesign ("sharpened"): 5-slot global nav (Today·Jobs·Capture·Hours·Gear, account on the header avatar) + screen re-skins. Behavioural change to the ratified Phil package — flips only via governance (P15) |
| `phil_job_rooms` | launch-gate | global | 2026-12-31 | In-job four-rooms navigation (Now·Work·Proof·Site + Capture) on `/phil/jobs/[jobId]` — the #133 tabbed-job experiment, judged by the tabs criterion. Requires `phil_sharpened` |
| `xero_connection` | launch-gate | admin-tier | 2026-12-31 | The Xero payroll foundation — connection, reference sync, worker + work-type mappings, immutable payroll batches on `/hours/period` (#247/#610/#248/#611/#893/#894). No Xero write exists behind this flag; the timesheet push (#249) gets its own independent gate |
| `servicem8_sync` | launch-gate | admin-tier | 2027-06-30 | Daily ServiceM8 → BuhlOS job sync (auto-create missing Work Orders) + the Command Centre card. Needs `SERVICEM8_API_KEY` |
| `phil_jobs_summary_read` | launch-gate | global | 2026-12-31 | Serve the FIELD job LIST read (`/api/jobs`) from the derived `jobs-summary.json` projection, freshness-gated with a full `jobs.json` fallback (Phil LCP). Protected; env-only |
| `xero_payroll_export` | launch-gate | admin-tier | 2026-12-31 | The first Xero WRITE — export a LOCKED payroll batch to Xero Payroll AU as DRAFT timesheets with per-worker readback reconciliation (#249). Independent of `xero_connection`; default OFF. DRAFT timesheets only — no pay runs / approval / STP / tax / super / payslips (payroll-boundary ADR #609). Gates the Preview/Export/Retry/Reconcile controls on `/hours/period`; the batch-CSV download stays available without it |
| `jobs` | kill-switch | global | 2027-06-30 | **CORE.** The jobs list + job hub (`/v2/jobs`, `api/jobs.js`) and, under the same flag, the office Job Builder (`/v2/jobs/[jobId]/builder`: areas, stages, task generation, build readiness, blueprints, publish). Default ON; turning it off at `/owner` hides the whole Jobs surface |
| `hours` | kill-switch | global | 2027-06-30 | **CORE.** The hours workflow — `/hours` (weekly, approvals, today, period) + the time-entry APIs. Default ON; owner kill-switch |
| `evidence` | kill-switch | global | 2027-06-30 | **CORE.** Per-job evidence capture + admin review — `/v2/jobs/[jobId]/evidence` + `api/evidence.js`. Default ON; owner kill-switch |
| `employees` | kill-switch | global | 2027-06-30 | The employees / People admin surface — `/employees`. Default ON; owner kill-switch |
| `gear` | kill-switch | global | 2027-06-30 | The gear / test-and-tag register — `/gear`. Default ON; owner kill-switch |
| `job_photos` | kill-switch | global | 2027-06-30 | The per-job photos gallery — restored to the lean core by owner decision 2026-07-18 (#916): the gallery completes the capture loop. Default ON; owner kill-switch |

## What a flag proves — and what the repository cannot

"Live" has been used across this repo, the wiki and AI working memory to mean
five different things. They are not the same, and a status claim must say
which one it means. A 2026-09 audit found status being asserted from memory
and from the registry alone; this section is the rule that stops that.

| State | Meaning | Where it is established |
|---|---|---|
| **Built** | The code is on `main` behind the flag: routes, handlers, tests, a registry row. | The repository. |
| **Registry default** | What the flag resolves to with no env var and no `flags.json` override — `false` for a launch-gate, `true` for a kill-switch. | `api/_lib/feature-flags.js` and the table above (CI-checked by `check:flag-docs`). |
| **Effectively enabled** | What the flag resolves to in a given deployment for a given viewer: env `FLAG_*` › `flags.json` override › registry default, then targeting (see [Flipping a flag](#flipping-a-flag)). | Only the running deployment can say. `/owner` shows every flag's resolved state **and its source**. The repository cannot: an env var or a runtime override can differ from the default in either direction, and neither is in git. |
| **Externally configured** | Everything outside the code that the feature needs before it can do its job: DNS/MX records, provider webhooks and secrets, mailbox rules, OAuth connections, migrations applied to the right database. | Provider dashboards, Vercel project settings, the Supabase migration list — checked by a person and stamped with a date and a name in the feature's own doc. A flag being on implies none of these. |
| **Operationally proven** | Real users have run the loop on real data and someone checked the result. | Field evidence ([phil-field-validation.md](phil-field-validation.md), the weekly closeout in [product/03-lean-startup-loop.md](product/03-lean-startup-loop.md)), dated, with who checked and what they saw. |

Rules for writing status anywhere — docs, PR descriptions, issues, the wiki,
AI memory:

- Do not write **"live"** unless you mean *operationally proven*, and say when
  and by whom. For code on `main` behind a flag write **"built, dark"** or
  **"built, default off"**.
- For effective state write **"enabled in production (source: env / runtime
  override), read at `/owner` on YYYY-MM-DD"** — never from memory, never from
  the registry alone.
- Name outstanding **external configuration** explicitly, with its status and
  date (for example "email intake needs the mailbox forwarding rule — not
  configured as of 2026-09-27").
- A feature doc that claims any of the last three states without a date and a
  source is wrong by construction: fix the doc, not the claim.

How to establish the other three for a real flag, with a stamp table:
[runbooks/production-flag-verification.md](runbooks/production-flag-verification.md).

CI (`npm run check:flag-docs`) proves only the first two states — that the
registry, the `FlagKey` union and the table above agree. Nothing in CI, and
nothing an agent can read from the repository, establishes the other three.

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

## Expiry decisions due

An expiry is a cleanup nag, not a kill date: the guard fails the build, a
person decides. Extending one is allowed only with the decision it is waiting
for written down here.

| Flag | Was | Now | Why not removed yet | Decision needed before the new date |
|---|---|---|---|---|
| `supabase_dual_write` | 2026-09-30 | 2026-10-31 | Still load-bearing code, not dead: `api/_lib/hours-mirror.js` (the synchronous hours mirror runs when this OR `supabase_source_hours` is on), `api/_lib/user-mirror.js` (user-profile mirror) and `api/internal/sync-checks/hours.js` all branch on it. Removing it means choosing whether the mirror is always-on or gone — a data-plane decision (`docs/architecture/supabase-served-source-roadmap.md`), and its effective production state cannot be read from the repository. | Owner + data-plane: retire the flag by making the hours/user mirror unconditional (it becomes plain code), or delete the mirror. Either way a runtime PR, reviewed. |
| `admin_flags_readout` | 2026-09-30 | 2026-10-31 | Gates the active-flags readout card on `/command-centre` (`src/app/(admin)/command-centre/page.tsx`). Since #760 the Owner Console shows every flag's resolved state and source, so the card may be redundant — but deleting it is a user-visible change and the owner has not said whether the command-centre readout is still wanted. | Owner: keep the card (then make it plain code or a kill-switch) or delete the card and the flag together. |

Extended 2026-09-27 (remediation Task B). Neither change touches a default,
a target or runtime resolution — `expires` is read only by `check:flag-expiry`
and the Owner Console's expiry classification.

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
it. Archiving is a **holding position, not a resting place**: the 2026-07-27
**gut** deleted those archived features outright, flags included. See
"Feature kill-switches" below.

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
**Since the 2026-07 lean reset and the 2026-07-27 gut**
(`docs/product/02-lean-reset.md`), the kill-switch set IS the lean core:
**jobs, hours, evidence, employees, gear, job_photos**. The reset hid every
other shipped feature by reclassifying its kill-switch to a dark launch-gate;
the gut then **deleted those features' code and their flags** — the registry
went from 66 flags to 30 (the table above is the current, CI-checked set).
There is no `/owner` dial for a gutted feature any more; restoring one means restoring from the `pre-gut-archive` tag.
Each kill-switch flag gates its feature at **three layers**, so
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
