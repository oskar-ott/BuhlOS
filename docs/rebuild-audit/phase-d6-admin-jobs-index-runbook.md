# Phase D6 · Admin jobs index runbook

> **Status:** built. First rebuild-side admin landing that makes the D4 evidence and D.5 snag surfaces actually discoverable from the new sidebar.
>
> **Read alongside:** [phase-d5-runbook.md](phase-d5-runbook.md), [phase-d55-snags-runbook.md](phase-d55-snags-runbook.md), [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §6.2 Admin, [27-interface-usability-pass.md](27-interface-usability-pass.md), [31-interface-usability-post-d1-addendum.md](31-interface-usability-post-d1-addendum.md).
>
> Non-numeric filename intentional — sibling of `phase-d2-runbook.md`, `phase-d5-runbook.md`, `phase-d55-snags-runbook.md`.

---

## 1 · What D6 ships

D6 closes the largest Phase D rollout gap: there was no path from the rebuild admin sidebar to the per-job evidence and snags surfaces. Admins had to know the job ID and type `/v2/jobs/<id>/evidence` directly. The `Jobs` sidebar item was labelled UC and linked to `/command-centre`.

| Surface | Change |
| --- | --- |
| `src/app/v2/jobs/page.tsx` | New server component. Gates auth + LH/admin surface access, fetches `/api/jobs?withStats=1` with the V2 counts, hands the list to `<JobsList />`. |
| `src/components/admin/JobsList.tsx` | New client component. Mirrors Phil's row shape (status pill / name / address / when caption) and adds two pending-count chips per row that deep-link into `/v2/jobs/[jobId]/evidence` and `/v2/jobs/[jobId]/snags`. Single search box covers name / address / ref. |
| `src/components/admin/AdminSidebar.tsx` | `Jobs` flipped from UC → live, points at `/v2/jobs`. `Snags` stays UC (a cross-job snag triage queue is a future slice; per-job snags are already reachable through the Jobs index). |
| `api/jobs.js` | `?withStats=1` path extended to compute V2 counts from the same per-job `data.json` already read for legacy stats. New fields: `statsEvidenceV2Pending`, `statsSnagsV2Active`. Zero extra blob reads — same fetch covers both. |
| `src/domains/jobs/schema.ts` | New optional Zod fields on `JobSchema`: `statsEvidenceV2Pending`, `statsSnagsV2Active`, plus the older `statsPct` / `statsOpenSnags` / `statsCrewCount` / `statsAreaCount` / `statsExpiredTags` / `statsExpiringTags` that the legacy API has always returned but were untyped on the rebuild side. `passthrough()` continues to accept the rest of the legacy payload. |
| `scripts/smoke-evidence-routes.js` | Adds `/v2/jobs` to the gated-route smoke (24 checks total). |
| `tests/phase-d-d6-admin-jobs-index.spec.ts` | New Playwright spec — unauth-redirect active test + skipped authenticated flow (same blocker as the rest of the Phase B / D suite waiting for seeded CI test accounts). |

**No vercel.json change.** No legacy route touched. No new public/\*.html. The Phil routes, the per-job evidence + snag routes, and the `/admin/jobs.html` legacy admin shell are unmodified.

---

## 2 · Counts: what each chip means

The two count chips on each row are computed from `jobs/<jobId>/data.json`:

| Chip | Field | Source | Definition |
| --- | --- | --- | --- |
| **Evidence** | `statsEvidenceV2Pending` | `data.evidence[]` filtered by status | Count of evidence rows in `submitted` or `pending_upload` — the items still waiting for admin review. Excludes `reviewed`, `rejected`, `failed`. |
| **Snags** | `statsSnagsV2Active` | `data.snagsV2[]` filtered by status | Count of snags in `open`, `in_progress`, or `resolved` — the lifecycle states that still need action. Excludes `verified`, `closed`, `rejected`. |

When the data.json read fails, both counts fall back to `0` — the row stays clickable, the admin lands on the per-job page either way. The chip is highlighted (navy background, yellow count badge) when the count is > 0 so the eye picks out jobs with pending work without filtering.

---

## 3 · Permissions

Same gate as the rest of `/v2/jobs/*`:

| Role | Page | Counts | Click-through |
| --- | --- | --- | --- |
| unauth | 307 → `/v2/login?next=/v2/jobs` | — | — |
| `client` | 307 → `/v2/login` (middleware) | — | — |
| `tradie` / `apprentice` | 307 → `/v2/login` (middleware) | — | — |
| `leadingHand` | 200, same list | yes | per-job pages render their own read-only badge |
| `admin` / `boss` / `owner` / `manager` / `office` | 200, same list | yes | full actions on per-job pages |

The list itself is the same for LH and admin — the read-only restriction is enforced inside the per-job evidence + snag pages, mirroring the precedent set by the D4 evidence page.

---

## 4 · UX rules followed

Per [27-interface-usability-pass.md](27-interface-usability-pass.md):

- **One primary action per row** (open the job — both the title cell and the chevron link to the evidence surface, with snags as a peer chip).
- **Status visible, count visible** — the pill plus the two count chips give a one-glance state read.
- **No fake metrics** — chips show real V2 counts from the same data.json the per-job pages render. When stats enrichment fails, the chip count is `0`, not a fabricated number.
- **No dense admin table** — single search input, scannable rows, no multi-column sort UI in the first cut.
- **UC discipline** — `Snags` sidebar item stays UC because the cross-job triage queue is a future slice; per-job snags are reachable through the Jobs index.
- **No legacy shadowing** — `/admin/jobs.html` continues to serve from `vercel.json` rewrites unchanged. This is parallel, not a cutover.

---

## 5 · Open questions / future work

1. **Cross-job snags triage queue.** A top-level `/v2/snags` surface that lists every active snag across every job (filterable by priority, assignee, status). Sidebar `Snags` UC stays until that ships.
2. **Activity feed.** Original Phase D plan had a `/admin/activity → /activity` cutover (doc 25 §D5). Not in D6 scope. Lives on the audit-log infrastructure the snag + evidence loops already feed.
3. **`/admin/jobs` cutover.** Promoting `/v2/jobs` to the canonical `/admin/jobs` URL via `vercel.json` is deferred — quarantining the 4,772-line `public/admin/job.html` legacy surface is a separate hardening pass.
4. **Sort + filter.** The current single-search filter covers the ~5–20 active jobs admins manage today. If active-job count grows, add a status filter (`Active / On hold / Complete`) and a "pending-only" toggle.
5. **Bulk evidence review.** Per-job page already supports the queue selection; cross-job bulk review would belong on this index, not on a per-job page. Future slice if it comes up.

---

## 6 · Field test script

Run after merge + production deploy (`npm run smoke:evidence-routes <prod-url>` should return 24/24 pass).

Admin path:

1. Log in as admin.
2. From any rebuild admin page, click **Jobs** in the sidebar. Land on `/v2/jobs`.
3. Confirm the list shows active jobs (archived hidden).
4. Type into the search box — filter narrows by name / address / ref.
5. Confirm each row shows:
   - status pill on the left
   - job name + address
   - timestamp caption on the right
   - **Evidence** chip with count (highlighted navy when > 0)
   - **Snags** chip with count (highlighted navy when > 0)
   - "All clear" caption when both counts are 0
6. Click the **Evidence** chip on `birdwood-iv3232` — land on `/v2/jobs/birdwood-iv3232/evidence` with the queue rendered.
7. Back to `/v2/jobs`, click the **Snags** chip on `birdwood-iv3232` — land on `/v2/jobs/birdwood-iv3232/snags`.

LH path:

1. Log in as LH on a single job.
2. Open `/v2/jobs` — list shows only the jobs the LH is assigned to (server-side filter at `api/jobs.js:188-195`).
3. Open the **Evidence** chip on the assigned job — page renders with the read-only badge (no action buttons in the queue or drawer).

Regression:

- `/phil/jobs` still works (D1) — Phil-side untouched.
- `/v2/jobs/[jobId]/evidence` + `/v2/jobs/[jobId]/snags` still work — same page, just discovered from the new index.
- `/admin/jobs.html` still 200s through `vercel.json` rewrites — no rewrite changed.
- `/command-centre` still 200s for admin — its content is unchanged.

---

## 7 · Known limitations

1. **No cross-instance stats freshness.** The V2 counts come from the same 5s blob cache as the legacy stats; an admin who has just transitioned a snag may see a slightly stale count for up to BLOB_TTL_MS. The same race the D5 drawer-history retry covers — but the count is informational here, not load-bearing.
2. **`statsOpenSnags` legacy stays.** The list still surfaces the legacy `statsOpenSnags` field for any future consumer; the rebuild surfaces use `statsSnagsV2Active`. Both will coexist until the legacy snags namespace is decommissioned (a Phase F+ decision).
3. **No bulk action on the index.** Bulk review / bulk close lives on the per-job page. The index is purely a navigator.
4. **Search is case-insensitive substring, not fuzzy.** Plenty for ~20 jobs; revisit if the list scales past ~100.
