# BuhlOS / Phil — Roll-out Status

> **One-line answer: NOT ready for real field roll-out. READY for controlled
> internal dogfood with seeded QA and manual oversight.**

| | |
| --- | --- |
| **Snapshot** | `main @ 55ca30c` (PR #75 merged) |
| **Date** | 2026-06-05 |
| **Author** | Field-readiness rollout pack (docs-only) |
| **Re-verify before acting** | `main` moves fast (multiple sessions merge daily). Re-run the checks in [§ Status accuracy](#status-accuracy) and re-read the labels before you rely on any line below. |

This is a **status page**, not a planning artefact and not a sign-off. It does
not introduce scope, claim readiness, or hide blockers. If something is unclear
or unverified it is labelled as such — read the labels literally.

**Status labels used in this pack:** `MERGED` · `OPEN PR` · `IN PROGRESS` ·
`NOT STARTED` · `DEFERRED` · `FUTURE` · `DECISION NEEDED`. "Merged" means a PR
is on `main` and confirmed by `git log`. "Merged" does **not** mean
production-verified — that is called out separately wherever it matters.

Companion docs:
[DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md) ·
[KNOWN_LIMITATIONS](./KNOWN_LIMITATIONS.md) ·
[NEXT_HARDENING_LANE](./NEXT_HARDENING_LANE.md)

---

## 1 · Current verdict

| Question | Answer |
| --- | --- |
| **Controlled internal dogfood (supervised)?** | **YES** — with seeded QA accounts, explicit test jobs, and manual rollback. |
| **Real field roll-out (live crew, payroll reliance)?** | **NO.** |
| **Why** | The foundation is genuinely strong — route/shell ownership, seeded QA, role normalisation, modern job assignment, hours attribution, and the Plans/Needs-Attention surfaces are all merged. But several **operational gaps** remain: there is no dedicated field-readiness smoke run green, the audit-log durability guarantee is undecided, deprecated-naming cleanup is still an open PR, and several modules are **partial** (procurement loop, My Gear, plan upload). Treat the app as a supervised dogfood tool, not a system of record. |

**Do not assume production-ready.** Modern surfaces look polished and several
loops are genuinely complete, which makes the app *look* further along than it
is. The partial modules below are the ones most likely to be mistaken for
finished.

---

## 2 · What is now solid

All of the following are **MERGED to `main`** and confirmed by `git log` at the
snapshot above. "Solid" = built, on main, with tests; it does **not** assert
production smoke unless stated.

| Capability | Status | Evidence |
| --- | --- | --- |
| **Route / shell ownership** — every route has an owner + status; guards block legacy/forbidden links and shell drift | `MERGED` | PR #66, #50 · [docs/route-ownership.md](../route-ownership.md) · `check:route-ownership`, `check:shell-contract`, `check:admin-shell`, `check:production-shell` |
| **Preview Smoke is guarded** — manual `workflow_dispatch` only; refuses production/unsupported targets; **requires** both admin + field credentials (fail-fast, secret names only) | `MERGED` | PR #62 · [.github/workflows/preview-smoke.yml](../../.github/workflows/preview-smoke.yml) · [docs/testing/Claude-Authed-Preview-Smoke.md](../testing/Claude-Authed-Preview-Smoke.md) |
| **Seeded authenticated QA** — deterministic seeded accounts + authed smoke harness | `MERGED` | PR #65 · [docs/testing/Seeded-Authenticated-QA.md](../testing/Seeded-Authenticated-QA.md) · [docs/qa/authenticated-smokes.md](../qa/authenticated-smokes.md) |
| **Role normalisation** — jobs + hours + gear APIs agree on admin / LH / field / client tiers (lowercased, multi-alias) | `MERGED` | PR #63, #64 (hours/jobs) · PR #74 (gear/assets) |
| **Modern job assignment** — admin assigns field workers; writes `users.json.assignedJobIds`; Phil visibility derives from it | `MERGED` | PR #67 · v2 assignment UI on the job builder |
| **Plans Phase 1 + 2** — read-only plan viewer + drawing-markup overlay foundation (source kept immutable, overlays stored separately) | `MERGED` | PR #61, #68 · [docs/plans-phase-2-overlays.md](../plans-phase-2-overlays.md) |
| **Needs Attention / Command Centre** — operational attention surface (grouping, sort, tabs, action-state clarity, source deep-links) | `MERGED` | PR #69–#73 · [docs/needs-attention-exceptions-inbox.md](../needs-attention-exceptions-inbox.md) |
| **Material Requests** — field-to-office request loop (requested → approved → ordered → delivered → cancel) | `MERGED` | PR #56 (request loop only — see limitations) |
| **Gear / Assets hardening** — Gear/Assets role checks normalised for field readiness | `MERGED` (PR #74) | confirmed on `main` at snapshot |
| **Phil hours job attribution** — field hours attach to the active assigned job; zero/many-job states handled; API rejects arbitrary/unassigned/draft/archived job for field self-submit | `MERGED` (PR #77) | confirmed on `main` at snapshot. **Production verification still pending** — see §3 / §7. |
| **Phil field UI / design-system polish** | `MERGED` (PR #75) | confirmed on `main` at snapshot |

---

## 3 · What still blocks real roll-out

Prioritised. A `P0` blocks even a *supervised* trial that touches real data; a
`P1` blocks a limited field pilot; a `P2` should be cleared before widening.

### P0 — must not happen during any trial

| # | Blocker | Status | Note |
| --- | --- | --- | --- |
| P0-1 | **No system-of-record guarantees.** Storage is append-then-overwrite on JSON blobs (last-write-wins under concurrent writes), mitigated by a short cache + retry, not solved. Do **not** treat any data as durable truth. | `DECISION NEEDED` | See P0-2 and [KNOWN_LIMITATIONS § Hours / § Audit](./KNOWN_LIMITATIONS.md). |
| P0-2 | **Audit-log durability guarantee undecided.** The audit-log domain + verbs exist, but writes are best-effort; there is no enforced "every state change is logged or the action fails" guarantee. | `DECISION NEEDED` | A deliberate decision (enforce vs accept best-effort + document) is required before pilot. |

### P1 — blocks a limited field pilot

| # | Blocker | Status | Note |
| --- | --- | --- | --- |
| P1-1 | **Phil hours job attribution production-unverified.** Merged (#77), but Preview Smoke was not dispatched and authed Phil pages can't run on local `next dev`. The 0/1/many-job behaviour must be verified on a preview/seeded environment before any payroll-adjacent use. | `MERGED`, verification pending | [DOGFOOD_CHECKLIST § Field worker flow](./DOGFOOD_CHECKLIST.md) |
| P1-2 | **No dedicated field-readiness smoke.** No branch/workflow named field-readiness smoke exists; Preview Smoke + seeded QA are the only authed nets. A purpose-built field-readiness smoke (assign → field login → see job → log attributed hours → office sees it) is not built. | `NOT STARTED` | _Status requires confirmation_ if another session is mid-flight. |
| P1-3 | **Deprecated "Site Office" naming cleanup not on `main`.** Cleanup lives on an **open PR (#76)**; until merged + verified, legacy naming can still surface. A route-ownership guard already forbids deprecated names in active nav. | `OPEN PR` (#76) | |
| P1-4 | **Legacy / manual setup detours still exist.** Admin job setup, plan upload, and several "bail-out to legacy" links route operators through legacy `public/*.html` surfaces. These are reachable and load-bearing. | `IN PROGRESS` / `DEFERRED` | [docs/route-ownership.md § Legacy routes](../route-ownership.md) |
| P1-5 | **Material Request loop not fully closed.** Request → approve → order → deliver exists; there are **no** purchase orders, supplier ordering, Xero, or stock decrement. It is a request tracker, not procurement. | `MERGED` (partial) | [KNOWN_LIMITATIONS § Material Requests](./KNOWN_LIMITATIONS.md) |

### P2 — clear before widening past one field user

| # | Blocker | Status | Note |
| --- | --- | --- | --- |
| P2-1 | **Plan upload / rasterisation still legacy.** Modern viewer + overlays are read-side; uploading and rasterising plans still goes through the legacy admin surface. | `NOT STARTED` (modern) | per-page PNGs already exist, de-risking render. |
| P2-2 | **My Gear issue / QR / inventory workflows deferred.** Gear register + assignment are live; worker-side issue reporting, QR scan, and van-stock/inventory are UC/deferred. | `DEFERRED` | [KNOWN_LIMITATIONS § Gear](./KNOWN_LIMITATIONS.md) |
| P2-3 | **Old legacy routes still reachable.** `/phil`, `/my-day`, `/my-gear`, `/admin/*.html`, `/buhlos/*` mirrors, `/dev/site-office` remain rewritten in production (preserved on purpose). | `DEFERRED` (quarantine) | guarded by `check:route-ownership` against re-linking from modern nav. |
| P2-4 | **Modules that look complete but are partial.** Needs Attention is projection-only (no dismiss/snooze); Plans is read + markup-foundation only; Hours lacks the rejected-hours correction loop + payroll export. | mixed | [KNOWN_LIMITATIONS](./KNOWN_LIMITATIONS.md) is the authoritative list. |

---

## 4 · What is safe for dogfood

With supervision, the following are appropriate:

- **Controlled admin testing** — exercising admin surfaces (Command Centre, Hours, Approvals, Gear register, Jobs, Material Requests) against explicit test jobs.
- **Seeded QA** — running the seeded authenticated QA accounts and authed smokes ([docs/qa/authenticated-smokes.md](../qa/authenticated-smokes.md)).
- **Office-only trials** — an office user walking the full admin loop without a real crew attached.
- **One internal field user with supervision** — a single known person (ideally an operator/owner) running Phil on a real device against a test job, watched.
- **Explicit test jobs** — clearly named, parked as Draft where possible, prefixed so they are obviously not real (see [DOGFOOD_CHECKLIST § Before dogfood](./DOGFOOD_CHECKLIST.md)).
- **Manual rollback / cleanup** — anything created during a session is removed by hand afterwards; there are no automated cleanup endpoints.

---

## 5 · What is NOT safe yet

Do not do any of the following:

- **Full crew use.** No general workforce; one supervised field user at a time.
- **Payroll reliance without manual review.** Hours are not a payroll source of truth; every entry must be eyeballed.
- **Using Phil hours as the final job-costing source.** Attribution is merged (#77) but **production-unverified**, and there is no rejected-hours correction loop or job-costing report. Treat as indicative only.
- **Relying on gear / inventory as live asset truth.** Gear role checks are hardened (#74) but issue/QR/inventory workflows are deferred; the register is not a live single source of asset truth.
- **Using reports / Xero / QR / AI as if built.** None are built. UC panels referencing them are placeholders, not features.
- **Trusting Needs Attention as a complete worklist.** It is a projection (no dismiss/snooze); use it as a prompt, not a queue of record.
- **Treating any write as durable.** See P0 — last-write-wins JSON storage; no transactional guarantees.

---

## 6 · Readiness scale

| Level | Meaning |
| --- | --- |
| 0 | Prototype only |
| 1 | Internal dev testing |
| **2** | **Controlled dogfood** |
| 3 | Limited field pilot |
| 4 | Operational roll-out |
| 5 | Production-grade |

### Current rating: **2 / 5 — Controlled dogfood**

**Why not 1:** the app is clearly past dev-only tinkering. Route/shell
ownership is guarded, seeded authenticated QA exists, role normalisation is
consistent across APIs, modern job assignment and hours attribution are on
`main`, Preview Smoke is wired (guarded), and multiple operational loops
(Hours, Gear, Jobs, Evidence/Snags, Material Requests, Needs Attention, Plans
read-side) are genuinely shipped.

**Why not 3:** the gates for a limited field pilot are not met. There is no
field-readiness smoke run green; the audit-log durability guarantee is
undecided (P0-2); deprecated-naming cleanup is an open PR (#76); hours
attribution is production-unverified (P1-1); and several modules are partial
(procurement, My Gear, plan upload, rejected-hours correction). Until those
clear, a real pilot would be relying on surfaces that are not yet trustworthy
as records.

**Trajectory:** there is a credible, short path from 2 → 3. See §7.

---

## 7 · Next readiness gates (before a limited field pilot)

These are the **exact** gates to clear to move from 2 (dogfood) to 3 (limited
field pilot). Each must be **merged AND verified**, not merged alone.

- [ ] **#74 (Gear/Assets normalisation)** — `MERGED`. Remaining: verify gear role behaviour on a preview/seeded env.
- [ ] **#76 (deprecated naming cleanup)** — `OPEN PR`. Merge + verify no "Site Office"/"Switchboard" leak on active surfaces.
- [ ] **#77 (Phil hours attribution)** — `MERGED`. Remaining: run the 0 / 1 / many-job attribution check on a preview/seeded env and confirm the entry carries the job into admin approvals.
- [ ] **Field-readiness smoke** — `NOT STARTED`. Build it, merge it, and run it **green** (assign → field login → see job → log attributed hours → office sees it).
- [ ] **Audit-log guarantee decision** — `DECISION NEEDED`. Decide enforce vs accept-best-effort-and-document, and record the decision.
- [ ] **Manual preview checklist passed** — run [DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md) end to end on a preview deployment with seeded accounts.
- [ ] **First internal test job completed** — one full supervised loop (admin sets up a test job → field user logs attributed hours → office reviews) with the dogfood report filled in.

When every box above is checked, re-rate against §6 and update this page.

---

## Status accuracy

This page is a snapshot. To re-verify before relying on it:

```bash
git fetch origin
git log --oneline origin/main -15            # what is actually merged
gh pr list --state open                      # what is still open
gh pr view <N> --json state,mergedAt         # confirm a specific PR
```

If a status here disagrees with the commands above, **the commands win** —
update this doc. If a claim cannot be confirmed, it should read
"_Status requires confirmation_" rather than assert a state.
