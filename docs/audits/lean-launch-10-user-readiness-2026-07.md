# Lean-launch readiness audit — 10+ users, 2026-07-20

**Mission:** is the lean BuhlOS/Phil product ready for 10+ real people in one
company — shared jobs, field hours, mobile approvals, Xero draft-timesheet
export — as a *shared operational system*, not a demo?

**Verdict: CONDITIONAL GO.** The hours spine is structurally sound for 10
concurrent users (per-user-per-day storage + CAS, proven by simulation against
the real handlers), access control holds under hostile probes, the payroll
batch layer is Postgres-transactional with real immutability and
duplicate-export protection. Three conditions gate the launch, all named
below: merge the open Phil-hours read fix (PR #909), close the evidence
metadata lost-update seam (PR opened by this audit), and two config-level
human actions (`APP_BASE_URL`, real-Xero connect). Full detail in §9.

---

## 1. Baseline

| Item | Value |
| --- | --- |
| Repository | `oskar-ott/BuhlOS` (working dir `~/Desktop/birdwood`) |
| Audit worktree | `~/Desktop/birdwood-launch-audit`, detached at `origin/main` |
| Audit-start commit (origin/main) | `8ec83b7` — fix(admin): owner can purge test jobs (#933) |
| Production deployment | `dpl_E7cEesZ3v7Hf1aaSB3vPM7b9ZMYh`, READY, target=production, **commit `8ec83b7` from `main`** ✓ |
| Production domain | `buhlos.com` (root 307 → `/v2/login`, page 200 in 0.41 s) |
| CI on main | green (last 5 runs success) |
| Test date | 2026-07-20 |
| Parallel session | hours Supabase cutover — uncommitted edits in the shared dir (`hours-mirror/hours-read/mirror-drift`, Jul 16) + open **PR #909**. Not touched by this audit. |
| Other open PRs | #861, #858, #847, #837, #781 (older, no overlap) |

The main working dir sits detached 12 commits behind `origin/main` with the
parallel session's uncommitted edits — all audit work ran in the isolated
worktree; nothing in the shared dir was modified.

## 2. Constitution Gate

Governing docs loaded: `CLAUDE.md`, `docs/product/02-lean-reset.md`
(ratified 2026-07-18 — the product boundary), `docs/feature-flags.md` (flag
governance incl. the two flag kinds + protected data-plane flags),
`docs/architecture/payroll-boundary-adr.md` (#609 — draft timesheets only),
`docs/architecture/data-ownership-map.md`, `docs/backups.md`,
`docs/deploy-checklist.md`, `docs/owner-console.md`, `docs/notifications.md`,
hours-loop docs, Phil constitution/governance (per memory + repo).

**Change classification of everything this audit did:**

- The audit itself — *read-only*, no principle touched.
- Two new regression test files (concurrency sim + isolation probes) —
  **follows existing constitution** (the sanctioned createRequire/mocked-Blob
  API-test harness; no product change).
- The evidence-CAS repair (§8) — **follows existing constitution**: applies
  the already-governed `expectedRev` idiom (#157/#576, "the api/users.js
  pattern" cited in repo comments) to a lean-core write path that lacked it.
  No new architecture, no flag change, no payroll-boundary contact.
- This report — records drift findings; amends no principle.

## 3. Effective feature state (production, reconstructed 2026-07-20)

Resolution = env `FLAG_*` > `flags.json` (rev 16, updated 2026-07-19) >
registry default. Verified from the live Vercel prod env and a read-only
fetch of the prod `flags.json` blob.

**ON in production:**

| Flag | Source | Note |
| --- | --- | --- |
| jobs, hours, evidence, employees, gear, job_photos | registry kill-switch defaults | the lean core |
| phil_sharpened, phil_job_rooms | **env** | lean field app + in-job rooms LIVE |
| phil_jobs_summary_read | **env** | Phil jobs-list perf projection |
| supabase_dual_write, _jobs, _tasks, _evidence | **env** | full mirror stack on |
| supabase_read_hours, _jobs, _admin_tasks, _admin_evidence, _phil_jobs, _phil_tasks, _phil_evidence | **env** | all PG read overlays on |
| xero_connection, xero_payroll_export | flags.json | admin-tier |
| itp_simple | flags.json | owner flipped 2026-07-19 |
| admin_job_field_view | flags.json | admin-tier |

**OFF (hidden / dark), everything else** — incl. itp (heavy), observations,
material_requests, expenses, quotes, defects, snags, dayworks, diary,
documents, circuit_schedule, scope_reconciliation, job_control, closeout,
job_activity, reports, all registers (safety/certs/RFI/variations/minutes/
site-instructions), all AI flags, job_builder_redesign, servicem8_sync
(also inert: no `SERVICEM8_API_KEY` in env), supabase_source_tasks,
supabase_source_hours, supabase_read_health.

**ownerPreview overrides** (owner-only, sanctioned): job_builder_redesign,
ai_assistant, ai_contract_obligations, ai_drawings = true; defects,
circuit_schedule, quotes, snags = false.

Flag hygiene: `check:flag-expiry` green (no expired flags);
`check:read-flags-protected` green (all 9 supabase_read_* protected +
dark-by-default); protected flags are read-only on `/owner` and the write
route rejects them (code-inspected, `api/owner-flags.js`).

## 4. Ten-user test design + what was actually run

Representative population modelled: 1 owner (env-only synthetic), 2 office
admin sessions (`admin` + `office` roles), 10 field workers (mixed
`electrician`/`tradie`), 2 leading hands (isolation cases), 1 archived
worker. Because production is live company data (post-wipe: real users only)
and preview deployments **share the production Blob store**, no test accounts
or test records were created in production. Multi-user behaviour was proven
by driving the **real serverless handlers** (signed sessions, real auth,
real validation, real guard semantics) against in-memory Blob mocks: the
hours sim reproduces `writeBlob`'s check-then-put *including the non-atomic
race window*; the evidence regression models atomic puts with the
handler-level gap, pinning the fix's delta deterministically (each mock's
model is documented in its file header).

New evidence artifacts (in repo):

- `src/domains/time-entries/hours-concurrency-sim.test.ts` — 6 scenarios
- `src/domains/time-entries/hours-isolation-audit.test.ts` — 12 probes

### 4.1 Concurrency simulation results (all green)

| Scenario | Result |
| --- | --- |
| **10 workers × 5 days submitted in one concurrent burst (50 creates)** | 50/50 landed, **zero lost entries, zero duplicates**. Reconciliation exact: 405.0h total, 40.5h/worker × 10, job-a 370.0h + job-b 35.0h, every entry's allocations sum == total |
| Same-worker double-tap create, no idempotency key | observed `201+201` — both raced the existence check; same key → **one well-formed day entry** (duplicate day impossible by construction) |
| Duplicate create with `Idempotency-Key` | replay: same entry id, `idempotentReplay: true`, no second write |
| Two admins approve the same entry concurrently | final state `approved` exactly once, `approvedBy` = one of the two; inside the narrowed window both may see 200 (benign double-stamp, identical status) |
| Admin approves ↔ worker edits same submitted entry | both interleavings end in a **legal state** (observed: edit landed last → entry back to `submitted@7.5h`, i.e. it re-enters the queue). Residual: within the ~100 ms put window an in-flight edit can be clobbered by the approve's stale spread — bounded by the batch layer's `source_hash` re-verification at lock (§6) |
| Reject → resubmit ↔ stale approve | stale approve correctly refused (400 not-submitted); never approved-with-rejected-reason |

**Why cross-worker loss is structurally impossible:** hours storage is
`users/<userId>/time-entries/<date>.json` — one blob per worker per day.
Ten workers submitting at the same deadline write ten disjoint keys. The
only same-key contention is one worker's own day (two devices/tabs), which
is CAS-guarded (`expectedRev` → 409 + client re-read) and idempotency-ringed
(#497).

### 4.2 Isolation probes (12/12 green, API-enforced)

- field worker **cannot** read another worker's entries (`?userId=` → 403)
- field worker **cannot** edit another worker's entry (403, entry untouched)
- field worker **cannot** approve / reject / see the approver queue (403)
- field worker **cannot** log on behalf of another worker (403)
- **a forged admin role claim inside a validly-signed cookie loses to the
  stored users.json role** (fresh lookup governs every request)
- LH cannot approve another LH (403); admin cannot approve own hours (403)
- non-owner admin + field worker cannot toggle feature flags (403)
- **archived worker with a still-valid session cookie: 401 everywhere**
  (read/create/approve) — archive revokes access within one blob-cache TTL (≤5 s)

## 5. Blob concurrency map (lean core)

`writeBlob` documents its own honest limit: expectedRev = fresh-read → check
→ put — *"no CAS — this narrows the race, it can't eliminate it."* What
matters is which stores thread it:

| Store | Writers | Protection | Exposure |
| --- | --- | --- | --- |
| `users/<id>/time-entries/<date>.json` | time-entries*, approve/reject/reopen | disjoint per-worker keys + expectedRev + idempotency ring + per-store validator | **sound** (simulation §4.1) |
| `users.json` | users, invites, employees, jobs (assign), notification-prefs, crew | expectedRev ×8 + re-read retry ("the api/users.js pattern") + shrink guard (floor 4) + owner-sentinel ban | sound |
| `flags.json` / `feature-settings.json` | owner-flags / owner-settings | true optimistic CAS + validator | sound |
| Payroll batches / items / events / attempts | api/_lib/xero/* | **Postgres transactions**, status-CAS (`where status='ready'`), DB-trigger immutability once locked, supersede-only corrections | sound |
| ITP-simple metadata | api/itp-simple.js | Supabase-first (PG) | sound; binaries Blob write-once |
| `assets/<id>.json` (gear) | api/assets.js | per-asset keys | narrow same-asset race only |
| `jobs/<id>/data.json` **evidence[]** | api/evidence.js | validator + shrink guard, **no expectedRev**, cached read | **P1 — concurrent photo captures on one job can silently drop a metadata row** (binary survives; gallery row lost; 201 already returned). Fix PR opened (§8) |
| `jobs/<id>/tags.json` | api/tags.js | none | **P2** — two workers tagging one job concurrently can lose a tag |
| `leave-requests.json` | api/leave.js | validator, no CAS | **P2** — global single array; concurrent leave writes can lose one |
| `jobs.json` (create via `createJob`) | api/jobs.js (single sanctioned writer) | slug + IV-code dedupe (enumeration-hardened), shrink guard, **no expectedRev** | **P2** — two *different* jobs created in the same ~200 ms window: one lost. Same-job double-create converges on one id (benign) |

Also mapped: `listAllEntriesForApprovers` lists `users/` with `limit: 5000`
and fetches **every entry blob ever written** (no date scoping) — fine at
launch, a real cost/scaling cliff around 12–14 months of 10-worker history
(**P2**, #935).

## 6. Payroll batch + Xero (draft-boundary) verification

- **Immutability:** locked batches are DB-trigger-enforced immutable;
  corrections only via `supersedes_batch_id` (revision+1); events append-only.
- **Lock integrity:** `lockBatch` re-assembles the LIVE source, re-verifies
  `source_hash` (drift → `blocked` + loud event), re-runs validation, then
  CAS `ready→locked` — exactly one concurrent lock wins (code-inspected).
- **Duplicate-export protection chain:** CAS `locked→exporting`; per-worker
  prior-timesheet check (`requires_correction` — an existing Xero timesheet
  for employee+period is never overwritten); `exportId` stamped per worker
  only after accepted+verified, "never re-stamp"; validation refuses
  `already_exported` rows outside correction batches; `exported` is terminal.
- **Contract regression:** 20 Xero suites, **204/204 green** on the audit
  worktree — covering every live proving-run find: bare-array POST body
  (#928), singular `Timesheet` readback (#929), XML-under-Accept:json 400
  extraction (#927), `.NET /Date(ms)/` calendar anchors incl. Wed-anchored
  weekly (#925), ValidationErrors detail + FK drop (#926), later-ok resolves
  open failure (#930), export-panel gating (#932).
- **External proof:** first draft timesheet landed + verified in Demo
  Company (AU) 2026-07-19; batch reached `exported` (prior session,
  recorded). Demo org since purged + disconnected in the prod wipe.
- **Boundary:** no pay-run/approval/STP/tax/super code paths exist behind
  the export flag (ADR #609 honoured; write scope added only when
  `xero_payroll_export` is on for the connecting admin).

**Live gap found:** production `APP_BASE_URL=""` (empty string) →
`redirectUri()` returns null → `/api/xero/connect` answers **503
"xero not configured"** in production. Invite links are unaffected (request-
host fallback), but the owner's launch-critical *real-org connect* is
config-blocked until `APP_BASE_URL=https://buhlos.com` is set in the prod
env (and the Xero app's registered redirect URI matches
`https://buhlos.com/api/xero/callback`).

## 7. Findings

### P1 — launch blockers

| # | Finding | Evidence | State |
| --- | --- | --- | --- |
| P1-1 | **Phil hours week can render blank while Blob holds every entry.** `supabase_read_hours` is ON in prod env; a PG row whose allocations were quarantined (job absent from PG) serves `allocations: []`; Phil's all-or-nothing parse rejects the week. Reproduced on a real device + confirmed against prod data (13–16 Jul). | Open **PR #909** (parallel session): faithfulness gate + partial-mirror drift; CI green (6730 tests), prod-verified read-only | **Merge PR #909** (owned by the parallel session / owner) |
| P1-2 | **Concurrent photo captures on one job can silently lose evidence metadata.** `api/evidence.js` create = cached read → mutate → write, no expectedRev; second writer clobbers the first's `evidence[]` row after both got 201. Matches the launch condition "no successful upload may disappear". | Code-inspected + lost-update reproduced in a mocked-store regression test | **Fix PR opened by this audit** (§8) |
| P1-3 | **Production Xero connect is 503-blocked** (`APP_BASE_URL=""` → null redirect URI). The money-path setup step cannot run. | Prod env pull + code path (`api/_lib/xero/config.js`, `api/xero/connect.js`) | **Human action:** set `APP_BASE_URL` in Vercel prod env |

### P2 — important near-term

1. Tags register: no CAS on `jobs/<id>/tags.json` — concurrent tag saves on
   one job can lose one (#934).
2. Leave: global `leave-requests.json` RMW without CAS (#934).
3. Job create: `jobs.json` RMW without CAS — simultaneous *different* job
   creates can lose one (#934, same pattern fix).
4. Approver-queue read fetches every historical entry blob; `list` capped at
   5000 blobs — cost grows linearly, hard cliff ~14 months at 10 workers
   (#935).
5. **Payroll reminders are push-only and prod has no VAPID keys** — the
   Sunday 18:00 / Monday 07:30 Sydney reminder crons fire and deliver to
   nobody; notification-prefs UI offers channels that never arrive. Owner
   decision: configure VAPID or strip/label the promise (existing memory
   finding, re-verified in env today).
6. Same-entry approve↔edit narrowed race can drop an in-flight edit
   (§4.1) — bounded by batch `source_hash` re-verification; acceptable at
   10-user scale once documented; a `If-Match`-style client refresh is the
   eventual fix.

### P3 — backlog

- `docs/architecture/data-ownership-map.md` header still says "only
  supabase-health touches Postgres (0 rows)" — stale versus the live
  dual-write + read-overlay + hours/batches reality (doc drift, no code
  impact).
- Two stale local scripts in the shared working dir (`prod-import.sh`,
  `switch-over.sh`) + untracked one-off docs — parallel session's; untouched.
- `listAllEntriesForApprovers` fetch fan-out is also a latency tax on
  `/hours/approvals` today (each load re-fetches every blob).

## 8. Repairs performed by this audit

**R1 — evidence metadata lost-update (P1-2).** Branch
`fix/evidence-metadata-cas` from `origin/main`: the evidence create/review
writes now run under `expectedRev` + the #511 re-read/re-apply retry,
**extended with verify-after-write** — after a successful put the helper
re-reads fresh and only resolves once this request's effect is observably
present, so a clobbered write is detected and re-applied instead of
silently lost; exhausted retries throw (an honest 502), never a false 201.
A regression suite reproduces the lost update deterministically (3/4 tests
fail on the old path, 4/4 pass with the fix; all 270 existing evidence
tests stay green). Honest limit, stated in code: Vercel Blob's guard-read →
put is not atomic, so a same-instant cross-instance put can still land
after a verify — the fix shrinks the loss window from the whole request
duration (seconds) to ~one put RTT and repairs every conflict it can
observe. The **structural** close-out is the evidence PG-as-source rung
(the `evidence_files` table + dual-write mirror already exist; same
promotion shape as tasks #738) — deliberately NOT built here (§38: no new
architecture, no overlap with the active hours-cutover session). PR opened;
full `check` green locally; **left OPEN for owner merge** — a race window
cannot be hand-verified on a preview, and preview deployments share the
production Blob store, so the mocked multi-writer regression suite is the
honest evidence standard here. Rollback = revert the single commit.

**R2 — audit regression suites.** The two §4 test files ride the same PR so
the 10-user concurrency + isolation properties stay pinned in CI.

No other code was changed. No production data was written. The parallel
session's files and PR #909 were not touched.

## 9. Verdict + conditions

**CONDITIONAL GO.** The lean core is structurally ready for 10+ users:
hours cannot lose a worker's day cross-worker by construction and survived a
50-entry concurrent burst with exact reconciliation; role boundaries and
archived-access revocation hold under direct API attack; payroll batches are
immutable, drift-checked and double-export-proof; the Xero contract is
pinned by 204 green tests plus a live Demo-Company proving run; hidden
features are three-layer gated with no expired flags.

Conditions before the first real payroll week:

1. **Merge PR #909** (Phil hours read faithfulness) — without it a worker
   can look at a blank week and re-enter hours the system already holds.
2. **Merge the evidence-CAS fix** (PR from §8) — without it a photo burst
   on one job can silently drop gallery rows.
3. **Set `APP_BASE_URL=https://buhlos.com`** in the Vercel production env,
   then connect the real Xero organisation and confirm worker/pay-item
   mappings (owner, in-browser).
4. Decide the reminder channel (VAPID or explicitly none) so the
   notification UI stops overpromising (P2-5) — can land during week 1.

### Remaining human actions (cannot be done by an agent)

- Connect the **real** Xero org (after condition 3); confirm mappings; run
  one controlled real export of a small batch and verify the draft in Xero.
- Onboard the real 10+ users (invites from `/employees`); role check.
- Physical-device walk: Phil login → My Day → log hours → submit →
  correction loop; tag + photo capture on at least two phones.
- Simple-ITP field walk (flag already live) + one generated PDF eyeballed.
- `/owner` sweep: §3's table is the current truth — confirm it matches
  intent (notably `phil_job_rooms` ON via env = the #133 experiment is live).
- Nominate the first-week support owner + fallback payroll process
  (CSV path stays available without the export flag).

### Launch-day checklist (condensed)

users invited+activated → roles verified → real jobs present →
flags per §3 confirmed at `/owner` → `APP_BASE_URL` set → Xero connected +
mappings green → workers briefed (log, submit, fix-rejected, tag, photo) →
office briefed (weekly review, reject/approve, batch → lock → export,
duplicate-export = correction batch only) → backup cron green that morning
(daily 02:00 Sydney, 14-day retention) → rollback = Vercel instant rollback
to prior deployment (both current prod deployments are rollback candidates)
→ support owner named.

### Four-week validation metrics (owner tracks)

submission rate + on-time %, missing/duplicate hours (expect 0), correction
+ rejection counts, approval time on phone, batch reconciliation exact-match
per week, Xero export errors, duplicate jobs created, photo/tag/ITP usage,
login problems, support requests. Success = four consecutive payroll weeks,
zero lost hours, zero duplicate payroll records, less admin effort than the
old process.

## 10. Evidence matrix

| Level | Items |
| --- | --- |
| Controlled multi-user simulation passed | hours burst ×50, double-tap, idempotent replay, dual-approve, approve↔edit, reject↔resubmit; 12 isolation probes |
| Automated test passed | full `check:full-ci` (all 17 guards, exit 0) at `8ec83b7`; Xero 204/204; audit suites 18/18; full `tsc` clean |
| Production configuration verified | deployment commit == origin/main; prod env FLAG_* values; `flags.json` rev 16; crons (18) incl. backup + payroll reminders; no VAPID; no SERVICEM8 key; `APP_BASE_URL=""`; domains |
| Production read-only behaviour verified | login 200/0.41 s; root 307→login; API estate 401-unauth (time-entries, evidence-adjacent, observations, expenses, supabase-health); owner-flags 405 on GET |
| Code inspected | writeBlob/blob-guards CAS semantics; approve/reject/PATCH state machine; batch lock/export chain; three-layer flag gating; auth fresh-lookup + archived-user null |
| Previously externally proven | Demo Company (AU) draft-timesheet proving run 2026-07-19 (batch → exported, verified readback) |
| Not tested (by an agent, by design) | real-device mobile UX; authenticated production walk; real-org Xero write; push delivery; true network-level Blob race timing |
| Requires human action | §9 list |

---

*Audit executed 2026-07-20 in an isolated worktree at `8ec83b7`; no
production writes; no interference with the active hours-cutover session.*
