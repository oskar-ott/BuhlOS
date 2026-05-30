# Material Requests — field-to-office procurement (PR 11)

> Status: **v1 live.** Direct admin create (POST), state-machine PATCH, and the
> observation-side conversion entry point (POST
> `?action=convert-to-material-request` on `/api/observations`) all ship in
> PR 11. The cross-job inbox at `/material-requests` is admin-only; the
> per-job view at `/v2/jobs/[jobId]/material-requests` is read-only for
> field/LH on assigned jobs and full-action for admin.

## 1. What a Material Request is

A **Material Request** is a tracked procurement record raised against a job —
"we need 20m of 25mm conduit on 100 Arthur by Friday". It owns its own
lifecycle from raised-by-the-field to delivered-on-site, with the office
sitting in the middle to approve / order / receive.

The natural entry point is a worker in **Phil** raising a "Need material"
**Observation**. The office then **converts** that observation to a real
Material Request (PR 11 conversion endpoint); from that moment the procurement
record carries its own status, audit trail and inbox row, while the original
observation flips to `status='converted'` with `linkedMaterialRequestId` and a
back-link to the procurement view.

The office can also create one **directly** from BuhlOS (admin-only `POST
/api/material-requests?jobId=…`) — useful when the office spots a need before
the field does.

### Relationship to the legacy `/admin/materials` surface

The legacy admin module **`/admin/materials`** (still served by the legacy
Vercel functions) owns the structured procurement flow: takeoff lists,
purchase orders, supplier invoices, invoice-match. That stays where it is —
PR 11 deliberately doesn't touch it.

The new Material Requests module owns a **different** loop: the
**field-to-office request** (worker says "we need X", office tracks it
through approved → ordered → delivered). The two modules don't overlap and
neither replaces the other. A later phase may merge them once both are
mature; v1 keeps them separate so the new loop can ship without destabilising
existing procurement.

The inbox copy and the SectionNav row both name this distinction
("Material requests" vs "Materials (legacy takeoff)") so the office never
confuses one for the other.

## 2. Data model

Persisted in a **new top-level blob `material-requests.json`**:
`{ requests: [MaterialRequestItem, …] }`.

Same shape decision as `observations.json` and `employees.json`: the inbox
is cross-job by design, so a single-document read is the right shape and a
brand-new blob can't corrupt existing job / evidence / snag / observation
data. Whole-document read-modify-write race is bounded at SME-procurement
volume; per-record split is Phase F+.

Schema + types: `src/domains/material-requests/{schema,types}.ts`.

- **Required:** `id` (`mr_…`), `jobId`, `jobName` (denormalised), `item`,
  `quantity`, `unit`, `status`, `urgency`, `source`, `requestedById`,
  `requestedByName`, `requestedAt`, `auditLogIds[]`, `createdAt`, `updatedAt`.
- **Optional / lifecycle stamps:** `description`, `stage`, `areaId`/`areaName`,
  `taskId`/`taskName`, `linkedObservationId`, `linkedEvidenceId`,
  `approvedAt`/`By*`, `orderedAt`/`By*` + `supplier` + `supplierNote` +
  `orderRef`, `deliveredAt`/`By*` + `deliveryNote`, `cancelledAt`/`By*` +
  `cancelReason`.

| Enum | Values |
| --- | --- |
| `status` | `requested` · `approved` · `ordered` · `delivered` · `cancelled` |
| `urgency` | `low` · `normal` · `high` · `urgent` |
| `source` | `observation` · `buhlos` · `system` |

**`requestedAt`** is the canonical "when was it raised" timestamp (used by
the inbox sort + Command Centre oldest-age label). Lifecycle stamps
(`approvedAt`, `orderedAt`, `deliveredAt`, `cancelledAt`) land as the
matching state transition occurs.

## 3. State machine

Server-owned (mirrored client-side for the UI). Source of truth:
`api/material-requests.js#canTransition` and
`src/domains/material-requests/service.ts#canTransition` (covered by the
parity test in `material-requests.test.ts`).

```
null → requested
requested → approved | ordered | cancelled
approved → ordered | cancelled | requested      (last is "back to triage")
ordered → delivered | cancelled
delivered → ordered                              (e.g. partial delivery — re-order)
```

- Any open status can transition to `cancelled` (with required `cancelReason`).
- `delivered` is terminal except for the `delivered → ordered` shortcut for
  partial deliveries (admin acknowledges the loop reopens).
- Anything else (e.g. `requested → delivered`) returns **409** from the
  PATCH endpoint.

## 4. API — `api/material-requests.js`

| Method | Route | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/material-requests` | admin-tier | cross-job inbox + filters (`jobId`, `status`, `urgency`) |
| GET | `/api/material-requests?jobId=X` | field/LH assigned + admin (non-client) | one job's requests, newest-first |
| POST | `/api/material-requests?jobId=X` | admin-tier | direct create (source='buhlos') |
| PATCH | `/api/material-requests` (id in body) | admin-tier | status transition + supplier/orderRef/notes |

POST/PATCH validation: `item` required (≤200 chars), `quantity` positive
finite, `unit` required (≤24 chars), `supplier` ≤120, `orderRef` ≤60,
`cancelReason` required when transitioning to `cancelled`. Unknown jobs →
404. Bad status / urgency → 400. Illegal transition → 409.

Permissions use the shared tier helpers (`canWrite`, `isAdminRole`) from
`api/_lib/auth.js`. The cross-job inbox is gated **admin-tier** to match
`canAccessSurface('admin')` exactly.

## 5. Observation → Material Request conversion

The natural worker action is to raise a "Need material" observation in Phil
(`type='material_request'`). The office converts it to a tracked Material
Request from the Observations inbox drawer (Convert section), supplying the
structured `item / quantity / unit / urgency` (and optionally
`description / supplier / orderRef`) at convert time.

Handler: `api/observations.js#convertObservationToMaterialRequest`.
Endpoint: `POST /api/observations?action=convert-to-material-request`.

Write order is **material-request-first → observation-second** (mirrors
PR 6 snag conversion). The material request is persisted via
`api/material-requests.js#persistItem` (re-used to keep shape parity with
the direct-POST path); the audit-log emits two entries —
`material_request.created` (so the procurement timeline reads the same
whether the request was conversion-born or direct-created) and
`observation.converted_to_material_request` (attributing the office
decision on the observation side). If the observation write fails after
the request lands, the response is `502` with `materialRequestId` —
the orphan request exists and can be relinked.

Idempotency: a second convert on the same observation returns **409** —
the observation already has `linkedMaterialRequestId` or `convertedTo`. An
observation already converted to a Snag is also rejected with 409
(no double-downstream).

Default eligibility: `type='material_request'` auto-promotes; other types
require `{ "force": true }`. The inbox surfaces both cases — a primary CTA
for eligible types, a secondary "Force-convert" CTA otherwise.

## 6. BuhlOS surfaces

- **Cross-job inbox** — `/material-requests`
  (`src/app/(admin)/material-requests/page.tsx` +
  `src/components/admin/MaterialRequestsInbox.tsx`).
  Exception-first triage: summary cards (to approve/order, on order,
  delivered, urgent open), filters (status / urgency / job), detail drawer
  with procurement actions (Approve, Mark ordered with supplier + PO,
  Mark delivered with note, Urgency picker, Cancel with required reason).
  Admin-tier only at the middleware gate.

- **Per-job view** — `/v2/jobs/[jobId]/material-requests`
  (`src/app/v2/jobs/[jobId]/material-requests/page.tsx`). Reuses the same
  inbox component with `actionsEnabled={isAdminRole(role)}` and
  `showJobFilter={false}`. Field/LH on assigned jobs see read-only details;
  admin sees the same actions as the cross-job inbox. Linked from the job
  hub via `JobInterfaceSectionNav` (LIVE row, separate from the legacy
  "Materials (legacy takeoff)" UC row).

- **Command Centre card** — `/command-centre` "Material requests" queue
  card. Count = open requests (status in `requested` / `approved` —
  the procurement queue actually waiting on the office). Click target =
  `/material-requests`. Errors land in the existing "Couldn't load every
  queue" banner.

- **Observations inbox drawer** — the Convert section that lands the
  conversion endpoint. See §5.

## 7. Audit verbs

Two new verbs + one new target type in
`src/domains/audit-log/{schema,format}.ts` and
`api/_lib/audit-log.js#VALID_ACTIONS` / `VALID_TARGET_TYPES`:

- `material_request.created` — emitted on direct POST AND on observation
  conversion (with `convertedFromObservationId` in metadata for the latter).
- `material_request.transitioned` — emitted on PATCH when a
  user-meaningful field changed (`status`, `urgency`, `supplier`,
  `orderRef`). Free-text `supplierNote` / `deliveryNote` edits piggy-back
  as metadata on the next status flip and don't emit their own row.
- `observation.converted_to_material_request` — emitted on the observation
  side of the conversion (mirrors `observation.converted_to_snag`).

Target type `material_request` is accepted by `GET /api/audit-log` (the
per-job activity feed at `/v2/jobs/[jobId]/history` filters on it).

## 8. Not built yet (honest backlog)

- Bridge to the legacy `/admin/materials` takeoff/PO/invoice module —
  v1 keeps them separate (see §1).
- Supplier suggestions / autocomplete on the "Mark ordered" form (the
  inbox uses a free-text input).
- Delivery photos / receipts attached to the delivered transition.
- Email-the-supplier on ordered (today's `orderRef` is operator-typed; a
  later phase wires it to an actual PO send).
- Aggregated "what's outstanding by supplier" report — sits with the
  reports phase.
