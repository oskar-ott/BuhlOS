# Plans Phase 2/3 — Drawing markup overlays

> Status: **foundation shipped** + **Phase 3 annotation slice shipped** (#651:
> area tool, geometry edit, `arrow`/`text` shapes, manage panel).
> Builds on Phase 1 (read-only viewer, `src/domains/plans/coords.ts`). This is
> still **not** AI interpretation, takeoff, **measurement**, or as-built export —
> measurement is the linked follow-up to #651 (§9).

## 1. The one rule

**Original drawings are immutable.** Markups are a *separate overlay layer* —
they are never written into the PDF/image and never mutate the plan blob or
`plans-index.json`. Overlays live in their own store and reference the plan by id.

## 2. What this adds

- BuhlOS office/admin (and a leading hand on an assigned job) can add **pins,
  notes, lines, areas, arrows and text** on top of a current plan page, label
  them, **move/edit their geometry**, mark them **visible to Phil**, archive
  them, and bulk-manage them from a **manage panel**.
- Phil field workers see **only `visibleToPhil`, non-archived** overlays, **read
  only** — no create/edit/move/manage, **no drag handles**, no office-only
  markups, none on superseded/archived plans.

> The area tool, geometry editing, the `arrow` + `text` shapes, and the manage
> panel are the **Phase 3 annotation slice** (#651). **Measurement** (scale
> calibration / measurement variant / readouts) remains the follow-up — see §9.

## 3. Data model — `DrawingMarkup`

`src/domains/plan-markups/schema.ts` (`DrawingMarkupSchema`):

| field | notes |
|---|---|
| `id` | `mk_…` server-assigned |
| `jobId`, `planId`, `pageIndex` | the anchor (see §4) |
| `type` | `pin` \| `note` \| `line` \| `area` \| `arrow` \| `text` |
| `x`, `y` | normalised 0..1 anchor for `pin`/`note`/`text` |
| `points[]` | normalised 0..1 — `line`/`arrow` = 2, `area` = 3..24 |
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
| `POST ?jobId=` | create pin/note/line/area/arrow/text | `canManageJob` |
| `PATCH ?jobId=&id=` | update text/label/tone/**geometry** (`x,y` or `points`)/`visibleToPhil`/`archived`/`asBuilt` | `canManageJob` |
| `DELETE ?jobId=&id=` | soft-archive | `canManageJob` |

Validation (no broad body spreading): known `type`; coords strictly 0..1;
**line/arrow = 2 points**, area = 3..24, **pin/note/text = `{x,y}` anchor**;
text/label caps; `pageIndex` must be a registered page; `planId` must exist;
archived plans reject new overlays. The `MARKUP_TYPES` enum is kept in **lockstep**
between `src/domains/plan-markups/schema.ts` (TS/zod) and `api/plan-markups.js`
(CJS) — a test asserts the two arrays are equal.

**Geometry editing** reuses the existing PATCH: `{x,y}` re-positions the
`pin`/`note`/`text` anchor; `{points}` re-positions a `line`/`arrow` endpoint or
an `area` vertex (re-validated to the same per-type point rule). No new endpoint;
the original plan is never touched.

## 8. UI

- **BuhlOS** (`/v2/jobs/[jobId]/builder`'s plan route `/v2/jobs/[jobId]/plans`,
  `mode="admin"`): toolbar (Select / Add pin / Add note / Add line / **Add arrow
  / Add area / Add text** / **Move** / **Manage**), overlay count + "visible to
  Phil" summary, save status, and a detail panel to edit label/note, toggle
  visibleToPhil, designate as-built, and archive. Office-only markers show a
  dashed ring at a glance.
  - **Area** draws as a multi-tap loop (accumulate vertices, live preview, a
    "Finish area (N pts)" button; guarded 3..24). **Arrow** is a 2-tap like
    line, drawn with an SVG marker-end arrowhead. **Text** is a single tap then
    a label/note edit, rendered as an anchored callout.
  - **Move** (geometry edit) is admin-only: select a markup, then drag its
    handles — the anchor for `pin`/`note`/`text`, the endpoints for
    `line`/`arrow`, each vertex for `area`. Drag-end PATCHes `{x,y}` or
    `{points}`; the original plan is never mutated (overlay store only).
  - **Manage** opens `PlanMarkupManagePanel` — a projection over the page's
    active markups with per-row type icon + label + visibility pill, type +
    visibility filters, click-to-select, and **bulk** show/hide-to-Phil +
    archive over a checkbox selection (no new store; loops the per-record client).
- **Phil** (`/phil/jobs/[jobId]/plans`, `mode="phil"`): markers render read-only;
  tap to read the label/note. **No toolbar, no add/edit/move/manage controls, and
  no drag handles** — the controller withholds `editMode`/`onMovePoint` so the
  renderer never emits a handle in Phil mode (asserted by the Phil-negative SSR
  tests).
- Rendering: `PlanOverlayLayer` is an absolutely-positioned **SVG** inside the
  Phase-1 stage box, sharing the page transform; `pointer-events-none` root so
  the page still pans, markers opt back in.

## 9. Shipped vs deferred

**Shipped (Phase 3 annotation slice — #651):**

- **Arrow** + **text** shapes (schema/API enum lockstep; renderer branches).
- **Area creation UI** (multi-tap draw loop + finish guard).
- **Geometry editing** — drag-to-move anchors, line/arrow endpoints, area
  vertices (admin-only handles; PATCH `{x,y}`/`{points}`).
- **Manage panel** — list, filters, bulk visibility + archive.

**Deferred (the follow-up):**

- **Measurement** — scale calibration / a measurement variant / readouts. The
  tested `src/domains/plans/scale.ts` is ready; the measurement slice is filed
  as the linked follow-up to #651 and is **out of scope here**.
- AI interpretation, automatic takeoff, as-built **export**,
  Observations/Materials/Xero/QR/Reports — **out of scope by mandate.**

## 10. Cross-references

- Coordinate math: `src/domains/plans/coords.ts` (+ `coords.test.ts`)
- Model/API: `src/domains/plan-markups/*`, `api/plan-markups.js`
- Viewer wiring: `src/components/plans/PlanViewer.tsx` (`renderOverlay` prop),
  `PlanOverlayController.tsx`, `PlanOverlayLayer.tsx`, `PlanMarkupManagePanel.tsx`
- Route ownership: [`route-ownership.md`](route-ownership.md) (routes unchanged;
  shells unchanged — overlays render inside the existing viewer)
