# Phil job screen — section flow

The second simplification pass after #98. Goal: make the Phil job page read as
**one field-worker flow** — the active work leads, reference info follows — not
a stack of equally-weighted module panels.

## Audit (before — `main` @ `ec30959`)

`hero → command panel → attention → **Site (open card)** → Work/"Areas" →
Capture → Snags → ITPs → Plans → Documents → deferred note`

The clear flow problem: **Site (reference info) sat between the command panel
and Work**, so an open Site card pushed the active Work + Capture loop down the
page. "Areas" as the work heading also read more like a data structure than the
worker's intent.

## Chosen path: C — small reorder + field-language headings

The smallest change that improves flow. No new feature, no behaviour change.

### What changed
- **Site moved to the bottom "reference" zone.** Extracted the Site section into
  a small presentational **`PhilJobSiteCard`** (own collapse state) and render it
  near the end, just above the deferred note. So the page now leads with the
  work, not with site reference details.
- **"Areas" → "Work to do"** (the work section heading) — the worker's intent,
  and it matches the command panel's "Continue work" / "View your tasks" action.
- **Site heading "Site" → "Site details"** — signals reference info now that it
  sits in the reference zone.

### After

`hero → command panel → attention → **Work to do → Capture → Snags → ITPs →
Plans → Documents → Site details → Not connected yet**`

Flow reads as: do the work → capture proof → handle problems/checks → references
(plans/docs) → site details → what's not wired yet.

## Compatibility — nothing breaks

- **All 5 command-panel in-page anchors still resolve**: `#phil-job-work`,
  `#phil-job-capture`, `#phil-job-snags`, `#phil-job-itps`, `#phil-job-documents`
  — reordering moves whole `<section>`s, ids intact.
- **`#phil-job-site` preserved** on `PhilJobSiteCard` — the attention strip's
  "Site induction required" item still scrolls there
  (`PhilJobAttention.deriveAttention`).
- **"Capture evidence" kept verbatim** — the smoke + e2e specs
  (`phil.spec.ts`, `phase-d-d3-capture.spec.ts`, `fieldReadiness.ts`) match that
  button + the `CaptureSheet` dialog name. Renaming it would break the smoke gate,
  so it was deliberately left as-is.
- The induction warning still appears (in `PhilJobSiteCard` *and* the attention
  strip), so demoting Site never hides it.

## What was deferred (kept focused)

- A fuller **plans/docs-before-checks/issues** regroup + a wrapper "Site
  references & problems" grouping — a candidate for the copy pass.
- Renaming panel-internal headings ("ITPs" → "Checks", Snags → "Issues",
  Documents "Site files") — those live inside `JobItpPanel` / `JobSnagsPanel` /
  `JobDocumentsPanel` and their tests; a careful copy pass should own them.
- These belong to `feat/phil-job-screen-copy-pass`, not here.

## Safety

No time-entry write / `jobId:null` / capture-upload / task-toggle change. No new
APIs. No fake state. No admin/payroll/Xero language. No `/admin` links. Site is
the same real data, just relocated + renamed. Production/preview data untouched;
Preview Smoke not dispatched.

## Tests

`PhilJobSiteCard.render.test.tsx` (5): renders "Site details" + the real site
fields, keeps `#phil-job-site`, surfaces the induction warning, renders nothing
without site context, no admin/payroll/Xero jargon. The command-panel anchor
test continues to pass (anchors unchanged).

Validation: typecheck ✅ · lint ✅ · test:unit 1480 ✅ · test:api 209 ✅ · build ✅
· check:smoke-list 11 ✅ · route/shell guards ✅.
