# Pre-start readiness gate (#371)

> **Status:** the pure engine shipped (signals → state + items, with the honest
> defaults + schema, fully unit-tested). The persistence API, admin hub panel,
> and Phil nudges are scoped below as the next slices. Part of Epic 4 — Job Bible.

## What this answers

"Can we actually start Monday?" — one honest, itemised answer from REAL signals
only: **No / With warnings / Yes**, down to which worker is blocked, with an admin
**override-with-reason that is visibly flagged and never rendered green**.

## Shipped — the pure engine (`src/domains/jobs/readiness.ts`)

- `computeReadiness(signals) → { state, startApproved, overridden, override, items, blockingCount, warningCount }`.
  Pure, side-effect-free, unit-tested per signal combination including unknowns.
- **Signals in** (the caller resolves them from the real stores): the assigned
  crew, the induction register (#332), licence currency (#331), safety-doc
  acknowledgements (#219), the manual checklist, and the override. An **absent
  register is passed as `null` and renders "not tracked", never green** (standing
  rule: missing data is named, not faked).
- **State rules:** a real gap in a tracked **induction** / **safety-doc** register,
  or an **unticked manual obligation**, is a hard blocker → `no`. A **licence** gap
  (optional signal) or any **not-tracked** register is a soft `warnings`. All
  satisfied → `yes`.
- **Override:** never changes the honest `state`; it sets `overridden = true` and
  `startApproved = true` so the UI shows "started despite gaps — by <admin>:
  <reason>", never plain green.
- The one new per-job blob `jobs/<jobId>/prestart.json` is schema'd
  (`PrestartSchema`) with the honest v1 defaults (`DEFAULT_PRESTART_ITEMS`:
  insurances lodged, SWMS uploaded, AMPC induction, site rules) — non-integrated
  obligations, each ticked by a named admin.

## Next slice A — persistence API + signal resolution

A TS App Router route `src/app/api/job-readiness/route.ts`:
- `GET ?jobId=` → resolve the signals (crew from `users.assignedJobIds`,
  inductions from the #332 register, licences from #331, safety docs from #219
  when present else `null`), read/seed `jobs/<jobId>/prestart.json`, return
  `computeReadiness(...)`.
- `PATCH` → tick/untick a manual item (named admin + timestamp) or set an override
  (mandatory reason) → write `prestart.json`; **register the key in
  `api/_lib/backup-manifest.js`** (new blob key) and audit the change to the feed.

## Next slice B — surfaces

- **Admin hub panel** (`JobReadinessCard`) following the Status-summary card
  pattern (`deriveJobAttention`), with the editable checklist + override modal.
- **Phil nudges** — assigned workers see their OWN blocking items as read-only,
  riding the existing needs-you derivations (additive; hidden when clear).

Do not rebuild #219/#332, integrate external systems (Sign-on-Site/AMPC/Procore
have no integration), or hard-block publish/assignment in v1.
