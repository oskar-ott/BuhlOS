# Proof & review model — current state and limits

> **Status:** honest snapshot of `main` @ the task-model arc (#463–#494), plus
> the one in-flight piece (#495, **not merged**). The mechanics of the
> capture-proof loop are documented in the job-control series; this doc records
> **granularity, what the review read-model means, and what is deliberately not
> built yet**. Part of [`task-led-job-architecture.md`](task-led-job-architecture.md).

## The loop that exists (merged, on `main`)

Office authors required proof on a compiled job → Phil captures it → a capture
links to the requirement and flips it `needed → met`. End to end and field-proven:

- **Author + compile:** [`job-control-required-proof-authoring.md`](job-control-required-proof-authoring.md)
  (admin click-path on `/v2/jobs/[jobId]/job-control`, #471/#472).
- **Capture + link:** [`job-control-capture-proof-ui.md`](job-control-capture-proof-ui.md)
  (#470) and [`job-control-evidence-writer.md`](job-control-evidence-writer.md) (#468).
- **Met rule (one source of truth):** `isRequiredEvidenceMet`
  (`src/domains/job-control/task-context.ts`) — used by **both** Phil and the
  admin read (`src/server/job-control/status.ts`), so office and field never
  disagree (P7). "Met" requires a real `EvidenceLink` carrying evidence/observation,
  never a photo count.
- **Admin read-only status:** "Compiled proof status" on the same job-control
  page (#473) — audit view, writes nothing.
- **Per-task summary + review-eligibility (#494):** `summarisePhilTaskProof(ctx)`
  → `{ required, met, missing, eligibleForReview }`
  (`src/domains/job-control/task-context.ts`), surfaced as a compact
  "Proof — N/M captured / all captured · ready for review" line in the Phil task
  row. **Read-model only** — it reports state; it does not submit, approve, or
  mutate anything.

## Granularity — the honest limit

> **Required proof is area/package-granular today, not per-canonical-task.**

Proof is keyed by **work package** (`workPackageId`), resolved from a task's
`(areaId, stage, taskId)` context. The practical consequence:

- Every task within the **same area/package** shares that package's required
  proof. The same `taskId` in a **different area** is a different package, so it is
  **not** cross-affected (this isolation is tested).
- It is surfaced *per Phil task*, which can read as per-task — but it is **not yet
  authored per canonical task instance**. Per-canonical-task proof authoring
  (keying `EvidenceLink` by the `ct_<hash>` canonical id from
  `task-ref-compat.ts`) is a **deferred** slice.

`eligibleForReview` therefore means "this task's package has all required proof
captured", at package granularity — read it as a package-readiness signal, not a
per-instance one.

## Review / approval — what is and is NOT built

| Capability | State |
|---|---|
| Capture proof, link, derive met/missing | **Merged** (#463–#473) |
| Per-task proof summary + `eligibleForReview` read-model | **Merged** (#494) |
| Submit-for-review → admin **approve/reject** workflow | **Open PR [#495], NOT merged → not on `main`.** `ProofReview` / `applyProofReview` exist on that branch only; the symbols are absent from `main`. Its admin approve/reject **UI** is itself deferred (API + server exist on the branch; an admin would act via the API). |

So on `main` today: a worker can capture proof and see it as "ready for review",
but there is **no submit→approve/reject loop and no admin approval surface**.
Do not document admin proof approval as existing.

## Recommendation — pause admin review/approval until task ownership is clarified

`eligibleForReview` currently has **no consumer** on `main`, and #495 builds the
review/approval loop at **package** granularity while the deeper direction
([`task-led-job-architecture.md`](task-led-job-architecture.md)) is to make proof
**per canonical task instance**. Building a full admin approve/reject workflow now
risks entrenching package-granular review just before the identity it should hang
off changes.

**Therefore:** treat admin proof review/approval as **paused pending the task-led
identity decision.** #495 may land its read-model and server scaffolding, but the
admin approval *surface* and any "approved" semantics should wait until proof
keying moves to canonical task identity (or that direction is explicitly deferred
with a dated rationale). This is a recommendation for sequencing, not a blocker on
#495's already-built, tested, non-mutating pieces.

## Per-task proof — the #502 foundation (additive, not yet live)

The path off area/package granularity toward **per-canonical-task** proof is being
laid additively so nothing in the live loop changes until consumers opt in. The
foundation (#502, first slice) is:

- **`EvidenceLink.taskRef?`** — an OPTIONAL `(areaId, stage, taskId)` scope on a
  link (`schema.ts`). Absent on every link today ⇒ the link stays **package-level**
  (covers every task the package delivers). Present ⇒ the link is **task-scoped**
  (covers only that task instance). The tuple is the canonical identity in
  bridge form (`ct_…` via [`task-led-job-architecture.md`](task-led-job-architecture.md));
  the stored shape stays the tuple — **no storage migration**.
- **`isRequiredEvidenceMetForTask(links, wp, req, task)`** (`task-context.ts`) —
  a task-aware met rule that **generalises** the package rule: an untagged link
  satisfies the task (today's behaviour, byte-for-byte), a task-scoped link
  satisfies only its task. It returns the exact same answer as
  `isRequiredEvidenceMet` on current (untagged) data — proven in
  `per-task-proof.test.ts`.
- The **writer** (`evidence-link.ts`) optionally accepts and persists `taskRef`,
  with the idempotency key including it; existing callers (no `taskRef`) produce
  byte-identical links.

**Deliberately deferred (later #502 sub-slices), so prod stays area/package today:**

- The capture flow does not yet pass a `taskRef` — no task-scoped links are
  produced in prod.
- `isRequiredEvidenceMet` and its consumers (Phil `buildPhilTaskContext`, the
  admin status view, the #500 projection's injected proof) are **unchanged** —
  they remain package-level until a slice flips them to the task-aware rule.
- Per-canonical-task **authoring** of `requiredEvidence` and canonical-id keying
  via the #501 bridge are separate slices.

Until those land, **proof is still area/package-granular in prod** — do not claim
otherwise.

## What this is NOT

- **Not** a new proof model or a second `requiredEvidence` system — everything
  above reuses the one job-control loop and the shared `isRequiredEvidenceMet`.
  The #502 foundation is an **additive scope on the same `EvidenceLink`**, not a
  parallel model.
- **Not** a claim that proof is per-task — it is **area/package-granular** until
  the deferred #502 consumer slices land.
- **Not** a claim that admin approval exists — it does **not** on `main`.
