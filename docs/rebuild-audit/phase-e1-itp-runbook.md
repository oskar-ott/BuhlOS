# Phase E1 · ITP loop runbook

> **Status:** built. End-to-end operational loop is: admin attaches ITP →
> field records points → admin signs off (with independence + override rule).
> **Read alongside:** [32-phase-e-plan.md](32-phase-e-plan.md), [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md), [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md), [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md), [27-interface-usability-pass.md](27-interface-usability-pass.md).
>
> Non-numeric filename intentional — sibling of `phase-d2-runbook.md`, `phase-d5-runbook.md`, `phase-d55-snags-runbook.md`, `phase-d6-admin-jobs-index-runbook.md`.

---

## 1 · What E1 ships

E1 is the first complete operational loop for **Inspection / Test Plans
(ITPs)** — quality records the field captures and the office signs off
on. Pattern mirrors the existing Phase B (hours), Phase C (gear), D2–D5
(evidence) and D.5 (snags) loops.

Slices and merge commits:

| Slice | Scope | PR | Merge commit |
| --- | --- | --- | --- |
| **E1a** | ITP domain (`src/domains/itp/*`), V2 audit-log verbs + `itp_instance` targetType, `api/job-itps.js` V2 audit dual-write + PR #26 stale-read pattern + independence rule + role-tier alignment, `api/jobs.js` `statsItpsActive` enrichment | [#34](https://github.com/oskar-ott/BuhlOS/pull/34) | `996d848` |
| **E1b** | Phil per-instance recording UI (`/phil/jobs/[jobId]/itps/[instanceId]`), `JobItpPanel` on the job detail screen, `ITPRecording` orchestrator + `ITPPointCard` per-point input | [#38](https://github.com/oskar-ott/BuhlOS/pull/38) | `f3146e2` |
| **E1c** | Admin queue + drawer + sign-off modal (`/v2/jobs/[jobId]/itps`), reopen + archive transitions, jobs-index ITP chip, drawer history panel reading `targetType=itp_instance` audit rows | [#39](https://github.com/oskar-ott/BuhlOS/pull/39) | `7629661` |

**No vercel.json change.** No legacy routes touched. No new public/*.html.
Legacy `/admin/itp.html` SPA (powered by the unchanged `api/job-itps.js`
+ `api/itp-templates.js`) keeps serving its existing audience.

---

## 2 · Architecture overview

```
                        ┌──────────────────────────────────────┐
                        │ src/domains/itp/                     │
                        │   schema.ts   Zod wire shapes        │
                        │   types.ts    inferred TS types      │
                        │   service.ts  state machine + roles  │
                        │   format.ts   labels + tones         │
                        │   client.ts   typed fetch client     │
                        │   itp.test.ts  ~70 tests             │
                        └──────────────┬───────────────────────┘
                                       │
                                       │ shared client + types
                                       │
   ┌────────────────────────┐          │          ┌──────────────────────────────┐
   │ Phil (field user)      │          │          │ Admin (office user)          │
   │ /phil/jobs/[jobId]     │          │          │ /v2/jobs/[jobId]/itps        │
   │   ↓ JobItpPanel        │          │          │   ↓ ITPsQueue                │
   │ /phil/jobs/[jobId]/    │          │          │ ITPDrawer · ITPSignOffModal  │
   │   itps/[instanceId]    │          │          │                              │
   │   ↓ ITPRecording       │          │          │ /command-centre              │
   │   ITPPointCard ×N      │          │          │   ↓ ITP queue card (new)     │
   └─────────────┬──────────┘          │          └────────────┬─────────────────┘
                 │                     │                       │
                 │  HTTPS              │  HTTPS                │  HTTPS
                 ▼                     ▼                       ▼
              ┌────────────────────────────────────────────────────┐
              │  api/job-itps.js                                  │
              │    GET  ?jobId=X                                  │
              │    POST ?jobId=X&action=attach   (admin/LH)       │
              │    POST ?jobId=X&action=record   (any writer)     │
              │    POST ?jobId=X&action=signoff  (admin only)     │
              │    POST ?jobId=X&action=reopen   (admin + LH)     │
              │    DELETE ?jobId=X&id=Y          (admin/LH)       │
              │                                                    │
              │  Reads: jobs/<jobId>/itps.json + itp-templates.json│
              │  Writes (dual): jobs/<jobId>/itps.json             │
              │                 audit/<yyyy-mm>.json (V2 cross-loop)│
              │                 jobs/<jobId>/audit.json (legacy)   │
              └────────────────────────────────────────────────────┘
                                       │
                                       │ jobs.json stats enrichment
                                       ▼
                            ┌──────────────────────────────┐
                            │ api/jobs.js?withStats=1      │
                            │   adds statsItpsActive        │
                            └──────────────────────────────┘
```

Key architecture rules (per [doc 14](14-technical-architecture-deep-dive.md) +
[doc 20](20-agent-rules.md) + [doc 24](24-phase-d-jobs-evidence-plan.md) D-26):

- **Server-rendered pages** under `src/app/**/page.tsx` fetch initial
  data via `next/headers` + cookie forwarding. They are NOT marked
  `"use client"`. They delegate UI / mutation logic to client
  components under `src/components/{phil,admin}/`.
- **The domain layer is the contract.** The legacy `api/job-itps.js`
  on-disk shape is wrapped with Zod schemas in `schema.ts`. All
  client + server consumers import from `src/domains/itp/types.ts`,
  never the schemas.
- **No new parallel writer.** E1 reuses the legacy `api/job-itps.js`
  function rather than adding a `/api/itps-v2.js`. The endpoint is
  modified in place to dual-write the V2 audit log + apply the
  independence rule + read-after-write retry pattern from PR #26.

---

## 3 · Storage shape

Per-job blob `jobs/<jobId>/itps.json` (unchanged from legacy):

```jsonc
{
  "instances": [
    {
      "id": "itp_<nanoid>",
      "templateId": "tpl_msb_energise",
      "templateSnapshot": {
        "name": "MSB energisation",
        "category": "Compliance",
        "points": [
          {
            "id": "ip_photo_door",
            "label": "Photo of MSB door label",
            "type": "photo",
            "required": true
          },
          { "id": "ip_ir_lp", "type": "value", "unit": "MΩ", "min": 1, "max": 1000, "required": true },
          { "id": "ip_signoff", "type": "signoff", "witnessRole": "admin", "required": true }
        ]
      },
      "scope": "switchboard",
      "scopeId": "sb_msb_1",
      "status": "in-progress",
      "results": {
        "ip_photo_door": {
          "value": null,
          "note": "Door label visible.",
          "photoUrl": "https://...",
          "byUserId": "user-tradie-1",
          "byUsername": "sam",
          "at": "2026-05-26T09:00:00.000Z"
        }
      },
      "signedOffBy": "anna",
      "signedOffAt": "2026-05-26T11:00:00.000Z",
      "archived": false,
      "createdAt": "...",
      "createdBy": "anna",
      "updatedAt": "..."
    }
  ]
}
```

`.passthrough()` everywhere — legacy fields (`archivedBy`, `archivedAt`
etc.) flow through; future field additions don't break parsing.

Template catalogue lives at `itp-templates.json` (root) — unchanged.

Snapshot rule: when an admin attaches a template the per-instance
`templateSnapshot` field captures `name`, `category`, and `points[]`
verbatim with `archived` points dropped. Editing the global template
later does not rewrite history on already-attached jobs.

---

## 4 · State machine

```
                ┌──────────── (signed-off → witnessed, admin only) ────────────┐
                │                                                              │
                ▼                                                              │
   null ──► pending ──► in-progress ──► witnessed ──► signed-off ─────────────┘
              ▲           ▲                ▲             │
              │           │                │             │
              │           │   (auto: first │   (auto:    │
              │           │    record)     │    all required │
              │           │                │    points have  │
              │           │                │    results)     │
              │           │                │                 │
              └──── attach (admin/LH) ─────┘                 │
                                                              │
   archive: a sibling soft-delete boolean, can apply at any non-signed-off
   state (or signed-off, but that's a separate verb). Archive does NOT
   appear in this status machine.
```

- `pending → in-progress` and `in-progress → witnessed` are **server
  auto-advances** triggered by `action=record` — there is no explicit
  verb for them. `canTransition` still lists them so the helper is
  the single source of truth for "is this status flip legal?".
- **Direct skip to `signed-off` is blocked.** Status must reach
  `witnessed` (i.e. every required, non-archived point has a result
  with an `at` timestamp) before sign-off is offered. See
  `autoAdvanceStatus` in `api/job-itps.js`.
- **Reverse paths** are only `signed-off → witnessed` (reopen). All
  other reverse flips (e.g. witnessed → pending) are intentionally
  blocked — recording a point cannot undo an auto-advance.

### Role gates (`canRoleTransition`)

| Transition | admin (boss/owner/manager/office/pm/estimator) | LH | tradie / apprentice / labourer / electrician | client |
| --- | --- | --- | --- | --- |
| `null → pending` (attach) | ✓ | ✓ | ✗ | ✗ |
| `pending → in-progress` (auto via record) | ✓ | ✓ | ✓ | ✗ |
| `in-progress → witnessed` (auto via record) | ✓ | ✓ | ✓ | ✗ |
| `witnessed → signed-off` | ✓ + independence rule | ✗ | ✗ | ✗ |
| `signed-off → witnessed` (reopen) | ✓ | ✓ (assigned jobs) | ✗ | ✗ |
| archive | ✓ | ✓ (assigned jobs) | ✗ | ✗ |

`canTransition()` in `src/domains/itp/service.ts` and `ALLOWED_TRANSITIONS`
in `api/job-itps.js` are kept in sync; the test in
`src/domains/itp/itp.test.ts` asserts the documented set.

### Independence rule (sign-off only)

The user signing off must not have recorded **more than half** of the
recorded points unless they supply a non-empty `overrideJustification`.

- Threshold: `ITP_SIGNOFF_INDEPENDENCE_THRESHOLD = 0.5` — strict majority
  trips the rule. Exactly 50% still passes (matches the documented
  threshold and the field user's "I just helped sign-off the last point"
  scenario).
- Ratio counts every non-archived point with a result + `at` timestamp.
  Optional points count toward the denominator because the rule is
  about who physically captured the data, not which points were
  required.
- Cap: `ITP_OVERRIDE_JUSTIFICATION_MAX = 500` chars (mirrors the snag
  rejection-reason cap from PR #26).
- Server emits a `409` with `{ error, ratio }` when the rule trips
  without justification; the client modal switches to a textarea variant
  that is required-non-empty.

`canSignOff()` in `src/domains/itp/service.ts` and the mirrored block
in `api/job-itps.js#signoff` are kept in sync.

---

## 5 · API contract

### `GET /api/job-itps?jobId=<id>`

| Status | When |
| --- | --- |
| 200 | `{ jobId, instances: ITPInstance[] }` |
| 400 | `jobId` missing |
| 401 | unauthenticated |
| 403 | not admin AND not assigned to job (and not the job's client) |
| 404 | job not found |

Field users (tradie / LH) on assigned jobs see every instance on the
job, even ones they haven't recorded into. Admin sees every job.

### `POST /api/job-itps?jobId=<id>&action=attach` (admin / LH)

```json
{ "templateId": "tpl_msb_energise", "scope": "switchboard", "scopeId": "sb_msb_1" }
```

| Status | When |
| --- | --- |
| 201 | `{ instance }` — canonical row (with snapshot, empty results, status=`pending`) |
| 400 | missing `templateId`, unknown `scope` |
| 401 / 403 | unauthenticated / not admin or LH on this job |
| 404 | template not found |
| 502 | write failed |

### `POST /api/job-itps?jobId=<id>&action=record` (any writer)

```json
{ "instanceId": "itp_abc", "pointId": "ip_photo_door", "value": null, "note": "...", "photoUrl": "https://..." }
```

| Status | When |
| --- | --- |
| 200 | `{ instance }` — canonical updated row (status may have auto-advanced) |
| 400 | missing `instanceId` / `pointId`, body not an object |
| 401 / 403 | unauthenticated / no write access to job |
| 404 | instance or point not found |
| 409 | instance archived OR signed-off |
| 502 | write failed |

Server applies the PR #26 stale-read retry: if the instance lookup
suggests the request would 409, the writer waits 750ms and reads past
the cache once before surfacing the conflict.

### `POST /api/job-itps?jobId=<id>&action=signoff` (admin only)

```json
{ "instanceId": "itp_abc", "overrideJustification": "Anna double-checked all values" }
```

| Status | When |
| --- | --- |
| 200 | `{ instance }` — status=`signed-off`, `signedOffBy/At` stamped |
| 400 | missing `instanceId`, `overrideJustification` over 500 chars |
| 401 / 403 | unauthenticated / not admin |
| 404 | instance not found |
| 409 | status not `witnessed`, OR independence rule trips and `overrideJustification` empty (`{ error, ratio }`) |
| 502 | write failed |

### `POST /api/job-itps?jobId=<id>&action=reopen` (admin + LH on assigned jobs)

```json
{ "instanceId": "itp_abc" }
```

| Status | When |
| --- | --- |
| 200 | `{ instance }` — status=`witnessed`, `signedOffBy/At` cleared |
| 400 | missing `instanceId` |
| 401 / 403 | unauthenticated / not admin or LH on this job |
| 404 | instance not found |
| 409 | status not `signed-off` |
| 502 | write failed |

### `DELETE /api/job-itps?jobId=<id>&id=<instanceId>` (admin + LH on assigned jobs)

Soft-archive (sets `archived: true`, preserves `status`).

| Status | When |
| --- | --- |
| 200 | `{ ok: true }` |
| 400 | missing `id` |
| 401 / 403 | unauthenticated / not admin or LH on this job |
| 404 | instance not found |
| 502 | write failed |

---

## 6 · Audit

Dual-write per evidence + snag precedent:

1. **New cross-surface journal** (`api/_lib/audit-log.js`) — monthly
   `audit/<yyyy-mm>.json` blobs. E1a adds four verbs and the
   `itp_instance` targetType to the closed-set validator:
   - `itp.attached` — `metadata.templateId`, `templateName`, `scope`, `scopeId`, `pointCount`.
   - `itp.point.recorded` — `metadata.pointId`, `pointLabel`, `pointType`, `valueProvided`, `photoProvided`, `noteProvided`, `statusBefore`, `statusAfter`.
   - `itp.signed_off` — `metadata.signedOffByName`, optional `overrideJustification`.
   - `itp.reopened` — `metadata.previousStatus`.
   - `itp.archived` — `metadata.statusAtArchive`.
2. **Legacy per-job log** (`api/_lib/job-audit.js`) — `jobs/<jobId>/audit.json`.
   Writes a structural row on attach / signoff / reopen / archive.
   Kept best-effort behind a `.catch(() => {})`. Recording does NOT
   write the legacy log (would flood it).

The admin ITP drawer's **History** section calls
`GET /api/audit-log?targetType=itp_instance&targetId=<instanceId>&jobId=<jobId>`
and renders newest-first with action icons.

`targetType=itp_instance` (not `itp`) — chosen so cross-domain readers
can disambiguate an instance row from a template row if templates later
get their own audit verbs.

---

## 7 · Permissions matrix (full loop)

| Caller | GET itps | attach | record | signoff | reopen | archive | GET audit-log (itp_instance) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anonymous | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| client | own jobs only | 403 | 403 | 403 | 403 | 403 | own jobs only |
| tradie (assigned) | ✓ | 403 | ✓ | 403 | 403 | 403 | ✓ |
| tradie (not assigned) | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| LH (assigned) | ✓ | ✓ | ✓ | 403 | ✓ | ✓ | ✓ |
| LH (not assigned) | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| admin / boss / owner / manager / office / pm / estimator | ✓ | ✓ | ✓ | ✓ (+ independence) | ✓ | ✓ | ✓ |

---

## 8 · Phil UX

Worker journey:

- **Job detail (`/phil/jobs/[jobId]`).** A **JobItpPanel** sits below
  the snags panel. Shows active ITPs (`pending` / `in-progress` /
  `witnessed`) sorted by `compareForQueue`. Each row links to the
  per-instance recording page. Witnessed rows still show the same
  link so the worker can review the finished record before sign-off.
- **Per-instance recording (`/phil/jobs/[jobId]/itps/[instanceId]`).**
  The full page is a stacked list of `ITPPointCard` instances driven
  by `ITPRecording`. Each card variant matches the point's type:
  - `photo` → photo picker + optional note + photo thumbnail preview.
  - `value` → numeric input + unit label + min/max criterion +
    pass/fail derivation (`valuePassFail`).
  - `signoff` → witness-role aware "Mark complete" checkbox.
  - `note` → notes textarea only.
- **Auto-advance is visible.** When a record drives `pending → in-progress`
  or `in-progress → witnessed`, the status pill at the top of the page
  re-renders from the response without a refresh.
- **Signed-off rows are read-only.** Inputs disappear; the page shows
  who signed off and when.

Tap targets are `≥48 × 48 px` per [doc 27](27-interface-usability-pass.md)
§4. Status pill tones map to the 5-tone palette (§6.2):

| Status | Tone |
| --- | --- |
| pending | warning |
| in-progress | info |
| witnessed | info |
| signed-off | success |

---

## 9 · Admin UX

Admin journey from `/v2/jobs/[jobId]/itps`:

1. **Triage queue.** Default filter shows **Active**
   (`pending` / `in-progress` / `witnessed`). Each row has status +
   scope pills, template name, scope context line
   (e.g. "Switchboard: MSB-1"), progress (e.g. "3/5 points"), and the
   primary next-step button.
   - `pending` / `in-progress` rows → "No actions yet"
     (worker is still recording).
   - `witnessed` rows → **Sign off** opens `ITPSignOffModal`.
   - `signed-off` rows → **Reopen** posts directly (no modal).
2. **Drill in.** Click a row → right-slide `ITPDrawer`.
   - Body: every point with the recorded result inline.
   - History: every `itp_instance` audit-log entry, newest-first.
   - Footer: sign off / reopen / archive depending on status.
3. **Sign-off modal.** When `canSignOff` returns `needs-justification`,
   the modal switches from "Confirm sign off" to a required textarea
   with the recorded ratio surfaced in the help text.

LH gets the same drawer but the footer collapses to read-only
("Read-only — leading hand"). Archive and reopen are LH-allowed at
the API level but the queue UI surfaces them only to admin to keep
the LH copy honest with the snag pattern.

**Jobs index chip.** The "ITP / QA · N" pill on `/v2/jobs` and the
per-job section nav at `/v2/jobs/[jobId]` use `statsItpsActive` from
the `?withStats=1` enrichment (counts non-archived
`pending|in-progress|witnessed`).

---

## 10 · Known limitations (post-E1)

| ID | Limitation |
| --- | --- |
| E1-L1 | No bulk sign-off. Each row is signed off individually. Add when a real admin asks for it (mirrors D55-L1). |
| E1-L2 | No notifications / push. Admin only learns about a witnessed ITP by visiting the queue or seeing the chip on `/v2/jobs`. |
| E1-L3 | No archive UX on Phil. Workers can only request archive via admin; the API allows LH archive on assigned jobs but the Phil panel does not surface the verb. |
| E1-L4 | No template editor in the rebuild. Templates are still managed on the legacy `/admin/itp.html` SPA; rebuild only attaches existing templates. |
| E1-L5 | Audit-log endpoint scans the last 2 months by default; older ITP history needs `&months=N` (carried from D5-L1). |
| E1-L6 | No "needs sign-off" stats field on `api/jobs.js` — `statsItpsActive` lumps pending + in-progress + witnessed together. Command Centre card surfaces the union, not the witnessed subset. Separate field is a follow-up PR if the admin signal turns out to need precision. |
| E1-L7 | No cross-job ITP triage queue (analogous to the missing cross-job snag queue from D.5). A future Command Centre revamp could roll both up. |
| E1-L8 | The independence rule treats any admin role as the same actor for ratio purposes — i.e. an admin signing off another admin's recording is independent. The rule is about "the signing user", not "anyone in the admin tier". This is the intended behaviour but worth flagging. |

---

## 11 · Field test script (manual, with credentials)

Run on the preview before promoting. ~12 minutes.

**Pre-req:** at least one ITP template exists in `itp-templates.json`
with at least one required `photo` point and one required `value`
point.

**Admin (attach):**
1. Log in as admin.
2. Open `/v2/jobs/birdwood-iv3232/itps`. Confirm the queue renders
   (empty state OK).
3. Go to legacy `/admin/itp.html`, attach a TEST E1 template to
   `birdwood-iv3232` with `scope=switchboard`, `scopeId=<any switchboard id>`.
4. Return to `/v2/jobs/birdwood-iv3232/itps`. Confirm the new
   `pending` row appears.

**Tradie (record):**
5. Log in as a tradie assigned to `birdwood-iv3232`.
6. Open `/phil/jobs/birdwood-iv3232`. Confirm the **JobItpPanel** shows
   the TEST E1 row under "Open ITPs".
7. Tap the row → land on `/phil/jobs/birdwood-iv3232/itps/<instanceId>`.
8. Record the photo point (any image). Confirm the row remains visible
   and the status pill flips `pending → in-progress`.
9. Record the value point with a number outside the min/max range.
   Confirm the pass/fail pill renders "Fail".
10. Record the value again with an in-range number. Confirm pill
    flips to "Pass".
11. Complete every other required point. Confirm the status pill flips
    to `witnessed` and a banner says "All required points recorded —
    awaiting sign-off."

**Admin (sign off):**
12. Switch to admin browser. Open `/v2/jobs/birdwood-iv3232/itps`.
    Confirm the TEST E1 row now shows `witnessed`.
13. Click **Sign off** → confirm modal. Since the admin recorded 0%,
    the modal shows "Confirm sign off" (no override required).
14. Submit. Confirm the row flips to `signed-off`, the queue switches
    filter to "All" or "Signed off" still shows it, and the drawer
    history shows the new `itp.signed_off` row.

**Independence rule:**
15. Have admin attach a second TEST E1 instance.
16. Admin records every point themselves (mock photo + values).
17. Admin tries to sign off. Confirm the modal flips to the
    "override justification" variant with the ratio surfaced
    (1.0 = 100%).
18. Type a justification under 500 chars. Submit. Confirm sign-off
    succeeds and the audit-log row carries
    `metadata.overrideJustification`.

**Reopen + archive:**
19. From the queue, **Reopen** the first TEST E1 instance.
    Confirm status flips back to `witnessed`, stamps cleared.
20. From the drawer footer, archive it. Confirm it disappears from
    "Active" filter and the chip on `/v2/jobs` drops by one.

**LH read-only:**
21. Log in as a LH assigned to the job.
22. Open the same queue. Confirm Sign off button is hidden / disabled.
23. Confirm the drawer history still renders.

**Regression — snag / evidence loops still work:**
24. Tradie raises a TEST E1 snag on the same job.
25. Tradie captures a TEST E1 note evidence.
26. Admin verifies both still appear in their respective queues.

**Cleanup:**
- TEST E1 instances persist; soft-delete via the drawer archive button.
- Audit rows persist in `audit/<yyyy-mm>.json` (append-only).
- No automated cleanup endpoint. Manual cleanup via the Vercel Blob
  dashboard if needed.

---

## 12 · Production smoke

### Unauthenticated route + API gate (extended)

```
npm run smoke:evidence-routes                 # buhlos.com (default)
npm run smoke:evidence-routes -- <preview>    # any vercel preview
```

Covers `/v2/jobs/birdwood-iv3232/itps`, `/phil/jobs/birdwood-iv3232/itps/<id>`
gating, and the `/api/job-itps` 401-JSON gate. Run after every E1 merge.

If a check fails:
- `404 text/html` on `/api/job-itps` → function not deployed yet
  (CDN miss). Wait ~60s and retry.
- `200 text/html` on `/v2/jobs/.../itps` unauth → middleware regression;
  stop the rollout.
- `401 application/json` on `/api/job-itps` → expected and correct.

### Authenticated end-to-end (full lifecycle)

```
TRADIE_USER=oskar TRADIE_PASS=… \
ADMIN_USER=tom    ADMIN_PASS=… \
ITP_TEMPLATE_ID=tpl_… \
npm run smoke:auth-e1-itp
```

Defaults to **dry-run / read-only** (the script lists the job's existing
ITP instances and confirms 200 + audit-log read shapes). Pass
`WRITE=1` to enable the write path (attach → record → witness →
sign off → reopen → archive → audit). See §13 below for details and
required env vars.

### Production health post-deploy (manual)

After `git push origin main` and the auto-deploy completes:

```
curl -I https://buhlos.com/v2/jobs                  # → 307 to /v2/login
curl -I https://buhlos.com/v2/jobs/birdwood-iv3232/itps  # → 307
curl -I https://buhlos.com/api/job-itps?jobId=birdwood-iv3232  # → 401 JSON
```

Plus the standard `npm run check:admin-shell`,
`npm run check:production-shell`, `npm run smoke:admin-routes`
predeploy checks.

---

## 13 · `auth-smoke-e1-itp.sh` — usage notes

Lives at `scripts/auth-smoke-e1-itp.sh`. Two modes:

**Dry-run (default — safe to run repeatedly on production):**
- Logs in as `TRADIE_USER` and `ADMIN_USER`.
- `GET /api/job-itps?jobId=$JOB` — confirms 200 + parses the response.
- `GET /api/audit-log?targetType=itp_instance&jobId=$JOB&targetId=...`
  for any pre-existing instance — confirms 200.
- Negative checks: unauth → 401, tradie cannot sign off → 403.
- Exits 0 if all reads succeed; **no writes**.

**Write mode (`WRITE=1`, requires `ITP_TEMPLATE_ID`):**
- Admin attaches a TEST E1 instance using `$ITP_TEMPLATE_ID` and
  `scope=job` (the simplest scope — no scopeId resolution required).
- Tradie records every required point with a TEST E1 marker note.
- Tradie attempts to sign off → must 403.
- Admin signs off (independence rule: admin recorded 0 of the points,
  so the override branch is not triggered).
- Admin reopens, archives (drawer footer), then re-confirms list.
- Audit-log read on the new instance must show
  ≥ `itp.attached + N × itp.point.recorded + itp.signed_off + itp.reopened + itp.archived`.

Script behaviour:
- Uses temp cookie jars in `$TMPDIR`, scrubs them on exit.
- Never prints credentials.
- Tags every test record with `TEST E1 ITP <ISO>` for trivial blob-
  dashboard cleanup.
- Leaves the TEST E1 instance in archived state (write mode).
- Exit code 0 on full pass, 1 on any failure (with a list of failed
  checks), 2 on prerequisite missing (jq, env vars).

Required env vars:

| Var | When | Notes |
| --- | --- | --- |
| `TRADIE_USER`, `TRADIE_PASS` | always | tradie or apprentice/labourer assigned to `$JOB`. |
| `ADMIN_USER`, `ADMIN_PASS` | always | admin / boss / owner / manager / office / pm / estimator. |
| `ITP_TEMPLATE_ID` | `WRITE=1` only | id of an existing template in `itp-templates.json`. |
| `BASE` | optional | override target. Default `https://buhlos.com`. |
| `JOB` | optional | override jobId. Default `birdwood-iv3232`. |
| `WRITE` | optional | `1` to enable the write path. Default unset (dry-run). |

---

## 14 · Rollback considerations

E1 was a **pure additive** ship — no legacy file was deleted, no
vercel.json route was changed, no rewrites moved. To roll back any
slice:

| Slice | Rollback |
| --- | --- |
| **E1c** (admin queue) | Revert PR #39. Phil panel still works; admin loses the new queue but legacy `/admin/itp.html` still serves. |
| **E1b** (Phil UI) | Revert PR #38. JobItpPanel disappears from Phil; admin queue still works against the existing instances. |
| **E1a** (domain + API hardening) | Revert PR #34. Loses V2 audit-log rows, stale-read retry, independence rule, role-tier alignment, and `statsItpsActive`. The legacy `/admin/itp.html` SPA still works against the unmodified `api/job-itps.js` core. |

If a runtime regression hits production:
1. Check `npm run smoke:evidence-routes -- https://buhlos.com` first.
2. If smoke is healthy, the regression is auth- or data-shape-specific.
3. Take a Vercel deploy snapshot before reverting; the on-disk
   `jobs/<jobId>/itps.json` writes are forward-compatible
   (`.passthrough()` schemas) so rolling back code does NOT require
   data fixup.

The dual-write to `audit/<yyyy-mm>.json` is best-effort
(`.catch(() => {})`) — if the audit blob ever goes corrupt, the
record / signoff / reopen / archive writes still succeed and the
drawer history degrades gracefully (empty list rendered).

---

## 15 · Next recommended PRs

Ordered by user-visible value-to-risk ratio (the same lens [doc 35](35-current-product-state-audit.md)
§9 uses):

1. **Documents / Specs read-only viewer** — pull `/api/plans` data
   onto a `/v2/jobs/[jobId]/documents` surface (admin) and a Phil
   tab. Mirror the D2 pattern: domain layer + thin admin queue +
   Phil panel. Pure read — no upload UI yet. Highest user value: PMs
   ask "do you have the plans?" 6× per week.
2. **Cross-job ITP queue on `/command-centre`** — extend the new
   card to surface witnessed instances across jobs (requires
   `statsItpsNeedsReview` on `api/jobs.js?withStats=1`, see E1-L6).
3. **ITP template editor in the rebuild** — replace the legacy
   `/admin/itp.html` template management with a rebuild surface,
   then deprecate the legacy SPA. Mid-risk because the data shape
   is shared.
4. **Notifications for witnessed ITPs** — email-only first, scoped to
   the assigned admin / PM (uses `me.role` filter on
   `jobs.assignedJobIds`).
5. **Bulk archive / cleanup helper** — admin-only DELETE-by-marker
   endpoint or Blob dashboard runbook for cleaning up TEST records.

---

## 16 · Cross-references

- [32-phase-e-plan.md](32-phase-e-plan.md) — Phase E scope + decisions.
- [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md) — E1a/E1b/E1c build prompts.
- [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) — per-slice QA gates.
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) — the loop pattern E1 mirrors.
- [phase-d5-runbook.md](phase-d5-runbook.md) — evidence loop precedent (audit-log read shape).
- `api/job-itps.js` — endpoint (legacy + V2 audit dual-write).
- `api/itp-templates.js` — template catalogue (unchanged).
- `api/jobs.js` — `statsItpsActive` enrichment.
- `src/domains/itp/` — typed domain.
- `src/app/v2/jobs/[jobId]/itps/page.tsx` — admin route.
- `src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx` — Phil route.
- `src/components/admin/ITPsQueue.tsx` + `ITPDrawer.tsx` + `ITPSignOffModal.tsx` — admin UI.
- `src/components/phil/JobItpPanel.tsx` + `ITPRecording.tsx` + `ITPPointCard.tsx` — Phil UI.
- `scripts/smoke-evidence-routes.js` — production smoke (now covers ITPs too).
- `scripts/auth-smoke-e1-itp.sh` — authenticated end-to-end.
