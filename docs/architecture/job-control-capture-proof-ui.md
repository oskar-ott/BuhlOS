# Per-requirement Capture proof (Phil)

> Status: **real, worker-facing loop closer.** Builds on L2/L3 (#467), L4 (#468),
> and the revision guard (#469). Code: `src/components/phil/jobControlEvidenceLinkClient.ts`
> + a contextual action in `PhilTaskScopeContext.tsx`, wired through
> `PhilJobAreaDetail` → `PhilJobDetail` → the Phil job page.

## Why

L2/L3 made Phil show "proof needed"; L4 + #469 made the server able to link a
proof to a requirement (with a stale-write guard). This slice closes the field
loop: a worker can capture proof for a specific required item and have it flip
needed → met — **without any new Phil navigation or a Capture redesign**.

## The loop

```
Phil shows "proof needed" (unmet requirement)
  → worker taps "Capture proof" (inside the existing per-task context disclosure)
  → the EXISTING CaptureSheet opens, scoped to that task's area/stage
  → on save it returns the real EvidenceItem id (onCaptured)
  → POST /api/job-control/evidence-link { jobId, workPackageId, requiredEvidenceId,
       evidenceId, expectedJobControlRevision }
  → on 200, the link is reflected in local evidenceLinks → buildAreaTaskContext → met
```

## Design (smallest reuse)

- **No new capture UI.** It reuses the existing `CaptureSheet` (already
  pre-scopeable via `initialContext` and already calls back `onCaptured(evidenceItem)`
  with the saved id). No Capture redesign, no new tab/page/nav.
- **`jobControlEvidenceLinkClient.ts`** — `linkRequiredProof(input, fetch?)` POSTs
  the link and maps the response to `linked | stale | invalid | unauthorized | error`.
  `applyProofLinkResult(result, ctx)` is a PURE mapper to local state changes.
- **`PhilTaskScopeContext`** renders a small "Capture proof" button per **unmet**
  requirement, ONLY when a handler + a current revision + a `workPackageId` exist
  (else the row stays read-only — never a broken action). Site-language statuses
  (no raw ids): "Saving…", "Evidence saved but not linked. Try again.", "Proof
  list changed. Refresh and try again.", "Couldn’t link. Try again."
- **`PhilJobDetail`** owns the orchestration: `evidenceLinks` and the revision are
  client state; on "Capture proof" it opens the scoped CaptureSheet and remembers
  the target; in `onCaptured` it links the saved id and, **only on a confirmed
  200**, appends the link (→ met) and advances the revision.

## Revision handling (#469)

The Phil read exposes `meta.revision`; the page now forwards it. The link call
sends it as `expectedJobControlRevision`. On `409 stale_revision` the worker sees
"Proof list changed. Refresh and try again." — the proof is **not** marked met.
When no revision is available the affordance is hidden (no write without a
precondition).

## Failure behaviour (never fakes met)

| Step | Outcome |
|---|---|
| evidence save fails | `CaptureSheet.onFailed` fires (not `onCaptured`) → link never called; existing failure banner; pending target dropped |
| link fails after save | "Evidence saved but not linked. Try again." — proof stays needed |
| stale revision | "Proof list changed. Refresh and try again." — proof stays needed |
| invalid target / missing artifact | "Couldn’t link. Try again." — proof stays needed |
| success (200) | link appended locally → requirement shows met |

`met` is reflected **only** after the link route confirms — never optimistically.

## Deliberately not built

No new Phil nav/tab/page, no Capture redesign, no evidence-storage change, no job
task mutation, no compile/reconcile, no variation release, no #244, no Supabase,
no `api/evidence.js` / `api/_lib/blob.js` / Vercel change.

## Tested vs. needs field validation

Unit-tested: the link client (status mapping, sends the real evidenceId +
revision, never fabricates an id), the pure result→state mapper (met only on
linked; stale/invalid/error never met), and the `PhilTaskScopeContext` affordance
gating + statuses. **The one seam not unit-covered is the real device capture →
`onCaptured` glue** (the existing CaptureSheet) — exercised by the next step:
real compiled-job field validation (needed → capture → link → refresh → met).
