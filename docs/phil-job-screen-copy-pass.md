# Phil job screen — field-language copy pass

A copy-only pass (no behaviour change) after #99's reorder. Goal: the Phil job
screen's real panels should use plain field-worker language, not office/module
terms. A worker should feel they're seeing **work · capture · plans · checks ·
issues · site details**, not an "ITP module" or a "compliance workflow".

## Copy audit matrix

| Current | File | Worker meaning | Problem | New copy | Test dep? | Changed? |
|---|---|---|---|---|---|---|
| Heading "ITPs" | `JobItpPanel` | inspection checks | "ITP" is compliance jargon | **"Checks"** | none | ✅ |
| Desc "Inspection & test plans for this job…" | `JobItpPanel` | what they are | office phrasing | "Inspection checks (ITPs) for this job…" (keeps acronym for recognition) | none | ✅ |
| Empty "No ITPs attached… Your PM… attaches them." | `JobItpPanel` | nothing yet | jargon | "No checks listed for this job yet. Your PM or leading hand sets them up." | none | ✅ |
| Empty "All attached ITPs are signed off…" | `JobItpPanel` | all done | jargon | "All checks are signed off. Good work." (real state, kept honest) | none | ✅ |
| Heading "Snags" | `JobSnagsPanel` | site problems | wanted "Issues" | **"Issues"** | none | ✅ |
| Desc "Issues raised on this job. Tap Report snag…" | `JobSnagsPanel` | what's here | redundant w/ new heading | "Things on site that need fixing. Tap Report snag to raise one." | none | ✅ |
| Empty "No open snags on this job." | `JobSnagsPanel` | nothing open | heading consistency | "No open issues on this job." | none | ✅ |
| Button "Report snag" | `JobSnagsPanel` | raise one | established AU site term | **kept** (recognition) | none | — |
| Heading "Documents & specs" + copy | `JobDocumentsPanel` | drawings/specs | already plain | — | none | **kept** |
| Heading "Plans" / "Open plan viewer" | `PhilJobDetail` | drawings | already plain | — | none | **kept** |
| "Capture evidence" (button + dialog) | `PhilJobDetail` / `CaptureSheet` | capture proof | smoke/E2E depend on it | — | **YES** | **kept verbatim** |
| "Work to do" / "Site details" | `PhilJobDetail` / `PhilJobSiteCard` | — | already done in #99 | — | render test | **kept** |
| "Quick actions" + action labels | `PhilJobCommandPanel` (from #96 model) | worker shortcuts | heading reframed after capture-shutter; labels remain model-owned | — | **YES** | **heading changed, labels kept** |
| Count chips "1 ITP" / "2 snags" | area cards / jobs list | counts | compact, heavily tested | — | **YES (5 files)** | **deferred** |

## Chosen path: B — panel-level field-language pass

Two clear, safe wins that also **align the panels with the command panel's
existing language** (the #96 model already says "Complete N **checks**" and
"Report an **issue**", which jump to these sections):

- `JobItpPanel`: **"ITPs" → "Checks"** (heading + description + empty states),
  keeping "(ITPs)" in the description and the `Open ITP:` aria-labels for
  recognition.
- `JobSnagsPanel`: **"Snags" → "Issues"** (heading + empty state), keeping the
  "Report snag" action button (established AU site term).

## Deliberately kept unchanged

- **"Capture evidence"** — the smoke + E2E specs (`phil.spec.ts`,
  `phase-d-d3-capture.spec.ts`, `fieldReadiness.ts`) match this button + the
  `CaptureSheet` dialog name. Renaming would break the smoke gate.
- **Command-panel action labels / action IDs** — owned by the #96 model and
  asserted by its tests; already field-plain ("checks" / "issue"). Not touched.
- **`JobDocumentsPanel`** — already field-appropriate ("Documents & specs",
  "Current drawings and specs…", honest empties). No change for change's sake.
- **Count chips ("1 ITP", "2 snags")** — compact badges with heavy test
  coverage across 5 files (`philJobWorkTree`, `philJobsListSignals`,
  `PhilJobsList`, `PhilJobAreaDetail`, `PhilJobAttention`). Left as-is this pass;
  a future pass could align them.

## Safety

No behaviour, data, API, anchor, or action-ID change — only visible strings.
No time-entry write / capture upload / task-toggle / rejected-hours change. No
fake completed/uploaded/signed-off copy (the "signed off" empty state is the
real terminal ITP state). No admin/payroll/Xero language. No new APIs.
Production/preview data untouched; Preview Smoke not dispatched.

## Tests

New `JobItpPanel.render.test.tsx` (3) + `JobSnagsPanel.render.test.tsx` (3):
each asserts the field-language heading, the honest plain empty state, and no
admin/payroll/Xero/module jargon. The command-panel anchor test continues to
pass (anchors + map unchanged).

Validation: typecheck ✅ · lint ✅ · test:unit ✅ · test:api ✅ · build ✅ ·
check:smoke-list ✅ · route/shell guards ✅.
