# Phil — Field Smoke Test Plan

Manual smoke plan for the Phil worker app. Run before each rollout deploy
and after any change to a worker surface (`/my-day`, `/jobs`, `/jobs/:id`,
`/my-gear`, `/onboarding`).

Auth is cookie-based (`buhl_session`). Open a fresh incognito window per
role to avoid cookie crosstalk.

---

## 1. Routing

| URL | Expected |
|---|---|
| `/` | Redirects to `/login` |
| `/login` | Login form renders |
| `/phil` | Redirects to `/my-day` |
| `/my-day` | Tradie/LH lands here. Admin → `/admin/operations`. LH → `/lh`. Client → `/client`. |
| `/jobs` | Tradie/LH job list. Admin → `/admin/jobs`. Client → `/client`. |
| `/jobs/:jobId` | Workspace for one job. Worker bottom-tabbar visible for tradie/LH. |
| `/my-gear` | Tradie/LH gear list. Admin → `/admin/assets`. Client → `/client`. |
| `/onboarding` | Tradie/LH readiness checklist. Admin → `/admin/operations`. Client → `/client`. |

Pass if every entry redirects / renders as listed without 404.

---

## 2. Tradie session

Login as a tradie account (4-digit PIN).

### My Day (`/my-day`)
- [ ] Header shows "Morning/Afternoon/Evening, &lt;FirstName&gt;" with date in mono uppercase.
- [ ] Sync indicator (`<buhl-mark>`) renders to the right of the greeting.
- [ ] Primary yellow CTA says "Log today's hours" when nothing's logged today; "Logged today: Xh · tap to edit" with green confirmation styling when logged.
- [ ] Tapping the CTA opens `BuhlLogHours` sheet pre-scoped to today.
- [ ] On-site-today card appears when the tradie has touched a job today (or has exactly one active assignment); row title reads **"Open Workspace"** (consistent vocabulary with `/jobs/:id` header sub-line); links to `/jobs/:id`.
- [ ] This-week card shows per-job hour breakdown sorted by hours, with a week total in the header.
- [ ] My-jobs card lists assigned active jobs; "today" pill on the job touched today.
- [ ] Bottom tab bar: 4 tabs — My day (active) · Jobs · My gear · Me.

### Jobs (`/jobs`)
- [ ] Header reads "Jobs" with a mono uppercase rollup line ("3 assigned · 2 SNAGS · 1 TAGS DUE").
- [ ] Search filters live as you type, against name / ref / address.
- [ ] Job cards show: yellow initials, Inter Tight name, mono ref chip, address, 3 stat tiles (Progress / Snags / Tags), yellow progress bar.
- [ ] Snag and Tags tiles flip red when non-zero.
- [ ] Tapping a job goes to `/jobs/:id` (Workspace).
- [ ] Bottom tab bar: Jobs (active).

### Workspace (`/jobs/:jobId`)
- [ ] Header sub-line shows "WORKSPACE · &lt;REF&gt;" (not just the job id).
- [ ] Hamburger menu (Tools) shows: Snags · Photos & ITP · Plans · Contacts · ← My Day · Sign out. NOT visible to tradie: Hours table, Temps, Test & Tag, ITPs cross-register.
- [ ] Dashboard tiles include "Log hours" and "Raise snag" in the secondary row.
- [ ] Worker bottom tab bar visible at the bottom of the page: My day · Jobs (active) · My gear · Me.
- [ ] Worker FAB (the old "+ Log hours / Raise snag" pair) is **hidden** when the worker tabbar is on (verify via DevTools: `.worker-fab` should have `display:none`).
- [ ] Tapping any tab bar item navigates to the right page; page-back via tab bar works without browser-back chord.
- [ ] **Me tab opens a sheet** (it's a button, not a direct nav). Sheet contains avatar / name / role + "Onboarding & readiness" link + red "Sign out" + Cancel. Same protected pattern as `/my-day` / `/my-gear` / `/jobs`. Sign-out cannot fire on a single accidental tap.

### My Gear (`/my-gear`)
- [ ] Header sub-line reads "N items out" (or "1 OVERDUE / 2 DUE SOON" if applicable).
- [ ] Navy "Scan check in/out" CTA renders at top.
- [ ] Each item shows: yellow initials, name, type · identifier · since/back date, status pill (ok / due soon / overdue), per-row "Transfer / return" button.
- [ ] Transfer sheet opens; "Return to storage" option present; transfer succeeds (or queues offline → "Queued offline" message and 202 path).
- [ ] Bottom tab bar: My gear (active).

### Me sheet (any worker page)
- [ ] Tapping the "Me" tab opens the bottom sheet with avatar / name / role.
- [ ] Sheet has two actions: **Onboarding & readiness** (link) and **Sign out** (red).
- [ ] Tapping outside the sheet, pressing Escape, or tapping Cancel closes without signing out.
- [ ] Tapping "Onboarding & readiness" goes to `/onboarding`.
- [ ] Tapping "Sign out" clears the session and redirects to `/login`.

### Onboarding (`/onboarding`)
- [ ] Back link reads "‹ My day" and works.
- [ ] Readiness ring fills as profile + gear items complete (license items are admin-managed and intentionally NOT counted).
- [ ] When profile + gear are all done, hero label reads "**Profile complete**" with the sub-line "Compliance docs sit with admin · not yet verified here." The ring stays neutral (no green tint) — there is no "Ready for site" state until the licence backend lands.
- [ ] Profile checklist: Username (done), Role assigned (done if user has a role), Email on file (done if set, else "ask admin to add"), Job assignment (done if assignedJobIds non-empty).
- [ ] Compliance section lists White card / Electrical licence / First aid / EWP, each as "admin" state (grey pill). Meta reads "lodge with admin · …" — non-committal wording, no claim of confirmation.
- [ ] Gear section shows N items in your name (or "No gear assigned" todo).
- [ ] Advisory at the bottom is honest about the gap: "Licence tracking coming soon. Phil doesn't yet show licence expiry dates or upload status."
- [ ] Bottom tab bar: Me (active).
- [ ] Me tab opens a sheet with **just Sign out + Cancel** (no Onboarding link — you're already on /onboarding).

---

## 3. Leading Hand session

Run all tradie tests above. Additionally:
- [ ] Worker tab bar is visible on `/jobs/:id`.
- [ ] Hamburger menu on Workspace exposes the same items as for a tradie (LH gets the same field-focused view; admin tools live in BuhlOS).
- [ ] "Crew today" Dashboard pip / "Triage snags" pip render in the secondary row (LH-only).
- [ ] LH can write to assigned jobs (tasks, snags, hours, photos).

---

## 4. Admin session

- [ ] Login redirects to `/admin/operations`, not `/my-day`.
- [ ] Manually visiting `/my-day` → redirects to `/admin/operations`.
- [ ] Manually visiting `/my-gear` → redirects to `/admin/assets`.
- [ ] Manually visiting `/jobs` → redirects to `/admin/jobs`.
- [ ] Manually visiting `/onboarding` → redirects to `/admin/operations`.
- [ ] On `/jobs/:id` admin sees the full hamburger menu (Hours table, Temps, T&T, Materials, etc.). Worker bottom tab bar is **not** shown.

---

## 5. Client session

- [ ] Login redirects to `/client`.
- [ ] Manually visiting any `/my-*` or `/jobs*` route → redirects to `/client`.
- [ ] `/client/jobs/:jobId` renders the read-only project portal.

---

## 6. Offline / poor signal

Use DevTools Network → "Offline" to simulate.

- [ ] My Day → CTA tap opens the sheet; submit while offline → BuhlQueue persists to IndexedDB; sync indicator (`<buhl-mark>`) shows offline state; entry shows up on the My Week list with "queued" treatment if BuhlLogHours surfaces it.
- [ ] Asset transfer → submit while offline → "Queued offline · will transfer when online."
- [ ] Re-enable network → queue drains; sync indicator returns to idle; written changes reflect on next page load.

---

## 7. Cross-device

- [ ] iPhone 13 (375 × 812): all worker pages render without horizontal scroll. Bottom tab bar clears the home indicator (`env(safe-area-inset-bottom)` honored).
- [ ] iPad portrait: pages center at max-width 430 px; tab bar stays centered.
- [ ] Desktop (1280 × 800) on `/jobs/:id`: worker tab bar hidden (CSS media query > 760px); admin nav-pills visible if applicable.

---

## 8. Deployment checks

- [ ] Vercel build passes (no syntax errors, `vercel.json` valid).
- [ ] Preview deploy URL responds 200 for `/login`, `/my-day`, `/jobs`, `/my-gear`, `/onboarding`, `/phil`.
- [ ] DevTools console has no uncaught errors on any worker page boot.
- [ ] Service worker (`/sw.js`) registers without errors.
- [ ] No CORS warnings from `/api/auth?action=me`.

---

## 9. Regression hot-spots

These have churned recently and warrant focused attention:

- [ ] BuhlLogHours integration on `/my-day` — opens, saves, refreshes the CTA + week total in place.
- [ ] Asset transfer on `/my-gear` — uses BuhlQueue.fetch with `replaceKey`.
- [ ] Workspace tab bar on `/jobs/:id` — only for tradie/LH; FAB hidden when tabbar is on; layout doesn't shift other content.
- [ ] `/onboarding` readiness ring — recalculates correctly when ASSETS or ME fields change.
- [ ] Me sheet across all four worker pages — Onboarding link present; Sign out is the only red action.

---

## How to file a bug

If a check fails, capture:
1. Role you were testing as
2. URL where it failed
3. Console output (DevTools → Console, copy errors)
4. Network tab screenshot if an API call returned non-2xx
5. Screenshot of the visible state

Open the issue on GitHub and tag `field-rollout`.
