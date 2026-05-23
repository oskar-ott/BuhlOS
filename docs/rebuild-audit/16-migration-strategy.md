# 16 · Migration strategy

> How to move from the legacy `public/*.html` + `api/*.js` repo to a clean Next.js + TypeScript rebuild **without breaking production**. The plan is incremental, additive, and gated.

---

## A. Migration principles

1. **Keep production stable at all times.** Every PR must leave `buhlos.com` working for every user role. No feature flag gate is a substitute for this — the legacy surface stays *fully functional* until its replacement is verified.
2. **Keep the useful backend.** `api/*.js` + `api/_lib/*` + Vercel Blob is the temporary backend. Endpoints are *consumed* by typed clients in `src/domains/<domain>/client.ts`; they are not rewritten until their domain comes online in Phase B+.
3. **Introduce the clean frontend in parallel.** The new app boots alongside the legacy app on non-colliding routes (`/command-centre`, `/v2/login`, `/v2/phil`, `/hours/*`, `/gear/*`, ...). No legacy route is flipped to the new app until the new app has been verified on a preview URL.
4. **Verify on preview before cutover.** Every Vercel preview deploy is the proving ground. Production is only updated through merge to `main` — there is no manual prod deploy.
5. **Never delete legacy until replacement is verified.** A `public/*.html` page is deleted *one billing cycle* after its new equivalent has been in production without regression.
6. **No direct prod deploy from feature branches.** `deploy:prod` is removed from `package.json` in Phase A. `GUARD_OVERRIDE` is removed in Phase B. Production updates only via `main` merge → Vercel auto-deploy.
7. **Route cutovers are explicit, single-rewrite-at-a-time, never bundled.** Each `vercel.json` rewrite edit is its own PR with its own preview verification and its own rollback plan.

---

## B. Phase map

| Phase | Goal | Deliverable | Routes added (Next.js) | Routes cut over (vercel.json edits) |
| --- | --- | --- | --- | --- |
| **1** | Audit | `docs/rebuild-audit/00–09` + `docs/architecture/00–01` + `docs/product/00–01` | none | none |
| **1B** | Deep audit / decision pack | `docs/rebuild-audit/10–23` + updates to `00` and `08` | none | none |
| **A** | App shell / foundation | Next.js + TS + Tailwind scaffold; AdminShell + PhilShell; `/command-centre`, `/v2/login`, `/v2/phil`; tests; CI | `/command-centre`, `/v2/login`, `/v2/phil` | none |
| **B** | Hours loop end-to-end | `src/domains/timesheets/*`; `/phil/my-day` Log Hours; `/hours/approvals`; CSV export | `/phil/my-day`, `/phil/hours`, `/hours`, `/hours/approvals` | none in Phase B; cutover at start of Phase C |
| **C** | Gear loop end-to-end | `src/domains/gear/*`; Phil scan + my-gear; admin gear register | `/phil/gear`, `/gear`, `/gear/:assetId` | `/login → /v2/login`, `/phil → /phil/my-day`, `/my-day → /phil/my-day` (legacy hosted at `/legacy/my-day`) |
| **D** | Jobs & evidence | `src/domains/{jobs,evidence,snags}/*`; Phil capture + snag raise; admin job page + snags queue + activity | `/phil/jobs/*`, `/phil/snags/*`, `/jobs/*`, `/snags`, `/activity` | `/admin → /command-centre`, `/admin/* → /<section>` (per-section batch), `/jobs → /jobs` (Next.js owns) |
| **E** | ITP / RFI / materials / plans / variations | `src/domains/{itp,rfis,materials,plans,variations}/*` | `/itp`, `/rfis`, `/materials`, `/plans`, `/variations`, `/phil/itps/*`, `/phil/rfis/*` | per-section as each lands |
| **F** | Reporting / integrations / intelligence | `src/domains/{audit-log,alerts}/*`; reports; Xero push; AI plan UI rebuild | `/reports`, `/settings/integrations`, `/support` | remaining legacy admin pages |
| **G** | Service worker rewrite + legacy quarantine | Push-only SW; legacy HTML moved to `public/_legacy/`; `/legacy/*` rewrite added; old paths deleted after one cycle | none net new | `/buhlos/*`, `/admin-legacy`, `/dev/*` deleted |

---

## C. Route strategy

### C.1 Routes that stay on legacy until cutover

These `vercel.json` rewrites are **NOT touched in Phase A–B**:

- `/` → `/login.html`
- `/login` → `/login.html`
- `/jobs` → `/admin/jobs.html`
- `/jobs/:jobId` → `/project.html`
- `/jobs/:jobId/log-hours` → `/project.html`
- `/admin` → `/admin/index.html`
- `/admin/*` (all 24 sub-paths)
- `/buhlos`, `/buhlos/*` (full mirror set — eventually removed in Phase G)
- `/phil`, `/phil/app`, `/phil/login` → static phil.html / login.html
- `/my-day` → `/my-day.html`
- `/my-gear` → `/my-gear.html`
- `/phil-hours` → `/phil-hours.html`
- `/lh`, `/lh-home` → `/lh-home.html`
- `/install` → `/install.html`
- `/client`, `/client/jobs/:jobId` → `/client.html`
- `/approvals`, `/overview` → admin/* aliases
- `/admin-legacy` → `/admin.html`
- `/dev/*`, `/dev/site-office/*` → deprecated dev surfaces

### C.2 Safe new routes used in Phase A (no collision)

- `/command-centre` — new admin home
- `/v2/login` — new login (parallel)
- `/v2/phil` — new Phil shell (parallel to `/phil`)

These three are NOT in `vercel.json`. Next.js owns them naturally.

### C.3 Cutover sequencing

**Cutover of `/login`** (start of Phase C):

- **Preconditions:** Phase B hours loop shipping reliably on legacy login → `/my-day` for one week minimum. `/v2/login` Playwright tests green against preview.
- **Action:** Edit `vercel.json` `/login` rewrite to point at the Next.js app (or delete the rewrite so Next.js owns it natively).
- **Verification:** Preview URL hits `/login` and sees the new login. Existing session cookies still authenticate.
- **Rollback:** Restore the rewrite line; redeploy.

**Cutover of `/phil`** (start of Phase C):

- **Preconditions:** Phil hours loop verified in preview; PWA manifest update prepared (`start_url` → `/phil/my-day`); SW cache bumped.
- **Action:** Edit `vercel.json` to remove `/phil → /phil.html` rewrite. `/my-day` rewrite changes to point at `/legacy/my-day` (a new rewrite). `/my-day` and `/phil-hours` and `/my-gear` quarantined to `/legacy/*`.
- **Verification:** Tradie installs PWA, sees `/phil/my-day` as launch screen. Existing installed PWAs receive SW update and refresh to new start URL.
- **Rollback:** Restore rewrites; bump SW cache version.

**Cutover of `/admin` and `/admin/*`** (Phase D, in batches):

- **Preconditions:** Each `/admin/<section>` cutover requires the corresponding new section page to render real data + pass Playwright smoke + all four legacy guards (`check:admin-shell`, `check:sw-cache-version`, `check:production-shell`, `smoke:admin-routes`).
- **Action:** Remove the specific rewrite line for that section. Next.js takes over.
- **Verification:** Admin opens `/admin/<section>` and sees new shell. Cross-link from legacy admin (where still serving other sections) still works.
- **Rollback:** Restore the rewrite line.

**Cutover of `/my-day`, `/my-gear`, `/phil-hours`** (Phase C, with `/phil` cutover):

- These become `/legacy/my-day` etc. via new rewrites. Original paths return 404 → Next.js `not-found.tsx` which links to `/v2/login`.
- After one billing cycle without complaints, delete the `/legacy/*` rewrites and the HTML files.

**Cutover of `/jobs`, `/jobs/:jobId`** (Phase D):

- Identical pattern: new Next.js page lives at `/jobs` and `/jobs/:jobId`; legacy HTML quarantined to `/legacy/jobs` etc.

**Quarantine cleanup** (Phase G):

- Move all `public/*.html` files to `public/_legacy/`.
- Add `/legacy/*` catch-all rewrite to `public/_legacy/*`.
- Delete `/buhlos/*` mirror routes entirely (no replacement).
- Delete `/dev/*` and `/admin-legacy` rewrites + their HTML files.
- One release cycle later, delete the `/legacy/*` rewrite and the `public/_legacy/` folder.

### C.4 Preventing blank-page regressions during cutover

- Every cutover PR runs `smoke:admin-routes` + new Playwright route smoke against preview.
- Service worker cache must be bumped if `_shell.js` or any cached admin HTML changes (enforced by `check:sw-cache-version.js`).
- Each cutover deploys *only* on Monday morning (low traffic) with on-call ready for one hour.

---

## D. Data / API strategy

### D.1 Endpoints to retain (no rewrite needed in Phase A–C)

- All `/api/time-entries*` (10 endpoints) — the well-formed hours model.
- `/api/auth*` — session cookie infrastructure.
- `/api/jobs*`, `/api/job-*` — read-only consumption in Phase B; reused in Phase D.
- `/api/users*`, `/api/people*` — admin user management.
- `/api/photos*`, `/api/assets*`, `/api/snags*`, `/api/plans*`, `/api/itp*`, `/api/materials*`, `/api/variations*` — consumed gradually as their domains come online.
- `/api/notifications`, `/api/push-test`, `/api/cash-watch`, `/api/payroll-reminder`, `/api/payroll-runs` — cron-driven; retained until Phase F.
- All 7 cron-targeted endpoints in `vercel.json` `crons[]`.

### D.2 Endpoints that need replacement (Phase D+)

- Any endpoint accepting **full-document writes** for grow-collections — patch endpoints replace them as their domain comes online. Phase 1A flagged `POST /api/data?jobId=X` specifically.
- `api/job-draft.js` — Job Builder state lives in Blob; rebuild as proper draft entity in Phase D.
- `api/data-quality.js`, `api/admin-stats.js` — fold into Phase F reporting.

### D.3 Existing data shapes consumable as-is

- `users.json` — User array; consumed Phase B+.
- `users/<userId>/time-entries/<date>.json` — **reuse verbatim** in Phase B. This is the rebuild's reference schema for timesheets.
- `jobs.json` + `jobs/{id}/data.json` — consumed read-only in Phase B; mutated in Phase D when patch endpoints land.
- `assets.json` (or wherever gear lives) — consumed in Phase C.

### D.4 Where future DB model should live

- Phase F+ migration from Vercel Blob to Postgres.
- Schemas already live in `src/domains/<domain>/schema.ts` (Zod) — Drizzle / Prisma derivation is straightforward at that point.
- Migration plan: dual-write for one week, dual-read for one week, cut to Postgres-only, retire Blob.
- No new domain is built directly on Postgres before Phase F+; build on Blob first via existing endpoints, then migrate the storage layer once domain shape is stable.

### D.5 Preventing mock data masquerading as live

- The single allowed mock-data mechanism is `src/domains/<domain>/fixtures.ts` (typed seed data).
- Whenever `fixtures.isDemoMode()` returns true, `DemoModeBanner` renders.
- The legacy `window.BUHLOS_MOCK` silent-fallback pattern is banned in new code (ESLint).
- When a domain wires real data (Phase B+), the corresponding `fixtures.isDemoMode()` flips to false for that domain.

---

## E. Cutover criteria

### E.1 Phase A → Phase B

- Phase A scaffold committed and passing all CI checks in PR + on `main`.
- `npm run dev` boots and serves `/command-centre`, `/v2/login`, `/v2/phil`.
- `npm run build` succeeds.
- Legacy guards (4) pass.
- Vitest unit tests (Phase A: `landingFor` + `rolePermits`) pass.
- Playwright Phase A spec passes locally.

### E.2 Phase B → Phase C (start of Phase C is cutover of /login + /phil)

**Preconditions for entering Phase C:**

- Phase B hours loop end-to-end on preview:
  - Tradie logs in via legacy `/login`, lands on legacy `/my-day` (Phase B keeps this path), opens Phil → Log Hours flows to new shell at `/phil/my-day` via a deep link.
  - Standard day submits in <15 seconds.
  - Admin sees pending entries at `/hours/approvals` (new), approves with one click.
  - Approved entry exports to CSV (`/api/time-entries-export.js` reused).
- Playwright tests green:
  - Tradie login → /phil/my-day → submit hours.
  - Admin login → /hours/approvals → approve.
- One week of real worker submissions on the new flow without rollback.
- Boss + admin sign-off.

**Cutover actions for entering Phase C:**

1. Edit `vercel.json`:
   - Remove `/login → /login.html` (Next.js owns `/login` natively via redirect to `/v2/login` OR direct mount).
   - Remove `/phil → /phil.html`; add `/legacy/phil → /phil.html`.
   - Remove `/my-day → /my-day.html`; add `/legacy/my-day → /my-day.html`.
   - Remove `/phil-hours → /phil-hours.html`; add `/legacy/phil-hours → /phil-hours.html`.
2. Update `public/manifest.json` `start_url` to `/phil/my-day`.
3. Bump `public/sw.js` `CACHE_VERSION`.
4. PR review + preview verification.
5. Merge to `main`. Vercel auto-deploys.
6. On-call standby for one hour post-deploy.

**Verification:**

- Existing PWA installs receive SW update; open to `/phil/my-day`.
- Legacy `/my-day` → 404 → not-found.tsx links to `/v2/login`.
- All legacy guards pass on the new state.
- No production incident in 7 days.

**Rollback (if any of above fails):**

- Revert the merge commit; Vercel auto-rolls-back.
- Or `vercel promote <previous-deploy>` for instant restore.

### E.3 Phase C → Phase D

**Preconditions:**

- Phil gear loop verified in preview (assign → scan → return).
- All Phase B success criteria still passing.
- 7-day quiet period since Phase C cutover.

**Cutover (no admin cutover in Phase C → D; admin section cutovers happen *inside* Phase D):**

- Phase D ships new admin Jobs page first; cutover `/admin/jobs` rewrite to Next.js when verified.
- Same pattern for `/admin/snags`, `/admin/activity`.
- `/admin/operations` (Command Centre SPA) becomes `/command-centre` (new) when feature parity reached + 7-day shadow.

### E.4 Phase D → E → F → G

- Each follows the same pattern: precondition (loop verified end-to-end), cutover (one rewrite at a time), verification (preview + 7-day quiet), rollback (revert merge).
- Phase G is the final quarantine: all `public/*.html` moved to `public/_legacy/`, mirror routes deleted, dev surfaces deleted.

### E.5 Rollback plan template (every cutover)

```
1. Identify last known-good deploy on Vercel.
2. `vercel promote <deploy-id>` (instant — production is the previous deploy).
3. Open incident channel; assess impact.
4. Revert the merge commit on `main` (git revert).
5. Push to `main` → Vercel auto-deploys the revert.
6. Verify production is back to known-good.
7. Post-incident review within 48 hours.
```

`GUARD_OVERRIDE` is **not** acceptable for rollback. Use `vercel promote`.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — what we're migrating toward.
- [11-operational-workflow-map.md](11-operational-workflow-map.md) — workflow order matches phase order.
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) — claimed routes + safe routes.
- [15-risk-register.md](15-risk-register.md) — risks each cutover mitigates.
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) — verification gates referenced here.
- [06-deployment-audit.md](06-deployment-audit.md) — Phase 1A deploy policy.
- [07-salvage-map.md](07-salvage-map.md) — what survives the migration.
