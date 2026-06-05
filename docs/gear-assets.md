# Gear / Assets — field-readiness reference

Status: **hardened for controlled internal dogfood** (PR `fix/gear-assets-field-readiness`).

Gear / Assets tracks company-owned items — vehicles, keys, tools, accessories,
PPE — and **who currently holds each one**. It is deliberately *not* a QR
system, not inventory automation, not stock decrementing, not purchasing, not
Xero, and not a full maintenance workflow. Those are listed under
[Deferred](#deferred--not-built) and must not be implied as built.

- **BuhlOS** (admin/office) surface: `/gear` — the register. Assign, return,
  mark condition, see history.
- **Phil** (field) surface: `/phil/gear` — "My gear". The worker sees only the
  gear they personally hold and can return it / report check / damaged / missing.

---

## Source of truth

| Question | Answer |
| -------- | ------ |
| Where are assets stored? | Vercel Blob, **one file per asset** at `assets/<id>.json`, with an append-only transfer/condition log at `assets/<id>/history.json`. Written via `api/_lib/blob.js`. |
| How is the holder represented? | A single field on the asset record: **`currentHolderId`** (a `users.json` user id, or `null` = depot/storage). `assignedAt` / `expectedReturn` are companions. |
| How does Phil "My gear" decide what to show? | It calls `GET /api/assets`; the server filters to `currentHolderId === me` for field/LH callers. The page then keeps only held items client-side. |
| Do BuhlOS Gear and Phil My Gear read the same source? | **Yes.** Both read `GET /api/assets` → the same `assets/*.json` store. |
| Does holder assignment write the same field Phil reads? | **Yes.** `POST /api/assets?action=transfer` writes `currentHolderId`; Phil reads `currentHolderId`. The write path and read path agree — this is the property the audit specifically checked. |
| Are archived assets hidden? | Yes. `GET /api/assets` hides `archived` rows unless `?archived=1` is passed (admin register only). Derived status `retired` is shown honestly in both UIs. |
| Can disabled users be holders? | **No** (enforced on transfer + create-assign as of this PR). |
| Can clients / admins be holders? | **No.** Holders are field + leading-hand only (see [Roles](#role-model)). |
| Can field roles see all company assets? | **No.** Field/LH see only what they personally hold. Only admin-tier sees the whole register. |

There is **one** source of truth and the read/write paths use the same field.
No new asset store was created.

---

## Audit table (pre-implementation)

P1 = breaks real field usage; P2 = security/correctness; P3 = cosmetic. "Fixed
in this PR" rows changed; "OK" rows were verified correct and left untouched.

| # | Area | File / API / route | Current behaviour (before) | Source of truth | Problem | In this PR? |
|---|------|--------------------|----------------------------|-----------------|---------|-------------|
| 1 | Admin Gear route | `src/app/(admin)/gear/page.tsx` | Page guard `canAccessSurface(role,"admin")` = admin-tier; fetches `/api/assets?archived=1` + `listTradies`; holder filter `role!=='admin' && role!=='client'` (literal) | blob assets + `users.json` | Page opens for office/boss/PM but both fetches mis-serve them (empty register + empty picker); holder filter literal | **Yes** — normalised holder filter (real fix is in the two APIs) |
| 2 | Asset list API | `api/assets.js` GET (no id) | `visible = user.role==='admin' ? all : own-held`; top-level deny only `role==='client'` | blob assets | **P1** literal `admin` → office/boss/PM/owner/manager/estimator see only own-held (empty); unknown roles not denied | **Yes** |
| 3 | Asset single GET | `api/assets.js` GET `?id=` | `isAdminRole` see-all + holder check | blob assets | OK (already normalised) | normalise wording only |
| 4 | Asset create (+assign) | `api/assets.js` POST | `isAdminRole` gate ✓; create-assign set any `currentHolderId`, **no holder validation** | blob assets | **P2** can create-assign to admin/client/unknown/disabled | **Yes** — validate holder |
| 5 | Asset edit | `api/assets.js` PUT | `isAdminRole` ✓; blocks holder change (use transfer) | blob assets | OK | No |
| 6 | Asset archive | `api/assets.js` DELETE | `isAdminRole` ✓ soft-archive | blob assets | OK | No |
| 7 | Holder transfer | `api/assets.js` POST `?action=transfer` | caller `isAdminRole`/holds-it ✓; destination only rejects `client` + non-admin→admin; no field/LH requirement; no disabled check | blob assets | **P2** admin can transfer to office/boss/unknown/disabled; diverges from My Gear (only field/LH read gear) | **Yes** — holder must be active field/LH or storage |
| 8 | Report check/damaged/missing | `api/assets.js` POST `?action=report` | `isAdminRole` + holder check ✓ | blob assets | OK | No |
| 9 | mark-good | `api/assets.js` POST `?action=mark-good` | `isAdminRole` ✓ | blob assets | OK | No |
| 10 | Holder picker / user list | `api/users.js` `?action=listTradies` | caller literal `admin\|\|leadingHand`; returns literal `tradie\|\|leadingHand`; strips `passwordHash` ✓; no disabled filter | `users.json` | **P1** caller 403s office/boss/PM; returned set misses electrician/apprentice/labourer + lowercase LH aliases; disabled included | **Yes** — normalise caller (`isStaffRole`) + returned set (field/LH, exclude disabled). Field-narrowing the response shape is **deferred** (legacy `public/project.html` reads `assignedJobIds` off it) |
| 11 | Full user list | `api/users.js` GET (admin) | `requireAuth({roles:['admin']})` tier-aware ✓; strips hash ✓ | `users.json` | OK | No |
| 12 | My Gear / Phil | `src/app/phil/gear/page.tsx`, `PhilGearList.tsx` | guard `canAccessSurface(role,"phil")` = field/LH; reads `/api/assets` (archived hidden); honest empty + UC panel; real actions | blob assets | OK — truthful; relies on server own-held filter which is already correct for field/LH | verify + document |
| 13 | Worker action helper | `src/domains/gear/service.ts` `canWorkerActOnAsset` | literal `role==='admin'` | n/a (pure) | **P2** latent literal-role: admin-tier treated as held-only | **Yes** — `isAdminRole` |
| 14 | Holder "(LH)" label | `GearRegisterClient.tsx` (transfer select) | literal `h.role==='leadingHand'` | n/a | **P3** lowercase LH aliases miss the "(LH)" suffix | **Yes** — `isLeadingHandRole` |
| 15 | Asset status fields | `service.ts deriveStatus` | archived→retired, condition, holder precedence | derived | OK | No |
| 16 | Asset holder field | `currentHolderId` (+ `assignedAt`, `expectedReturn`) | write + read agree on `currentHolderId` | blob assets | OK — **no field mismatch** | No (documented) |
| 17 | Secret stripping | `api/assets.js`, `api/users.js` | assets API never returns user secrets (enriches names only); `listTradies` strips `passwordHash` | both | secret (`passwordHash`) already stripped ✓; field-narrowing the rest would help but isn't a secret leak | **Partial** — `passwordHash` stripping verified by test; broader projection deferred for legacy compat (#10) |
| 18 | Legacy gear/inventory | `public/my-gear.html`, `public/admin/assets.html` | functional legacy; **no** QR/Switchboard/Site-Office/`localStorage` leaks; registered in route-ownership | blob assets | OK | No |
| 19 | Empty / error / loading | admin page, register, Phil page | error cards + honest empty states + history loading/empty/error + UC panels | n/a | OK | verify |
| 20 | Tests | `src/domains/gear/gear.test.ts` | rich **unit** tests; **no API-level role test**; `canWorkerActOnAsset` only covered for literal admin/tradie/lh | n/a | the "UI exists but reads/writes the wrong role/data path" class is untested at the API boundary | **Yes** — `assets-api.test.ts` (assets API) + `listTradies` tests in `users-api.test.ts` + holder-picker render test + extend the unit test |

---

## Role model

All gates use the **normalised** role helpers (`api/_lib/auth.js` ⇄
`src/lib/auth/roles.ts` / `permissions.ts`), never scattered string literals.

| Tier | Roles (normalised, case-insensitive) | Gear register (`/gear`) | My Gear (`/phil/gear`) | Assignable holder? |
|------|--------------------------------------|-------------------------|------------------------|--------------------|
| Admin-tier | `admin`, `boss`, `owner`, `manager`, `office`, `pm`, `estimator` | **All assets**, assign/return/condition | redirected away | No |
| Leading-hand | `leadinghand`, `leading_hand`, `leading-hand`, `lh`, legacy `leadingHand` | own held only | own held | **Yes** |
| Field | `tradie`, `apprentice`, `labourer`, `electrician` | own held only | own held | **Yes** |
| Client | `client` | **403** | redirected away | No |
| Unknown / other | anything else | **403** | redirected away | No |

- **See the whole register / list all assets** = `isAdminRole` (admin-tier).
- **See only own held gear** = field + LH (`canViewAssignedGear`).
- **Be a gear holder** = active (not archived/disabled) field + LH — the same
  tier that can read gear in My Gear, so every assignment is visible to its
  holder. Mirrors `isAssignableWorkerRole` used by job assignment.
- **Manage assets** (create/edit/archive/mark-good) = `isAdminRole`.
- **List assignable workers** (`listTradies`) caller = `isStaffRole` (admin-tier
  **or** LH, preserving the prior LH caller access); returns active field + LH
  only, `passwordHash` stripped. The gear picker consumes just
  `{ id, username, role }` (its Zod schema is `.passthrough()`), but the
  response is **not** narrowed to those three fields — legacy `public/project.html`
  reads `assignedJobIds` off the same endpoint, so field-narrowing is deferred.

Disabled/archived users are excluded as holder candidates and rejected as
transfer/create-assign targets.

---

## Phil "My gear" — what it currently supports

- Lists the worker's **own actively-held** gear (real data from `/api/assets`).
- Per item: Return to depot, "Got it" (possession check), Report damaged,
  Report missing — all backed by real `api/assets.js` actions.
- Honest empty state ("Nothing in your name…") and an **Under construction**
  panel for the deferred QR check-out flow.
- No fake QR/scan affordance, no admin controls, no cross-user gear, archived
  hidden. No `localStorage`, no demo data.

My Gear was found **truthful** in the audit and needed no correctness fix — the
field/LH visibility filter was already correct; only the admin-tier list path
was broken.

---

## Deferred — NOT built

These are explicitly out of scope and surfaced in the UI as "Under
construction", not as working features:

- **QR scanning / labels** — camera check-out, Nimbot/Brother label printing.
- **Issue / lost / damaged escalation workflow** beyond the simple condition
  flag (damaged/missing) that already exists.
- **Maintenance logs / service history.**
- **Van stock / warehouse inventory automation / stock decrementing.**
- **Purchasing / suppliers / Xero.**
- **Bulk operations** (bulk assign / bulk retire) and reports.

Create / edit / archive of assets still lives on the legacy `/admin/assets`
page (same blob store); the new `/gear` register is single-item assign / return
/ condition flows.

---

## Known limitations

- Admin-tier staff (e.g. a boss who drives a company ute) cannot be recorded as
  a gear holder — holders are field/LH only. If personal-vehicle tracking for
  office staff is wanted, that is a future enhancement, not a bug.
- `subcontractor` and other roles outside the canonical taxonomy are treated as
  unknown → denied gear access and not assignable. Extending the taxonomy is a
  foundation change, out of scope here.
- The register's bulk/QR/label affordances are deferred (see above).
- `listTradies` still returns the full (passwordHash-stripped) worker record,
  not a `{ id, username, role }` projection, because the legacy
  `public/project.html` snag-crew picker reads `assignedJobIds` from the same
  endpoint. Narrowing the shape needs those legacy consumers migrated first —
  no secret is exposed (only staff callers, `passwordHash` stripped), so this is
  a tidy-up, not a leak.

---

## Tests that protect role normalisation

- `src/domains/gear/assets-api.test.ts` — API-level role tests against the
  **real** `api/assets.js` handler (in-memory blob + mocked `@vercel/blob`
  `list`/`fetch`, signed sessions): admin-tier (office/boss) lists all; field/LH
  see only own; client + unknown denied; archived hidden; single-asset
  visibility; holder validation on transfer **and** create-assign (active
  field/LH only; admin/client/disabled rejected; return-to-depot ok); no
  `passwordHash` in any asset response.
- `src/domains/users/users-api.test.ts` — `?action=listTradies` caller gate
  (office allowed, field/client 403), returned-role normalisation (field + LH,
  excludes admin/office/client), disabled exclusion, `passwordHash` stripped.
- `src/components/admin/GearRegisterClient.render.test.tsx` — SSR render of the
  holder-picker `<select>`: lists the assignable holders, marks LH by the
  **normalised** role (`lh`, not literal `leadingHand`), offers return-to-depot,
  excludes the current holder, and hides the picker for archived assets.
- `src/domains/gear/gear.test.ts` — extended `canWorkerActOnAsset` coverage for
  normalised admin-tier (boss/office/pm/owner) bypass.

These guard the exact "UI exists but the API reads/writes the wrong role/data
path" class that previously affected job assignment.
