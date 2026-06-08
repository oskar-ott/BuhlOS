# Phil job screen simplification

A strategic UI correction: Phil's individual job page had grown into a stack of
~13 separate cards/panels. This pass starts pulling it back toward **one coherent
field-worker flow** — fewer, better sections — without removing any real
capability. This is step one (the clearest, lowest-risk win); a section
*reorder* is the recommended follow-up.

## Audit — the page as a worker flow (post-#97, `main` @ `1777b00`)

| # | Section | Real/stub | Worker value | Verdict |
|---|---|---|---|---|
| 1 | Back link → All jobs | real | nav | keep |
| 2 | `PhilJobHero` — name / status / address | real | "where am I" | keep |
| 3 | `PhilJobCommandPanel` — "Quick actions" (#97, reframed after capture-shutter) | real | worker shortcuts | keep |
| 4 | `PhilJobAttentionStrip` — viewer-scoped attention | real | "what's wrong" | keep |
| 5 | Site (collapsible) — address/access/parking/safety/induction | real | "on arrival" | keep |
| 6 | Work / Areas (#94) — area picker + task drill-in/toggle | real | core work | keep |
| 7 | Capture evidence — CTA + today's strip | real | core | keep |
| 8 | Snags — `JobSnagsPanel` | real | problems | keep |
| 9 | ITPs — `JobItpPanel` | real | checks | keep |
| 10 | Plans — "Open plan viewer" link | real | drawings | keep |
| 11 | Documents — `JobDocumentsPanel` ("Site files") | real | docs | keep |
| 12 | **Materials — `JobMaterialsPanel`** | **UC stub** | **none yet** | **demote** |
| 13 | **History — `JobHistoryPanel`** | **UC stub** | **none yet** | **demote** |

**The clearest problem:** two **full under-construction Cards** (Materials +
History) sit at the bottom, each taking a whole section's worth of vertical
space to say "Under construction." On a phone, the worker scrolls past two
placeholder cards to reach the end. That's filler dominating the experience —
exactly the "stack of feature panels" risk.

Everything above #12 is real and worker-valuable; the order is already close to
the target flow (context → next → attention → site → work → capture →
problems → checks → references).

## Chosen path: C — stub / deferred-section cleanup

The lowest-risk, highest-value, real-data-only win. (A full *reorder* — Path A —
is higher-risk and better reviewed on its own; the command panel — Path D — is
working well and needs no refinement.)

### What changed

- **Deleted** the two UC stub components `JobMaterialsPanel.tsx` +
  `JobHistoryPanel.tsx` (pure placeholders — no data, no links, no handlers)
  and the `JobMaterialsPanel.render.test.tsx`.
- **Added** one tiny, pure `PhilJobDeferredNote.tsx`: a single compact,
  low-emphasis **"Not connected in Phil yet"** note that honestly names the
  deferred surfaces and the real next step ("Materials — phone or text your PM…;
  Job history — the full activity log lives in the office for now").
- `PhilJobDetail.tsx`: the two full-card sections (`#phil-job-materials`,
  `#phil-job-history`) become one low-emphasis section (`#phil-job-more`).

**Net −1 component** (deleted 2 stubs, added 1 note) → fewer, better sections.

### Before → after (bottom of the page)

```
…Plans → Documents → [Materials: full UC card] → [History: full UC card]
…Plans → Documents → [Not connected yet: one compact note]
```

Nothing real was removed or hidden. Plans, Documents, Capture, Work, Snags,
ITPs, the command panel and attention strip are all untouched and still
reachable. The deferred surfaces stay **honest** — the worker is still told
they're not in Phil yet and what to do instead — just without two cards
pretending to be sections.

## Deferred (recommended follow-ups, intentionally NOT in this PR)

Kept out to stay a focused, low-risk PR (per "don't combine too many paths"):

- **Section reorder (Path A)** — e.g. lift Plans nearer Work as a "site
  reference"; consider grouping Snags/ITPs/Plans/Documents under a light
  "references & problems" structure. Higher-risk layout change; review on its own.
- **Copy pass (Path B)** — field-plain section headings (e.g. the Work card's
  "Areas" heading; "ITPs" → "Checks") — touches the panel components.
- **Re-add minimal jump-nav** only if losing the (#97-removed) section anchors
  proves to hurt on long jobs. The shorter page + the command panel's actions
  make this lower priority; revisit with real field feedback.

## Safety

- No time-entry write change; no `jobId:null`; no rejected-hours/resubmit change.
- No capture upload change.
- No fake task/evidence/ITP/activity; the deferred note is honest, not a stub
  pretending to be real.
- No admin/payroll/Xero language; no dead `/admin` links (the prior `/admin`
  materials leak was already removed in #95, and the whole panel is now gone).
- Production/preview data not touched. Preview Smoke **not** dispatched.

## Tests

`PhilJobDeferredNote.render.test.tsx` (2) — the note is one concise honest line
naming Materials + History + the PM next step, with **no** "under construction"
card language and no admin/payroll/Xero jargon.

Validation: `typecheck`, `lint`, `test:unit` (1475), `test:api` (209), `build`,
`check:smoke-list` (11), route/shell guards — all green.
