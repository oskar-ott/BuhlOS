# BuhlOS / Phil — Internal Dogfood Checklist

> **Scope:** controlled, supervised internal dogfood only. This is **not** a
> field roll-out checklist. Read [ROLL_OUT_STATUS](./ROLL_OUT_STATUS.md) first —
> the current rating is **2 / 5 (controlled dogfood)** and several modules are
> partial. See [KNOWN_LIMITATIONS](./KNOWN_LIMITATIONS.md) for what not to trust.

**Golden rules for every dogfood session**

1. **Mutating dogfood runs on a non-production target only.** Anything that writes — create/reuse a test job, assign a field worker, publish/activate, log hours, archive/delete cleanup — must run against a **preview / seeded / controlled test environment**, never production. Production is **read-only** during routine dogfood; do not create/publish/assign/log/clean up test data there. A production *change* requires explicit, separate approval **and** a documented production-change procedure. **Preview Smoke is preview-only — never dispatch it against production.**
2. Use **explicit test jobs** with an obvious prefix (e.g. `DOGFOOD —`). Never test against a real customer job.
3. Treat all data as **disposable** — there are no transactional guarantees and no automated cleanup.
4. One **supervised** field user at a time. The supervisor stays present.
5. If you hit a **stop condition** (§6), stop immediately and record it.
6. Some labels mean **placeholder, not feature** — see "depending on merge state" notes; verify against `main` before relying on a flow.

Status shorthand used below: ✅ pass · ⚠️ pass-with-note · ❌ fail · ⏭️ not-applicable.

---

## 1 · Before dogfood

- [ ] **Confirm the current main / PR stack.** `git fetch origin && git log --oneline origin/main -15` and `gh pr list --state open`. Note the snapshot SHA you are testing.
- [ ] **Confirm the dogfood target is a preview / seeded / controlled test environment — not production.** Every mutating step below (create/assign/publish/log/cleanup) runs against that target only. Production is **read-only** for this session: limit any production check to safe read-only verification unless a separate, approved production-change procedure exists. **Do not dispatch Preview Smoke against production.**
- [ ] **Confirm the Vercel deploy is healthy** for the commit under test (on the preview / seeded target above). Unauth gated routes should 307 to `/v2/login`; APIs should 401 unauth; no 500s, no blank pages.
- [ ] **Confirm seeded QA accounts exist** and you have the credentials out-of-band (admin + field at minimum). See [docs/testing/Seeded-Authenticated-QA.md](../testing/Seeded-Authenticated-QA.md).
- [ ] **Confirm no exposed / test passwords** are committed, pasted into the report, or visible on screen during capture. Credentials live in secrets, never in this repo.
- [ ] **Confirm no active disallowed `SMOKE_TEST` / `STRESS_TEST` jobs** are lingering. `npm run qa:list-smoke-jobs` and clear anything that should not be live.
- [ ] **Confirm test-job naming** follows the agreed prefix and is parked as **Draft** where possible. See [docs/testing/Test-Data-Rules.md](../testing/Test-Data-Rules.md).
- [ ] **Confirm everyone present knows this is dogfood only** — not production, not payroll, not a customer demo of "finished" features.

---

## 2 · Admin setup flow

Run as a seeded **admin** account.

- [ ] **Create or reuse a test job** (prefixed, Draft where possible).
- [ ] **Assign the field worker** to the job (modern v2 assignment → writes `assignedJobIds`).
- [ ] **Publish / activate** the job so it is visible to the field user (not Draft/Archived).
- [ ] **Attach or verify plan availability** if the flow needs it (Plans is read-only + markup foundation; upload is still legacy — note which path you used).
- [ ] **Verify the assigned field user can see the job** (cross-check in §3, or via the assignment UI).
- [ ] **Verify Needs Attention and Command Centre show no false blockers** — counts reconcile to reality; nothing UC/placeholder is presented as a live action.

---

## 3 · Field worker flow

Run as a seeded **field** account, on a real device where possible, supervised.

- [ ] **Log in** as the field user via `/v2/login`.
- [ ] **Open Phil** (modern surface, not legacy `/phil`).
- [ ] **Confirm the assigned job** appears.
- [ ] **Open the job.**
- [ ] **Open plans** for the job.
- [ ] **Verify read-only plan / overlay behaviour** — source plan is immutable; overlays/markups are stored separately; only current revisions render.
- [ ] **Log hours with job attribution** (PR #77, merged — **verify on this deploy**):
  - one active assigned job → preselected, shown as "Assigned job", Standard Day stays one tap;
  - multiple → choice **required** before submit;
  - zero → submit **blocked** with "ask the office to assign you to a job" (no fake job invented);
  - confirm the submitted entry carries the job into admin approvals (§4).
- [ ] **Check My Gear** (Gear normalisation merged #74; issue/QR/inventory are deferred — confirm what is actually interactive vs placeholder).
- [ ] **Record any confusing UI or dead ends** — UC panels, "SOON" pills, bail-out-to-legacy links, anything that reads as built but isn't.

---

## 4 · Office review flow

Run as a seeded **admin** account.

- [ ] **Review submitted hours** in the approvals queue.
- [ ] **Confirm job context is visible** — attributed entries show the job name; legacy/unattributed entries show an amber "No job assigned" flag (still approvable/rejectable, display-only).
- [ ] **Review material requests** if any were raised (request → approve → order → deliver; remember there is no PO / supplier / stock decrement).
- [ ] **Review Needs Attention** — items map to real sources and deep-link to the correct section.
- [ ] **Verify no fake / future action appears as live** — Xero push, payroll finalisation, QR, bulk ops, reports, AI are UC placeholders, not actions.
- [ ] **Check the gear register** if relevant — assignment/state reflects what the field user reported.

---

## 5 · Cleanup

Nothing is automatic. Do all of this by hand at the end of the session.

- [ ] **Archive / delete / unpublish the test job.**
- [ ] **Remove test assignments** if they should not persist.
- [ ] **Check no disallowed active smoke / test jobs remain** — `npm run qa:list-smoke-jobs` again; clear leftovers.
- [ ] **Record defects** in the report template (§7) before closing the session.
- [ ] **Confirm no real/production job was mutated** during the session.

---

## 6 · Stop conditions

Stop the dogfood session **immediately** and record the condition if any of
these occur. Several map directly to roll-out blockers in
[ROLL_OUT_STATUS § 3](./ROLL_OUT_STATUS.md).

- [ ] **Field user sees the wrong job** (a job they are not assigned to, or a Draft/Archived job).
- [ ] **Field user can reach an admin surface** they should not (privilege/tier leak).
- [ ] **Hours submit without a job** when active assigned jobs exist (attribution regression).
- [ ] **Admin cannot see submitted hours** (write/propagation failure — read-after-write loss).
- [ ] **Permissions appear wrong** for any tier (admin / LH / field / client mismatch).
- [ ] **Data writes to a real production job** unintentionally.
- [ ] **A route goes blank** (shell boot failure / RSC manifest error).
- [ ] **Legacy / deprecated naming appears in an active flow** ("Site Office", "Switchboard" as a section/sidebar — note #76 is still an open PR).

---

## 7 · Dogfood report template

Copy this block per session and fill it in. Keep it in the team's dogfood log
(not committed with secrets/screenshots of credentials).

```
## Dogfood session report

- Date:                 YYYY-MM-DD
- Tester:               <name>
- Account role:         admin | leading hand | field | client
- Environment:          preview | seeded | controlled-test   (production = read-only checks only)
- Snapshot under test:  main @ <sha>  (preview / seeded URL; prod only for read-only checks)
- Job used:             <prefixed test job id/name>  (Draft? yes/no)

### Flows tested  (✅ / ⚠️ / ❌ / ⏭️)
- Admin setup:          [ ]
- Field worker:         [ ]
- Office review:        [ ]
- Cleanup:              [ ]

### Hours attribution (PR #77) specifically
- One job (preselect):  [ ]
- Many jobs (required): [ ]
- Zero jobs (blocked):  [ ]
- Entry carried job to admin approvals: [ ]

### Result
- Overall pass/fail:    PASS | PASS-WITH-NOTES | FAIL
- Screenshots / notes:  <links, no credentials>

### Bugs found
| # | Description | Severity (P0/P1/P2/P3) | Stop-condition? | Next action |
|---|-------------|------------------------|-----------------|-------------|
| 1 |             |                        | yes/no          |             |

### Cleanup confirmation
- Test job archived/removed:        [ ]
- No disallowed smoke/test jobs:    [ ]
- No production job mutated:        [ ]
```
