# Phil — fix & resubmit a rejected hours entry

_Branch `feat/phil-hours-rejected-resubmit`. Built on the #92 safe-hours
foundation and reviewed against current `main` after #95. The one
genuinely-missing Phil hours feature #57 promised, kept separate because it
touches the attribution-sensitive write-path UI._

## Why this exists

#92 ("safe Phil/admin hours foundation") deliberately **deferred** the in-place
rejected→resubmit flow (see `docs/buhlos-hours-safe-foundation.md` → "What was
deliberately NOT carried forward"). Before this PR, a worker whose hours were
rejected saw the reason in Phil but was sent to the **legacy** app to fix them
(`/phil/hours` showed an "Edit rejected entry" under-construction panel pointing
at `/my-day`; `LogHoursSheet`'s status line said "the in-Phil edit flow is still
being built"). This PR makes that loop work inside Phil.

## What it does

On **`/phil/hours`**, each **rejected** entry now has an in-place
**"Fix rejected hours"** form (`RejectedHoursResubmitSheet`). The worker sees the
rejection reason, edits the hours (and, if needed, the job and a note), and taps
**"Submit correction"**. That PATCHes the existing entry to `submitted`.

The two "Fix & resubmit →" affordances already on `/phil/my-day` (the rejected
AttentionBanner and the recent-entries list) deep-link here, so the loop is now
complete end-to-end without changing `/phil/my-day`. `LogHoursSheet` keeps its
create-path behaviour but refreshes the rejected-status copy so it points to
Hours history instead of saying the in-Phil flow is still being built.

## API / client path (no API change)

- **Client:** `timesheetsClient.editOwnEntry(date, payload)` →
  `PATCH /api/time-entries?date=YYYY-MM-DD` with `status: "submitted"`.
- **Server (unchanged, already on `main`):** `handlePatch` allows a self-edit of
  one's own entry and the `rejected → submitted` transition; it clears
  `rejectedReason` and stamps `submittedAt`. Approved/exported entries stay
  locked behind admin reopen; `approved`/`rejected` target statuses are refused
  (those go through the dedicated approve/reject endpoints).
- **No `api/*.js` is modified.** This is a UI + pure-helper slice only.

## Attribution invariant (the #77/#80/#81 guarantee)

A field worker with active assigned jobs must never (re)submit `jobId: null`.
The server's PATCH path does **not** re-run the create-path field-attribution
check, so — exactly as on the create path — the **Phil UI is the guardrail**:

- `resolveResubmitJob()` (pure, unit-tested) only resolves to a real, currently
  **assigned** job; otherwise it blocks with an honest reason (jobs failed to
  load · no assigned job · pick one).
- `buildResubmitPayload()` takes a **non-null `jobId: string`**, so a null job
  cannot be encoded onto the wire.
- `resubmitInitialJobId()` preserves the original job when still assigned,
  auto-selects the sole assigned job, and otherwise forces an explicit pick
  (never auto-picks among multiple jobs — the rule #92 protected when it dropped
  `pickDefaultJobId`).
- Submit is disabled until attribution resolves; `jobsError` blocks rather than
  degrading to an unattributed entry.

`/phil/my-day`, the attribution validator
(`src/domains/qa/time-entry-attribution.ts`) and the field-readiness smoke are
**unchanged**. `LogHoursSheet` only receives the copy refresh noted above; its
submit payload, job attribution guard, and create-path behaviour are unchanged.

## Scope / limitations

- **Single-allocation only** (`canResubmitInPhil`): the Phil-native one-job-per-
  day shape. A multi-allocation (legacy/admin split) rejected entry shows its
  reason but no in-Phil resubmit, so the single-job form can never silently
  collapse a split day.
- After a successful resubmit the surrounding list is server-rendered, so the
  form shows a success banner with a **Refresh status** button rather than live-
  mutating the list.
- **Known follow-up — CLOSED 2026-07-26 (owner-directed):** the PATCH path now
  rejects `jobId: null` allocations from a field self-edit server-side (same
  403 shape as the active-job gate in `api/time-entries.js`), so the UI is no
  longer the sole guard on edits. The create path keeps its backward-compat
  null acceptance (legacy/overhead), where the Phil UI remains the guard.
  The same owner direction extended this sheet to SUBMITTED (undecided)
  entries — "Change these hours" / "Change & resend" — because a worker can
  fix a sent day until the office decides; content edits of a submitted entry
  are journalled as `hours.edited_while_submitted`.

## Tests

- `src/domains/timesheets/resubmit.test.ts` — pure helpers: provenance
  preservation, block-on-missing-job, multiple-requires-pick, jobs-load-failure
  block, never-null payload, ordinary/OT split, success/error feedback mapping.
- `src/components/phil/RejectedHoursResubmitSheet.render.test.tsx` — SSR render:
  collapsed trigger, open form with reason + job, multiple-jobs "pick one",
  jobs-error / no-jobs blocked states, and no admin/payroll controls.
- `src/components/phil/LogHoursSheet.render.test.tsx` — verifies rejected-status
  copy points workers to Hours history and no longer says the in-Phil flow is
  still being built.
