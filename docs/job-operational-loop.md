# Job operational loop — BuhlOS job hub Overview

_Feature: `feat/job-operational-loop-v1`. Surfaces what is actually happening on
a job on the admin Job hub Overview (`/v2/jobs/[jobId]`), so Tom/admin can open a
job and read its operational state without diving into each tab._

The Overview now renders three read-only operational cards under the existing
Status (PR #87) and "What the field sees" (PR #88) cards:

| Card | Question it answers | Real data source | Deep-links to |
| --- | --- | --- | --- |
| **Labour** | What hours are waiting for me to approve on this job? | `GET /api/time-entries?scope=approver&status=submitted`, allocations filtered to this job | `/hours/approvals` |
| **Evidence** | What photos/notes have come in, and what needs review? | `GET /api/evidence?jobId=<id>` (persisted per-job in `jobs/{id}/data.json`) | `/v2/jobs/[id]/evidence` |
| **Recent activity** | What just happened on this job? | `GET /api/audit-log?jobId=<id>&scope=job&months=4` (append-only audit-log) | `/v2/jobs/[id]/history` |

All three load in parallel in `loadJobInterface` (`src/app/v2/jobs/[jobId]/page.tsx`)
via `Promise.allSettled`: the job fetch gates the page, the three operational
fetches are best-effort and each degrades to its own card's error state.

## What is real (shipped here)

- **Labour** — every number is real time-entry data. The card sums the
  `allocations[]` that point at this job across the approver SUBMITTED queue and
  shows: hours awaiting approval, entry count, latest submitted date, and a
  per-worker breakdown. Pure derivation in `src/domains/jobs/job-hours.ts`.
- **Evidence** — evidence is fully persisted per-job (Vercel Blob,
  `jobs/{id}/data.json`). The card shows totals by status
  (`submitted`/`reviewed`/`rejected`), distinct workers, the latest capture, and
  a "missing context" count (captures not linked to a task/area/stage). Pure
  derivation in `src/domains/jobs/job-evidence.ts`.
- **Recent activity** — the append-only audit-log (`api/_lib/audit-log.js`) is a
  real event store already consumed by the full history feed. The card reads the
  SAME per-job endpoint and trims to the newest five. Selection helper in
  `src/domains/jobs/job-activity.ts`.

Nothing is fabricated: empty inputs yield honest empty states
("No hours are awaiting approval on this job", "No evidence captured for this job
yet", "No recent activity yet"), and a job's own data is the only source.

## What is deliberately deferred (and why)

- **Full hours ledger on the Overview** (total logged / approved / rejected /
  weekly totals). Time entries are stored per-user-per-day with **no per-job
  index**, so `scope=approver` is one full user-blob scan per status. A full
  rollup would mean ~3 cross-job scans on every hub view. The Labour card is
  therefore scoped to the single most actionable office signal — _hours awaiting
  approval_ — and deep-links to `/hours/approvals` for the complete ledger.
  - The pure `summariseJobHours` helper is already status-agnostic: the day a
    per-job hours endpoint exists (e.g. PR #57's `OverviewByJob`), the same
    helper renders the full breakdown with no maths changes.
- **Hours approval actions** stay on `/hours/approvals`. This card is read-only —
  no approve/reject/edit, no payroll/Xero push. The Phil hours write path
  (`/api/time-entries` POST, attribution, `LogHoursSheet`) is untouched.
- **Evidence review actions** stay on the evidence tab (`EvidenceQueue`). No
  thumbnails wall on the Overview, no global Evidence module/sidebar — evidence
  lives inside the job interface only.
- **A bespoke activity event system.** None was built: the audit-log already is
  the merged per-job event stream. `job-activity.ts` only sorts + limits it.

## Hard constraints honoured

- No change to the Phil hours write path or `/api/time-entries` behaviour.
- No new write endpoints; only existing read-only GETs are consumed.
- No fabricated labour totals, evidence rows, or activity events.
- No global Evidence module; no AI/OCR/markup/client portal/bulk export.
- Auth/role boundaries unchanged — the hub is already admin/LH-gated and the
  cards add no new surface.

## LH scoping note

The Labour card uses the approver scope, so an LH viewing a job sees the hours
they can approve (jobs they lead). The copy is written around _approval_
("awaiting approval"), so an LH on a job they don't lead reads an honest "nothing
awaiting approval" rather than a misleading "no hours logged". Admins see the
full pending picture.
