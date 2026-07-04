# Client portal — foundation (Epic 16 / #271)

> Status: **foundation shipped** (read-only shell + scoped own-jobs list +
> sanitised single-job overview). The curated content modules are the epic's
> follow-on children (see [Deferred](#deferred-curation-children)). This doc is
> the audit + the reuse-vs-replace + linkage decisions the issue's acceptance
> criteria require.

## 1. What shipped

A modern, mobile-first, **read-only** client portal on its own surface:

- **Routes** (registered in `docs/route-ownership.md` §8): `/portal` (the
  signed-in client's own jobs) and `/portal/jobs/[jobId]` (one sanitised job
  overview). Own shell — `PortalShell` (`src/components/portal/`), neither
  `AdminShell` nor `PhilShell`.
- **Dedicated sanitised endpoints** — `GET /api/portal-jobs` (scoped list) and
  `GET /api/portal-job?jobId=` (single job). Both project every job through the
  ONE allowlist in `api/_lib/portal-projection.js`. A client is never served
  raw `/api/data` or the admin job payload.
- **Server-side gating**: middleware gates `/portal` to the `client` role
  (`portal` surface in `src/lib/auth/permissions.ts`); the pages re-check and
  bounce a non-client to `landingFor(role)` and an anonymous visitor to
  `/v2/login?next=`. A client hitting another client's `jobId` gets `404`
  (existence not confirmed), never the data.

Read-only end to end: no write path is added, `canWrite` is untouched, and
clients remain read-only by construction (`api/_lib/auth.js`).

## 2. The client → job scoping key (single source of truth)

**`job.clientUserId === me.id` is the single source of truth** for the client
→ job linkage, and the portal uses only it.

The pre-existing estate had a DUAL linkage (audited on #271):

- `job.clientUserId` — set by `createClient` (`api/users.js`) and editable in
  the builder (`api/jobs.js`, `api/job-draft.js`). Gates `/api/jobs`,
  `/api/client-update`, `/api/client-jobs-summary`, `/api/job-timeline`,
  `/api/job-circuits`, `/api/job-itps`.
- `users.json.assignedJobIds` — also set once by `createClient`, and the field
  that lets a client pass the `requireAuth({ jobId })` gate on **raw
  `/api/data`** (`api/_lib/auth.js`).

Nothing syncs them: re-linking a job's client in the builder updates
`clientUserId` but leaves the old client's `assignedJobIds` intact — a stale
raw-data access hazard.

**Decision:** the portal's own endpoints key **exclusively** on `clientUserId`
and never consult `assignedJobIds`, so re-linking a job immediately re-scopes
the portal with no stale access. The portal introduces **no** dependence on
`assignedJobIds` for client visibility. Closing the raw-`/api/data`
`assignedJobIds` seam for the `client` role (so the stale-access hazard is gone
platform-wide) is called out below as a follow-up — the portal itself does not
need `/api/data`, so nothing in this foundation relies on it, but the seam
remains until that follow-up lands.

## 3. Audit of the client-reachable seams (keep / sanitise / close)

The eight seams a `client` session could reach before this work, and the ruling
each gets. (Reuse-vs-replace: the modern portal **replaces** the legacy
`public/client.html` consumption pattern; it does **not** reuse the legacy
sanitised endpoints, which compute progress with the pre-#198 per-area
averaging math that now disagrees with production `/v2/jobs`.)

| # | Seam | Today | Ruling |
| - | --- | --- | --- |
| 1 | `GET /api/jobs` (scoped list + single) | scopes clients to `clientUserId`, excludes draft/archived/complete | **Keep** — correct; not consumed by the portal (the portal uses its own endpoints) |
| 2 | `GET /api/data?jobId` | raw dwellings + BOTH snag arrays + evidence + notes; client admitted via `assignedJobIds` | **Close (for clients)** — the uncurated-truth leak. The portal never calls it. Removing client reachability is a follow-up (see §4); the portal's foundation does not depend on it. |
| 3 | `GET /api/client-update?jobId` | sanitised weekly summary; ownership `clientUserId`; #386 draft/archived 404 | **Keep as-is (superseded for portal)** — the portal does not consume it (progress math is pre-#198). Left working for any legacy `/client` use until cutover. |
| 4 | `GET /api/client-jobs-summary` | multi-job rollup; #386 already excludes draft/archived for clients | **Superseded** by `/api/portal-jobs` (canonical #198 progress). Left working for legacy `/client` until cutover. |
| 5 | `GET /api/job-timeline?jobId` | sanitised client stream (`clientVisible` filter) | **Keep, don't consume** — not needed by the foundation; a candidate source for the #274 live-progress child. |
| 6 | `GET /api/job-circuits` (GET) | clients admitted via `clientUserId` | **Close (recommend)** — nothing in the portal plan needs circuits; an undocumented client seam. No portal dependence. |
| 7 | `GET /api/job-itps` (GET) | clients admitted via `clientUserId`; returns **raw ITP instances** (internal check detail, actor names) | **Close (recommend)** — raw internal detail; the portal must never expose it. No portal dependence. |
| 8 | `PUT /api/notification-prefs` | self-prefs; the one existing client write | **Keep** — self-only, out of scope; read-only portal adds no write path. |

Seams 2, 6 and 7 are **recommended to close for the client role** in a
follow-up; the portal foundation adds no reliance on any of them, so closing
them later touches only those endpoints, not the portal.

## 4. The conservative allowlist (what the portal exposes — and excludes)

Enforced in ONE place: `api/_lib/portal-projection.js` (`projectJobForClient`),
mirrored by the response schema in `src/domains/client-portal/schema.ts`. A
fresh object is built — the raw job is never spread — so anything off the list
is absent by construction.

**Exposed:**

- `id` — needed to open the job
- `name` — the job name
- `siteAddress` — the client's own site address
- `status` — high-level; only `active` jobs are ever projected for a client
  (draft/archived/complete are filtered upstream **and** defended in the
  projection)
- `progressPct` — overall completion %, from the **canonical pooled task
  counts** (`api/_lib/job-tasks.js` `jobTaskCounts`, the #198 definition
  production `/v2/jobs` uses), or `null` when the job has no checklist yet
  (the UI renders "Not started", never a fake 0%)
- `stageLabel` — a coarse phase word (`Not started` / `In progress` /
  `Complete`) **derived** from `progressPct`; not stored, not fabricated

**Deliberately excluded** (left out on the "when unsure, leave it out" rule):
money / margin / costs / quotes; internal, access and parking notes; assignee /
crew / worker names or any worker PII; raw dwellings, task detail, evidence,
snag descriptions, observations, RFIs, ITP instances, diary, plans; `job.ref`
(internal office reference); `clientUserId`; dates; job type (a content
decision deferred to a later child).

## 5. Legacy `/client` — untouched; cutover deferred

`public/client.html` and its `/client` + `/client/jobs/:jobId` vercel.json
rewrites are **left working, untouched**. Per route-ownership §12.1 the cutover
(retire `client.html`, the two rewrites, `theme.css` + `css/buhlos.css`, flip
`landingFor(client)` from `/client` to `/portal`, and update
`check-legacy-quarantine`) is a **separate final PR** — deliberately not done
here. Until then a client still LANDS on `/client` and reaches `/portal` by
navigation; both work.

## 6. Follow-ups (not built here)

- **Close the raw-`/api/data` client seam** (audit seam 2) + circuits/ITPs
  (seams 6, 7) for the `client` role, and drop the `assignedJobIds` linkage for
  clients so `clientUserId` is the sole gate everywhere.
- **The `/client` cutover PR** (route-ownership §12.1).
- Client accounts have **no email field** today (`createClient` is
  username + PIN) — relevant to #301 / #312 (magic-link / multi-contact).

### Deferred curation children

The foundation intentionally stops at the conservative overview. Each content
module is a named epic child — **do not build them into the foundation**:

- **#274** — live progress detail
- **#277** — photo gallery
- **#287** — documents
- **#279** — variation approve/decline (the ONLY client write; separate issue)
