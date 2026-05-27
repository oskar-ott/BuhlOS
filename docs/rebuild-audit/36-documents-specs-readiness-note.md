# 36 · Documents / Specs readiness note

> **Status:** docs-only, post-E1 hardening session. Decides what shape the
> next slice should take for the **Documents & Specs** section that today
> renders as a UC stub on Phil and a UC row on `/v2/jobs/[jobId]`.
>
> Authored: 2026-05-28. Verified against `origin/main` at `7629661`.

---

## TL;DR

- ✅ Real data exists, per-job, at `jobs/<jobId>/plans-index.json`.
- ✅ Safe read-only access already gates correctly via `GET /api/plans?jobId=X`
  (admin OR `canManageJob` OR `assignedJobIds` inclusion).
- ✅ The next slice can be a thin, read-only viewer mirroring the D1
  pattern (Phil panel + admin queue). No new write path, no AI-takeoff
  surfacing, no upload.
- 🟡 The plan record has revision lineage already (`supersedes` +
  `supersededBy`) — the viewer must filter `status === 'current'` by
  default or it'll dump multiple drafts of the same drawing.
- 🟡 The `category` field is free-text — early surfacing should treat
  it as a label, not a typed enum.

**Recommended next PR:** **Documents / Specs read-only viewer** — same
domain-then-UI shape as D1 evidence:
1. `src/domains/documents/` — Zod schemas mirroring `api/plans.js`'s
   GET-list response, with `.passthrough()` for AI-takeoff fields the
   viewer won't render.
2. `src/components/phil/JobDocumentsPanel.tsx` — replace the UC stub
   with a live list (current revisions only, "Open" button per row,
   no upload).
3. `src/app/v2/jobs/[jobId]/documents/page.tsx` + admin queue
   component — list view + drawer with full revision lineage.
4. No vercel.json change, no `/admin/plans` cutover, no AI-takeoff
   surfaced.

Risk is **low** — read-only against an endpoint that's been in
production for over a year. The AI-takeoff path keeps living behind
`/admin/plans` until later.

---

## 1 · Where the real data lives

| Storage | Shape | Writer |
| --- | --- | --- |
| `jobs/<jobId>/plans-index.json` | `{ plans: PlanRecord[] }` | `api/plans.js` (POST upload, PATCH metadata, DELETE soft-archive) |
| `jobs/<jobId>/plans/<planId>.<ext>` | The plan PDF / PNG / JPG file | `api/plans.js` POST + Vercel Blob `put(...)` |
| `jobs/<jobId>/plans/<planId>.page-<n>.png` | Rendered page PNGs for AI takeoff | `api/plans.js?action=set-pages` |
| `jobs/<jobId>/ai-takeoff.json` | Legend + per-dwelling AI suggestions + spend | `api/plans.js?action=analyse-*` |
| `jobs/<jobId>/quote-documents/...` | Quote attachments (separate from plans) | `api/quote-documents.js` |

### PlanRecord shape (verbatim from `api/plans.js` POST handler)

```ts
{
  id: string;            // pl_<base36-time>-<random4>
  jobId: string;
  fileName: string;      // ≤200 chars
  blobPath: string;      // 'jobs/<id>/plans/<planId>.<ext>'
  url: string;           // Vercel Blob public URL
  mimeType: string;      // 'application/pdf' | 'image/png' | 'image/jpeg'
  sizeBytes: number;
  drawingNumber: string; // free text, optional
  revision: string;      // free text, optional
  title: string;
  level: string;
  category: string;      // free text — NOT an enum
  status: 'current' | 'superseded' | 'archived';
  notes: string;
  supersedes: string;    // planId of the previous revision, if any
  supersededBy: string;  // planId of the next revision, if any
  uploadedAt: string;    // ISO
  uploadedBy: string;    // username
  uploadedByUserId: string;
  // Phase 9 takeoff fields (`pages[]`, etc.) flow through .passthrough()
}
```

The shape is rich, but the read-only viewer only needs: `id`,
`fileName`, `url`, `mimeType`, `drawingNumber`, `revision`, `title`,
`level`, `category`, `status`, `notes`, `uploadedAt`, `uploadedBy`,
plus the revision-lineage pair.

---

## 2 · Read-only access — already safe

`GET /api/plans?jobId=<id>` permissions (from `api/plans.js`:494-512):

| Caller | Result |
| --- | --- |
| anonymous | 401 |
| client | 403 |
| tradie / apprentice / labourer / electrician (assigned to job) | 200 `{ plans: [...] }` |
| tradie (not assigned) | 403 |
| LH (assigned) | 200 |
| LH (not assigned) | 403 |
| admin / boss / owner / manager / office / pm / estimator | 200 |

Non-admin callers automatically get `plans.filter(p => p.status !== 'archived')`
— archived rows never leak to the field. Currently `superseded` rows
**are** returned to non-admin; the new viewer should default-filter
to `current` only and surface the full revision lineage behind an
admin-only "Show old revisions" toggle.

There is no Phil-specific permission gap to fix before building.

---

## 3 · What the next slice should NOT do

- **No upload from Phil.** Workers do not upload plans today and
  shouldn't in the read-only slice.
- **No AI-takeoff surfacing in the rebuild.** That tooling lives on
  the legacy `/admin/plans` SPA and is admin-only; lifting it is
  a separate, much larger slice (Vision API spend governance,
  takeoff review UI, cost cap UX).
- **No `/admin/plans` cutover.** The legacy SPA owns upload + revision
  curation + takeoff. The rebuild adds a parallel **read** surface
  while the legacy keeps its write authority.
- **No quote-documents merge.** `api/quote-documents.js` is a
  separate endpoint with its own shape. Folding it into a unified
  "documents" view is a later slice once the plans-only viewer is
  validated in the field.

---

## 4 · Sketch of the slice (deferred — not part of this session)

| Layer | File(s) | Notes |
| --- | --- | --- |
| Domain schemas | `src/domains/documents/schema.ts` + `types.ts` + `client.ts` + `format.ts` + `documents.test.ts` | Mirror `api/plans.js` GET response. `.passthrough()` for AI-takeoff fields. |
| Phil panel | `src/components/phil/JobDocumentsPanel.tsx` (replace UC stub) | Renders `status === 'current'` only. "Open" button → `target="_blank"` on `plan.url`. Group by `level` then by `drawingNumber`. |
| Phil job page | `src/app/phil/jobs/[jobId]/page.tsx` | Add a third parallel fetch alongside snags + ITPs. |
| Admin queue | `src/app/v2/jobs/[jobId]/documents/page.tsx` + `src/components/admin/DocumentsList.tsx` | Default current-only filter, "Show superseded / archived" toggle. Per-row → drawer with `supersedes` lineage. |
| Job interface chip | `src/components/admin/JobInterfaceSectionNav.tsx` | Flip the "Documents & specs" UC row to a live row with `statsDocumentsCurrent`. |
| Jobs-index chip | `api/jobs.js?withStats=1` | Add `statsDocumentsCurrent` to the enrichment loop (one blob read per job — same cost as `statsItpsActive`). |
| Smoke | `scripts/smoke-evidence-routes.js` | Add `GET /api/plans?jobId=...` and `/v2/jobs/.../documents` 401/307 gate checks. |
| Runbook | `docs/rebuild-audit/phase-e2-documents-runbook.md` | Mirror the E1 runbook shape — section 1 to 16. |

**Estimated size:** ~600 lines TS/TSX + ~250 lines tests +
~150 lines runbook. Roughly the same size as the D1 Phil read-only
slice (PR #11).

---

## 5 · Blockers

None.

The slice is gated on a real admin signal that workers want this
section now. The session that built E1 didn't surface any field
request specifically blocked on it. Suggested validation step before
opening the slice:

- Ask the founder which is more painful right now:
  (a) field workers not seeing plans in Phil, or
  (b) admins re-typing material counts from `/admin/plans`-takeoff
       into the rebuild.
- If (a), build this slice next.
- If (b), the next slice should instead bring takeoff results into
  `/v2/jobs/[jobId]/materials` — separate scope, separate plan doc.

---

## 6 · Cross-references

- `api/plans.js` — endpoint (unchanged for read-only slice).
- `api/quote-documents.js` — sibling endpoint; out of scope for this slice.
- `src/components/phil/JobDocumentsPanel.tsx` — current UC stub.
- `src/components/admin/JobInterfaceSectionNav.tsx` — current "Documents & specs" UC row.
- [phase-e1-itp-runbook.md](phase-e1-itp-runbook.md) §15 — recommended-next-PR list (this slice = #1).
- [35-current-product-state-audit.md](35-current-product-state-audit.md) §13 PR plan.
