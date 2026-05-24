# Phase C · My Gear · rollout and runbook

> Operating notes for the gear loop on the new shell. Pairs with [12-domain-model-deep-dive.md] §Gear and [13-ui-information-architecture.md] §Section Gear / §Tab Gear. Phase C is **live on buhlos.com** as of the PR #5 + PR #6 + PR #7 merge sequence (2026-05-24).

---

## What Phase C ships

Closed operational loop for company-owned assets:

1. **Admin** assigns gear to a worker through the new `/gear` register.
2. **Worker** sees the assigned gear in Phil at `/phil/gear`.
3. **Worker** can return, confirm possession, or report damaged / missing.
4. **Admin** sees the updated status and the full action history on the same `/gear` page.
5. **Admin** can clear a damaged or missing flag (via "Mark good") after the asset is repaired or recovered.

Storage shape unchanged from the legacy `api/assets.js` — Phase C is an additive surface, not a data migration. The legacy `/admin/assets` page and the legacy `/my-gear` page both still work.

---

## Live routes

| Route | Surface | Status |
|---|---|---|
| `/gear` | Admin · register + manage drawer | live |
| `/phil/gear` | Phil · my gear card list + actions | live |
| `/api/assets` (GET list/detail, POST create/transfer/report/mark-good, PUT edit, DELETE archive) | Backend | live |
| `/admin/assets` (legacy create / edit / archive) | Admin · fallback | live (preserved) |
| `/my-gear` (legacy worker view) | Phil · fallback | live (preserved) |

---

## Admin flow · `/gear`

1. **List view.** Six filter tabs at the top: All, Available, Assigned, Damaged, Missing, Retired. Each shows a count. The list is sortable by overdue-first then alphabetical name; the search box matches name / identifier / current holder.
2. **Open the Manage drawer** by clicking the row's Manage button. The drawer shows:
   - Status pill + Overdue flag if past `expectedReturn`.
   - Type / Condition / Current holder / Assigned since / Expected return / Notes.
   - **Transfer** section: dropdown of eligible holders + an "Assign" or "Return" button + optional note (visible in history).
   - **Mark condition** section. Surfaces three / four buttons depending on state:
     - `Confirm checked` — admin asserts possession. No condition change.
     - `Mark damaged` — sets condition='damaged' + writes a `report_damaged` history entry by the admin.
     - `Mark missing` — sets condition='missing' + writes a `report_missing` history entry by the admin.
     - `Mark good` (Phase C hardening 2026-05-24) — admin clears a damaged or missing flag back to 'good' after off-site repair or recovery. Writes an `admin_updated` history entry. Shown whenever the asset is currently damaged or missing, **including when it has been returned to depot** for repair.
   - **History** — newest first. Kinds: `transfer`, `check`, `report_damaged`, `report_missing`, `admin_updated`.
3. **Create / edit / archive** of asset metadata — currently UC in the new register. Use the legacy `/admin/assets` page; the new register reads the same store, so a new asset appears in `/gear` after refresh.

### Decision rules

- Workers can **report** damaged / missing on assets they hold but **cannot** clear a damage report (one-way). This prevents a tradie from hiding their own report.
- Admin **transfers** are recorded via `?action=transfer` and always append a history entry. PUT cannot change `currentHolderId`.
- A damaged asset is in the **Damaged** filter regardless of who currently holds it — the admin queue must see the damage report even while the asset is still in the worker's hand.
- Archiving an asset is a soft-delete (`archived=true`). The asset disappears from active queues and worker views but the row + history are preserved.

---

## Worker flow · `/phil/gear`

1. **Mobile-first card list.** Each card shows the asset name + identifier, an Assigned pill, the asset type, current condition, held-since timestamp (Sydney time), and expected return (with an "overdue" highlight if past).
2. **Action grid** under each card (large touch targets, 2-col on phones, 4-col on tablets):
   - `Return` — sends `?action=transfer` with `toUserId: null`, the asset goes back to depot.
   - `Got it` — sends `?action=report` with `kind: 'check'`, records possession without changing condition.
   - `Damaged` — sends `?action=report` with `kind: 'damaged'`. Disabled if the asset is already damaged.
   - `Missing` — sends `?action=report` with `kind: 'missing'`. Disabled if the asset is already missing.
3. **Confirmation sheet** before every action — short copy explaining what happens, plus Cancel / confirm buttons.
4. After confirm: the sheet closes immediately, the action fires in the background, a success or error banner shows above the cards, and the list refreshes.

The worker sees **only** the gear where `currentHolderId === their user id`. The server enforces this filter; the Phil page also filters client-side as defence-in-depth.

---

## API contract

`POST /api/assets?action=mark-good` (Phase C hardening)
```jsonc
// request
{ "assetId": "a_abc123", "note": "Battery replaced" /* optional, ≤ 500 */ }
// response 200
{ "asset": { /* asset with condition='good' + lastConditionAt updated */ } }
// errors
{ "error": "admin only" } // 403 for non-admin
{ "error": "asset not found" } // 404
{ "error": "assetId required" } // 400
```

Other actions remain unchanged from Phase C v1:

| Action | Method | Description |
|---|---|---|
| List | `GET /api/assets[?archived=1]` | Admin sees all; worker sees own held |
| Detail | `GET /api/assets?id=<id>` | Asset + enriched history |
| Create | `POST /api/assets` | Admin only |
| Transfer | `POST /api/assets?action=transfer` | Assign / return |
| Report | `POST /api/assets?action=report` | Worker check / damaged / missing |
| Mark good | `POST /api/assets?action=mark-good` | Admin clears damaged/missing |
| Edit | `PUT /api/assets?id=<id>` | Admin only; holder change blocked |
| Archive | `DELETE /api/assets?id=<id>` | Soft delete |

---

## Known limitations

- **Bulk operations are deferred.** Bulk assign, bulk retire, and label printing are UC in the new register. Use legacy `/admin/assets` for bulk work until Phase D+.
- **QR scan check-out is deferred.** Camera-based scanning is on the roadmap. For now, admin / leading hand transfers gear through the office register, and the worker returns / reports from the card.
- **Long asset names truncate with ellipsis in the admin table** (Phase C hardening 2026-05-24). The Asset column is capped at ~320px and the name/identifier truncate with hover tooltip showing the full string. Manage stays visible at typical viewport widths. The drawer's title shows the full name. (BUG-C-005, fixed.)
- **Silent name truncation in create.** The API enforces a 120-character cap and silently truncates rather than returning 400. The typed client schema rejects 121+ on the client side, but a direct curl to `POST /api/assets` will accept a long name truncated to 120 chars. (BUG-PRE-002, open.)
- **Detail GET is eventually consistent.** Right after a write, the GET-by-id endpoint can serve stale data for up to one Vercel function-instance cache TTL. Phase C hardening switched `readAsset` and `readHistory` to `readBlobFresh`, so the drawer reflects writes within a single round-trip; the list view was already cache-bypassed.
- **Rapid same-asset mutations can race.** Vercel Blob's list+fetch pipeline is eventually consistent across function instances. Three back-to-back POSTs (transfer → report damaged → mark-good) within ~500ms on the same asset can clobber each other's read-modify-write — observed in automated testing as either a lost holder field or lost history entries. **In real usage the loop spans minutes-to-days between admin and worker actions and is unaffected.** A future Phase F+ migration off Vercel Blob (Postgres / Durable Objects / similar) would fix this; in the meantime, do not script bulk same-asset mutations through the API without sleep-spacing them.

---

## Rollout (what already happened)

1. **PR #5** · Phase C build — admin register, Phil my gear, gear domain, condition reports, `/api/assets?action=report`. Merged at `467bf46`.
2. **PR #6** · Phase C hardening — timezone fix for hydration, dialog UX, GET cache freshness, `/command-centre` copy, and the **critical** `/hours/approvals` 500 regression caused by a Next.js 15.5 RSC bundler bug. Merged at `49e28b1`.
3. **PR #7** · Sign-out fix — sidebar Sign out now POSTs to `/api/auth?action=logout`. Merged at `52d629e`.
4. **Phase C hardening 2** · Mark Good admin action (this PR).

All four steps deployed to production on the same day. Production smoke test green for `/gear`, `/phil/gear`, `/hours`, `/hours/approvals`, `/v2/login`, and legacy routes after each merge.

---

## Smoke test checklist

Pre-deploy, after every Phase C-touching change:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run check:admin-shell
npm run check:sw-cache-version
npm run check:production-shell
npm run smoke:admin-routes
```

Post-deploy, on production buhlos.com (or preview URL):

**Unauthenticated route gates:**
- `/gear` → 307 to `/v2/login?next=/gear`
- `/phil/gear` → 307 to `/v2/login?next=/phil/gear`
- `/hours`, `/hours/approvals`, `/phil/my-day`, `/phil/hours` → 307 (Phase B regression)
- `/login`, `/phil`, `/my-day`, `/my-gear`, `/admin/operations` → 200 (legacy preserved)
- `/v2/login` → 200

**Authenticated cross-surface loop** (admin + worker accounts):
1. Admin opens `/gear`, picks an asset in depot, opens the Manage drawer, transfers to a worker with a clear note.
2. Worker opens `/phil/gear`, sees the asset with status "Assigned", taps `Damaged`, confirms the sheet.
3. Admin refreshes `/gear`, the Damaged filter shows the asset, the drawer history shows the worker's `report_damaged` entry.
4. Admin clicks `Mark good` (Phase C hardening 2). The asset condition flips back; history shows the `admin_updated` entry.
5. Worker `Return`s the asset. Admin sees status "Available" and the new `transfer` entry.
6. Logout via the sidebar; confirm `/api/auth?action=me` returns 401.

---

## Cross-references

- [12-domain-model-deep-dive.md] §Gear · entity shape + storage layout
- [13-ui-information-architecture.md] §Section Gear · admin register + §Tab Gear · Phil
- [api/assets.js] · server-side source of truth
- [src/domains/gear/service.ts] · `deriveStatus`, transition rules, payload builders
- [src/domains/gear/format.ts] · timezone-pinned labels (BUG-C-002 fix)
- [src/components/admin/HoursApprovalsQueue.tsx] · sibling fix; lives here instead of next to its route page because of the Next.js 15.5 RSC bundler bug noted above
