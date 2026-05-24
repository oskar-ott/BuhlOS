# 30 · Phase D4 — Admin evidence review · spec + build prompt

> **Status:** docs only. Planning artefact. No app code implied or built by this doc.
>
> **Read first:** [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §5.5 + §6.2 + §9.5 + §9.6, [27-interface-usability-pass.md](27-interface-usability-pass.md) §5 + §6 + §9.5 + §9.6 + §11, [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) §C, [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) (counterpart on Phil; D3 + D4 close the loop).
>
> **Phasing note:** **In this session's phasing**, D4 = admin evidence review surface as its own thin slice — separate from any `/admin/jobs` cutover. Doc 25's older D4 prompt bundled the admin Jobs surface and `/jobs` route cutover with the Evidence panel; this split lets D4 ship without a `vercel.json` change, behind `/v2/jobs/...`. The wider admin Jobs page + route cutover is its own later slice. See [doc 28 §0](28-d2-d3-d4-evidence-qa-checklist.md) for the full reconciliation.

---

## 1 · Purpose

Admin reviews evidence submitted from Phil. Each evidence item lands in a queue, the admin opens a drawer, marks it `reviewed` or rejects it with a reason. The loop closes back to the worker (the worker sees the new status on next Phil refresh).

The slice is UI + a stub of an already-D2-shipped review endpoint. No new schema. No route cutover.

---

## 2 · Scope

### 2.1 · In scope

- A new admin evidence review surface mounted at a safe path (`/v2/jobs/[jobId]/evidence` — provisional; see §3 route decision).
- Read-only list of evidence items per job, status-first.
- Filters: status · capturedBy · date range · unattached-only (no area/stage/task set).
- Drawer (preferred) or full-page detail with full-size photo, full note, target (area + stage + task or "unattached"), captured-by, captured-at, status pill, audit trail.
- Mark reviewed (single + bulk).
- Reject with reason (single only — bulk reject muddles audit and is **out of scope**).
- Admin un-review (`reviewed → submitted`) — optional, can defer to D5.
- A queue card on `/command-centre` showing the pending-review count + age of oldest pending. Click-through links to the admin evidence surface filtered to `status='submitted'`.

### 2.2 · Out of scope (defer)

- The full `/admin/jobs` admin Jobs list + detail page rebuild. That's a separate, larger slice — provisionally rolled into D5 or shipped as its own "D4.5".
- `/admin/jobs` and `/admin/jobs/:jobId` legacy route cutovers and the `vercel.json` rewrite removal. Doc 25 §13 D4 included these; this spec splits them out.
- `/admin/activity` route cutover. Doc 25 §13 D5.
- Bulk reject. Reasons are per-item.
- LH "approve" parallel — LH stays read-only per [doc 24 §15.0 #6](24-phase-d-jobs-evidence-plan.md).
- Snags / ITPs / RFIs / materials / AI plan / reports.
- Photo zoom/pan beyond the browser default (the `<img>` tag's native zoom is acceptable).
- Image manipulation (rotate, crop, annotate).
- Per-row keyboard shortcuts (a future polish).

---

## 3 · Routes

### 3.1 · Decision — provisional surface

D4 ships behind `/v2/jobs/[jobId]/evidence`. This:

- Avoids any `vercel.json` change.
- Lives alongside the legacy `public/admin/job.html` (which continues to serve under `/admin/jobs/[jobId]` via the existing rewrite).
- Cutover (the legacy → new admin Jobs page swap) is its own slice later.

The legacy `/admin/job.html`'s existing "Photos" / "Snag photos" tab continues to work and is unrelated to evidence (it predates Phase D). The admin's mental model: "evidence" is a new concept that lives on the new surface; existing photo tabs are legacy and not touched.

### 3.2 · Routes mounted by D4

| Route | Owner | Notes |
| --- | --- | --- |
| `/v2/jobs/[jobId]/evidence` | Next.js (new) | Admin evidence queue + drawer. `vercel.json` doesn't claim this. |
| (optional) `/v2/jobs/[jobId]/evidence/[evidenceId]` | Next.js | Full-page drawer fallback for deep-link sharing in Slack / email. Default is drawer-only; this route is a nice-to-have if it doesn't bloat the PR. |

**Not mounted by D4:**

- `/jobs`, `/jobs/[jobId]` — wait for the admin-Jobs-cutover slice.
- `/admin/jobs/*` — legacy, unchanged.
- `/admin/operations/*` — legacy, unchanged.

### 3.3 · Middleware

Add `/v2/jobs` to `src/middleware.ts` PROTECTED + matcher with surface `admin`. (LH read access lives below; the page itself gates write actions, but middleware-level surface check is fine — admin or LH may pass; the page checks role for write actions.)

Reconsider in code review: if LH is supposed to read but not write, the surface gate may need to be `admin | lh`. Two viable patterns:
- **A.** Middleware lets through admin + LH; page renders read-only for LH (action buttons disabled).
- **B.** Middleware blocks LH; LH reads via a separate `/lh/jobs/[jobId]/evidence` mount.

**Recommendation:** A. Mounts once; the role check lives in the action handlers, not in middleware. This matches the existing Phase B `/hours/approvals` pattern.

---

## 4 · File plan

All new client components live in `src/components/admin/` per [doc 27 §10](27-interface-usability-pass.md). RSC manifest rule binding.

### 4.1 · New files

| Path | Role |
| --- | --- |
| `src/components/admin/EvidenceQueue.tsx` | Status-first rows. Filter bar above. Bulk-select column. "Mark N reviewed" CTA. Receives `evidence: EvidenceItem[]` + `job: Job` as props. |
| `src/components/admin/EvidenceDrawer.tsx` | Slides in from the right when a row is clicked. Full-size photo (responsive), full note, target detail, status pill, audit trail. Actions: Mark reviewed / Reject. |
| `src/components/admin/EvidenceRejectModal.tsx` | Small modal with required reason textarea (≤ 500 chars). Submit / Cancel. |
| `src/components/admin/EvidenceFilterBar.tsx` | Filter controls (status, capturedBy, date range, unattached-only). |
| `src/components/admin/EvidenceQueue.test.tsx` | Vitest + RTL. |
| `src/components/admin/EvidenceDrawer.test.tsx` | Same. |
| `src/components/admin/EvidenceRejectModal.test.tsx` | Same. |
| `src/app/v2/jobs/[jobId]/evidence/page.tsx` | Server component. Gates auth (admin or LH). Fetches `/api/jobs/[jobId]` + `/api/jobs/[jobId]/evidence`. Renders `<EvidenceQueue />` + (state-driven) `<EvidenceDrawer />`. |
| (optional) `src/app/v2/jobs/[jobId]/evidence/[evidenceId]/page.tsx` | Full-page deep-link fallback. |
| `tests/phase-d-d4-admin-review.spec.ts` | Playwright: mark reviewed, reject with/without reason, filter, bulk-select. |

### 4.2 · Edits

| Path | Edit |
| --- | --- |
| `src/middleware.ts` | Add `/v2/jobs` to PROTECTED + matcher. Surface: `admin` (or accept LH if §3.3 A is chosen — clarify in PR). |
| `src/app/command-centre/page.tsx` | Add the "X evidence pending review" queue card (per [doc 27 §9.1](27-interface-usability-pass.md)). Card shows count + oldest item age + click-through. **No new sparkline.** |

### 4.3 · No domain changes

D2 ships `src/domains/evidence/`. D4 consumes its `client.listForJob`, `client.review`, etc. D4 must not add new schemas.

If a helper method is needed, file a QA finding for D2's domain layer to ship it before D4 opens.

### 4.4 · No D3 changes

D3 lives in `src/components/phil/`. D4 must not touch any `src/components/phil/*` files. The loop closes via the server: admin marks reviewed → Phil reads new status on next refresh. No socket, no push.

---

## 5 · API contract (consumed)

### 5.1 · `GET /api/jobs/[jobId]/evidence`

Returns `{ evidence: EvidenceItem[] }` filtered server-side per role (admin → all; LH → all on this job; tradie → own only; client → 403). D4 trusts the server filter; no client-side re-filtering.

### 5.2 · `POST /api/jobs/[jobId]/evidence/[evidenceId]/review`

(Or whatever path D2 ships — see §A.4 of [doc 28](28-d2-d3-d4-evidence-qa-checklist.md).)

**Mark reviewed:**

```ts
POST { status: 'reviewed' }
→ 200 { evidence: EvidenceItem (status='reviewed', reviewedById, reviewedAt) }
```

**Reject:**

```ts
POST { status: 'rejected', rejectionReason: '<≤500 chars>' }
→ 200 { evidence: EvidenceItem }
→ 400 if rejectionReason missing or empty
```

**Un-review (admin only, optional in D4):**

```ts
POST { status: 'submitted' }
→ 200 { evidence: EvidenceItem }
```

Errors: 401 / 403 / 400 / 404. Server enforces the state-machine transitions per [doc 24 §5.5](24-phase-d-jobs-evidence-plan.md).

### 5.3 · `GET /api/audit-log?targetEntity=evidence&targetId=<id>`

(Or however D2 ships the audit-log read.) Returns `{ entries: AuditLogEntry[] }` for the drawer's history section. Optional in D4 — if D2 hasn't shipped a query, the drawer renders a "History" placeholder until D5 polish. Don't block D4 on this.

---

## 6 · UI rules (binding)

[Doc 27](27-interface-usability-pass.md) is the source of truth; the most relevant for D4:

### 6.1 · Status-first rows (doc 27 §5.2)

Every queue row:

| Column | Width / role |
| --- | --- |
| Bulk-select checkbox | 32px |
| Status pill | left-anchored, ~80-100px |
| Thumb (48×48) | clickable, opens drawer |
| Note excerpt | 1 line, truncate with `…` |
| Target | area + stage + task, or "unattached" pill (neutral tone) |
| Captured by | worker name |
| Captured at | relative ("2h ago"); absolute on hover (`<time title=...>`) |
| Row actions | "Review" (primary) / "Reject" (secondary) — buttons, **not** three-dot menu |

The whole row is the drawer-open target except the checkbox column.

### 6.2 · Drawer (doc 27 §5.2)

- Slides in from the right.
- Body scrolls; drawer is dismissible via `Esc` / click outside.
- Header: status pill + "Reviewed by [admin] on [date]" if applicable.
- Body sections (vertical):
  1. **Photo** — full-size, responsive, native browser zoom.
  2. **Note** — full text, `whitespace-pre-line`.
  3. **Target** — area + stage + task, or "Unattached" pill + helper copy "Worker captured without picking an area / stage / task".
  4. **Captured** — worker name + ISO date in user's locale.
  5. **History** — `evidence.captured` → `evidence.reviewed` / `evidence.rejected` events from `AuditLog`. If D2's audit-read isn't ready, render "History will appear here once available" — labelled UNDER CONSTRUCTION with the standard pill.
- Footer (sticky): primary "Mark reviewed" + secondary "Reject" (opens modal). Disabled if already `reviewed` or `rejected`. Tertiary "Un-review" only if status is `reviewed` and user is admin (D4 polish; can defer).

### 6.3 · Reject modal (doc 27 §9.2 lessons from Hours)

- Small modal (not full-page).
- Required textarea, max 500 chars (matches legacy `time-entries-reject` convention).
- Counter visible.
- Submit blocked until reason is non-empty (trimmed).
- Cancel returns to drawer with no state change.
- No `confirm()` / `alert()`.
- After submit: modal closes → drawer status pill flips → row in queue updates without a full route refresh (router refresh or local state revalidation).

### 6.4 · Filter bar

- Sticky at top of the queue (below the page header).
- Status dropdown: All / Submitted (default) / Reviewed / Rejected.
- CapturedBy: type-ahead worker name (only workers who actually have captures on this job — server returns the distinct set with the evidence list, or D4 derives client-side).
- Date range: two date inputs (from / to), default last 14 days.
- Unattached-only toggle.
- "Clear filters" link, visible only when at least one filter is non-default.

### 6.5 · Bulk select + bulk mark reviewed

- Checkbox column.
- Header checkbox toggles all-on-current-filter (not all-on-server).
- "Mark N reviewed" CTA appears in the bar above the queue when ≥ 1 row selected. Disabled while in-flight.
- Bulk = N separate POSTs to the review endpoint, parallel. If any fails, that row keeps `submitted` + an inline error pill; the others succeed. PR body must document this behaviour (server-side bulk is **not** in scope for D2/D4).
- After all N resolve, the bulk CTA hides; selected rows clear.

### 6.6 · Command Centre queue card (doc 27 §9.1)

A new queue card on `/command-centre`:

```
Evidence pending review
12                              [oldest 2h ago]
                    Open queue →
```

- Card shows count + oldest age + click-through.
- Click → `/v2/jobs/[jobId]/evidence?status=submitted` — but this is per-job; for cross-job there's no aggregator until the admin Jobs surface ships. **D4 ships a per-job card only** when the admin lands on a specific job; cross-job aggregation is deferred.
- Until per-job context exists on Command Centre, the card may instead point to a future "all evidence pending review" route. Decision deferred to the admin-Jobs-cutover slice; for D4, the card may be **skipped on Command Centre** if it can't link to a useful place. PR body documents the choice.

---

## 7 · State machine (server-enforced)

(Re-stated from [doc 24 §5.5](24-phase-d-jobs-evidence-plan.md):)

- `submitted → reviewed` — D4 admin action.
- `submitted → rejected` (with `rejectionReason`) — D4 admin action.
- `reviewed → submitted` — admin un-review. D4 optional (D5 if pushed).
- All other transitions → 400.

D4 does not invent transitions. Any new transition needs an ADR.

---

## 8 · Visual markers (doc 27 §6.2)

| Marker | Tone | Where |
| --- | --- | --- |
| `submitted` | info | queue + drawer status pill |
| `reviewed` | success | queue + drawer; optional `lock` icon for immutability |
| `rejected` | danger | queue + drawer; rejection reason inline on the row + in the drawer body |
| `Unattached` | neutral | target column when area / stage / task all missing |

No new tones, no new labels.

---

## 9 · Empty / loading / error / pending

[Doc 27 §12](27-interface-usability-pass.md):

| State | Queue | Drawer |
| --- | --- | --- |
| Loading | Skeleton 5 rows | Spinner inside drawer header |
| Empty | "No evidence captured for this job yet." | n/a (drawer only opens on tap) |
| Empty under filter | "No evidence matches these filters." + Clear filters link | n/a |
| Error | Banner above queue: "Couldn't load. Retry?" + Retry button | "Couldn't load this item. Retry." |
| Ready | Rows | Full detail |
| Mark reviewed in flight | Row dimmed; mark button shows spinner | Drawer's primary button disabled with spinner |
| Mark reviewed success | Row's status pill flips to `reviewed`; brief affirmative ("Reviewed") decays in 1.5s | Drawer's status pill flips |
| Reject in flight / success | same | same; modal closes on submit |

---

## 10 · Validation rules

- Reject reason: `trim().length ≥ 1` and `length ≤ 500`. Client blocks submit until valid. Server is authority.
- Bulk: N evidence IDs, all must be `status === 'submitted'` at time of submit; if a row has already changed (e.g. another admin marked it), the per-row POST returns 400 and the row retains its current state.
- Un-review: caller must be admin; if LH attempts, button shouldn't be visible.

---

## 11 · Acceptance criteria

Phase D4 ships when **all** of:

- [ ] `/v2/jobs/[jobId]/evidence` renders the per-job queue for admin or LH.
- [ ] Anonymous → redirect to `/v2/login?next=...`.
- [ ] Tradie / client visiting `/v2/jobs/[jobId]/evidence` → middleware redirects to landing.
- [ ] Status-first rows render with photo thumb, note excerpt, target, captured-by, captured-at, status pill.
- [ ] Filters work: status, capturedBy, date range, unattached-only.
- [ ] Bulk-select + "Mark N reviewed" produces N audit-log rows; per-row failures don't roll back successes.
- [ ] Reject modal blocks empty reason; submit produces a `evidence.rejected` audit row + sets `rejectionReason`.
- [ ] Drawer renders full photo + note + target + status + history (or UC if history endpoint deferred).
- [ ] `reviewed` rows are immutable (mark/reject buttons disabled or hidden — admin un-review optional).
- [ ] LH sees rows but cannot mark/reject (action buttons hidden or disabled with explanatory tooltip).
- [ ] All admin client components live in `src/components/admin/`; [doc 26 §A.1 grep](26-phase-d-testing-checklist.md) clean.
- [ ] Vitest + Playwright tests pass per [doc 28 §C.7](28-d2-d3-d4-evidence-qa-checklist.md).
- [ ] DemoModeBanner is **OFF** on `/v2/jobs/[jobId]/evidence`.
- [ ] No `vercel.json` change.
- [ ] Phase B / C / D1 / D2 / D3 regression passes (per [doc 28 §D](28-d2-d3-d4-evidence-qa-checklist.md)).
- [ ] Cross-surface verification: tradie captures → row appears in admin queue within 5s of refresh.
- [ ] Mark reviewed → tradie's `Today's captures` shows `reviewed` pill on next page open.
- [ ] Reject with reason → tradie sees the reason inline.

---

## 12 · Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| D4-1 | Bulk mark reviewed N rows; one fails mid-flight; UI inconsistency | Per-row independent POSTs; failed row stays `submitted` with inline error; successful rows flip; PR documents non-atomic behaviour. |
| D4-2 | Reject reason copy-pasted across many items via bulk → audit pollution | Bulk reject is **not** in scope. Reason is per-item. |
| D4-3 | Admin double-clicks Mark reviewed | Button disabled during in-flight POST; server enforces single transition (`submitted → reviewed`; second POST returns 400 because state is no longer `submitted`). |
| D4-4 | Drawer history is empty because audit-log query endpoint hasn't shipped | Render UNDER CONSTRUCTION panel inside the drawer's History section. Don't block D4 ship. |
| D4-5 | LH accidentally hits the review POST via dev tools | Server enforces (admin-only). Client hides buttons; server is the authority. |
| D4-6 | Filter performance on a job with > 1000 evidence rows | Phase D's expected ceiling is ≪ 1000 per job (a normal site captures dozens per stage). If exceeded, paginate server-side — D5 polish. |
| D4-7 | LH access expanded later breaks the page's role gating | Page-level `canAccessSurface` check; action buttons check role explicitly. Test with admin + LH + tradie + client. |
| D4-8 | Photo blob URL expires mid-drawer | Vercel Blob public URLs don't expire by default. If a future change adds expiry, surface a "Reload" affordance. Not D4 concern. |
| D4-9 | RSC manifest regression — `EvidenceDrawer.tsx` co-located under route | [Doc 26 §A.1 grep](26-phase-d-testing-checklist.md) enforces. Pre-merge gate. |
| D4-10 | "Today's captures" pill on Phil shows stale status (no live update) | Phil revalidates on page focus / interval; D3 spec already calls this out. D4 doesn't push to Phil. |
| D4-11 | Admin un-review is a destructive operation | If implemented, requires a confirmation modal with reason ("Why are you un-reviewing?"). If too messy, defer to D5. |

---

## 13 · Build prompt — paste into Session 7

```
You are Claude Code working as the Phase D · D4 build session for BuhlOS / Phil.

This session builds the admin evidence review surface on top of D2's
persistence API and alongside D3's Phil capture (which must both be
merged on main before this session opens).

Read first (in order):
  docs/rebuild-audit/27-interface-usability-pass.md   ← UI binding rules
  docs/rebuild-audit/30-phase-d4-admin-evidence-review-spec.md ← this spec
  docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §C   ← QA gate
  docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5.5 + §9.5 + §9.6
  docs/rebuild-audit/26-phase-d-testing-checklist.md §A.1 + §B.4
  src/domains/evidence/*                              ← D2 domain
  src/app/api/jobs/[jobId]/evidence/*                 ← D2 persistence + review
                                                         routes (path may differ —
                                                         confirm from D2/D3 merged PRs)
  src/components/admin/HoursApprovalsQueue.tsx        ← admin surface precedent
                                                         (or equivalent if renamed)
  src/middleware.ts

Branch:    phase-d-d4-admin-evidence-review (from latest origin/main, AFTER D2 + D3 merge)
PR title:  Phase D4 · admin evidence review surface

============================================================
SCOPE
============================================================

You MAY add (this PR only):

  src/components/admin/EvidenceQueue.tsx
  src/components/admin/EvidenceDrawer.tsx
  src/components/admin/EvidenceRejectModal.tsx
  src/components/admin/EvidenceFilterBar.tsx
  src/components/admin/EvidenceQueue.test.tsx
  src/components/admin/EvidenceDrawer.test.tsx
  src/components/admin/EvidenceRejectModal.test.tsx
  src/app/v2/jobs/[jobId]/evidence/page.tsx
  (optional) src/app/v2/jobs/[jobId]/evidence/[evidenceId]/page.tsx
  tests/phase-d-d4-admin-review.spec.ts

You MAY edit (minimally):

  src/middleware.ts
    - add /v2/jobs to PROTECTED + matcher.
    - surface: admin (default). LH access via in-page role check.

  src/app/command-centre/page.tsx
    - ONLY if a useful click-through target exists. Card is optional
      in D4 — see spec §6.6. If linking to a specific job's queue is
      not yet meaningful, skip the card and document.

You MUST NOT:

  - add api/*.js changes                  (D2 owns the API)
  - add src/domains/evidence/* changes    (D2 owns the domain)
  - add src/app/api/* changes             (D2 owns persistence)
  - add src/components/phil/* changes     (D3 owns Phil capture)
  - mount /jobs or /jobs/[jobId]          (admin-Jobs-cutover is its own slice)
  - touch vercel.json
  - touch public/*.html
  - merge this PR yourself
  - perform any route cutover

Hard rules (binding):

  - All admin client components live in src/components/admin/.
  - All marker strings + tones come from doc 27 §6.2 dictionary.
  - DemoModeBanner OFF on /v2/jobs/[jobId]/evidence — data is real.
  - Bulk reject is NOT shipped. Reasons are per-item.
  - LH read-only (admin un-review optional; default skip).
  - No three-dot menus where the primary action exists.
  - No alert() / confirm() / prompt() anywhere.

Before writing code:
  - re-read src/components/admin/HoursApprovalsQueue.tsx (or the post-PR-#6
    equivalent) — that's the admin surface precedent: server component
    renders shell + permission gate + initial fetch; client component
    handles interactivity.
  - re-read doc 26 §A.1 grep — pre-flight your file layout.
  - re-confirm D2's review endpoint shape (body + response).
  - re-confirm D2's evidence list endpoint shape.
  - confirm whether audit-log read endpoint exists; if not, render the
    drawer's History section as UNDER CONSTRUCTION (don't block D4).

Checks before opening the PR:
  npm run typecheck
  npm run lint
  npm run test
  npm run build
  npm run check:admin-shell
  npm run check:sw-cache-version
  npm run check:production-shell
  npm run smoke:admin-routes
  npm run test:e2e
  git diff --stat              (only src/components/admin/*, new
                                src/app/v2/jobs/[jobId]/evidence/*,
                                src/middleware.ts edit,
                                src/app/command-centre/page.tsx edit (if any);
                                NO api/, NO src/domains/, NO src/components/phil/,
                                NO vercel.json, NO public/)

Doc 28 §C QA checklist must be pasted into the PR body and ticked.

Authenticated preview smoke (run before requesting review):
  - Log in as admin.
  - Open /v2/jobs/birdwood-iv3232/evidence (preview URL).
  - Confirm queue lists captures from D3.
  - Mark one reviewed → row flips → audit-log row appears.
  - Reject one with reason → row flips → reason visible.
  - Bulk-select two → "Mark 2 reviewed" → both flip.
  - Log out / log in as Phil tradie → /phil/jobs/birdwood-iv3232 →
    Today's captures shows updated statuses.
  - Log in as LH → /v2/jobs/[jobId]/evidence loads read-only (no
    action buttons or disabled with tooltip).

PR body must include:
  - doc 28 §C checklist (ticked)
  - explicit confirmation no Phil files changed
  - explicit confirmation no api/ files changed
  - explicit "DemoModeBanner OFF" note for evidence
  - explicit route decision: surface mounted at /v2/jobs/[jobId]/evidence
    (no /admin/jobs cutover)
  - non-atomic bulk behaviour documented

Final report: as previous Dx sessions, plus the LH read-only verification.
```

---

## 14 · Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — binding scope, data model, state machine.
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + §6.2 markers + §9.6 critique of admin evidence review.
- [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) — D4 QA gate (§C).
- [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) — Phil counterpart; D3 + D4 close the loop.

---

## Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/30-phase-d4-admin-evidence-review-spec.md` |
| Author | Session 4 (non-interference QA / UX planning agent) |
| Branch | `session-4-qa-ux-planning` |
| Status | **Docs-only. Planning artefact.** No app code implied. |
| Phase precondition | D1 shipped (PR #11). D2 + D3 must be merged before D4 starts. |
| Next action | After D3 ships, Session 7 pastes the §13 build prompt and follows. |
