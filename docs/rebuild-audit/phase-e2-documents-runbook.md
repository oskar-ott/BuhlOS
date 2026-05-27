# Phase E2 · Documents / Specs read-only runbook

> **Status:** built. Read-only viewer for plans + specs. No uploads, no
> AI takeoff, no curation — those keep happening on the legacy
> `/admin/plans` SPA.
> **Read alongside:** [36-documents-specs-readiness-note.md](36-documents-specs-readiness-note.md), [phase-e1-itp-runbook.md](phase-e1-itp-runbook.md), [27-interface-usability-pass.md](27-interface-usability-pass.md).
>
> Sibling of the other phase-*-runbook.md files.

---

## 1 · What E2 ships

E2 is the first **read-only** loop in the rebuild — workers need to
see drawings and specs without round-tripping their PM, but the
operational write surface (upload + revision curation + AI takeoff)
keeps living on the legacy SPA.

| Surface | Change |
| --- | --- |
| `src/domains/documents/{schema,types,client,format,documents.test}.ts` | New domain. Zod schemas, status + category enums, label / tone / size / mime helpers, drawing-lineage grouper, typed fetch client. |
| `src/domains/documents/documents.test.ts` | 39 tests covering schema, format helpers, sort + group, client. |
| `api/jobs.js` | Adds `statsDocumentsCurrent` to the `?withStats=1` enrichment loop (counts `status === 'current'` plus legacy rows without a status field). One extra blob read per job, same fan-out as `statsItpsActive`. |
| `src/domains/jobs/schema.ts` | `statsDocumentsCurrent: z.number().optional()` on `JobSchema`. |
| `src/components/phil/JobDocumentsPanel.tsx` | Replaces the PR #37 UC stub with a live, current-only list. "Open" button on each row → `_blank` on the Vercel Blob URL. |
| `src/app/phil/jobs/[jobId]/page.tsx` | Parallel fetch of `/api/plans?jobId=<id>` alongside evidence / snags / ITPs. Passes `initialDocuments` + `documentsError` into `PhilJobDetail`. |
| `src/components/phil/PhilJobDetail.tsx` | Threads documents through to the panel; flips its comment block to note Documents is live. |
| `src/app/v2/jobs/[jobId]/documents/page.tsx` | New admin route. Same shape as the D4 evidence / D.5 snags / E1c ITPs pages — server component, auth gate, parallel fetch. |
| `src/components/admin/DocumentsList.tsx` | Admin list component. Filter tabs (Current · All), `Card` shell, drawing-group rows with "Show previous revisions" expander, `_blank` Open button. |
| `src/components/admin/JobInterfaceSectionNav.tsx` | Flips the "Documents & specs" UC row to a live row driven by `statsDocumentsCurrent`. |
| `scripts/smoke-evidence-routes.js` | Adds the `/v2/jobs/.../documents` 307 gate and the `/api/plans` 401 gate. |

**Tests added:** 39 new (documents domain). Full vitest **524 / 524**.

**No vercel.json change.** No new write path. No new audit verb. No
legacy file deleted.

---

## 2 · Architecture overview

```
                            ┌─────────────────────────────────────┐
                            │ src/domains/documents/             │
                            │   schema.ts   Zod wire shapes      │
                            │   types.ts    inferred TS types    │
                            │   format.ts   labels + tones +     │
                            │               drawing-group helper │
                            │   client.ts   typed listDocuments  │
                            │   documents.test.ts 39 tests       │
                            └────────────────┬───────────────────┘
                                             │
                                             │ shared types + helpers
                                             │
   ┌──────────────────────────┐               │      ┌────────────────────────────┐
   │ Phil                     │               │      │ Admin                      │
   │ /phil/jobs/[jobId]       │               │      │ /v2/jobs/[jobId]/documents │
   │   ↓ JobDocumentsPanel    │               │      │   ↓ DocumentsList          │
   │                          │               │      │ (filter tabs + drawing-    │
   │ Current revisions only.  │               │      │  group rows + revision     │
   │ "Open" → _blank.         │               │      │  lineage expander)         │
   │ No drawer, no actions.   │               │      │ "Open" → _blank.           │
   └────────────┬─────────────┘               │      └──────────────┬─────────────┘
                │                             │                     │
                │  HTTPS                      │                     │  HTTPS
                ▼                             ▼                     ▼
                            ┌──────────────────────────────────┐
                            │ api/plans.js GET handler         │
                            │   GET /api/plans?jobId=X         │
                            │   permissions: admin OR LH on    │
                            │     assigned job OR field user   │
                            │     on assigned job              │
                            │   server strips status='archived'│
                            │     for non-admin callers        │
                            └──────────────┬───────────────────┘
                                           │
                                           │ reads
                                           ▼
                            ┌──────────────────────────────────┐
                            │ jobs/<jobId>/plans-index.json    │
                            │   { plans: PlanRecord[] }        │
                            └──────────────────────────────────┘
                                           │
                                           │ withStats=1 enrichment
                                           ▼
                            ┌──────────────────────────────────┐
                            │ api/jobs.js?withStats=1          │
                            │   adds statsDocumentsCurrent     │
                            └──────────────────────────────────┘
```

E2 is **pure read** at every layer. No POST, no DELETE, no PATCH
client method exists. The legacy `api/plans.js` mutating verbs
remain only callable from the legacy SPA.

---

## 3 · Storage shape (read-only consumer)

Per-job blob `jobs/<jobId>/plans-index.json` (unchanged from legacy):

```jsonc
{
  "plans": [
    {
      "id": "pl_<timestamp>-<rand>",
      "jobId": "birdwood-iv3232",
      "fileName": "E-200_rev_b.pdf",
      "blobPath": "jobs/birdwood-iv3232/plans/pl_x.pdf",
      "url": "https://...public.blob.vercel-storage.com/...",
      "mimeType": "application/pdf",
      "sizeBytes": 1234567,

      "drawingNumber": "E-200",
      "revision": "B",
      "title": "Switchboard schedule",
      "level": "Level 1",
      "category": "plan",

      "status": "current",        // | "superseded" | "archived"
      "notes": "...",

      "supersedes": "pl_xxx",     // previous revision's planId
      "supersededBy": "",         // next revision's planId

      "uploadedAt": "2026-05-01T08:00:00.000Z",
      "uploadedBy": "anna",
      "uploadedByUserId": "user-admin-1"
      // Phase 9 AI-takeoff fields flow through .passthrough().
    }
  ]
}
```

`status` is best-effort: legacy rows from before the status enum
existed default to `'current'` on the writer side. The viewer mirrors
that — `isCurrent({})` is `true`.

Category is **free text on disk** but the viewer collapses to the
six known buckets via `normaliseCategory` / `categoryLabel`:
`plan | spec | schedule | photo | certificate | other`.

---

## 4 · API contract (consumed only)

### `GET /api/plans?jobId=<id>`

| Status | When |
| --- | --- |
| 200 | `{ plans: PlanRecord[] }` — server strips `status === 'archived'` for non-admin callers |
| 400 | `jobId` missing |
| 401 | unauthenticated |
| 403 | role `client`, OR non-admin not assigned + can't manage |
| 500 | storage read failed |

Admins MAY pass `?includeArchived=1` to receive every row including
archived. The admin queue route passes this flag so the "All" filter
chip can surface the full set without a second round trip.

### What E2 does NOT call

Every other verb on `api/plans.js` stays admin-only via the legacy
SPA:

- `POST /api/plans` (upload)
- `PATCH /api/plans?id=Y` (metadata edit)
- `DELETE /api/plans?id=Y` (soft-archive)
- `POST /api/plans?action=set-pages`
- `POST /api/plans?action=analyse-legend`
- `POST /api/plans?action=analyse-sheet`
- `POST /api/plans?action=set-dwelling-materials`
- `POST /api/plans?action=mark-reviewed`
- `POST /api/plans?action=dismiss-dwelling`

---

## 5 · Permissions matrix

| Caller | Phil panel data | Admin queue | Open file |
| --- | --- | --- | --- |
| anonymous | redirected to /v2/login | redirected to /v2/login | n/a |
| client | 403 (admin/phil surfaces unreachable) | 403 | n/a |
| tradie / apprentice / labourer / electrician (assigned) | current revisions only (server + client filter) | route gated to LH+ | direct Blob URL, opens in new tab |
| tradie (not assigned) | server 403 → empty list + no banner | 403 | n/a |
| LH (assigned) | current revisions only | full list including archived (via `?includeArchived=1`) | same |
| admin / boss / owner / manager / office / pm / estimator | current revisions only | full list including archived | same |

Workers see only **current** revisions on Phil. The motivation is
field safety: a worker who sees a superseded card alongside the
current one can install per the old spec. The rebuild treats "show
the current revision and nothing else" as a hard Phil rule. Admin can
review the full lineage on `/v2/jobs/[jobId]/documents`.

---

## 6 · Phil UX

Worker journey from `/phil/jobs/[jobId]`:

1. **See it.** The Documents & specs panel sits below the ITP panel
   (same render order as before — header → site → stage → areas →
   capture → strip → Snags → ITPs → **Documents** → Materials →
   History). Header shows current count as a neutral pill.
2. **Read it.** Each row shows the title (admin-entered, with sensible
   fallbacks), the drawing context line ("E-200 · Rev B · Level 1"),
   a category pill, MIME label, and a chevron-style icon to make
   tap-to-open obvious.
3. **Open it.** Tapping the row opens the Blob URL in a new tab via
   `target="_blank" rel="noopener noreferrer"`. The original Phil
   context (job page) stays in the worker's tab history.
4. **No editing.** No upload button, no markup, no preview. Workers
   never see superseded or archived rows.
5. **Empty + error states.** Empty: "No documents on this job yet."
   If the fetch failed (network blip): an amber info bar tells the
   worker to refresh; the panel still renders the empty list.

---

## 7 · Admin UX

Admin journey from `/v2/jobs/[jobId]/documents`:

1. **Header.** Job name + "Read-only" pill so admins see at a glance
   the page is a viewer, not the curation surface. Help text points
   at `/admin/plans` for uploads + curation.
2. **Filter tabs.** Default `Current (N)` — the same set Phil sees.
   `All (N)` exposes superseded + archived behind a single click;
   the tab shows "X superseded · Y archived" on hover so the admin
   knows what they're opening up.
3. **Drawing groups.** Within each drawing number, the current
   revision lands at the top. "Show N previous revisions" is a
   small expander that reveals older revisions beneath, indented and
   slightly muted so the active row stays visually loudest.
4. **Per-row info.** Status pill (success / info / neutral), category
   pill, MIME label, size, uploadedBy, optional notes line. "Open"
   button opens the file in a new tab.
5. **No actions.** No edit, no archive, no re-revise. Curation stays
   on the legacy SPA.

Admin section nav on `/v2/jobs/[jobId]` now shows the Documents row
as live with a `statsDocumentsCurrent` chip — the row drops the UC
pill and links into the queue page.

---

## 8 · Known limitations (post-E2)

| ID | Limitation |
| --- | --- |
| E2-L1 | No in-app preview. PDFs + images open in a new tab. A PDF.js / image-modal preview is a later slice. |
| E2-L2 | No markup / annotation. Snags must still cite a drawing manually. |
| E2-L3 | No bookmarking / pin per worker. The whole list is rendered each visit. |
| E2-L4 | Category remains free text on disk. New values land in the "Other" bucket on the viewer. A schema-tight migration is a separate PR. |
| E2-L5 | Workers see all current revisions on a job; there is no per-area / per-stage scoping. A "drawings for this area" filter is a later slice if PMs ask. |
| E2-L6 | Quote documents (`api/quote-documents.js`) are NOT surfaced here. Folding them in is a later slice once the plans-only viewer is validated in the field. |
| E2-L7 | The `statsDocumentsCurrent` chip is computed from a separate per-job blob — when an admin uploads on the legacy SPA, the chip lags by a few seconds while Vercel propagates the read-through cache. Same shape as `statsItpsActive`. |

---

## 9 · Field test script (manual, with credentials)

Run on the preview before promoting. ~6 minutes.

**Pre-req:** the legacy `/admin/plans` surface has at least one
current plan + one superseded plan + one archived plan on
`birdwood-iv3232`. If not, upload a quick TEST E2 PDF via legacy and
revise it once.

**Tradie:**
1. Log in as a tradie assigned to `birdwood-iv3232`.
2. Open `/phil/jobs/birdwood-iv3232`. Scroll past Snags + ITPs to
   confirm the new **Documents & specs** card renders below ITPs.
3. Confirm only current revisions appear (no superseded, no
   archived).
4. Tap a row → file opens in a new tab; Phil tab stays put.
5. Refresh the page → list persists.

**LH:**
6. Log in as a LH assigned to the job.
7. Open `/v2/jobs/birdwood-iv3232/documents`. Confirm the queue
   renders the current revision and a "Show N previous revisions"
   expander on drawings with revisions.
8. Confirm the **All** tab is present and shows superseded rows when
   clicked. Archived rows remain hidden (LH is non-admin).

**Admin:**
9. Log in as admin. Open the same admin queue.
10. Confirm both **Current** and **All** tabs work; **All** shows
    superseded + archived.
11. Confirm `/v2/jobs/[jobId]` section nav shows Documents as live
    with the chip count matching the Current tab.
12. Confirm `/v2/jobs` admin index still serves; nothing on that
    page should break — `statsDocumentsCurrent` is additive.

**Regression — every existing loop still works:**
13. Tradie raises a TEST E2 snag on the same job.
14. Tradie captures a TEST E2 note evidence.
15. Admin signs off an existing TEST E2 ITP (if one was set up
    during E1 testing).
16. Confirm all four loops (evidence / snags / ITP / documents) still
    render their respective sections side-by-side without overlap.

**Cleanup:**
- No new test data is created by E2 itself (read-only). Any TEST E2
  plans uploaded via legacy can be soft-archived from `/admin/plans`.

---

## 10 · Production smoke

### Unauthenticated route + API gate

```
npm run smoke:evidence-routes                 # buhlos.com (default)
npm run smoke:evidence-routes -- <preview>    # any vercel preview
```

Covers `/v2/jobs/.../documents` 307 gate and `/api/plans` 401-JSON
gate. **Run this after every E2 merge.**

If a check fails:
- `404 text/html` on `/api/plans` → function is missing from the
  deployment.
- `200 text/html` on `/v2/jobs/.../documents` unauth → middleware
  regression; halt rollout.
- `401 application/json` on `/api/plans` → expected and correct.

### Authenticated end-to-end

There's no dedicated `scripts/auth-smoke-e2-documents.sh` because the
loop has no write path — every API verb the viewer touches is GET
+ auth. The existing `auth-smoke-d55-snags.sh` already exercises
auth/session via `/api/auth?action=login` and `/api/auth?action=me`;
running it as part of the regular ritual confirms E2's prerequisites
are healthy. A document-specific authenticated smoke can be added if
field testing surfaces a regression.

---

## 11 · Rollback considerations

E2 is **pure additive read-only** — no legacy file deleted, no
vercel.json change, no rewrites moved. To roll back:

| Slice | Rollback |
| --- | --- |
| Phil panel | Revert the `JobDocumentsPanel` change in the merge PR; the previous UC stub returns. Other Phil sections (evidence, snags, ITPs) unaffected. |
| Admin queue | Revert the `src/app/v2/jobs/[jobId]/documents/page.tsx` add and the `JobInterfaceSectionNav` row flip; the section row reverts to UC. |
| Stats chip | Revert the `statsDocumentsCurrent` block in `api/jobs.js`; the schema field becomes ignored (forwards-compat). |

No data fixup ever needed — E2 doesn't write.

---

## 12 · Next recommended PRs

Ordered by user-visible value-to-risk ratio:

1. **In-app PDF preview** — wrap the file URL in a PDF.js viewer
   modal so workers don't lose their place by jumping to a new tab.
   Mid-risk because PDF.js bundles are large.
2. **Quote-documents merge** — fold `api/quote-documents.js` into the
   same domain so admins see "every doc on this job" in one queue.
3. **Per-area drawing filter** — surface a "drawings for Level 1" or
   "for area Kitchen" filter on the Phil panel.
4. **Materials read-only viewer** — same shape as this slice against
   `api/job-areas.js` / `api/materials-list.js`. Doc 36's
   "alternative if (b)" path.
5. **Category enum tightening** — replace the free-text category with
   the closed-set enum on the writer side; one-time migration.

---

## 13 · Cross-references

- `api/plans.js` — endpoint (unchanged; consumed only).
- `api/quote-documents.js` — sibling endpoint, not surfaced in E2.
- `api/jobs.js` — `statsDocumentsCurrent` enrichment.
- `src/domains/documents/` — typed domain.
- `src/app/v2/jobs/[jobId]/documents/page.tsx` — admin route.
- `src/app/phil/jobs/[jobId]/page.tsx` — Phil parallel fetch.
- `src/components/admin/DocumentsList.tsx` — admin list component.
- `src/components/phil/JobDocumentsPanel.tsx` — Phil panel.
- `src/components/admin/JobInterfaceSectionNav.tsx` — UC→live flip.
- `scripts/smoke-evidence-routes.js` — production smoke (now covers
  documents too).
- [phase-e1-itp-runbook.md](phase-e1-itp-runbook.md) — pattern precedent.
- [36-documents-specs-readiness-note.md](36-documents-specs-readiness-note.md) — the spec this slice implements.
