# Next Hardening Lane

> Prioritised hardening roadmap to move BuhlOS / Phil from **2 / 5 (controlled
> dogfood)** toward a limited field pilot and beyond. Ordering reflects what
> unblocks trustworthy field use first.

| | |
| --- | --- |
| **Snapshot** | `main @ 55ca30c` (PR #75), 2026-06-05 |
| **Companion** | [ROLL_OUT_STATUS](./ROLL_OUT_STATUS.md) · [KNOWN_LIMITATIONS](./KNOWN_LIMITATIONS.md) · [DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md) |

Labels: `MERGED` · `OPEN PR` · `IN PROGRESS` · `NOT STARTED` · `DEFERRED` ·
`FUTURE` · `DECISION NEEDED`. Recommended PR names are suggestions, not
reservations. This is a docs-only roadmap — it does not open any work.

---

## P0 / P1 — before field pilot

### 1. Phil hours job attribution

- **Why it matters:** unattributed field hours break job costing, approval context, payroll review, and Needs Attention grouping. This is the spine of "did the right person bill the right job".
- **Current status:** `MERGED` (PR #77) — UI attaches the active assigned job; API rejects arbitrary/unassigned/draft/archived for field self-submit. **Production-unverified**; `null` jobId still accepted server-side (legacy compat).
- **Recommended PR:** `verify(phil-hours): production smoke + server-side null-block for field roles`
- **Risk if not done:** hours that look attributed in dogfood but regress in production; legacy paths quietly producing `null`-job records that pollute costing.
- **Dependencies:** modern job assignment (#67, `MERGED`); a preview/seeded env to run the 0/1/many checks; field-readiness smoke (#4) is the durable net.

### 2. Gear role normalisation

- **Why it matters:** inconsistent role checks let the wrong tier read or mutate gear, or lock out legitimate users (boss/pm/office). Field readiness needs the gear holder-picker and register to agree on tiers.
- **Current status:** `MERGED` (PR #74). Gear/Assets role checks normalised; remaining work is production verification.
- **Recommended PR:** `verify(gear): preview smoke of holder-picker + register role tiers`
- **Risk if not done:** silent permission gaps on assets; a field user editing or seeing gear they shouldn't.
- **Dependencies:** auth role normalisation foundation (#63/#64, `MERGED`).

### 3. Deprecated naming leakage

- **Why it matters:** "Site Office" / "Switchboard" are dead product names. If they resurface in active flows, the product looks inconsistent and operators relearn the wrong vocabulary.
- **Current status:** `OPEN PR` (#76) — cleanup not yet on `main`. A route-ownership guard already forbids deprecated names in active nav and requires a DEPRECATED banner on the dev route.
- **Recommended PR:** (already open) `fix(naming): remove deprecated "Site Office" leak from active surfaces` (#76) → merge + verify.
- **Risk if not done:** legacy naming leaks into a field pilot; the guard catches nav links but not every surface until the cleanup lands.
- **Dependencies:** route-ownership guard (#66, `MERGED`).

### 4. Field-readiness smoke

- **Why it matters:** there is currently no automated proof that the core field loop works end to end. Manual dogfood is the only gate, which does not scale or guard regressions.
- **Current status:** `NOT STARTED` (no branch/workflow found; _confirm_ none is mid-flight). Preview Smoke (#62) + seeded QA (#65) are the building blocks.
- **Recommended PR:** `test(field-readiness): assign → field login → attributed hours → office sees it smoke`
- **Risk if not done:** every pilot relies on a human remembering to check the loop; attribution/assignment/permission regressions ship unnoticed.
- **Dependencies:** seeded authenticated QA (#65, `MERGED`); Preview Smoke harness (#62, `MERGED`); hours attribution (#77, `MERGED`).

### 5. Audit-log guarantee — decision / enforcement

- **Why it matters:** if state changes aren't reliably logged, you can't reconstruct who did what — which undermines approvals, disputes, and any payroll-adjacent trust.
- **Current status:** `DECISION NEEDED`. The audit-log domain + verbs exist (e.g. #55), but writes are best-effort on JSON blobs; there is no "log-or-fail" guarantee.
- **Recommended PR:** `docs/decision: audit-log durability — enforce vs accept-and-document`, then (if enforce) `feat(audit-log): make state-change logging non-optional`.
- **Risk if not done:** silent gaps in the operational record; an action succeeds while its audit entry is lost under concurrent writes.
- **Dependencies:** the underlying storage-durability question ([KNOWN_LIMITATIONS § preamble](./KNOWN_LIMITATIONS.md)); decide the policy before building enforcement.

---

## P1 / P2 — after controlled dogfood

### 1. Material request loop

- **Why it matters:** today it is a request tracker, not procurement; the office still orders by hand off-system.
- **Current status:** `MERGED` (partial, PR #56) — requested → approved → ordered → delivered → cancel. No PO, supplier, Xero, or stock decrement.
- **Recommended PR:** `feat(material-requests): purchase-order + delivery reconciliation (no external integrations yet)`
- **Risk if not done:** double-ordering, lost requests, no link between "ordered" and what actually arrives.
- **Dependencies:** decision on whether POs live in-app or defer to a supplier/accounting integration (`FUTURE`).

### 2. Rejected-hours correction flow

- **Why it matters:** without an in-app correction loop, a rejected entry forces the worker back to legacy My Day, breaking the modern flow and attribution.
- **Current status:** `IN PROGRESS` / `DEFERRED` — deferred in #77; the broader "complete the Hours money-control workflow" PR (#57) is `OPEN`.
- **Recommended PR:** (advance #57) `feat(hours): in-app rejected-entry correction with attribution`
- **Risk if not done:** rejected hours stall or get re-entered without a job; approval churn.
- **Dependencies:** hours attribution (#77, `MERGED`); PATCH attribution path (deferred in #77).

### 3. Plan upload / rasterisation modernisation

- **Why it matters:** upload is still legacy; the modern viewer can only show what the legacy path produced.
- **Current status:** `NOT STARTED` (modern). Per-page PNGs already exist (de-risks render).
- **Recommended PR:** `feat(plans): modern plan upload + rasterisation pipeline`
- **Risk if not done:** plan setup stays a legacy detour; revision handling and overlays risk drift from the source.
- **Dependencies:** Plans Phase 1/2 (#61/#68, `MERGED`); the `0..1` coordinate unit suite called out in Known Risk Areas.

### 4. My Gear issue reporting

- **Why it matters:** field workers need to report damaged/lost/returned gear from the field; today that worker-side loop is deferred.
- **Current status:** `DEFERRED`. Admin register + assignment + states are live (#74).
- **Recommended PR:** `feat(phil-gear): worker issue reporting (returned / missing / damaged)`
- **Risk if not done:** gear state drifts from reality; the register can't be trusted as asset truth.
- **Dependencies:** gear role normalisation (#74, `MERGED`).

### 5. Legacy route quarantine

- **Why it matters:** dozens of legacy routes (`/buhlos/*` mirrors, `/admin-legacy`, `/dev/site-office`) remain reachable; some are load-bearing, some are pure liability.
- **Current status:** `DEFERRED`. Preserved on purpose; `check:route-ownership` blocks re-linking from modern nav.
- **Recommended PR:** `chore(routes): quarantine non-load-bearing legacy routes`
- **Risk if not done:** stale surfaces leak as "current"; deprecated naming re-enters via a legacy mirror.
- **Dependencies:** deprecated-naming cleanup (#76, `OPEN PR`); a clear map of which legacy routes production still depends on ([docs/route-ownership.md](../route-ownership.md)).

### 6. Admin setup wizard

- **Why it matters:** job setup currently mixes modern assignment with legacy detours; a guided wizard reduces operator error before a pilot.
- **Current status:** `NOT STARTED`. Modern assignment (#67) + thin Job Builder exist as building blocks.
- **Recommended PR:** `feat(jobs): guided admin job-setup wizard (assign → plan → publish)`
- **Risk if not done:** inconsistent setup; missed assignments or plan attachments that surface as field confusion.
- **Dependencies:** job assignment (#67, `MERGED`); plan upload modernisation (above) for the plan step.

---

## Future only

These are **`FUTURE`** — not scheduled, not built, and must never be presented
as available. UC panels referencing them are placeholders.

| # | Item | Why later | Status |
| --- | --- | --- | --- |
| 1 | **QR labels** | Needs the gear issue/inventory loop first | `FUTURE` |
| 2 | **Xero** | Needs a trustworthy hours/payroll + procurement base | `FUTURE` |
| 3 | **Reports** | Cross-loop reporting depends on durable records (P0) | `FUTURE` |
| 4 | **AI plan interpretation** | Depends on modern plan upload/rasterisation | `FUTURE` |
| 5 | **As-built export** | Depends on plans markup maturity | `FUTURE` |
| 6 | **Supplier purchasing** | Depends on the material-request → PO foundation | `FUTURE` |

---

### Sequencing summary

1. **Verify what's merged** (#77, #74) and **merge what's open** (#76) — close the gap between "merged" and "trusted".
2. **Build the field-readiness smoke** (#4 above) and **decide the audit-log guarantee** (#5) — these turn manual dogfood into a repeatable gate.
3. **Run one supervised internal test job** end to end ([DOGFOOD_CHECKLIST](./DOGFOOD_CHECKLIST.md)).
4. Only then re-rate against [ROLL_OUT_STATUS § 6](./ROLL_OUT_STATUS.md) and consider a limited field pilot.
