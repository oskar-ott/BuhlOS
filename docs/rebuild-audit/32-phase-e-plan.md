# 32 · Phase E — ITP / RFI / Materials plan

> **Status: Planning artefact (docs-only).** No Phase E code is in scope of the PR that introduces this doc. **Must be approved by Oskar before any Phase E build prompt is run.**
>
> Authored on `phase-e-plan` branch from `main` at `17f6da6` (post PR #26 — D.5 snags hardening). Phase D is shipped and verified on production; D.5 snag loop is live. This plan picks the next operational loop to add to the rebuild.
>
> **Read first:** [10-product-definition.md](10-product-definition.md), [11-operational-workflow-map.md](11-operational-workflow-map.md) §15 (ITP) / §16-#18 (Plans) / §13-#14 (Materials) / §21 (RFI), [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) §ITP / §RFI / §Materials, [13-ui-information-architecture.md](13-ui-information-architecture.md) §Phil / §Jobs, [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md), [20-agent-rules.md](20-agent-rules.md), [21-rebuild-decision-record.md](21-rebuild-decision-record.md), [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) (format precedent), [27-interface-usability-pass.md](27-interface-usability-pass.md) (cross-cutting UX rules — still binding), [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) (QA-checklist format precedent), [phase-d5-runbook.md](phase-d5-runbook.md), [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md), [phase-d6-admin-jobs-index-runbook.md](phase-d6-admin-jobs-index-runbook.md).

---

## 1 · Executive summary

Phase E ships the fourth, fifth, and (eventually) sixth closed operational loops in the rebuild on top of the Phase D jobs/evidence/snags foundation. The Phase E **umbrella** covers three legacy concerns currently named together in the rebuild roadmap:

- **ITP** — Inspection / test plans + checklists. Admin authors a reusable template; admin attaches the template to a job (scoped to the whole job, a level, an area, or a switchboard); a tradie/LH records each point's result (photo / value / signoff / note); admin signs off when every required point is recorded. **The closest mental model to a Phase D-style loop.**
- **RFI** — Request for information. Field user raises a question against a job → admin (or PM) responds → field user sees the answer. Effectively a thin sibling of the snag loop.
- **Materials** — Per-job materials list, takeoff legend, purchase orders, supplier invoices, field-capture invoice review. Already substantial in the legacy system (1,200+ line `api/materials-list.js`) and overlaps with AI takeoff + PO/invoice workflows that pre-date the rebuild.

This plan **decisively splits the three** into separate phases rather than bundling. Recommendation:

| Slice | Scope (one line) | Status in this plan |
| --- | --- | --- |
| **E1** | ITP field-record + admin sign-off loop (rebuild surface; reuse legacy API + extend with V2 audit-log writes) | Planned in this doc. |
| **E2** | ITP template editor in the rebuild + cross-job sign-off triage (replaces legacy `/admin/itp.html` template UI) | Deferred to a separate plan. |
| **E3** | RFI bootstrap — greenfield domain + Phil capture + admin response loop | Deferred to a separate plan. |
| **E4** | Materials rebuild (incremental; likely multiple sub-slices because of legacy size) | Deferred to a separate plan. Will need its own multi-doc planning pack. |

Operational rationale for the order: E1 ships fastest because the legacy ITP API at [api/job-itps.js](../../api/job-itps.js) + the photo path at [api/photos.js#L152](../../api/photos.js) are already well-shaped. E2 is the natural extension once E1 proves the surface. E3 is greenfield-small so it slots in after the ITP set settles. E4 is greenfield-large and must wait for its own scoping pass — bundling it here would balloon Phase E from ~5-8 build days to ~20+.

**Operational loop Phase E1 creates:**

```
Admin creates ITP template (legacy /admin/itp.html — unchanged)
  → Admin attaches template to a job (legacy attach UI OR a thin rebuild attach action)
    → ITP instance exists with templateSnapshot, status='pending'
      → Tradie / LH on Phil sees the attached ITP on the job
        → Tradie taps an ITP → works through points (photo / value / signoff / note)
          → Status auto-advances: pending → in-progress → witnessed
            → Admin reviews witnessed ITP in /v2/jobs/[jobId]/itps
              → Admin signs off → status='signed-off' (terminal)
                → Field data accumulates for handover-readiness reporting (Phase F+)
```

The loop is identical in shape to the D.5 snag loop (worker→admin→worker) — the rebuild's third use of the same pattern. By E1 ship the BuhlOS Command Centre + Phil shell will both surface evidence, snags, AND ITPs through one consistent interface idiom.

**Recommended E1 scope (concise):** New `src/domains/itp/` (Zod schema + client + service + tests) modelled on the existing legacy shape. Extend the legacy `api/job-itps.js` with V2 monthly audit-log writes (no parallel namespace — the legacy endpoint is already correct, just not yet wired to the new journal). Add a new admin queue at `/v2/jobs/[jobId]/itps` mirroring `/v2/jobs/[jobId]/snags`. Add Phil per-instance recording at `/phil/jobs/[jobId]/itps/[instanceId]`. Add a snag-style chip to `/v2/jobs`. **No template-editor rebuild, no cross-job triage, no RFI, no materials.**

---

## 2 · Scope

### 2.1 In scope (E1 ships these end-to-end)

**Phil (mobile):**

- An **ITP section** on the existing `/phil/jobs/[jobId]` page (sibling to the Snags section already there from D.5). Lists attached ITP instances grouped by status. Shows: title (template name + scope label), status pill, progress (e.g. `4 / 7 points`), tap to open.
- A new **per-instance recording surface** at `/phil/jobs/[jobId]/itps/[instanceId]`. Renders the snapshot's ordered points. For each point: photo-capture button (reuses `/api/photos?action=upload-itp-photo`, already shipped), value input with unit + pass-criterion hint, note textarea, sign-off toggle. Shows pass/fail/pending state per point. Submit-per-point (no all-or-nothing).
- An **inline error state** when the server returns 409 (e.g. ITP was archived between page load and submit) — friendly message + "reload" affordance.
- A **read-only view** for LH on jobs where they're assigned but the ITP requires a different witness role for sign-off. They see the points and can record results; they just can't sign off.

**Admin (desktop):**

- A new **per-job ITP queue** at `/v2/jobs/[jobId]/itps` — mirrors `/v2/jobs/[jobId]/snags` shape. Filter tabs `Active | Signed off | All` with counts. Table rows: status pill, template name, scope label (whole job / level / area / switchboard), progress, attached-by, attached-at, primary action (`Sign off` or `Reopen`).
- A **drawer** for a single instance: full point grid with results + a History panel that reads from `/api/audit-log?targetType=itp_instance&targetId=<id>`. Pattern is verbatim port of [SnagDrawer.tsx](../../src/components/admin/SnagDrawer.tsx).
- A new **Sign-off modal** that enforces the **independence rule** from [public/admin/itp.html](../../public/admin/itp.html) §sign-off (the user signing off cannot be the same user who recorded a majority of the points, unless explicitly overridden with a justification field). Modal: actor name confirmation + optional override justification.
- A **chip on the `/v2/jobs` cards**: `ITPs N` highlighted when there are active ITP instances on the job (parity with the existing Evidence + Snags chips). Counter = instances in `pending | in-progress | witnessed`.

**API + storage:**

- **Reuse `api/job-itps.js` as-is for the state machine** — it's already well-shaped (GET, POST `action=attach|record|signoff|reopen`, DELETE archive). Add V2 monthly audit-log writes (the same `appendAuditLog` pattern from `api/snags.js` and `api/evidence.js`) so the new History panel finds the entries.
- **Extend `src/domains/audit-log/schema.ts`** action enum with `itp.attached`, `itp.point.recorded`, `itp.signed_off`, `itp.reopened`, `itp.archived`. Extend target-type enum with `itp_template`, `itp_instance`.
- **Extend the V2 stats in `api/jobs.js`** with a `statsItpsActive` counter (pending | in-progress | witnessed) for the jobs index chip.
- **No new POST endpoint paths.** `api/photos.js?action=upload-itp-photo` and `api/job-itps.js?action=record` already cover the recording write path.

**No cutovers:**

- Legacy `/admin/itp.html` template editor and per-job ITP queue continue to serve unchanged through `vercel.json` rewrites. E1 ships a parallel rebuild surface at `/v2/jobs/[jobId]/itps`. **No `vercel.json` change in E1.**

### 2.2 Out of scope (deliberately)

**Deferred to E2 (separate plan):**

- Rebuild template editor (replace legacy `/admin/itp.html` template CRUD with a rebuild surface).
- Cross-job ITP triage queue (analogous to the cross-job snag queue still pending from D.5 follow-ups).
- ITP template versioning (legacy uses `templateSnapshot` at attach-time; E1 inherits this verbatim — no version history surface).
- ITP export / report (CSV, PDF). Handover-readiness rollups are Phase F+.

**Deferred to E3 (separate plan):**

- RFI domain — greenfield, smaller than ITP. Separate plan.

**Deferred to E4+ (separate planning pack):**

- Materials. Existing `api/materials-list.js` is 1,200+ lines covering takeoff, procurement, invoicing, field-capture. AI-takeoff entanglement, supplier email drafts, PO sequencing, supplier-invoice matching, captured-invoice review — each is a sub-loop. Premature to scope in this doc.

**Always out of scope for Phase E (any slice):**

- AI plan interpretation. Phase F+.
- Xero / payroll integration. Phase F+.
- Reporting / BI layer. Phase F+.
- The `/admin → /command-centre` cutover. Gated on Phase E ships covering enough sections that the new Command Centre has feature parity — bigger decision than Phase E1 alone.
- Offline-first sync engine. Existing patterns (in-flight indicator + retry-without-data-loss) carry forward; durable queue + conflict resolution is Phase F+.

---

## 3 · Operational loop

```
ADMIN-SIDE STATE EXISTS (legacy backbone)
  itp-templates.json — global library
    [{ id, name, category, description, points: [...] }, ...]
  jobs/<jobId>/itps.json — per-job attached instances
    { instances: [{ id, templateId, templateSnapshot, scope, scopeId,
                    status, results, ... }] }
  Both blobs populated via the LEGACY UI today (no rebuild templates UI in E1).

  ↓

ADMIN ATTACHES TEMPLATE TO JOB (legacy /admin/job.html, or a thin rebuild attach action)
  POST /api/job-itps?jobId=X&action=attach
    body: { templateId, scope, scopeId? }
    → snapshots template at attach-time (templateSnapshot is immutable)
    → status='pending'
    → audit-log: itp.attached (NEW — added in E1)
    → legacy structural log: kind='itp-attach' (already shipped)

  ↓

WORKER OPENS PHIL JOB
  GET /phil/jobs/[jobId]
    → existing D1 page renders
    → NEW: ITP section lists instances by status
      → tap → /phil/jobs/[jobId]/itps/[instanceId]

  ↓

WORKER RECORDS POINTS
  /phil/jobs/[jobId]/itps/[instanceId]
    For each point in templateSnapshot.points:
      → photo button → /api/photos?action=upload-itp-photo (existing)
      → value input + unit hint + pass-criterion display
      → note textarea
      → signoff toggle (only for type='signoff' points)
      → submit-per-point → POST /api/job-itps?jobId=X&action=record
        body: { instanceId, pointId, value?, note?, photoUrl? }
        → server auto-advances status: pending → in-progress (first record),
          in-progress → witnessed (all required points have results)
        → audit-log: itp.point.recorded (NEW — added in E1)

  ↓

ADMIN REVIEWS IN /v2/jobs/[jobId]/itps
  Server component (page.tsx) fetches /api/job-itps?jobId=X
    → renders <ITPsQueue /> client component
      → filter tabs: Active (pending|in-progress|witnessed) / Signed off / All
      → row primary action by status:
          pending          → no admin primary action (read-only)
          in-progress      → no admin primary action (read-only)
          witnessed        → "Sign off" (opens modal)
          signed-off       → "Reopen" (admin reverts to witnessed)
    → drawer on row click: shows full point grid + History panel
      → History fetches /api/audit-log?targetType=itp_instance&targetId=Y

  ↓

ADMIN SIGNS OFF
  Click "Sign off" → SignOffModal
    → independence-rule check: if current admin's userId matches >50% of point
      recorders, require an override justification (free text, ≤500 chars)
    → POST /api/job-itps?jobId=X&action=signoff
      body: { instanceId, overrideJustification? }
      → server validates + flips status='signed-off' + stamps signedOffBy/At
      → audit-log: itp.signed_off (NEW — added in E1)
        with metadata.overrideJustification if present

  ↓

CHIPS + COUNTERS UPDATE
  /v2/jobs cards show "ITPs N" chip from statsItpsActive (NEW — added to api/jobs.js)
  /phil/jobs/[jobId] ITP section badge reflects status counts
```

The loop is the same shape as evidence (D4) and snags (D.5): worker captures field data → admin reviews and signs off → state visible both sides → audit trail accumulates.

---

## 4 · Routes

### 4.1 Rebuild routes added in E1

| Method | Route | Owner | Purpose |
| --- | --- | --- | --- |
| HTML | `/phil/jobs/[jobId]/itps/[instanceId]` | Next.js | Phil per-instance point recording surface |
| HTML | `/v2/jobs/[jobId]/itps` | Next.js | Admin per-job ITP queue + drawer |
| API | `GET /api/job-itps?jobId=X` | existing — reused unchanged | List instances on a job |
| API | `POST /api/job-itps?jobId=X&action=attach` | existing — extend with V2 audit-log write | Admin attaches a template |
| API | `POST /api/job-itps?jobId=X&action=record` | existing — extend with V2 audit-log write | Worker records a point result |
| API | `POST /api/job-itps?jobId=X&action=signoff` | existing — extend with V2 audit-log write + independence rule | Admin signs off |
| API | `POST /api/job-itps?jobId=X&action=reopen` | existing — extend with V2 audit-log write | Admin reverts sign-off |
| API | `DELETE /api/job-itps?jobId=X&id=Y` | existing — extend with V2 audit-log write | Admin archives an instance |
| API | `GET /api/audit-log?targetType=itp_instance&targetId=Y&jobId=X` | existing read endpoint — schema extension only | History panel feed |
| API | `GET /api/jobs?withStats=1` | existing — add `statsItpsActive` field | Jobs index chip |
| API | `POST /api/photos?action=upload-itp-photo` | existing — reused unchanged | Point photo upload |

### 4.2 Routes deliberately NOT added in E1

- No `/v2/itps` cross-job triage queue (deferred to E2).
- No `/v2/admin/itp-templates` template editor (deferred to E2; legacy `/admin/itp.html` continues to serve).
- No `vercel.json` rewrites changed (no cutovers in E1).
- No RFI routes (deferred to E3).
- No materials routes (deferred to E4+).

### 4.3 Legacy routes left running

- `/admin/itp` → `public/admin/itp.html` (template editor + cross-job queue). Unchanged in E1.
- `/admin/jobs/:jobId` → `public/admin/job.html` per-job tab with the existing legacy ITP section. Unchanged in E1.

---

## 5 · Data model

### 5.1 Existing on-disk shape (preserved verbatim in E1)

`itp-templates.json` (global):

```ts
{
  templates: [{
    id: string,                       // "tmpl_xxx"
    name: string,
    category?: string,
    description?: string,
    points: [{
      id: string,                     // "pt_xxx"
      label: string,
      type: 'photo' | 'value' | 'signoff' | 'note',
      unit?: string,                  // only for type='value'
      min?: number, max?: number,     // pass criterion (only for type='value')
      required?: boolean,             // default true
      witnessRole?: 'builder' | 'admin' | 'lh',  // default 'admin' for signoff
      archived?: boolean,
      order?: number
    }],
    archived?: boolean,
    createdAt: string, createdBy: string,
    updatedAt: string
  }]
}
```

`jobs/<jobId>/itps.json` (per-job):

```ts
{
  instances: [{
    id: string,                       // "itp_xxx"
    templateId: string,
    templateSnapshot: {               // captured at attach-time, immutable
      name: string,
      points: [{ ...full point definition }]
    },
    scope: 'job' | 'level' | 'area' | 'switchboard',
    scopeId?: string,                 // levelId | areaId | switchboardId | null
    status: 'pending' | 'in-progress' | 'witnessed' | 'signed-off',
    results: {
      [pointId]: {
        value?: any,                  // number for type=value, boolean for type=signoff, etc.
        note?: string,
        photoUrl?: string,
        byUserId: string,
        byUsername: string,
        at: string                    // ISO timestamp
      }
    },
    signedOffBy?: string,             // userId
    signedOffByName?: string,
    signedOffAt?: string,             // ISO
    overrideJustification?: string,   // NEW in E1 (optional field; legacy ignores)
    archived?: boolean,
    createdAt: string,
    createdBy: string,                // userId
    createdByName: string,
    updatedAt: string
  }]
}
```

### 5.2 New `src/domains/itp/` (rebuild domain — added in E1)

Mirrors the existing legacy shape with Zod schemas + `.passthrough()` for forward-compat (same convention as `src/domains/snags/schema.ts`):

- `schema.ts` — `ITPTemplatePointSchema`, `ITPTemplateSchema`, `ITPInstanceSchema`, `ITPInstanceResultSchema`, `AttachITPPayloadSchema`, `RecordITPPointPayloadSchema`, `SignOffITPPayloadSchema`. List + transition response schemas.
- `types.ts` — re-exports the inferred types.
- `client.ts` — typed wrappers: `listItps(jobId)`, `attachItp(jobId, payload)`, `recordItpPoint(jobId, payload)`, `signOffItp(jobId, payload)`, `reopenItp(jobId, payload)`, `archiveItp(jobId, instanceId)`.
- `format.ts` — pure display helpers: `statusLabel`, `statusTone`, `pointTypeLabel`, `valuePassFailLabel`, `isActive`, `isDone`, `needsWorkerAttention`, `formatProgress(instance)`.
- `service.ts` — state-machine + role gates: `allowedTransitions`, `canTransition(from, to)`, `canRoleTransition(from, to, viewer, instance)`, `canSignOff(viewer, instance, points)` (encapsulates the independence rule). Pure functions, no I/O.
- `itp.test.ts` — unit tests for schemas + state machine + role gates + independence rule.

### 5.3 Audit-log schema extension (E1)

Extend [src/domains/audit-log/schema.ts](../../src/domains/audit-log/schema.ts):

- `AUDIT_ACTIONS` add: `'itp.attached'`, `'itp.point.recorded'`, `'itp.signed_off'`, `'itp.reopened'`, `'itp.archived'`.
- `AUDIT_TARGET_TYPES` add: `'itp_template'`, `'itp_instance'`.

Existing read endpoint at `api/audit-log.js` and the History panels do not need changes — they already iterate enum-agnostic.

### 5.4 No `jobs/<id>/data.json` namespace touch

ITP storage lives at `jobs/<id>/itps.json` separately from `data.json` (which holds evidence + snagsV2 + dwellings + notes). E1 inherits that separation verbatim. No new namespace on `data.json`.

---

## 6 · Phil UI

### 6.1 Job detail ITP section

Mounted on the existing `/phil/jobs/[jobId]` page below the Snags section. Same `<Card>` shape, same heading-then-list pattern, same yellow-CTA convention.

Header row:
```
ITPs                                                    N done
Inspection plans attached to this job. Tap one to start
or continue recording points.
```

If no instances: empty state "No ITPs attached to this job yet."

If instances exist: grouped list. Each row shows:
- Status pill (Open, In progress, Witnessed, Signed off)
- Template name + scope label (e.g. "MSB energisation · Unit 1") 
- Progress bar (e.g. `4 / 7 points`)
- Right-aligned chevron

Tapping a row navigates to `/phil/jobs/[jobId]/itps/[instanceId]`. No in-line actions.

### 6.2 Per-instance recording surface

New route: `/phil/jobs/[jobId]/itps/[instanceId]`.

Layout:
- Sticky header: back link to job detail, title (template name), status pill, progress badge.
- Scoped scope-context: "Whole job" / "Level: G" / "Area: Unit 1" / "Switchboard: MSB-01".
- Vertical list of points (one card per point):
  - Point label + required-asterisk if `required !== false`.
  - Body controlled by `type`:
    - `photo` — photo capture button (sheet pattern from `src/components/phil/CaptureSheet.tsx`) + thumbnail of recorded image + note input.
    - `value` — number input + unit + pass-criterion hint (`Pass: ≥ 250 V` / `Pass: 0.2-0.5 Ω`) + note input.
    - `signoff` — toggle ("Mark complete") + optional note input. Disabled if `witnessRole` excludes the current user.
    - `note` — textarea only.
  - Submit button per point (text changes between "Save", "Update", "Saving…").
  - Result state pill if recorded (timestamp + recorder name).

State machine on the client: per-point status `idle | dirty | submitting | saved | error`. Auto-saves the photo on capture; saves value/note/signoff on explicit tap to avoid accidental over-writes during typing.

Inline error path: on 409 (e.g. instance archived between page load and submit), show a friendly "This ITP has been updated. Reload to see the latest." banner with a reload button. On 403, "You can't record this point." On 400 (genuine validation), show server message.

### 6.3 Tap-target rules

All buttons follow doc 27 §4 + PR #20 tap-target precedent: `size="lg"` (48 px) on every primary tap. Photo capture button is 56 px tall (matches CaptureSheet pattern).

### 6.4 Routes used by Phil UI

- `GET /api/job-itps?jobId=X` — on Phil page load (server-component fetch) so the list paints from the first byte.
- `POST /api/photos?action=upload-itp-photo` — per-point photo capture.
- `POST /api/job-itps?jobId=X&action=record` — per-point save.

No new endpoints created by the Phil UI.

---

## 7 · BuhlOS Admin UI

### 7.1 Per-job ITP queue

New route: `/v2/jobs/[jobId]/itps`.

File layout (per the binding RSC manifest rule [doc 24 D-26]):
- `src/app/v2/jobs/[jobId]/itps/page.tsx` — server component. Gates auth + LH/admin surface access. Fetches `/api/job-itps?jobId=X`. Renders `<ITPsQueue />`.
- `src/components/admin/ITPsQueue.tsx` — client component (the list + drawer + sign-off modal owner). Mirrors `SnagsQueue.tsx` shape.
- `src/components/admin/ITPDrawer.tsx` — point-grid drawer with History panel. Mirrors `SnagDrawer.tsx`.
- `src/components/admin/ITPSignOffModal.tsx` — sign-off confirmation + independence-rule override.

Queue:
- Filter tabs: `Active` (pending + in-progress + witnessed), `Signed off`, `All`.
- Counts per tab.
- Table columns: Status pill, Template + scope, Progress, Attached by, Attached at, Actions.
- Row primary action by status:
  - `witnessed` → `Sign off` button (opens modal).
  - `signed-off` → `Reopen` button (direct POST, no modal — same as snag transitions).
  - `pending` / `in-progress` → "No actions" tag.
- Read-only Pill for LH viewer ("Read-only — leading hand").

Drawer:
- Point grid: label, type-specific result rendering, recorder name + timestamp, pass/fail badge for value points with criteria.
- History panel: reads `/api/audit-log?targetType=itp_instance&targetId=Y&jobId=X` with the 2.5s retry pattern from `EvidenceDrawer` (D5-FIX-1) and `SnagDrawer` (D.5-fix-1).
- Footer: same Sign off / Reopen / Archive (admin only) action set as the row.

### 7.2 Sign-off modal independence rule

The legacy `public/admin/itp.html` enforces a sign-off independence rule (admin-only, the inspector signing off shouldn't be the same person as the point recorder). E1 hardens this by computing the rule in `src/domains/itp/service.ts#canSignOff(viewer, instance, points)` and surfacing it in the UI:

- If the viewer's `userId` matches the recorder on **more than 50% of required points**, the modal requires an `overrideJustification` (free text, ≤500 chars).
- If the viewer's `userId` matches the recorder on **0% to 50%**, the modal is a simple confirm.
- Server enforces the same rule defensively — the modal isn't the only gate.

### 7.3 `/v2/jobs` chip update

Extend the existing `JobsList.tsx` ActionChip row with an `ITPs N` chip. Counter sourced from `job.statsItpsActive` (added to `api/jobs.js` `withStats=1` enrichment). Highlighted yellow when N > 0. Aria-label: `"Open N ITPs needing attention for ${job.name}"`. Click navigates to `/v2/jobs/[jobId]/itps`.

### 7.4 Sidebar UC badge flip

`src/components/admin/AdminSidebar.tsx` currently shows `Snags · UC`. E1 doesn't add a sidebar entry for ITPs (admins find them via the jobs index chip). A dedicated cross-job triage entry is E2.

---

## 8 · APIs needed later (E2-E4)

E1 deliberately introduces zero new HTTP routes. The rebuild's HTTP surface stays exactly where Phase D + D.5 left it. Future Phase E slices will need:

- **E2 (templates rebuild):**
  - GET / POST / PATCH / DELETE on a rebuild template wrapper around the existing `api/itp-templates.js`. New `src/domains/itp-templates/` for typed client + Zod schema (mirroring this E1 plan's domain pattern).
  - Cross-job ITP triage queue route at `/v2/itps` (server-component fetch across all readable jobs — same pattern as a future cross-job snag queue).
- **E3 (RFI):**
  - `GET /api/rfis?jobId=X` — list RFIs on a job.
  - `POST /api/rfis?jobId=X` — create RFI (field-side).
  - `POST /api/rfis?jobId=X&action=respond` — admin/PM response.
  - `POST /api/rfis?jobId=X&action=close` — admin close.
  - New `src/domains/rfis/` greenfield domain.
- **E4 (materials):**
  - Existing `api/materials-list.js` + `api/materials-summary.js` are already in place. Rebuild needs a careful audit before re-wrapping — likely multiple sub-slices, each its own plan. **Not scoped in this doc.**

None of the above will be touched by E1.

---

## 9 · Permissions

Inherits the role tiers from `api/_lib/auth.js` (PR #23 normalisation):

- **admin tier** (`admin`, `boss`, `owner`, `manager`, `office`, `pm`, `estimator`) — full ITP control: attach, record any point, sign off, reopen, archive.
- **LH tier** (`leadinghand`, `leading_hand`, `leading-hand`, `lh`) — record points on assigned jobs; cannot sign off unless point's `witnessRole === 'lh'`.
- **field tier** (`tradie`, `apprentice`, `labourer`, `electrician`) — record points on assigned jobs; cannot sign off; cannot attach.
- **client** — read-only (where they have job access at all); cannot record or sign off.

Server-side checks live in `api/job-itps.js` (already implements basic admin/LH gating). E1 adds:

- Independence rule on sign-off (admin can override with justification).
- Witness-role check on per-point sign-off (point with `witnessRole='lh'` requires LH or admin recorder).

The existing `api/snags.js` PR #26 fix that aligned local role sets with `api/_lib/auth.js` exports should be mirrored verbatim in `api/job-itps.js` during E1 so admins on the expanded tier (`pm`, `estimator`) can attach and sign off.

---

## 10 · Audit

Dual-write pattern unchanged from D.5:

1. **Legacy** `api/_lib/job-audit.js` per-job structural log — already wired for `itp-attach`, `itp-signoff`, `itp-reopen`, `itp-archive` (line 174, 206, 229 of `api/job-itps.js`). E1 does NOT touch this — keeps the legacy admin audit tab working.
2. **New V2** `api/_lib/audit-log.js` monthly cross-surface journal — E1 adds calls in `api/job-itps.js` for: attach, record, signoff, reopen, archive. New action verbs in §5.3.

Both calls wrapped in `.catch(() => {})` so a log failure on either path never blocks the ITP write — same precedent as snags.

---

## 11 · Testing

See [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) for the full per-slice gate. Summary here:

- **Domain unit tests** — Zod schemas accept/reject expected shapes; state machine accepts only the documented transitions; role gates honor the role tiers; independence rule fires correctly.
- **Client integration tests** — `listItps`, `recordItpPoint`, `signOffItp` surface 200/400/403/409 from the server faithfully (vitest with mocked fetch, same pattern as `snags.test.ts`).
- **Server-side smoke** — extend [scripts/smoke-evidence-routes.js](../../scripts/smoke-evidence-routes.js) to include the new HTML routes (`/v2/jobs/birdwood-iv3232/itps` → 307) and the existing API routes (`/api/job-itps?jobId=...` → 401 unauth).
- **Authenticated end-to-end smoke** — extend `scripts/auth-smoke-d55-snags.sh` (or fork it as `scripts/auth-smoke-e1-itp.sh`) to drive the full E1 loop: attach → record N points → sign off → audit log assertions.
- **Production smoke (manual)** — labelled `TEST E1 ITP` instances, walk the full lifecycle in production via Chrome MCP, mirror the Session 5 / 8 verification reports.
- **Regression** — full Phase B/C/D/D.5/D6 unauth smoke (`npm run smoke:evidence-routes`) green on each preview build + after merge.

---

## 12 · Under construction

For E1's ship date:

- `/v2/jobs/[jobId]/itps` — live (the E1 surface).
- `/phil/jobs/[jobId]/itps/[instanceId]` — live (the E1 Phil surface).
- `/v2/jobs` ITP chip — live.
- Legacy `/admin/itp.html` — live (template library, cross-job queue, unchanged from before E1).
- Legacy `/admin/job.html` ITP tab — live (admin can still attach + sign off there).

For E1's ship date that stays **UC** in the rebuild:

- `Templates · UC` — no rebuild template editor; users go to legacy `/admin/itp.html` (until E2).
- `Cross-job triage · UC` — no rebuild cross-job ITP queue; users go to legacy `/admin/itp.html` (until E2).
- `RFI · UC` — no rebuild surface (until E3).
- `Materials · UC` — no rebuild surface (until E4+).

The sidebar should NOT add a top-level `ITPs · UC` entry in E1. ITPs are accessed via the jobs index — same pattern as Evidence and Snags. A cross-job `ITPs` sidebar entry lands with E2.

---

## 13 · Hard rules — every Phase E session

Mirrors the Phase D rules (doc 25) verbatim where relevant. Specifically for E1:

- Do NOT touch any branch other than the one you create for your slice.
- Do NOT deploy. Do NOT `vercel deploy` anything.
- Do NOT push to `main` directly.
- Do NOT bypass any pre-commit hook with `--no-verify`.
- Do NOT add `any` or `@ts-ignore`. Do NOT use `alert()` / `confirm()` / `prompt()` in product code.
- Do NOT use `window.location.href = ...` for in-app nav. Use `<Link>` / `useRouter()`.
- Do NOT add a `vercel.json` rewrite. E1 is rebuild-surface-only.
- Do NOT add new HTTP endpoint paths beyond the two HTML routes listed in §4.1. The API additions are extensions to existing endpoints (new audit-log calls + new statsItpsActive field). If you find yourself wanting a new API path, **STOP and ask** ([20-agent-rules.md] #5, #31).
- Do NOT silent-fallback to fixtures. If API fails, render error UI.
- Do NOT write "Switchboard" or "Site Office" as user-facing strings — but DO render "Switchboard" as the ITP scope label since that's the legacy data semantic for `scope='switchboard'` (proper noun referencing electrical equipment). Verify by Oskar in §15.1.
- Do NOT touch the legacy `/admin/itp.html` page or the `api/itp-templates.js` template-editor endpoint in E1.
- Do NOT mix E1a / E1b / E1c into a single PR.
- DO NOT put a client component (`"use client"`) next to a page that is ≥2 route segments deep. Same RSC manifest rule from doc 24 D-26 / doc 25. E1 client components live under `src/components/phil/` or `src/components/admin/`.

**Every PR title** starts with `[Phase E1]`.

---

## 14 · Build sequence

Phase E1 ships as three sub-slices, each its own PR:

| Slice | Scope | Estimated size |
| --- | --- | --- |
| **E1a** | `src/domains/itp/` (schema + client + service + format + types + tests) + audit-log schema extension + `api/job-itps.js` extension with V2 audit-log calls + `api/jobs.js` statsItpsActive | Small (touches existing API; new domain). 200-400 LOC + tests. |
| **E1b** | `src/components/phil/JobITPsPanel.tsx` (section on existing `/phil/jobs/[jobId]`) + new `/phil/jobs/[jobId]/itps/[instanceId]/page.tsx` + `src/components/phil/ITPRecordSheet.tsx` (or per-point inline) + per-point client integration | Medium. ~400-600 LOC + tests. |
| **E1c** | `/v2/jobs/[jobId]/itps/page.tsx` + `src/components/admin/ITPsQueue.tsx` + `ITPDrawer.tsx` + `ITPSignOffModal.tsx` + `JobsList.tsx` chip extension + admin client integration | Medium. ~400-600 LOC + tests. |

Each slice gets its own preview + smoke + Oskar review + merge before the next starts. Same cadence as D2/D3/D4. E1c depends on E1a being shipped (typed domain available); E1b can run in parallel with E1c after E1a merges, but practically running them sequentially gives cleaner reviews.

---

## 15 · Decisions

### 15.1 Open founder calls (Oskar to resolve before E1 starts)

1. **E1 scope confirmation.** This plan recommends ITP field-record + admin sign-off as E1. RFI (greenfield) and Materials (huge legacy) are deferred. **Confirm.**
2. **API strategy: reuse `api/job-itps.js` (extend it) vs parallel V2 endpoint (`api/itps.js`)?** This plan recommends extending the existing endpoint with V2 audit-log writes because the state machine + storage shape are already correct. Parallel namespace adds duplication without benefit. **Confirm.**
3. **Sign-off independence rule severity.** Legacy enforces softly via UI gating. This plan promotes it to a server-side check that requires an override justification. **Confirm the 50% threshold is the right line.** Alternatives: 100% (any same-actor record blocks sign-off without justification) or 0% (the recorder can always sign off — drop the rule).
4. **"Switchboard" as the ITP scope label.** It's the legacy semantic for `scope='switchboard'`. Doc 27 §3 bans the word as a section / sidebar label, but it remains an electrical-equipment proper noun. **Confirm rendering "Switchboard" in ITP scope labels is allowed.**
5. **Phil per-instance route or sheet?** This plan recommends a dedicated route `/phil/jobs/[jobId]/itps/[instanceId]` because point grids are tall and include per-point photo capture. Alternative: a full-screen sheet from the job detail. **Confirm route-vs-sheet.**
6. **Legacy `/admin/itp.html` continuity.** E1 leaves the legacy template editor and cross-job queue running. **Confirm there's no need to add a UC warning banner to the legacy page** alerting admins that a rebuild path exists for the per-job ITP queue (similar to how legacy snags were left running alongside D.5).

### 15.2 Resolved (assumed by this plan unless §15.1 changes them)

- **R1**: E1 covers ITP only. RFI = E3. Materials = E4+ (its own planning pack).
- **R2**: Reuse `api/job-itps.js`; do not create `api/itps.js` parallel.
- **R3**: Reuse `api/photos.js?action=upload-itp-photo` for point photos.
- **R4**: No `vercel.json` change in E1. No cutovers.
- **R5**: Sidebar gets no `ITPs · UC` entry in E1. Jobs-index chip is the only discoverability path.
- **R6**: `jobs/<id>/itps.json` storage stays separate from `data.json`. No new namespace on `data.json`.
- **R7**: `templateSnapshot` immutability inherited verbatim from legacy.

---

## 16 · Risks

| Ref | Risk | Mitigation |
| --- | --- | --- |
| **E-01** | Extending `api/job-itps.js` with V2 audit-log writes accidentally regresses the legacy structural log (the dual-write breaks). | Audit-log writes wrapped in `.catch(() => {})` so a failure on the new path never blocks the legacy write. Unit-test both call sites in `api/job-itps.js`. |
| **E-02** | Legacy `/admin/itp.html` and the rebuild `/v2/jobs/[jobId]/itps` get out-of-sync because they read the same blob but write through different code paths. | Both paths use the same `api/job-itps.js` endpoint. The rebuild adds no parallel writer. |
| **E-03** | The independence-rule check fires false-positives because of a tradie who legitimately recorded most points and a different admin signing off without override. | Threshold tuned per §15.1 #3. UI clearly says "this looks like a single-recorder ITP — confirm sign-off authority." Server doesn't hard-block; the justification field is the safety valve. |
| **E-04** | The per-instance Phil page is a heavy render (10-20 points with photos). Mobile performance regression. | Render in chunks (server-component first paint of unrecorded structure; client component for the per-point recorders). Lazy-load point photos. |
| **E-05** | Audit-log schema extension breaks downstream parsers (e.g. existing snag/evidence History panels) because the enum grew. | Schemas use `z.enum()`. Extending the enum is additive — old data continues to parse. Existing History panels filter by `targetType` and ignore unknown verbs they don't render. Verified safe by D.5 pattern (D.5 added `snag.created` + `snag.transitioned` to the same enum). |
| **E-06** | Phil-side ITP rendering interferes with the existing D1 job detail rendering (the section is a sibling of Snags + Today's captures + Stage chooser). Layout regression. | Visual smoke in preview — Chrome MCP scroll-through of `/phil/jobs/birdwood-iv3232` confirms all sections render in order. Independent `<Card>` per section preserves the visual rhythm. |
| **E-07** | The Vercel Blob read-after-write lag bug (BUG 2 from PR #26) recurs in `api/job-itps.js` because the existing endpoint uses `readBlob` not `readBlobFresh`. | E1a inherits the PR #26 mitigation: change `transition`-equivalent paths (record, signoff, reopen, archive) to use `readBlobFresh` + the same retry-once pattern. Documented in [phase-d55-snags-hardening-runbook.md](phase-d55-snags-runbook.md) (after PR #26 lands). |
| **E-08** | Bundling E2 (template editor) into E1 ships a much larger PR set and slows feedback. | E1 explicitly defers template editor to E2 (see §2.2). Template CRUD remains on legacy `/admin/itp.html`. |
| **E-09** | The legacy `/admin/itp.html` admin queue and the rebuild admin queue both show an ITP that's been signed off — admins do the same operation twice. | Acceptable for E1 — same risk that snags faced when `/admin/snags.html` and `/v2/jobs/[jobId]/snags` both existed. Operationally the rebuild surface is preferred; legacy is a fallback. A UC banner on the legacy page can be added in E2. |

---

## 17 · Out-of-scope reminder (Phase E does NOT include)

- The `/admin → /command-centre` cutover.
- The `vercel.json` cleanup of any legacy routes.
- AI plan interpretation.
- Xero / payroll integration.
- Reporting / handover-readiness rollups.
- Offline-first sync engine.
- Cross-job ITP triage queue (E2).
- Template editor rebuild (E2).
- RFI domain (E3).
- Materials rebuild (E4+).
- Anything not in §2.1.

---

## 18 · Cross-references

- [33-phase-e-build-prompts.md](33-phase-e-build-prompts.md) — paste-ready build prompts for E1a / E1b / E1c.
- [34-phase-e-testing-checklist.md](34-phase-e-testing-checklist.md) — per-slice gate + regression matrix.
- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — format precedent; the binding rules carry forward.
- [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) — testing-checklist format precedent.
- [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md) — operational pattern E1 mirrors (worker→admin→worker loop).
- [api/job-itps.js](../../api/job-itps.js) — legacy server-side ITP state machine (E1 extends, doesn't replace).
- [api/itp-templates.js](../../api/itp-templates.js) — legacy template editor API (E1 does not touch).
- [api/photos.js](../../api/photos.js) §`upload-itp-photo` — legacy point-photo upload (E1 reuses).
- [public/admin/itp.html](../../public/admin/itp.html) — legacy admin UI (template editor + cross-job queue). E1 does not touch.

---
