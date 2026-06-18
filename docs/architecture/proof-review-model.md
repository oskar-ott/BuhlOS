# Proof & review model — current state and limits

> **Status:** honest snapshot of `main` @ the per-task-proof arc
> (#463–#473 loop, then #494, #527, #529, #539, #542, #543, #544, #546), plus the
> one still-parked piece (#495, **not merged**). Updated 2026-06-18. The mechanics
> of the capture-proof loop are documented in the job-control series; this doc
> records **granularity, what the review model means, and what is deliberately not
> built yet**. Part of [`task-led-job-architecture.md`](task-led-job-architecture.md).

## The loop that exists (merged, on `main`)

Office authors required proof on a compiled job → Phil captures it → a capture
links to the requirement and flips it `needed → met`. End to end and field-proven:

- **Author + compile:** [`job-control-required-proof-authoring.md`](job-control-required-proof-authoring.md)
  (admin click-path on `/v2/jobs/[jobId]/job-control`, #471/#472), now including a
  **per-task scope toggle** (#542 — author a requirement for one task instead of
  the whole area/package).
- **Capture + link:** [`job-control-capture-proof-ui.md`](job-control-capture-proof-ui.md)
  (#470) and [`job-control-evidence-writer.md`](job-control-evidence-writer.md) (#468).
  The capture flow now **threads `taskRef`** for a task-authored requirement (#543).
- **Met rule (one engine, two variants):** `isRequiredEvidenceMet` (package-level)
  and `isRequiredEvidenceMetForTask` (task-aware) in
  `src/domains/job-control/task-context.ts`. The task-aware variant **generalises**
  the package one — on untagged (package-level) data it returns the identical
  answer (`per-task-proof.test.ts`). "Met" requires a real `EvidenceLink` carrying
  evidence/observation, never a photo count. Phil's per-task read
  (`buildPhilTaskContext`) uses the **task-aware** variant (#529); the admin
  package audit (`src/server/job-control/status.ts`, #473) uses the **package**
  variant — they agree wherever a requirement is package-level (the default).
- **Per-task summary (#494):** `summarisePhilTaskProof(ctx)`
  → `{ required, met, missing, eligibleForReview }` (`task-context.ts`), surfaced
  as a compact "Proof — N/M captured · ready for review" line in the Phil task row.

## Granularity — opt-in per task, package-level by default

> **Required proof can now be authored per task instance, but a requirement with
> no `taskRef` stays area/package-granular — byte-identical to before.**

The path off pure area/package granularity is **live and additive** (#502 arc):

- **`RequiredEvidence.taskRef?`** (`schema.ts`, #539) — author a requirement for one
  task `(areaId, stage, taskId)` instead of the whole package. `requiredEvidenceForTask`
  filters a task's items to package-level + its own task-scoped ones.
- **`EvidenceLink.taskRef?`** (`schema.ts`, #527) — a captured link can be scoped to
  the same task. The writer persists it and keys idempotency on it; **untagged
  links remain package-level** and cover every task the package delivers.
- The tuple `(areaId, stage, taskId)` is the canonical identity in bridge form
  (`ct_…` via `task-ref-compat.ts`); the stored shape stays the tuple — **no
  storage migration**.

**The honest default:** no shipped job authors task-scoped requirements yet, so in
prod **proof is still area/package-granular in practice** — the plumbing is in
place and flips per requirement the moment an admin scopes one to a task. The same
`taskId` in a **different area** is a different package and is never cross-affected
(tested). `eligibleForReview` reflects whichever granularity a requirement was
authored at.

## Review / approval — what is and is NOT built

| Capability | State |
|---|---|
| Capture proof, link, derive met/missing | **Merged** (#463–#473) |
| Per-task required-proof authoring + capture + task-aware met | **Merged** (#539/#542/#543/#529) |
| Per-task proof summary + `eligibleForReview` read-model | **Merged** (#494) |
| **Submit → approve/reject engine, keyed to the TASK INSTANCE** | **Merged** (#544). `ProofReview` / `applyProofReview` / `writeProofReview` (`src/server/job-control/proof-review.ts`) — keyed by `taskRefKey` (cross-task isolation), revision-guarded, submit ≠ approve, approve/reject admin-only, resubmit clears stamps. |
| **Phil submit-for-review surface** | **Merged** (#546). Worker submits a task's captured proof; sees captured · ready · submitted · approved · rejected (`PhilJobAreaDetail.tsx`). |
| **Admin approve/reject SURFACE** | **NOT built.** No office UI to approve/reject a submitted task's proof — `ProofReview` approve/reject is reachable only via the server engine/API. |
| The original package-granular review PR | **#495 — OPEN, PARKED, superseded.** It keyed review by `workPackageId` at package granularity; #544 re-keyed the same loop to the task instance instead. Do not merge #495 for its approval semantics. |

## Recommendation — #503: the identity moved; the admin surface is the open call

The earlier recommendation was to pause admin review/approval until proof keying
moved to canonical task identity. **That move has happened:** #544's `ProofReview`
is keyed to the task instance (`taskRefKey`), not the work package, and the Phil
submit surface (#546) drives it. So the concern that approval would entrench
*package* granularity is resolved — the engine is per-task.

**What remains for #503** is a product decision, not an identity one: whether to
build the **admin approve/reject surface** now (the engine + independence rule
already exist) or keep approval server-side until the field validates the submit
loop. Until that surface ships, **do not document admin proof approval as
available to office users.** **#495 stays parked** (its package-granular approach
is superseded by #544); close or repurpose it rather than merging its semantics.

## What this is NOT

- **Not** a new proof model or a second `requiredEvidence` system — everything
  above reuses the one job-control loop and the shared met-rule family. The #502
  work is an **additive `taskRef` scope on the same `EvidenceLink`/`RequiredEvidence`**,
  not a parallel model.
- **Not** a claim that every job's proof is per-task — it is **package-level by
  default**; per-task is opt-in per authored requirement.
- **Not** a claim that an **admin approve/reject UI** exists — it does **not** on
  `main`. The per-task review *engine* (#544) and the *worker* submit surface
  (#546) do; the office approval surface does not.
