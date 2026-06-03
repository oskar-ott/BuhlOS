# Plans Phase 2 — Drawing markup overlays

> Status: **foundation shipped** (`feature/plans-phase-2-overlay-foundation`).
> Builds on Phase 1 (read-only viewer, `src/domains/plans/coords.ts`). This is
> **not** AI interpretation, takeoff, measurement, or as-built export.

## 1. The one rule

**Original drawings are immutable.** Markups are a *separate overlay layer* —
they are never written into the PDF/image and never mutate the plan blob or
`plans-index.json`. Overlays live in their own store and reference the plan by id.

## 2. What this adds

- BuhlOS office/admin (and a leading hand on an assigned job) can add **pins,
  notes and lines** on top of a current plan page, label them, mark them
  **visible to Phil**, and archive them.
- Phil field workers see **only `visibleToPhil`, non-archived** overlays, **read
  only** — no create/edit/archive, no office-only markups, none on
  superseded/archived plans.

## 3. Data model — `DrawingMarkup`

`src/domains/plan-markups/schema.ts` (`DrawingMarkupSchema`):

| field | notes |
|---|---|
| `id` | `mk_…` server-assigned |
| `jobId`, `planId`, `pageIndex` | the anchor (see §4) |
| `type` | `pin` \| `note` \| `line` \| `area` |
| `x`, `y` | normalised 0..1 anchor for `pin`/`note` |
| `points[]` | normalised 0..1 — `line` = 2, `area` = 3..24 |
| `text`, `label` | capped 2000 / 120 chars |
| `tone` | `navy`\|`yellow`\|`red`\|`green`\|`grey` (fixed palette) |
| `visibleToPhil` | **default false (office-only)** — only `true` reaches the field |
| `archived` | soft-delete; hidden from everyone by default |
| `drawingNumber`, `revision` | denormalised display context (the anchor is `planId`) |
| `createdBy/At`, `updatedBy/At` | audit |

Coordinates are normalised 0..1 (origin top-left), identical to and rendered
through the **Phase 1** `src/domains/plans/coords.ts` (`normToPixel` /
`pixelToNorm`), so a mark stays attached through zoom / pan / rotate / raster
resolution.

## 4. Anchoring & revision safety

A markup attaches to `(jobId, planId, pageIndex)`. `planId` is the
documents-register row id — and **every plan revision is a separate row with its
own id** — so a markup is **inherently revision-specific** and can never bleed
onto a different revision. No separate `planRevisionId` is needed; the id *is*
the revision linkage.

## 5. Storage

`jobs/<jobId>/drawing-markups.json` → `{ markups: DrawingMarkup[] }`, via the
existing Blob helpers (`api/_lib/blob.js`). Separate file from
`plans-index.json`; the plan blob is never touched.

## 6. Permissions

Helpers mirrored in `src/lib/auth/permissions.ts` (TS) + `api/_lib/auth.js`
(CJS); management is additionally **job-scoped** by `canManageJob`.

| Role | View | Create/Edit/Archive/Toggle |
|---|---|---|
| admin tier (admin/boss/owner/manager/office/pm/estimator) | all non-archived | ✅ any job |
| leading hand | all non-archived **on assigned job** | ✅ assigned job |
| field (tradie/apprentice/labourer/electrician) | **`visibleToPhil` non-archived only**, current plans only | ❌ |
| client / unknown | ❌ denied | ❌ |

## 7. API — `/api/plan-markups` (`api/plan-markups.js`)

| method | purpose | gate |
|---|---|---|
| `GET ?jobId=&planId=[&page=]` | list (page optional → all pages) | manage → all non-archived; assigned field → `visibleToPhil` only, **[] on non-current plans** |
| `POST ?jobId=` | create pin/note/line/area | `canManageJob` |
| `PATCH ?jobId=&id=` | update text/label/tone/position/`visibleToPhil`/`archived` | `canManageJob` |
| `DELETE ?jobId=&id=` | soft-archive | `canManageJob` |

Validation (no broad body spreading): known `type`; coords strictly 0..1; line=2
points, area=3..24; text/label caps; `pageIndex` must be a registered page;
`planId` must exist; archived plans reject new overlays.

## 8. UI

- **BuhlOS** (`/v2/jobs/[jobId]/builder`'s plan route `/v2/jobs/[jobId]/plans`,
  `mode="admin"`): toolbar (Select / Add pin / Add note / Add line), overlay
  count + "visible to Phil" summary, save status, and a detail panel to edit
  label/note, toggle visibleToPhil, and archive. Office-only markers show a
  dashed ring at a glance.
- **Phil** (`/phil/jobs/[jobId]/plans`, `mode="phil"`): markers render read-only;
  tap to read the label/note. No toolbar, no edit controls.
- Rendering: `PlanOverlayLayer` is an absolutely-positioned **SVG** inside the
  Phase-1 stage box, sharing the page transform; `pointer-events-none` root so
  the page still pans, markers opt back in.

## 9. Intentionally deferred (not in this PR)

- **Drag-to-move** markers and **line-endpoint editing** (create + edit-text +
  archive is the supported edit loop; reposition = archive + re-add for now).
- **Area creation UI** (the model + renderer support `area`; there's no draw-area
  tool yet).
- AI interpretation, automatic takeoff, measurement, as-built export,
  Observations/Materials/Xero/QR/Reports — **out of scope by mandate.**

## 10. Future (Phase 3 possibilities — NOT built)

Measurement (the tested `src/domains/plans/scale.ts` is ready), drag editing,
area tool, linking a markup to a snag/observation, as-built export. None of
these are implemented or implied complete here.

## 11. Cross-references

- Coordinate math: `src/domains/plans/coords.ts` (+ `coords.test.ts`)
- Model/API: `src/domains/plan-markups/*`, `api/plan-markups.js`
- Viewer wiring: `src/components/plans/PlanViewer.tsx` (`renderOverlay` prop),
  `PlanOverlayController.tsx`, `PlanOverlayLayer.tsx`
- Route ownership: [`route-ownership.md`](route-ownership.md) (routes unchanged;
  shells unchanged — overlays render inside the existing viewer)
