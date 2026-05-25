# Phase D.5 · Snags / defects loop runbook

> **Status:** built. Operational loop is: worker reports → admin acts → status flows back.
> **Read alongside:** [phase-d5-runbook.md](phase-d5-runbook.md), [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md), [27-interface-usability-pass.md](27-interface-usability-pass.md), [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md).
>
> Non-numeric filename intentional — sibling of `phase-d2-runbook.md` and `phase-d5-runbook.md`.

---

## 1 · What D.5 ships

D.5 is the first complete operational loop for **snags / defects** — issues raised on a job that need someone to fix and someone to verify. Pattern mirrors the existing Phase B (hours), Phase C (gear), and Phase D2–D5 (evidence) loops.

| Surface | Change |
| --- | --- |
| `src/domains/snags/{schema,types,service,format,client}.ts` | New domain. Zod schemas, status / priority enums, transition state-machine + role gates, display helpers, typed fetch client. |
| `src/domains/snags/snags.test.ts` | 63 tests covering schema, state machine, role gates, format helpers, sort comparator, client wrappers. |
| `api/snags.js` | New endpoint. `GET list`, `POST create`, `POST ?action=transition`. Validation, permissions, audit dual-write. |
| `api/_lib/audit-log.js` | Adds `snag.created` + `snag.transitioned` verbs and `'snag'` targetType to the closed-set validator. |
| `api/audit-log.js` | `targetType=snag` now accepted on the read endpoint. Tradie filter only applies to evidence — field users see the full snag history on jobs they can access. |
| `src/domains/audit-log/{schema,client}.ts` | Adds snag verbs + targetType to the enums; `listAuditForTarget` accepts `'snag'`. |
| `src/components/phil/JobSnagsPanel.tsx` | Phil section under the job detail screen — shows active snags, primary "Report snag" CTA, claim/resolve buttons for the creator / assignee. |
| `src/components/phil/ReportSnagSheet.tsx` | Full-screen sheet on mobile: title + description + priority + area + linked evidence. Inherits stage/area from the job page. |
| `src/app/phil/jobs/[jobId]/page.tsx` | Server component now also fetches `/api/snags?jobId=...`, passes initial list + viewer down. |
| `src/components/phil/PhilJobDetail.tsx` | Renders the new snags panel below `TodaysCapturesStrip`. |
| `src/app/v2/jobs/[jobId]/snags/page.tsx` | New admin page. Same shape as the D4 evidence page. |
| `src/components/admin/SnagsQueue.tsx` | Admin queue. Active/Done/All filter, status + priority pills, primary-next-step button per row. |
| `src/components/admin/SnagDrawer.tsx` | Right-slide detail drawer. Body + history + every available transition button. |
| `src/components/admin/SnagRejectModal.tsx` | Required-reason modal mirrored from `EvidenceRejectModal`. |
| `scripts/smoke-evidence-routes.js` | Extended to cover snag HTML route + API GET/POST gates (24 checks total). |
| `docs/rebuild-audit/phase-d55-snags-runbook.md` | This doc. |

**Tests added:** 63 new + 1 existing audit-log test updated to cover the new enums. Full vitest **348/348**.

**No vercel.json change.** No legacy routes touched. No new public/*.html. Legacy `snags[]` array on `data.json` left alone — new loop writes to a sibling `snagsV2[]` namespace.

---

## 2 · Storage shape

Per-job blob `jobs/<jobId>/data.json`:

```jsonc
{
  "dwellings": { ... },
  "snags":     [ ... ],           // LEGACY — owned by api/snag-quick-raise.js et al.
  "snagsV2":   [ SnagItem, ... ], // NEW — Phase D.5
  "evidence":  [ EvidenceItem ],  // D2+
  "notes":     [ ... ]
}
```

Append + full-doc rewrite. Two namespaces coexist intentionally: the legacy shape (`{dwelling, desc, priority: 'High'|'Medium'|'Low', status: 'Open'|'Closed'}`) is incompatible with the new schema, and the legacy endpoints still serve the legacy admin shell. Migration is a separate Phase F+ decision.

### SnagItem fields

| Field | Notes |
| --- | --- |
| `id` | `sn_<nanoid>` |
| `jobId` | parent |
| `title` | required, ≤120 chars |
| `description` | optional, ≤1000 chars |
| `summary` | optional rolled-up line; null on create today |
| `stage` | `roughIn \| fitOff \| null` |
| `areaId`, `areaName` | denormalised so the queue doesn't walk areaGroups |
| `taskId`, `taskName` | same; only set when stage + area are also set |
| `evidenceIds` | ≤10; each must resolve to a real EvidenceItem on this job |
| `status` | see §3 |
| `priority` | `low \| normal \| high \| urgent` (server defaults to `normal`) |
| `source` | `phil \| admin \| system` |
| `createdById/Name/Role`, `createdAt` | server-set from session |
| `assignedToId/Name` | optional; first claimant auto-fills if absent |
| `acknowledgedAt/ById/ByName` | set on first `open → in_progress` |
| `resolvedAt/ById/ByName` | set on every `* → resolved` |
| `verifiedAt/ById/ByName` | set on `resolved → verified` |
| `closedAt/ById/ByName` | set on `verified → closed` |
| `rejectedAt/ById/ByName/Reason` | set on `* → rejected` |
| `auditLogIds` | append-only pointers to monthly audit blobs |

`.passthrough()` everywhere — future fields don't break parsing.

---

## 3 · State machine

```
                        ┌────────────── rejected ──────────────┐
                        │                                       │
                        ▼                                       │
   null ──► open ──► in_progress ──► resolved ──► verified ──► closed
              ▲          │              │            │           │
              │          ▼              ▼            ▼           ▼
              └── (drop) open ◄── (re-open) resolved ◄── (un-verify) ── (re-open)

   open / in_progress / resolved → rejected (admin only, reason required)
   rejected → open (admin only — re-open a rejected snag)
```

`canTransition()` in `src/domains/snags/service.ts` and `ALLOWED_TRANSITIONS` in `api/snags.js` are kept in sync (test in `snags.test.ts` asserts the full matrix).

### Role gates (canRoleTransition)

| Transition | admin | LH | tradie creator | tradie assignee | other tradie |
| --- | --- | --- | --- | --- | --- |
| `null → open` (create) | ✓ | ✓ | ✓ | n/a | ✓ |
| `open → in_progress` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `in_progress → open` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `in_progress → resolved` | ✓ | ✓ | ✓ (if LH/tradie role) | ✓ | ✗ |
| `resolved → in_progress` | ✓ | same as resolve | same | same | ✗ |
| `resolved → open` | ✓ | same | same | same | ✗ |
| `resolved → verified` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `verified → closed` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `verified → resolved` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `closed → verified` | ✓ | ✗ | ✗ | ✗ | ✗ |
| any `* → rejected` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `rejected → open` | ✓ | ✗ | ✗ | ✗ | ✗ |

Direct `open → resolved` / `open → verified` / `open → closed` are intentionally blocked — verify is the audit trail, and a never-real snag should be `rejected` with a reason rather than silently closed.

---

## 4 · API contract

### `GET /api/snags?jobId=<id>`

| Status | When |
| --- | --- |
| 200 | `{ snags: SnagItem[] }`, newest-first by `createdAt` |
| 400 | `jobId` missing |
| 401 | unauthenticated |
| 403 | `role=client`, or worker not assigned to job |
| 404 | job not found (only thrown if a downstream read needs it; current GET returns empty list rather than 404 when the job exists but has no snagsV2) |
| 500 | storage read failed |

Field users (tradie / LH) on assigned jobs see every snag on the job. Admin sees everything. No tradie-only filter — that mirrors the field reality (a worker walking onto a site needs visibility of every outstanding issue).

### `POST /api/snags?jobId=<id>` (create)

Body shape (validated server-side AND client-side via `CreateSnagPayloadSchema`):

```json
{
  "title": "Plug missing earth in kitchen",
  "description": "...",
  "priority": "high",
  "stage": "fitOff",
  "areaId": "ar_kitchen",
  "taskId": "ft_xxx",
  "evidenceIds": ["ev_abc", "ev_def"],
  "assignedToId": "user-tradie-3"
}
```

| Status | When |
| --- | --- |
| 201 | `{ snagItem: SnagItem }` — canonical written row (no client round-trip needed) |
| 400 | validation error (`{ error, errors[] }`) |
| 401 | unauthenticated |
| 403 | `role=client`, or worker not assigned to job |
| 404 | job not found |
| 502 | Blob write failed |

Validation:
- `title` required, trimmed, ≤120 chars.
- `description` ≤1000 chars.
- `priority` enum (default `normal`).
- `taskId` requires `stage`.
- `areaId` must exist on the job's areaGroups.
- `taskId` must resolve via the area / job task template for the chosen stage.
- Every `evidenceId` must resolve to a real evidence row on this job.

### `POST /api/snags?jobId=<id>&action=transition`

```json
{ "snagId": "sn_abc12345", "nextStatus": "resolved", "reason": null }
```

| Status | When |
| --- | --- |
| 200 | `{ snagItem: SnagItem }` — canonical updated row |
| 400 | invalid `nextStatus`, invalid `from → to` for the state machine, missing reason for `rejected`, or reason > 500 chars |
| 401 | unauthenticated |
| 403 | `role=client`, no write access, OR role can't perform this transition (e.g. tradie attempting verify) |
| 404 | snag not found on job |
| 502 | Blob write failed |

`reason` is required on `* → rejected`; optional + audit-only on other transitions.

---

## 5 · Audit

Dual-write per evidence precedent:

1. **New cross-surface journal** (`api/_lib/audit-log.js`) — monthly `audit/<yyyy-mm>.json` blobs. D.5 adds two verbs:
   - `snag.created` — emitted on POST create. `metadata.priority`, `metadata.status`, `metadata.areaId`, `metadata.stage`, `metadata.taskId`, `metadata.evidenceIds`.
   - `snag.transitioned` — emitted on every successful transition. `metadata.from`, `metadata.to`, `metadata.priority`, optional `metadata.reason`.
2. **Legacy per-job log** (`api/_lib/job-audit.js`) — `jobs/<jobId>/audit.json`. Writes a `snag_v2_created` row on create and `snag_v2_<nextStatus>` on each transition. Kept best-effort behind a `.catch(() => {})`.

The admin snag drawer's **History** section calls `GET /api/audit-log?targetType=snag&targetId=<snagId>&jobId=<jobId>` and renders newest-first with action icons. Tradies see the same list (per-actor filter only applies to `targetType=evidence`).

---

## 6 · Permissions matrix (full loop)

| Caller | GET snags | POST create | POST transition | GET audit-log (snag) |
| --- | --- | --- | --- | --- |
| anonymous | 401 | 401 | 401 | 401 |
| client | 403 | 403 | 403 | 403 |
| tradie (assigned) | all on job | ✓ | claim/drop + (creator/assignee can resolve) | all on job |
| tradie (not assigned) | 403 | 403 | 403 | 403 |
| LH (assigned) | all on job | ✓ | claim/drop + (creator/assignee can resolve) | all on job |
| LH (not assigned) | 403 | 403 | 403 | 403 |
| admin | all | ✓ | all transitions in the machine | all |

---

## 7 · Phil UX

Worker journey from `/phil/jobs/<jobId>`:

1. **See it.** A "Snags" card sits below "Today's captures." Empty state: "No open snags on this job." A small "N done" pill counter on the card header counts verified + closed snags (out of the worker's path; the loop is over for those).
2. **Report it.** Large yellow "Report snag" button opens a full-screen sheet:
   - Title input (large; counter; required)
   - Notes textarea (optional)
   - 4-button priority grid (Low / Normal / High / Urgent)
   - Area picker (defaults to the area the worker already selected)
   - Linked-evidence multi-select (up to `SNAG_EVIDENCE_LINK_MAX` = 10 of the worker's most recent captures; once at cap the un-linked items disable)
3. **See status.** Each visible snag renders as a row with status pill, priority pill, title + description, area name. **Rejected snags surface their reason inline with rose styling and an "alert" role** so the worker actually sees the admin's pushback — the operational loop only closes when the worker sees status _and_ reason.
4. **Act on it.**
   - Any field worker can "I'll fix it" an `open` snag (`open → in_progress`).
   - The creator / assignee can "Mark resolved" an `in_progress` snag (`in_progress → resolved`).
   - The creator / assignee can "Re-open" a `resolved` snag (`resolved → in_progress`).

Phil never sees verify / close / reject buttons — that's admin work. But Phil **does** see the result of a reject (with reason) so the worker can re-raise or accept.

**Visibility rule:** Phil's panel renders snags where `needsWorkerAttention(status)` is true — open, in_progress, resolved, **and rejected**. Verified + closed fall into the done-count pill. This is the filter from `src/domains/snags/format.ts#needsWorkerAttention`.

**Tap targets:** all transition buttons on the panel are `size="lg"` (48 × ≥48 px) per doc 27 §4. The sheet's close button is 44 × 44 px (Apple HIG). The priority radios are square 48+ px tiles.

---

## 8 · Admin UX

Admin journey from `/v2/jobs/<jobId>/snags`:

1. **Triage queue.** Default filter shows **Active** (open / in_progress / resolved). Each row has the status + priority pill, snag title, target, raised-by, time-since, and the primary next-step button.
   - `open → in_progress` button is "Mark in progress."
   - `in_progress → resolved` button is "Mark resolved."
   - `resolved → verified` button is "Verify."
   - `verified → closed` button is "Close."
   - Reject button is offered on `open` / `in_progress` / `resolved` rows.
2. **Drill in.** Click a row → right-slide drawer.
   - Body: description, target, raised-by, linked evidence IDs.
   - History: every audit-log entry for the snag, newest-first.
   - Footer: every available transition button per the state machine + role.
3. **Reject with reason.** Modal forces a non-empty reason ≤500 chars; the reason becomes the row's `rejectionReason` and goes into the audit summary.

LH gets the same drawer but the footer collapses to "Read-only — leading hand."

---

## 9 · Known limitations (post-D.5)

| ID | Limitation |
| --- | --- |
| D55-L1 | No bulk transition (no "verify 3 selected"). Each row is its own action. Add when a real admin asks. |
| D55-L2 | No assignment UI yet — `assignedToId` is set by the first claimant. Admin can't pre-assign from the queue. |
| D55-L3 | No re-assign / re-open from closed UI on Phil. Admin can re-open from the drawer. |
| D55-L4 | No notifications / push. Admin only sees snags by visiting the queue. |
| D55-L5 | No archive / hard-delete. `closed` rows stay in `snagsV2[]` indefinitely; trim policy a later phase. |
| D55-L6 | Read-after-write lag possible if a transition immediately follows a separate write on a cold Vercel instance (carried from D5-L1). The API returns the canonical row directly so the UI doesn't have to round-trip. |
| D55-L7 | Audit-log endpoint scans the last 2 months by default; older snag history needs `&months=N` (carried from D5-L1). |
| D55-L8 | Legacy `snags[]` and new `snagsV2[]` are not unified. Existing legacy snag tools (snag-quick-raise, snags-mine, snag-stats, etc.) ignore `snagsV2[]`. Migration is a Phase F+ decision. |
| D55-L9 | `api/_lib/auth.js#canWrite` only recognizes `admin/tradie/leadingHand` role strings. Users with `boss/owner/manager/office/pm/estimator/apprentice/labourer/electrician` roles (per `src/lib/auth/roles.ts`) fail the gate before snags' role-machine evaluates them, returning 403 on POST. Pre-existing system bug (affects evidence + snags equally). Out of D.5 hardening scope; fix in a dedicated auth-helper pass. Workaround: use a user with role exactly `admin` or `tradie`. |

---

## 10 · Field test script (manual, with credentials)

Run on the preview before promoting. ~10 minutes.

**Tradie:**
1. Log in as a tradie assigned to `birdwood-iv3232`.
2. Open `/phil/jobs/birdwood-iv3232`. Confirm the new "Snags" card renders below "Today's captures."
3. Tap **Report snag** → sheet opens full-screen.
4. Title: `TEST D55 SNAG <ISO timestamp>`. Notes: a short sentence. Priority: High. Pick an area. Submit.
5. Confirm "Snag reported." banner appears and the new row shows with Open + High pills.
6. Refresh the page → the snag persists.
7. Tap **I'll fix it** → row flips to In progress.
8. Tap **Mark resolved** → row flips to Resolved.

**Admin:**
9. Log in as admin.
10. Open `/v2/jobs/birdwood-iv3232/snags`. Confirm the TEST row is visible.
11. Click the row → drawer opens; History shows `snag.created` and the two `snag.transitioned` entries.
12. In the drawer footer, tap **Verify** → row flips to Verified.
13. Tap **Close** → row flips to Closed and the filter switches: it now hides from "Active" but appears under "Done."
14. Create a second TEST snag from Phil. As admin, click **Reject** on the queue row → modal forces a reason. Submit with `TEST D55 reject`.
15. Confirm the queue row flips to Rejected with the reason inline; History shows `snag.transitioned` with `from=open, to=rejected`.

**LH:**
16. Log in as a LH assigned to the job.
17. Open `/v2/jobs/birdwood-iv3232/snags`. Confirm the "Read-only — leading hand" pill in the header card.
18. Confirm rows have NO action buttons; drawer footer collapses to the read-only note.

**Regression — evidence loop still works:**
19. Tradie: open `/phil/jobs/birdwood-iv3232`, capture a small note evidence (`TEST D55 EVIDENCE LINK <ISO>`).
20. Admin: open `/v2/jobs/birdwood-iv3232/evidence`, confirm the row + history still work as documented in `phase-d5-runbook.md` §7.

**Cleanup:**
- Snag rows persist; they're labelled `TEST D55 SNAG <ISO>`.
- Audit rows persist in `audit/<yyyy-mm>.json` (append-only).
- No automated cleanup endpoint (D55-L5). Manual cleanup via the Vercel Blob dashboard if needed.

---

## 11 · Production smoke

### Unauthenticated (24 checks, fast)

```
npm run smoke:evidence-routes                 # buhlos.com
npm run smoke:evidence-routes -- <preview>    # any vercel preview
```

Covers both the D2–D5 evidence routes AND the new D.5 snag routes / API. Exit 0 if all pass, 1 if any fail. **Run this after every D.5 merge** as part of the production smoke ritual.

If a check fails:
- `404 text/html` on `/api/snags` → the function isn't deployed yet (CDN miss or deploy didn't include it). Wait ~60s and retry.
- `200 text/html` on `/v2/jobs/birdwood-iv3232/snags` unauth → middleware regression; stop the rollout.
- `401 application/json` on `/api/snags` unauth → expected and correct.

### Authenticated end-to-end (full lifecycle)

```
TRADIE_USER=oskar TRADIE_PASS=… \
ADMIN_USER=tom    ADMIN_PASS=… \
npm run smoke:auth-d55-snags
```

Drives the full lifecycle:
- Tradie login → create TEST D55 SNAG → claim → mark resolved
- Tradie verify attempt → 403 (admin-only)
- Admin login → see both snags → verify → close
- Admin reject branch with reason
- Audit-log shows ≥4 entries (1 created + 3 transitions)
- Evidence regression (tradie creates a note evidence on the same job)
- Both sessions logged out

The script:
- Uses temp cookie jars in `$TMPDIR`, scrubs them on exit.
- Never prints credentials.
- Tags everything `TEST D55 …` for trivial blob-dashboard cleanup.
- Leaves the happy-path snag in `closed` state and the reject-branch snag in `rejected` state.
- Exit code 0 on full pass, 1 on any failure (with a list of failed checks).

`BASE=https://<preview>.vercel.app` switches targets. `JOB=<jobId>` overrides the default `birdwood-iv3232`.

---

## 12 · Cross-references

- [phase-d5-runbook.md](phase-d5-runbook.md) — evidence loop runbook, audit-log read endpoint precedent.
- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — Phase D scope; snags lifted to D.5 in commit `ef7d3a7`.
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + marker dictionary.
- `api/snags.js` — endpoint.
- `src/domains/snags/` — typed domain.
- `src/app/v2/jobs/[jobId]/snags/page.tsx` — admin route.
- `src/components/admin/SnagsQueue.tsx` + `SnagDrawer.tsx` + `SnagRejectModal.tsx` — admin UI.
- `src/components/phil/JobSnagsPanel.tsx` + `ReportSnagSheet.tsx` — Phil UI.
- `scripts/smoke-evidence-routes.js` — production smoke (now covers snags too).
