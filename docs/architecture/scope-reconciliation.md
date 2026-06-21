# Scope-vs-quote reconciliation (#366)

> Status: **engine + producer + authoring + read review, real.** The pure
> classification/conflict engine
> ([`src/domains/job-control/reconciliation.ts`](../../src/domains/job-control/reconciliation.ts)),
> the L0 producer that persists a confirmed reconciliation to
> `jobs/<jobId>/scope-reconciliation.json`
> ([`reconciliation-producer.ts`](../../src/server/job-control/reconciliation-producer.ts)
> + the preview/confirm routes), the narrow admin authoring on
> `/v2/jobs/[jobId]/job-control`, and the **read-only boss-facing review** at
> `/v2/jobs/[jobId]/scope` (#366 —
> [`reconciliation-read.ts`](../../src/server/job-control/reconciliation-read.ts)
> + `ScopeReconciliationStatus`, hub section nav "Scope reconciliation") are
> shipped. **Remaining follow-up:** wiring the live quote into the producer's
> `loadScope` so BOQ-line findings populate (the job carries `fromQuoteId` from
> #244, but the producer still passes `quote: null`), and a resolve/accept-in-UI
> action on the review surface.

## Why

Before work starts on a job like 100 Arthur St, the agreed scope
(`Job.scopeOfWork[]`, #200) and the priced quote (quotes-v2 `QuoteLine`s) must
be made to agree — every clause and every line accounted for. The traps that
leak money are silent: a clause that's *excluded* on price but still owed on
site (disposal/make-safe), an *alternative* line counted in the base total
(PL3 pendants), a priced line nobody claims, a clause nobody priced. The engine
**forces** a classification on every clause and names every conflict so the
office resolves them on purpose, not by accident.

## Model

- **Forced classification.** `seedReconciliation` emits exactly one record per
  clause (default `unclear`) and one per quote line (default unowned). No
  omissions. `unclear` is the explicit *not-yet-decided* state — it renders
  **amber**, never silently green.
- **Closed ten-class enum** (`SCOPE_CLASSIFICATIONS`): `priced`,
  `general_allowance`, `excluded`, `by_others`, `reuse_existing`,
  `pc_provisional`, `variation_trigger`, `closeout`, `admin_only`, `unclear`.
- **Findings are derived, never stored** (`detectFindings`), with deterministic
  keys so a resolution survives re-reconciliation. Four kinds:
  `excluded_with_obligation` (red), `alternate_in_base_total` (red),
  `priced_line_no_clause` (amber), `clause_unpriced_unclassified` (amber).
- **RAG** (`reconciliationStatus`): red = any open red finding; amber = any open
  finding; green = everything classified and every conflict resolved.
- **Resolutions are durable** (`applyResolution` + `reconcile`): editing scope
  re-opens only the items whose clause/line changed; resolutions are never
  wiped.
- **Warning hand-off** (`warningsForCompile`): the worker-facing text on
  `by_others` / `reuse_existing` / `variation_trigger` clauses — the seam the
  compile child (#367) stamps onto the delivering work package.

## Storage (deferred)

The reconciliation overlay persists per job (proposed `jobs/<jobId>/scope.json`)
— separate from the spine's `job-control.json`, because it's an *input* the
compile child reads to **produce** work packages. The blob name and the
read/write API land with the admin surface, after #244 supplies the quote↔job
link. The v2 `QuoteLine` carries no alternate/PC flag, so `isAlternate` lives on
the reconciliation overlay (`BoqLineClassification`), not on the quote.

## Deferred / non-goals (this slice)

- No `/v2/jobs/[jobId]/scope` page, no API, no persistence (engine + types + doc
  only — zero route risk).
- No publish gate on green — surface loudly; the hard pre-start gate is #371.
- No Phil changes — warnings travel to the field via #367, not from here.
