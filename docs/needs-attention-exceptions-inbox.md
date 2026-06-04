# Needs Attention — Exceptions Inbox (Phase 1)

> Status: **foundation shipped** (`feature/observations-exceptions-inbox-foundation`).
> A **projection**, not a new source of truth. Not reports, not Xero, not QR, not
> AI, not material ordering, not a ticketing system.

## 1. What it is

The office answer to *"what needs attention today?"* — an itemised, actionable
list rendered on the BuhlOS **Command Centre** (`/command-centre`) under a
**"Needs attention"** section, beneath the existing count-card scan.

Each item says **what happened · which job · why it matters · the next action**
(a canonical internal link back to the source surface). Example:
*"Bravo: active but no field workers assigned → Assign workers."*

## 2. Projection, not a store

`ExceptionItem`s are derived **deterministically** from existing, already
permission-gated source records. The inbox **stores nothing**, mutates nothing,
and exposes **no raw source records or secrets** — it builds minimal items and
links to the canonical source. The inbox is *not* a second source of truth; the
source (hours, snags, observations, …) stays authoritative.

- Domain: `src/domains/exceptions/` — `ExceptionItem` type, source `mappers.ts`,
  `service.ts` (`buildExceptions` / `filterExceptions` / `summariseExceptions` /
  `isSafeActionHref`). Named `exceptions` (not `observations`) deliberately —
  `src/domains/observations` is a distinct field-capture record store that is
  **one source** feeding this projection.
- UI: `src/components/admin/ExceptionsInbox.tsx` (client; list + source/severity/
  job filters + empty/partial states).

## 3. Data flow (no new API, no new route)

The Command Centre's existing `loadSnapshot()` already fetches the sources
server-side **behind the admin gate** (`canAccessSurface(role, "admin")`). The
page calls `buildExceptions(snapshot)` on that already-loaded data and passes the
projected items to `<ExceptionsInbox>`. So this PR adds **no endpoint, no route,
no new permission surface, no extra fetch**.

## 4. Sources included in Phase 1

| Source | Exception | Severity | Action link |
|---|---|---|---|
| Hours — submitted | "Hours from X (date) awaiting approval" | warning | `/hours/approvals` |
| Hours — rejected | "Rejected hours from X need correction" | warning | `/hours/approvals` |
| Observations (open + `requiresAction`) | the observation title, by priority | urgent→critical / high·normal→warning / low→info | `/v2/jobs/{id}/observations` or `/observations` |
| Job evidence (`statsEvidenceV2Pending`) | "{job}: N evidence to review" | warning | `/v2/jobs/{id}/evidence` |
| Job snags (`statsSnagsV2Active`) | "{job}: N open snags" | warning | `/v2/jobs/{id}/snags` |
| Job ITP (`statsItpsNeedsReview`) | "{job}: N ITPs need sign-off" | warning | `/v2/jobs/{id}/itps` |
| Active job, no crew (`statsCrewCount===0`, PR #67 source of truth) | "{job}: active but no field workers assigned" | **critical** | `/v2/jobs/{id}/builder#assigned-field-workers` |
| Draft job (`status==='draft'`) | "{job}: draft, not published" | info | `/v2/jobs/{id}/builder#publish` |
| Material requests (`requested`/`approved`) | "{job}: {item} ({status})" | urgent→critical / high→warning / else info | `/material-requests?focus={id}` |

Ordering is deterministic: **critical → warning → info**, then oldest first,
then id.

## 4a. Action links & states (action hardening)

Every item's "next action" resolves through a **canonical route registry**
(`src/domains/exceptions/routes.ts`). Each entry ties an action to the
**page file that implements it** (`sourceFile`); `routes.test.ts` asserts those
files exist on disk, so *"the link goes somewhere real"* is an enforced,
test-backed contract that catches a future route rename instead of shipping a
broken link. As of this PR **all nine Phase-1 actions resolve to real,
implemented surfaces** — none are fabricated.

`ExceptionItem` carries an honest `actionState` (and `actionReason`):

Every item carries an `actionState`, surfaced as a **badge** beside the action
(`ACTION_STATE_BADGE` in `labels.ts`) so "exact vs fallback vs not-built vs
future" is honest at a glance:

| `actionState` | Badge | Meaning | UI |
|---|---|---|---|
| `available` | **Exact action** (success) | a real registered route, safe encoded internal href | clickable link |
| `fallback` | **Fallback** (warning) | primary deep-link couldn't resolve, but a **real safe parent surface** (e.g. the job hub) is used | clickable link + the `actionReason` shown |
| `unavailable` | **Not built** (neutral) | no safe route at all (no jobId, unknown key, unsafe href, no fallback) | **non-clickable** "— source surface not built" + reason |
| `future` | **Future** (neutral) | a source/workflow intentionally deferred, not broken | **non-clickable** "— coming later, not broken" + reason |

`isActionable` = `available \|\| fallback` (both carry a safe href); `unavailable`
and `future` never render a clickable link. No Phase-1 source currently emits
`unavailable`/`future` (all resolve to `available`); the states + rendering exist
for honesty when a future source's surface isn't built.

Per-job section items (evidence/snags/ITP) pass the job hub as a `fallbackHref`,
so if a section route were ever removed they degrade to `fallback` (the job
surface) rather than breaking. All nine Phase-1 actions currently resolve to
`available`.

**Section anchors (deep-links).** Two job actions deep-link to a precise section
rather than the page top, via `resolveAction(..., { fragment })` (allowlisted
lowercase ids only — never derived from input):

- **no crew → `…/builder#assigned-field-workers`** — the PR #67 assignment panel
  (a sibling on the builder page) carries `id="assigned-field-workers"`, so the
  browser scrolls straight to it.
- **draft → `…/builder#publish`** — `JobBuilderClient` reads the URL hash on mount
  (`tabFromHash`) and opens the matching tab; an unknown hash (e.g. the assignment
  anchor) leaves the default tab untouched.

- **material → `/material-requests?focus={id}`** — `resolveAction(..., { query })`
  appends an **encoded** query string (via `withQuery`); the `/material-requests`
  page reads `?focus=` and opens that request's detail drawer on mount (and
  `?status=`, validated against the real status enum, seeds the status filter).
  Both are **tolerant**: an unknown focus id opens nothing, an unknown status is
  ignored — the page never errors on a missing/garbage query. The actionable
  statuses are **`requested`** (approve/reject) and **`approved`** (place the
  order); `ordered`/`delivered`/`cancelled` are not exceptions. **No ordering /
  PO / supplier / Xero / stock workflow is built or implied** — the inbox links
  to the existing surface; it never mutates a request.

Dynamic segments are `encodeURIComponent`'d **before** the literal `?query` /
`#fragment` is appended (so a jobId/requestId containing `#`/`/`/`?`/space becomes
`%23`/`%2F`/`%3F`/`%20` and can never inject a param or anchor); the combined href
is re-checked by `isSafeActionHref` (internal-only).

**Still deferred (no URL support):** hours-approvals and observations pages are
not URL-filter-driven, so the inbox does not append params they wouldn't honour;
a rejected-hours *review* surface and per-item observation anchors don't exist
yet (rejected hours link to the real approver queue).

`resolveAction(key, params)` builds the href (encoding dynamic segments via
`encodeURIComponent`) and derives the state; it returns a **safe fallback** href
or none — never an unsafe/`available` href. `isSafeActionHref` is hardened:
internal absolute paths only — **rejects** external URLs, any scheme
(`javascript:`/`http:`/…), protocol-relative `//`, backslashes, whitespace and
control chars; printable punctuation like `-` in a jobId is allowed.

## 4b. Operational view — grouping, sorting, summary

The inbox is an operational list, not a KPI dashboard. Pure helpers in
`src/domains/exceptions/{service,grouping}.ts` (all deterministic + tested):

- **Summary** (`getExceptionCounts`): total open · critical count · jobs
  affected · actionable count — shown in the header.
- **Sort** (`sortExceptions`/`compareExceptions`) — explainable + stable:
  1. severity (critical → warning → info), 2. **actionable now** (available,
  fallback) before **waiting** (unavailable, future), 3. oldest `createdAt`
  first, 4. id tiebreaker.
- **Grouping**: `groupExceptionsByJob` (no-job items under **"General"**, last;
  groups ordered by highest severity then name; per-job count + highest severity)
  and `groupExceptionsBySource` (by count desc).
- **Age** (`deriveAgeLabel` + `decorateAges`): relative `ageLabel` ("3h ago",
  "2d ago"), computed in the Command Centre page with a server `now` (kept out of
  the pure mappers so they stay deterministic).
- **Filtering** (`filterExceptions`): source · severity · job · **action
  availability** (actionable/waiting) · **free-text** (title/summary/job).

UI (`ExceptionsInbox.tsx`): a summary header, **view tabs** — All · Needs
action · Waiting · By job · By source — plus source/severity/job/search filters
that refine within every tab. Each row shows severity + source badges, job
context, age, the "why", and the next action (link, fallback link, or muted
state) with an **action-state badge** (Exact action / Fallback / Not built /
Future).
Empty states distinguish **"All clear"** (no open items) from **filters hiding
all items**.

## 5. Sources intentionally deferred

- **Plan markups (PR #68)** — overlays are stored per `(job, plan, page)` with no
  cross-job query; aggregating office-only markups would need N fetches per
  job/plan = overbuild. Deferred until a cross-job markup index exists.
- **Gear** — not loaded by the Command Centre; issue-status semantics need their
  own audit. Deferred.
- Evidence/snags are surfaced as **per-job summaries** (from job stats), not
  per-record items — the only honest projection from the available counts.

## 6. Permission model

The inbox renders **only** inside the admin-gated `/command-centre` page
(`canAccessSurface(role, "admin")` → admin tier: admin/boss/owner/manager/office/
pm/estimator). **Field workers and clients are redirected before render** and
never receive the projected items. The projection consumes only the safe,
hash-free domain types the admin APIs already return; `ExceptionItem` carries
only title/summary/severity/job-context/action — never a raw record or secret.
`isSafeActionHref` guarantees every link is a canonical internal path.

## 7. Known limitations

- Per-job evidence/snag/ITP items are **counts**, not individual records (links
  drill into the per-job surface).
- "Active job, no crew" trusts `statsCrewCount` (server-derived from PR #67
  `assignedJobIds`); if stats are stale the item is too.
- No persistence, so no per-item snooze/dismiss yet (next phase).

## 8. Next phases (NOT built)

Per-item dismiss/snooze (needs a small persistent overlay store), plan-markup +
gear sources, a dedicated `/needs-attention` route if the list outgrows the
Command Centre, "Today / this week" time filter, stale-item indicators. None of
these are implemented or implied complete.

## 9. Cross-references

- Projection: `src/domains/exceptions/*`; UI: `src/components/admin/ExceptionsInbox.tsx`
- Host page: `src/app/(admin)/command-centre/page.tsx` (`loadSnapshot` + `buildExceptions`)
- Sources: `src/domains/{timesheets,observations,jobs,material-requests}`
- Route ownership: [`route-ownership.md`](route-ownership.md) (no route added; the
  Command Centre is the host surface)
