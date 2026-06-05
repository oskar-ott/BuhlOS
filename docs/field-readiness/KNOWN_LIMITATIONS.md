# BuhlOS / Phil — Known Limitations

> **Purpose:** a blunt, plain-language list of what is **not** finished, so the
> team does not mistake a polished surface for a production-ready one. Serious
> issues are stated plainly and not softened.

| | |
| --- | --- |
| **Snapshot** | `main @ 55ca30c` (PR #75), 2026-06-05 |
| **Companion** | [ROLL_OUT_STATUS](./ROLL_OUT_STATUS.md) · [DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md) · [NEXT_HARDENING_LANE](./NEXT_HARDENING_LANE.md) |

Labels: `MERGED` · `OPEN PR` · `IN PROGRESS` · `NOT STARTED` · `DEFERRED` ·
`FUTURE` · `DECISION NEEDED`. Where a state is uncertain it reads
"_Status requires confirmation_".

**The single most important limitation, up front:** storage is append-then-
overwrite on JSON blobs with last-write-wins under concurrent writes, mitigated
by a short cache + retry, not solved. **Nothing in this app is a durable system
of record.** Every limitation below sits on top of that fact.

---

## 1 · Jobs

- **Legacy setup detours still exist.** Modern job assignment (`MERGED`, PR #67) writes `assignedJobIds`, and a thin honest Job Builder exists. But parts of job setup, plan attachment, and admin tooling still route through legacy `public/admin/*.html`. Plan on the operator touching legacy surfaces during setup.
- **Assignment is modern** (`MERGED`, PR #67): admin assigns field workers; Phil visibility derives from `users.json.assignedJobIds`. A `PUT` replaces the whole array — concurrent edits can clobber each other.
- **Publish / archive is basic.** Draft → publish gating is honest but minimal. There is no rich lifecycle (no scheduling, no soft-delete recovery guarantees). Archived/Draft jobs are correctly hidden from field.
- The shipped Job Builder is an **honest thin v1**, not the 14-section cockpit some planning docs describe. Each remaining "section" is a substantial future feature, not a polish pass.

## 2 · Phil (field app)

- **UI / design-system polish: `MERGED`** (PR #75). The field surface is polished, which can make adjacent unbuilt features look finished. Do not infer completeness from polish.
- **Hours attribution: `MERGED`** (PR #77) but **production-unverified** (Preview Smoke not dispatched; authed Phil can't run on local `next dev`). Verify on a preview/seeded env before any reliance.
- **My Day** shows assigned jobs + log-hours + recent entries. Multi-job allocation beyond the attribution picker, and several deep actions, bail out to legacy.
- **My Gear** is mostly read/placeholder for the worker: issue reporting, QR scan, and inventory are deferred (see §4).
- A "Snag"/cross-job inbox tab may render as **UC / SOON** — per-job snags exist via the job detail, but the cross-job inbox is not built; the placement can read as "snagging isn't built" when per-job snagging is.

## 3 · Hours

- **Job attribution: `MERGED`** (PR #77). Field hours attach to the active assigned job; zero/many-job states handled; the create API rejects a field self-submit whose job is arbitrary/unassigned/draft/archived.
- **`null` jobId is still accepted server-side** for backward compatibility (legacy `phil.html`, existing records, overhead). The **UI** blocks new null submissions; a server-side null-block for field roles is a **documented follow-up** (`NOT STARTED`).
- **Rejected-hours correction loop: `IN PROGRESS` / `DEFERRED`.** Correcting a rejected entry defers to the legacy My Day surface; the modern PATCH attribution path is deferred. The "complete the Hours money-control workflow" PR (#57) is **`OPEN`**, not merged.
- **Overhead / non-job hours: `NOT STARTED`.** There is no first-class overhead mode; zero-jobs currently blocks rather than offering an overhead bucket.
- **Payroll / Xero: `NOT BUILT` (`FUTURE`).** No payroll finalisation, no CSV/Xero export that can be trusted. UC copy referencing Xero/payroll is a placeholder. **Do not use hours as a payroll or final job-costing source.**

## 4 · Gear

- **Role hardening: `MERGED`** (PR #74). Gear/Assets role checks are normalised across tiers for field readiness. See [docs/gear-assets.md](../gear-assets.md).
- **QR labels / scanning: `DEFERRED` (`FUTURE`).** UC only.
- **Issue / damaged / lost worker workflow: `DEFERRED`.** The admin register tracks assignment + states; the worker-initiated issue-reporting flow is not the live field path yet.
- **Inventory / van stock: `DEFERRED`.** No per-van inventory or stock truth. The gear register is **not** a live single source of asset truth.

## 5 · Plans

- **Read-only viewer + overlays: `MERGED`** (Phase 1 PR #61, Phase 2 PR #68). Source plan is kept immutable; markups/overlays are stored separately; only current revisions render to field. See [docs/plans-phase-2-overlays.md](../plans-phase-2-overlays.md).
- **Upload / rasterisation: `NOT STARTED` (modern).** Uploading and rasterising plans still goes through the legacy admin surface. Per-page PNGs already exist, which de-risks the modern render path but does not replace upload.
- **AI takeoff / measure / as-built: `DEFERRED` (`FUTURE`).** Not built. Any "AI"/"takeoff" reference is a placeholder.
- **Coordinate drift risk:** overlay coordinates must hold to a `0..1` unit suite; treat overlay positioning as unverified until that suite lands (see [docs/testing/Known-Risk-Areas.md](../testing/Known-Risk-Areas.md)).

## 6 · Needs Attention

- **Projection-only.** It is a **read projection** over real sources (`MERGED`, PR #69–#73), not a queue of record. See [docs/needs-attention-exceptions-inbox.md](../needs-attention-exceptions-inbox.md).
- **No dismiss / snooze.** You cannot clear or defer an item; it persists while the underlying source condition holds.
- **Source-specific actions are limited.** Deep-links route to the correct source section (`MERGED`, PR #72/#73), but per-item actions beyond navigation are minimal.
- **Plan markups / gear sources: `DEFERRED`** unless explicitly built — the projection covers the sources wired so far, not every domain.

## 7 · Material Requests

- **Current status: `MERGED` (partial)** (PR #56). The field-to-office **request** loop works: requested → approved → ordered → delivered (+ cancel). It is distinct from the legacy `/admin/materials` takeoff/PO/invoice module.
- **No purchase orders.** Ordering is a status flag, not a PO.
- **No supplier ordering.** Nothing is sent to a supplier.
- **No Xero.** No accounting integration.
- **No stock decrementing.** Approving/ordering/delivering does not move any inventory. Treat this as a **request tracker**, not procurement.

## 8 · Legacy

- **Legacy routes still reachable.** `/phil`, `/my-day`, `/my-gear`, `/admin/*.html`, the `/buhlos/*` mirror set, and `/dev/site-office` remain rewritten in production. They are **preserved on purpose** (production depends on some), not accidentally live. See [docs/route-ownership.md § Legacy routes](../route-ownership.md).
- **Deprecated naming cleanup: `OPEN PR` (#76), not on `main`.** "Site Office" / "Switchboard" are deprecated product names. A route-ownership guard forbids them in active nav and requires a DEPRECATED banner on the dev route, but the broader leak cleanup is **not yet merged** — legacy naming can still surface until #76 lands and is verified.
- **Routes that must not be used for current operations:** `/admin-legacy`, `/admin.html`, bare `/phil`, the `/buhlos/*` mirrors, and `/dev/site-office`. Do not link to them from modern nav; `check:route-ownership` enforces this.

## 9 · Testing

- **Preview Smoke: `MERGED`** (PR #62) and **guarded** — `workflow_dispatch` only, refuses production/unsupported targets, requires both admin + field credentials (fail-fast, prints secret names only). It does **not** run automatically on every PR.
- **CI runs** typecheck, lint, unit + mocked-Blob API tests, build, and the route/shell guards on every PR/push ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)). Authenticated end-to-end flows are **not** in CI by default.
- **Field-readiness smoke: `NOT STARTED`.** No dedicated assign → field-login → attributed-hours → office-sees-it smoke exists. _Status requires confirmation_ if a session is mid-flight.
- **Manual dogfood is required.** Because authed Phil pages cannot run on local `next dev` and there is no field-readiness smoke, the [DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md) is currently the primary field-readiness gate. There is no substitute for a supervised manual run on a preview/seeded environment.

---

### How to keep this honest

If you fix or ship one of the above, update the label here **and** in
[ROLL_OUT_STATUS](./ROLL_OUT_STATUS.md) in the same PR. Do not let a limitation
read as open after it closes, and do not let a placeholder read as built.
