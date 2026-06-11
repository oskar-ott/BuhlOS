# Phil hours — job attribution

_Status: shipped in `fix/phil-hours-job-attribution`. Scope: field hours job attribution only — not payroll, Xero, reports, rostering, stage/task allocation, or GPS._

## The rule

A field worker must not submit job-attributable hours with `jobId: null` when
they have **active assigned jobs**. Modern Phil (`/phil/my-day` →
`LogHoursSheet`) now ties each submission to a real active assigned job.

| Worker's active assigned jobs | Behaviour |
| ----------------------------- | --------- |
| **One** | Preselected and shown ("Assigned job"). Standard Day stays one tap. |
| **Multiple** | A required choice — submit is blocked until one is picked. |
| **Zero** | Submit blocked with: _"No active assigned job. Ask the office to assign you to a job."_ No fake/overhead job is invented. |
| **Failed to load** | Submit blocked until jobs load (never falls back to an unattributed entry). |

The selected `jobId` flows into `allocations[0].jobId` for both the **Standard
Day** and **Custom Hours** payloads (`buildStandardDayPayload` /
`buildCustomHoursPayload`). There is no top-level entry `jobId` — attribution
lives on the allocation, and `primaryJobId()` reads it back.

## Source of truth

Assigned jobs come from **`users.json.assignedJobIds`** — the same source Phil
already uses for job visibility. `/api/jobs` (GET) scopes a field caller to
their `assignedJobIds` and strips `draft`/`archived` server-side
(`api/jobs.js`); My Day re-applies `isVisibleToField()` as defence-in-depth.

A job is a **valid attribution target** for a field worker iff:

- `users.json.assignedJobIds` (for that worker) includes `job.id`, **and**
- `job.status` is not `draft` and not `archived` (i.e. `isVisibleToField`).

Do **not** attribute to: `job.crew` alone, the onboarding employees register,
localStorage, mock/static job lists, or draft/archived jobs.

## Server enforcement

`POST /api/time-entries` (`handleCreate`) **and** `PATCH /api/time-entries`
(`handlePatch`, the edit/resubmit path) reject (`403`) a **field self-submission
/ self-edit** whose non-null allocation `jobId` is not an active job the worker
is assigned to (arbitrary, unknown, unassigned, draft, or archived). Both paths
share one gate (`fieldAllocationGateError`), so create and resubmit enforce the
same rule — previously the Phil UI was the only guard on the PATCH path.

Deliberately scoped:

- **Admin / leading-hand and on-behalf flows keep their existing latitude** —
  the gate only applies to non-delegated `isFieldRole` submissions and
  self-edits.
- **PATCH is only gated when the body actually sends `allocations`** — a
  notes-only edit of an entry whose job has since been archived still works;
  untouched allocations keep their original (already-validated) attribution.
- **A `null` jobId is still accepted server-side** for backward compatibility
  (legacy `public/phil.html`, existing records, future overhead). The Phil UI
  is what prevents a new `null` submission when active jobs exist.
- **PR #64 protections are untouched**: self-approval stays blocked, the PATCH
  allowlist stays strict, unknown roles stay denied, and the
  approve/reject/bulk routes are not modified.

## Backward compatibility

Existing entries with `allocations[].jobId === null` are **legacy /
exception** state. They are not rewritten. They render as **"No job assigned"**
(flagged amber) in the admin approvals queue and remain fully
approvable/rejectable under the existing rules. This change only prevents new
_avoidable_ unattributed records.

## Non-goals (explicitly deferred)

- **Overhead / "no job" hours**: not added — no existing explicit overhead mode
  exists, so zero-assigned-jobs blocks submission rather than defaulting to
  overhead.
- **Server-side `null`-block for field roles**: deferred to avoid breaking the
  legacy Phil surface mid-rollout (UI-enforced for now).
- ~~**PATCH (rejected-hours edit) attribution validation**~~: **done** — the
  edit/resubmit path now runs the same gate as create (see Server enforcement).
- **Needs Attention "unattributed hours" warning item**: small but additive
  with a de-dup design choice — deferred; the core fix stops new unattributed
  hours, and attributed hours now group by job for free.

## Future

- Stage/task attribution on a time entry (the allocation already carries
  `notes`; stage/task would extend it).
- In-Phil rejected-hours correction loop (today defers to legacy My Day).
- Job-costing reports off attributed allocations.
- Xero / payroll export mapping (NOT built — attribution is a prerequisite).
