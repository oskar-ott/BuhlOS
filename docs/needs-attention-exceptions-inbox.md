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
| Active job, no crew (`statsCrewCount===0`, PR #67 source of truth) | "{job}: active but no field workers assigned" | **critical** | `/v2/jobs/{id}/builder` |
| Draft job (`status==='draft'`) | "{job}: draft, not published" | info | `/v2/jobs/{id}/builder` |
| Material requests (`requested`/`approved`) | "{job}: {item} ({status})" | urgent→critical / high→warning / else info | `/material-requests` |

Ordering is deterministic: **critical → warning → info**, then oldest first,
then id.

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
