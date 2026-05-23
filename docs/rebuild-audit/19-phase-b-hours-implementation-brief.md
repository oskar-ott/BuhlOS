# 19 · Phase B — hours implementation brief

> The implementation brief Claude Code must follow when building **Phase B only**. Read [10-product-definition.md], [11-operational-workflow-map.md] #1–#4, [12-domain-model-deep-dive.md] §Hours, [13-ui-information-architecture.md] §Phil/Today + §Admin/Hours, [16-migration-strategy.md] §C.3, [17-testing-and-quality-plan.md] §C.2, and [20-agent-rules.md] first. **Phase A must be on main before Phase B starts.**

---

## Goal

Make Phil hours logging **genuinely usable** for field workers and connected end-to-end to the existing `/api/time-entries.js` backend. Land the first closed operational loop in the rebuild: **Phil capture → Admin approval → audit + export**.

Phase B is not "add a hours page". It is the entire hours pipeline shipped on the new shell, with the legacy surfaces still serving as fallback until the Phase C cutover.

---

## Phil surface

### `/phil/my-day` (Today tab)

- **One-tap Standard Day: "Standard day · 7h 36m" button** that completes the hours submission in one tap with today's active job pre-selected.
- **Custom hours fallback:** number pad for whole hours (4–12) with allocation across multiple jobs if needed.
- **Date selector:** defaults to today; allows ±2 days for catch-up.
- **Job selector:** defaults to active assignment; allows picking from worker's assigned jobs.
- **Optional notes:** single-line text.
- **Status indicator:** "Submitted" / "Approved" / "Rejected" with reason.

### `/phil/hours` (history)

- Worker's own entries in reverse chronological order.
- Status badge per entry.
- Tap entry → details (read-only for approved; edit for draft/rejected).

### Sheet: `LogHoursSheet`

- Modal that opens from My Day "Log hours" CTA.
- Two big buttons: Standard Day (7h 36m) and Custom.
- Standard Day → submits in one tap.
- Custom → number pad + allocation grid.
- Validation: total > 0; allocations sum to total; date valid.

### Required worker identity handling

- Worker identity comes from session cookie (`buhl_session` decoded → `userId`).
- No identity prompt in the UI; the cookie carries it.
- If session expired → middleware redirects to `/v2/login` with `?next=/phil/my-day`.

---

## Admin surface

### `/hours/approvals`

- Pending entries grouped by worker.
- Per entry: date, total hours, allocations, notes.
- Approve / Reject buttons.
- Reject requires reason.
- Bulk-approve a worker's week.

### `/hours` (overview)

- Filters: this week / last week / custom range.
- By worker or by job aggregations.
- Pending count badge in sidebar derived from real data.

### Export

- Button on overview: "Export approved week to CSV".
- Format matches Xero-compatible CSV (column order documented in `src/domains/timesheets/export.ts`).
- Export writes `IntegrationEvent` with file hash + row count.

---

## Status lifecycle

```
draft → submitted → approved
                 → rejected → (edit) → submitted ...
```

- Worker creates `draft` (auto-save as they edit) or submits directly.
- Worker can edit own `draft` or `rejected` entries.
- Admin can edit any entry (with audit).
- LH can approve crew entries (excluding other LHs) per legacy rule.

---

## Validation rules

Enforced in `src/domains/timesheets/schema.ts` (Zod) — same schema used client + server:

- `date: ^\d{4}-\d{2}-\d{2}$`
- `totalHours: number, > 0, ≤ 16`
- `ordinaryHours + overtimeHours === totalHours` (±0.01)
- `allocations: array, length ≥ 1`
- `allocations[].hours: > 0`
- Sum of `allocations[].hours === totalHours` (±0.01)
- `allocations[].jobId: must be in worker's assigned jobs` (warning only; allow but flag for review)
- `status: enum(draft, submitted, approved, rejected)`
- `notes: string, ≤ 500 chars`
- Worker may not edit a `submitted` or `approved` entry (admin only).
- Worker may not approve their own entry.
- LH may not approve entries from another LH.

---

## Existing `/api/time-entries` assessment

The legacy backend at `api/time-entries.js` (+ `api/_lib/time-entries.js`) is **well-formed** and reusable verbatim:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/time-entries` | GET | List own entries (admin/LH can pass `userId=X`) |
| `/api/time-entries?status=submitted&scope=approver` | GET | Approver queue (admin sees all; LH filtered by job + excludes other LHs) |
| `/api/time-entries` | POST | Create draft or submit |
| `/api/time-entries?date=YYYY-MM-DD` | PATCH | Edit own draft/rejected or admin any |
| `/api/time-entries?date=YYYY-MM-DD` | DELETE | Delete own draft |
| `/api/time-entries-approve` | POST | Approve a submitted entry |
| `/api/time-entries-reject` | POST | Reject with reason |
| `/api/time-entries-bulk-approve` | POST | Bulk approve N entries |
| `/api/time-entries-bulk-reject` | POST | Bulk reject |
| `/api/time-entries-export` | GET | CSV export |
| `/api/time-entries-overview` | GET | Aggregated counts for dashboard |
| `/api/time-entries-on-site` | GET | Who's currently logging hours today |
| `/api/time-entries-recent-jobs` | GET | Recent jobs the worker has logged against |
| `/api/time-entries-reopen` | POST | Re-open an approved entry (admin only) |

**Schema in `api/_lib/time-entries.js` is the rebuild's reference.** Storage paths:

- `users/<userId>/time-entries/<date>.json` — one entry per user per day.
- `users/<userId>/time-entries-audit/<yyyy-mm>.json` — append-only audit log.

**Phase B reuses these endpoints unchanged.** No new endpoint is written in Phase B unless required for a flow the legacy doesn't support.

If a legacy endpoint proves unsuitable:

- Document the gap in `docs/rebuild-audit/22-phase-1b-command-results.md` (or its Phase B successor).
- Stop. Ask. Do NOT silently add a new endpoint that diverges from the legacy contract.

---

## Phase B MUST NOT do

- **No `/login` cutover.** Legacy `/login` still serves `login.html`. Tradie may log in via legacy or via `/v2/login`; both set the same `buhl_session` cookie.
- **No `/phil` cutover.** Legacy `/phil` still serves `phil.html`. The new flow lives at `/phil/my-day`.
- **No `/my-day` cutover.** Legacy `/my-day` still serves. The PWA `start_url` does NOT change until Phase C.
- **No `/admin` cutover.** Legacy `/admin/operations` still owns the Command Centre.
- **No Xero export.** CSV only.
- **No payroll finalisation.** Just export.
- **No `vercel.json` edits.**
- **No removal of any legacy endpoint or `public/*.html` file.**
- **No new business logic in page components.** Domains carry logic; pages compose.
- **No mock-only fallback.** All data is real; if real data fails, show error UI (not silent fallback to fixtures).

---

## Acceptance criteria

### Functional

- [ ] Worker can submit Standard Day in **under 15 seconds** (Playwright timing assertion).
- [ ] Worker can submit custom hours with up to 3 job allocations.
- [ ] Submitted entry appears in admin approval queue within 1 second.
- [ ] Admin can approve / reject with reason.
- [ ] Rejected entry shows in worker's history with reason; worker can edit and resubmit.
- [ ] Bulk-approve works for a week of one worker's entries.
- [ ] Approved entries downloadable as CSV.
- [ ] CSV opens cleanly in Xero/spreadsheet (column order verified manually).
- [ ] LH approval scope works (LH sees only their crew, excludes other LHs).
- [ ] DemoModeBanner is OFF on `/phil/my-day`, `/phil/hours`, `/hours/approvals` once real data is wired.
- [ ] No "Site Office" or "Switchboard" (product label) in any page DOM.

### Technical

- [ ] All Phase A criteria still met.
- [ ] `src/domains/timesheets/{schema,types,fixtures,client,service}.ts` exists.
- [ ] `src/domains/timesheets/timesheets.test.ts` covers happy path + error cases for the typed client.
- [ ] Playwright `tests/phase-b-hours.spec.ts` covers:
  - Tradie login → /phil/my-day → submit Standard Day.
  - Admin login → /hours/approvals → approve.
  - Reject flow with reason.
  - LH visibility check.
- [ ] All four legacy guards pass.
- [ ] CI workflows green on PR + on main.

### Deploy

- [ ] No `vercel deploy` from local.
- [ ] PR merges to `main`; Vercel auto-deploys.
- [ ] Preview URL verified by user before merge.

---

## Failure cases & required behaviour

| Failure | Required behaviour |
| --- | --- |
| API not reachable (5xx) | Show error banner; offer retry; never silent fallback to fixtures. |
| Missing worker identity (no session) | Middleware redirects to `/v2/login?next=/phil/my-day`. |
| Missing job assignment | Allow submission with flag; admin sees a warning pill on the entry. |
| Duplicate submission (same date) | API returns 409; UI shows "An entry exists for this date — edit it instead". |
| Offline / connection lost | Local draft saved; sync attempts on reconnection; UI shows "Offline — will sync". |
| Invalid hours (> 16 / < 0) | Client-side validation prevents submit; server-side double-checks. |
| Admin rejects with no reason | UI requires reason text before reject API call. |
| Entry already approved (worker tries to edit) | UI hides edit button; if request is forced, server returns 403. |
| Session expired mid-submission | API returns 401; UI redirects to `/v2/login?next=/phil/my-day` preserving draft in localStorage. |

---

## Tests

### Vitest (`src/domains/timesheets/timesheets.test.ts`)

- Schema parses valid entry.
- Schema rejects: bad date, total ≠ split sum, allocations ≠ total, missing required fields.
- Client formats body correctly for create / patch / approve / reject.
- Client returns `{ok: false}` on 4xx / 5xx without throwing.

### Playwright (`tests/phase-b-hours.spec.ts`)

- Tradie login → /phil/my-day → tap Standard Day → entry submitted → admin sees in queue.
- Admin login → /hours/approvals → approve → entry status updated → CSV export available.
- Reject with reason → tradie sees reason → resubmit succeeds.
- Standard Day completes in < 15 seconds (timing assertion).
- LH login → /hours/approvals → sees only crew entries, no other LHs.

### Legacy guards

- All four continue passing.

---

## Data model requirements

The Phase B domain code lives in `src/domains/timesheets/`:

- `schema.ts` — Zod schemas matching `api/_lib/time-entries.js` shape exactly.
- `types.ts` — `z.infer<>` types.
- `fixtures.ts` — typed fixtures for Storybook / preview; **not used in production** (production wires the real API client).
- `client.ts` — typed fetch wrapper around `/api/time-entries*` endpoints.
- `service.ts` — pure helpers: `autoSplitOT(total)`, `calcTotalHours(start, end, breakMin)`, `weekOf(date)`, `allocationsSumValid(entry)`.
- `timesheets.test.ts` — unit tests.

The `AuditLog` write happens server-side in the legacy endpoint already (per `api/_lib/time-entries.js`); Phase B does NOT add a new audit table — Phase D will unify when more domains exist.

---

## Migration notes

- **Worker identity:** existing `users.json` with `role` field. No migration.
- **Existing time entries:** already in `users/<userId>/time-entries/<date>.json`. No migration.
- **Job index:** `jobs.json` consumed read-only for the job picker.
- **Pay rates:** read from `WorkerProfile` (today nested in `users.json`); Phase B uses but does not edit.
- **localStorage cleanup:** boot migration in `src/lib/storage/migrate-local-storage.ts` (added Phase A) deletes deprecated keys; Phase B does not need new migration.

---

## What to do if the existing API is unsuitable

If during Phase B implementation the agent discovers the legacy `api/time-entries.js` cannot support a required UI flow:

1. **Stop coding.** Do not silently write a new endpoint.
2. **Document the gap:** create `docs/rebuild-audit/22-phase-1b-command-results.md` Addendum or equivalent.
3. **Surface to the user** with: what flow needs what response shape, what the legacy endpoint actually returns, what the proposed new endpoint signature is.
4. **Get explicit approval** before adding a new endpoint.
5. **If approved:** new endpoint goes in `src/app/api/<domain>/route.ts` (not in `api/*.js`); Zod-validated; integration-tested.

---

## Phase B exit checklist

- [ ] All Phase B acceptance criteria met.
- [ ] One week of real worker submissions on `/phil/my-day` without rollback.
- [ ] Boss + admin sign-off recorded.
- [ ] Preview URL verified by user; production deploy via merge.
- [ ] Production verified post-deploy.
- [ ] Phase A surfaces still working (regression test).
- [ ] Docs updated: `00-executive-summary.md` Phase B section, this brief marked complete.
- [ ] [16-migration-strategy.md] Phase C cutover preconditions evaluated and any deviations flagged.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) §user groups (tradesman, admin, LH).
- [11-operational-workflow-map.md](11-operational-workflow-map.md) #1–#4.
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §Hours.
- [13-ui-information-architecture.md](13-ui-information-architecture.md) §Phil/Today + §Admin/Hours.
- [16-migration-strategy.md](16-migration-strategy.md) §C.3 (Phase C cutover preconditions).
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) §C.2.
- [18-phase-a-implementation-brief.md](18-phase-a-implementation-brief.md) — Phase A foundation that Phase B builds on.
- [20-agent-rules.md](20-agent-rules.md) — agent posture during Phase B.
- [[project_buhlos_phil_hours_pipeline]] — user's memory of the canonical hours pipeline order.
- [[feedback_hide_unfinished_features]] — never leave half-broken UI live.
