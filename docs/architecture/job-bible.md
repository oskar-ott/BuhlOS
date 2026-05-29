# Job Bible foundation (PR 8)

> Status: **foundation, real.** Generic per-job hub that works for **any** job
> in `jobs.json`. The "100 Arthur" job is named in the product brief as the
> proving job — at the time PR 8 shipped, **no 100 Arthur data exists in the
> repository** (see §3). The foundation is shaped so that when 100 Arthur is
> imported into `jobs.json` + `jobs/<id>/data.json` + `jobs/<id>/plans-index.json`,
> it lights up immediately without UI changes.

## 1. What the Job Bible is

A *job bible* in a construction business is the single page where the office
or a leading hand can answer "what's going on with this job, what's
outstanding, and what does the field need from me." Today BuhlOS supplies
several **per-job surfaces** wired to real data, and PR 8 adds one more
(Observations) plus opens the door for richer ones as they ship:

```
/v2/jobs/[jobId]                                    ← hub (header + site context + section nav)
/v2/jobs/[jobId]/evidence                           ← evidence review
/v2/jobs/[jobId]/snags                              ← per-job snags
/v2/jobs/[jobId]/itps                               ← per-job ITPs
/v2/jobs/[jobId]/documents                          ← per-job documents / plans
/v2/jobs/[jobId]/observations                       ← NEW (PR 8): per-job observations slice
```

PR 8 explicitly does NOT add a 100-Arthur-specific page. The same routes work
for `birdwood-iv3232` (the existing real test job) and for any future job
imported by an admin.

## 2. What PR 8 adds

- **`/v2/jobs/[jobId]/observations`** — server component, parallel-fetches
  `/api/jobs?id=&lt;id&gt;` and `/api/observations?jobId=&lt;id&gt;`, renders the
  existing `ObservationsInbox` client component pre-filtered to one job. The
  `Job` filter dropdown is hidden (one job only); the triage/convert action
  surfaces are gated on `isAdminRole(role)` — a leading hand assigned to the
  job can VIEW + filter, but only admin-tier can mutate (matches the API).
- **`JobInterfaceSectionNav`** gains a live `Observations` row pointing at the
  new sub-route, between Snags and ITPs.
- **`ObservationsInbox`** is now reusable in two modes via two new props:
  - `actionsEnabled` (default `true`) — hide the triage / priority / resolve /
    convert sections when the viewer can't mutate. Replaced with a small
    read-only banner pointing at `/observations`.
  - `showJobFilter` (default `true`) — hide the Job filter dropdown in
    job-scoped contexts.

## 3. The 100 Arthur situation (honest)

The product brief points at **100 Arthur** as the proving job for Job Bible.
At PR 8 ship time, the following greps across the repo (json/md/ts/tsx/js/
html/txt, excluding node_modules/.next/.git/.claude) returned **zero matches**:

```
100 Arthur · P25-014 · FITILLION · FF&E · FFE schedule · signage schedule ·
door schedule · door legend · 25275N-F00 / -F01 / -F10 · Buhl Electrical Scope
```

100 Arthur is *not in the repository.* There IS a `~/Downloads/buhlos-phil/`
directory and an `FF&E 002` PDF in Downloads, but those are local-only files
and not under version control. Per the [non-fake feature rule][feedback],
PR 8 does **not** fabricate 100 Arthur fixtures, sample tasks, or summary
strings.

[feedback]: ./00-rebuild-non-negotiables.md

## 4. How the foundation accepts 100 Arthur data

When the office is ready to import 100 Arthur, the following slots already
exist and will surface immediately on `/v2/jobs/<id>` with no UI change:

| Field | Surface (today) | Imports from |
| --- | --- | --- |
| `job.name`, `job.ref`, `job.typeName`, `job.status` | header card | jobs.json |
| `job.siteAddress`, `siteContact*`, `accessNotes`, `parkingNotes`, `safetyNotes`, `inductionRequired` | Site context card | jobs.json |
| `job.areaGroups[]` (rooms / levels), `roughInTasks`, `fitOffTasks` | already used by Phil + evidence/snag pickers | jobs.json |
| Plans (FF&E, signage, doors, install spec, electrical drawings) | Documents section (with `statsDocumentsCurrent` stats) | `jobs/<id>/plans-index.json` |
| Evidence / Snags / ITPs / Observations on this job | sub-route per section, with attention counts on the hub | per-job `data.json` + `observations.json` + audit-log |
| Site truth (blockers, plan mismatch, material requests, RFIs, variations) | `/v2/jobs/<id>/observations` (PR 8) + cross-job inbox | observations.json |

Fields the schedules / scopes WILL fit into:

| Schedule | Imports into | Behaviour today (no data) |
| --- | --- | --- |
| FF&E schedule | one or more rows in `plans-index.json` (`docType='ffe'` or similar) | Documents section shows zero rows; the section is live. |
| Signage schedule | same as above (`docType='signage'`) | Same. |
| Door schedule / Door legend | same (`docType='doors'`) | Same. |
| Fitillion install spec | same (`docType='spec'`) | Same. |
| Electrical drawings F00/F01/F10 | same (`docType='drawing'`) | Same. |
| Buhl Electrical Scope Summary | could be a single drawing-level note OR an area-group note; choose at import time | Same. |

A separate "specs / references" sidebar is **not** built — until the import
mechanism is defined, it would be a guess. The Documents section IS the
honest surface for now.

## 5. Closeout / readiness

Not built in PR 8. Per the brief: "only real or clearly under construction."
The closest real signal today is the **Command Centre Attention strip**
(PR 7) — open observations + open snags + ITPs awaiting sign-off all
already contribute to that view. A per-job readiness score that combines
those signals is the natural next step, and lives well as an addition to
the hub header (e.g. a `JobReadinessCard`) once the office decides what
"ready" means for them.

## 6. Phil-side Job Bible

Phil already has `/phil/jobs/<id>` (PhilJobDetail). PR 8 makes **no Phil-side
changes** — the worker still gets the simple job detail with capture / area
drill-in / hours / gear / current plan / evidence + snag visibility. A
worker doesn't need the full Job Bible; they need the next thing to do on
this job. The cross-route Observations work landed in PR 4 (Phil classify
capture) and PR 3 (job-linked observations are filterable in the inbox).

## 7. Honest backlog (not built in PR 8)

- 100 Arthur data import (no data exists; needs an office decision on import
  format — see §4 for the slots).
- `JobReadinessCard` on the hub.
- Per-job observation **count chip** on the SectionNav row (the count chip
  pattern requires a stat field; today the API doesn't enrich the job with
  observation counts. Adding `statsObservationsNeedsAction` is a small
  follow-up that means an extra Blob walk in `api/jobs.js#withStats=1`.)
- Phil-side per-job observations panel (today the worker sees observations
  they raised in the inbox they shared with the office; a job-scoped
  per-job view on Phil hasn't been requested).
- Cross-job materials / RFI / Variation modules — explicitly deferred.

## 8. Cross-references

- `src/app/v2/jobs/[jobId]/page.tsx` — the hub.
- `src/components/admin/JobInterfaceSectionNav.tsx` — section list.
- `src/app/v2/jobs/[jobId]/observations/page.tsx` — PR 8 sub-route.
- `src/components/admin/ObservationsInbox.tsx` — reused client (now accepts
  `actionsEnabled` and `showJobFilter`).
- `docs/architecture/observations.md` — observations model + relationships.
