# AI drawings — page understanding (Epic 5 foundation, #197)

The first Epic 5 slice: BuhlOS reads each rendered plan page and answers
"which drawing is this?" — sheet type + title block (sheet number, title,
revision, scale) — with per-field confidence, full provenance, and a human
review-and-correct loop. Every later Epic 5 capability (sheet registry #199,
legend extraction #201, revision diff #203, device recognition #204/#205,
takeoff assembly #213) keys off this metadata.

**Status: shipped dark** behind the `ai_drawings` flag (admin-tier, default
off). Nothing is user-visible until the flag is turned on.

## What it does

1. The office opens a job's **Documents** page. Each drawing document with
   rendered pages gets an "AI sheet understanding" panel (flag-gated).
2. **Analyse pages** runs ONE short vision call per page — the client
   orchestrates the loop (the Phase-9 takeoff pattern; Vercel serverless
   can't run background jobs). The client also sends a high-res crop of the
   bottom-right title-block region as a second image where the browser can
   produce one (small title-block text reads far better from the crop; if the
   canvas is CORS-tainted, the run proceeds whole-page only).
3. The model returns strict JSON: a sheet type from the fixed vocabulary
   (`floorPlan | schematic | schedule | legend | titleCover | detail | other`)
   plus the four title-block fields, each `{ value | null, confidence 0..1 }`.
   **Nulls over guesses** — an absent/illegible field comes back null, never
   invented (P7).
4. Results persist with provenance; the panel shows every field with the
   model's confidence. Fields under the review threshold (default 0.8) flag
   the page **needs review** — nothing low-confidence is silently accepted.
5. A human corrects any field inline. **Corrections are stored separately
   from AI values, always win on read, and survive re-extraction** (they key
   to the page, not to the extraction run). Every correction writes an audit
   entry.

## Storage (Supabase — the first extraction tables)

Migration: `supabase/migrations/20260702190000_epic5_plan_sheet_extractions.sql`

| Table | Role |
| --- | --- |
| `plan_sheet_extractions` | Append-only raw AI run log: page sha256, model, prompt version, full JSON output, typed projection, token usage, optional crop region, who ran it. Re-runs add rows; nothing is rewritten. |
| `plan_sheets` | Current projection, one row per `(job, plan document, page)` — what the #199 registry reads. AI values only. |
| `plan_sheet_overrides` | Human corrections, one row per field. `value = null` is an explicit human "this field is absent". |

Needs-review is **derived at read time** (override-aware confidence
threshold), never stored, so it can't go stale.

`job_id`/`plan_id` are legacy text ids (plans live only in Blob; the jobs PG
mirror is dark-gated) — FK wiring is a later migration, mirroring phase-2a's
deferred reference wiring. RLS is enabled with no policies (Phase 1
convention); the app reaches PG only through the guarded direct connection
(`api/_lib/supabase-db.js`). Where `SUPABASE_DB_URL` is absent (previews,
local dev) the API answers an honest 503 and the panel says the store is
unreachable.

## Spend governance

Vision calls record into the **shared per-job AI ledger**
(`jobs/<jobId>/ai-takeoff.json`, the #510 CAS-safe cap — extracted to
`api/_lib/ai-spend.js` and now used by both `api/plans.js` and
`api/ai-drawings.js`). One budget per job across every AI surface; at the cap
(`PLANS_MAX_USD_PER_JOB`, default $5) further calls 402 and the panel stops
the run and says so. Spend is recorded even when the model returns unusable
output — the money was spent.

An unchanged page (same sha256) analysed with the same prompt version + model
is served from the extraction cache and never bills twice.

## Surfaces

- API: `api/ai-drawings.js` — `GET ?action=sheets`,
  `POST ?action=understand-page | override | clear-override`.
  Admin-tier / managing-LH only; clients 403; flag off → 404.
- UI: `SheetUnderstandingPanel` on `/v2/jobs/[jobId]/documents`
  (`aiDrawingsEnabled` prop from the server component's flag check).
- **Sheet registry (#199)**: `SheetRegistryCard` inside the panel — the
  searchable register over every classified sheet (number/title substring
  search, type filter, natural sheet-number ordering, deep link to the
  rendered page, source document + status). Read-only projection
  (`src/domains/ai-drawings/registry.ts`) over the same effective data, so
  corrections made in the review flow win here automatically and re-uploads
  never lose them. Unreviewed rows are visibly marked.
- Domain: `src/domains/ai-drawings/` (zod contract + fetch client).

## Config

| Env | Default | Meaning |
| --- | --- | --- |
| `AI_DRAWINGS_MODEL` | `claude-opus-4-8` | Vision model (bare current alias, #378). |
| `AI_DRAWINGS_INPUT_USD_PER_MTOK` / `AI_DRAWINGS_OUTPUT_USD_PER_MTOK` | `5` / `25` | Spend accounting rates for the model above. |
| `AI_DRAWINGS_REVIEW_THRESHOLD` | `0.8` | Confidence under this (no override) → needs review. |
| `PLANS_MAX_USD_PER_JOB` | `5` | Shared per-job AI cap (#510). |
| `SUPABASE_TENANT_SLUG` | `buhl` | Tenant row the extraction rows attach to. |

Prompt changes bump `PROMPT_VERSION` (`pu-v1` today) in `api/ai-drawings.js`
— the cache key includes it, so a new prompt re-runs pages while old rows
remain for comparison.

## Legend vocabulary (#201)

The project's symbol language, extracted from its legend sheets into a
reviewed per-job vocabulary — the input device recognition (#204/#205)
consumes. Rides the same flag, handler, run-log cache and spend cap.

- **Extract**: pages whose (effective) sheet type is `legend` get an
  "Extract legend" action — one vision call (`kind = legend-entries`,
  prompt `lv-v1`) returning label / description / category / symbol
  description / confidence / symbol bbox per row. Cached by page sha256 +
  prompt + model like page understanding.
- **Review state machine** (the house `ai-suggestions` grammar):
  `suggested → accepted | edited | rejected`, with one documented
  vocabulary extension — a live (accepted/edited) entry can still be
  rejected later, because bogus vocabulary must be removable before #204
  consumes it. The AI's original label is always preserved (`edited`
  stores the correction alongside). **Downstream consumers read
  accepted/edited entries only** (`acceptedLegendEntries`).
- **Merging**: one live entry per normalised label per job (partial unique
  index) — multiple legend sheets/blocks converge on ONE vocabulary;
  duplicates are reported, not silently re-added. A label a human rejected
  never resurrects on re-extraction.
- **Symbol crops**: the browser crops each entry's bbox from the page PNG
  (no server-side image library) and attaches it via
  `jobs/<jobId>/legend-crops/<entryId>.png` — best-effort: a CORS-tainted
  canvas just leaves an honest label-only row. Crops become the few-shot
  reference images for #204.
- **Human additions**: entries the AI missed are added by hand,
  pre-accepted, with no invented model provenance (P7).
- Storage: `legend_entries`
  (migration `20260703060000_epic5_legend_entries.sql`); runs log into
  `plan_sheet_extractions` with the widened `kind` CHECK.
- The gateway output cap (`api/_lib/ai.js MAX_TOKENS_CAP`) rose 2048 → 4096
  for the row-heavy legend JSON; callers still request only what they need.
- Supersedes the Phase-9 blob `ai-takeoff.json.legendItems` as the
  vocabulary source of truth (the legacy takeoff loop still reads its own
  copy until it migrates).

## Schedule tables (#202, machinery shared with #207)

Tabular extraction with a side-by-side human verification view — lighting
schedules first; the machinery is table-type-agnostic and #207 adds the
switchboard mapper on top. Same flag, run-log cache and spend cap.

- **Extract**: schedule-classified pages get "Extract lighting schedule" —
  one vision call (`kind = schedule-lighting`, prompt `sl-v1`) returning
  every table on the page: raw headers, a canonical column map
  (`typeCode/description/manufacturer/model/lamp/wattage/qty`; unmapped
  columns keep their raw header), and every row's cells as
  `{value, confidence}`. **Verbatim policy**: cells are exactly the printed
  text, abbreviations never expanded; unreadable cells are `null` +
  flagged, never invented (P7).
- **Verify**: `ScheduleTablesCard` renders rows against a canvas-cropped
  **source strip** of the row's region; low-confidence cells are marked;
  per-cell corrections (`edited`) win on read with the AI's original
  preserved; rows accept/reject; accepted rows stay fixable. The accuracy
  line counts corrected cells openly — errors measured, not hidden.
- **Lifecycle**: re-extracting a page (new raster / prompt bump) inserts a
  NEW table and supersedes the old with its rows intact for the trail —
  schedule rows have no stable cross-run identity, so unlike page-keyed
  #197 overrides, corrections do not carry across a re-extraction.
- Storage: `schedule_tables` + `schedule_rows`
  (migration `20260703080000_epic5_schedule_tables.sql`, both kinds); runs
  log into `plan_sheet_extractions` with the widened `kind` CHECK.
- A very long schedule can overrun the 4k output cap — the run then fails
  honestly (502, nothing stored); chunked extraction is a known follow-up.

## Revision diff (#203)

"Rev C arrived — what changed?" Classic computer vision, **no model call,
no spend**: `api/_lib/page-diff.js` (pure `pngjs`) grayscales both rasters,
finds the best translation (render drift; near-tie candidates exact-rescored
— sparse sampling aliases 1px offsets), masks the title block (its revision
table always changes), and clusters per-block changes into region bboxes on
the newer revision.

- **Pairing**: the register's supersede lineage proposes "Compare Rev C
  against Rev B"; pages pair by index. One click compares the pair
  page-by-page (client-orchestrated).
- **Walk-through**: every region renders before/after strips
  (canvas-cropped from both rasters) and is marked reviewed/dismissed —
  flippable reviewer bookkeeping, audited (`document.revision_diffed` /
  `document.diff_region_reviewed`).
- **Honesty is structural**: every diff stores and displays its **basis**
  (alignment quality, pixel threshold, mask, algo version) — "no changes"
  never appears without it; byte-identical rasters say so and skip the
  compute; un-alignable pairs are refused with the reason (422) and nothing
  is stored; the diff shows *where* pixels changed — the human judges what
  it means.
- Storage: `page_diffs` + `diff_regions`
  (migration `20260703100000_epic5_page_diffs.sql`); cache = one live diff
  per (base sha, head sha, algo). Engine covered by synthetic-PNG unit
  tests (added element found, drift absorbed, mask honoured, noise
  refused).

## Device detection (#204)

Locating instances of **this project's reviewed legend vocabulary** on floor
plans. Detection is constrained matching, never invention: with no
accepted/edited legend entries the action refuses (409 — "extract and accept
the legend first"), and the model may only point at vocabulary indices;
anything off-list is dropped and counted (`offVocabulary`).

- **Tiling**: the browser crops the page into an overlapping 2×2 grid
  (`DETECTION_TILES`, 12% overlap) and runs one vision call per tile —
  small symbols survive at usable resolution where a whole-sheet pass
  would blur them. Tile-normalised boxes map back to page coordinates
  server-side (`tileBoxToPage`).
- **Few-shot from the project's own legend**: reviewed entries' symbol
  crops (#201) ride along as reference images (capped at 12; an
  unreachable crop degrades that entry to text-only). Human labels win
  over AI labels in the vocabulary.
- **Seam dedupe**: a device candidate overlapping (IoU > 0.5) an existing
  detection of the same legend entry on the same raster is the same
  physical device seen from two tiles; uncertain regions dedupe by
  overlap alone. This is also what makes a cached re-click idempotent.
- **Vocabulary frozen per run**: the entryIndex→legend-entry mapping is
  stored inside the run's raw output — later legend edits can never
  re-label detection history.
- **Uncertainty is a first-class output**: dense/degraded areas the model
  refuses to count instance-by-instance arrive as `uncertain-region` rows
  ("needs a human count"), not guessed markers (P7).
- **Everything is unverified**: the panel card frames every figure as
  "found (raw)"; each detection is inspectable back to its exact spot on
  the sheet (padded canvas crop). Nothing here feeds a takeoff — that is
  #205's overlay review.
- Storage: `detection_runs` (tile-keyed cache: page sha + tile + prompt
  `dd-v1` + model) + `device_detections`
  (migration `20260703120000_epic5_device_detections.sql`); spend kind
  `detect-devices` in the shared #510 ledger; audit
  `document.ai_extracted` (kind `device-detections`).
- **Eval harness shipped, accuracy AC prod-gated**: the greedy-IoU scorer
  (`src/domains/ai-drawings/detection-eval.ts`) computes per-label
  precision/recall/F1 against a hand-labelled reference sheet
  (`DetectionReference` contract; metrics are `null` where undefined,
  never fake). Building the reference set needs a real plan — same
  owner-preview session as the other accuracy ACs.

## Verified counts (#205)

The issue's state model, implemented verbatim: **raw detections (immutable,
#204) → review actions (append-only) → accepted counts (derived)**. A bare
number is unverifiable; a count only becomes trustworthy when every counted
instance is a marker the human checked in place.

- **Markers on the sheet**: the panel's count-review card overlays every
  effective marker on the page raster (SVG geometry via attributes over the
  measured `<img>`, the Plan-Viewer coords idiom — zoom 1/rotation 0).
  Removed markers stay visible as dashed ghosts (restorable); human-added
  markers carry a cross so their origin is visible on the sheet.
- **Corrections are layered, never destructive**: `detection_reviews` rows
  (`delete` / `restore` / `reclassify` / `add`) are append-only; the
  effective marker set is derived by replaying actions per target in time
  order (`api/_lib/count-review.js`, unit-tested). Reclassify implies the
  marker exists (revives a deleted one); adds require the reviewed legend
  vocabulary, same as detection. Every action is audited
  (`document.ai_corrected`, kind `device-marker`).
- **Accept is a sign-off with provenance**: one live `accepted_counts` row
  per (page raster, legend entry) — the count, the acceptor, the timestamp,
  and a basis snapshot of the EXACT marker keys counted plus the review
  actions that shaped them. Re-accepting supersedes (history kept). Audited
  as `document.count_accepted`. Accepting zero after removing every marker
  of a type is a valid sign-off; accepting a type with no markers at all is
  refused.
- **Staleness is structural**: corrections after a sign-off — or a page
  re-render changing the raster sha — flip the accepted badge to "changed
  since sign-off" (marker-key set comparison, not count equality: a delete
  plus an add nets the same number over different instances). Nothing
  silently stays "verified".
- **The takeoff seam**: `liveAcceptedCounts` (store) is the ONLY count
  surface downstream consumers (#213) may read. Raw and derived numbers
  never leave the review card, and every unaccepted/stale count renders
  "unverified".
- Storage: `detection_reviews` + `accepted_counts`
  (migration `20260703140000_epic5_count_review.sql`). No AI calls, no
  spend — this slice is pure human review over #204's output. The
  correction stream doubles as the eval feedback loop for detection
  quality (issue "future considerations").

## Rooms and zones (#206)

Flat per-sheet counts are coarse; pricing works room-by-room. The pragmatic
v1 per the issue: a **whole-page vision pass for room-label text plus
approximate bbox extents** — deliberately NOT wall-tracing polygons; boxes a
human can redraw beat over-promised geometry.

- **Extraction** ("Map rooms" on floor-plan sheets): prompt `rv-v1`, cached
  in the shared run log (`plan_sheet_extractions`, kind `rooms` — the kind
  CHECK is widened per slice). Names come back VERBATIM (duplicate names
  are legitimate — two "WIR" on one level), extents approximate, faint
  underlay text scores low, unlabelled space is simply not listed. Spend
  kind `extract-rooms`; materialisation is idempotent (a cached re-click
  inserts nothing); re-extraction supersedes ONLY prior AI suggestions —
  human-touched rooms persist.
- **Review is the legend grammar** (`rooms` table): suggested →
  accepted | edited | rejected; `edited` covers BOTH rename (`human_name`)
  and redraw (`human_bbox`) — overrides win on read. Merge = redraw one +
  reject the other; split = redraw + add. Humans add rooms (born
  accepted) by naming then two-tap drawing a box on the overlay.
- **Device grouping is derived, never stored**: marker centre
  point-in-effective-bbox; overlapping rooms → smallest area wins;
  outside every room → the **explicit unzoned bucket** (rendered
  amber-dashed, never silently dropped). Redrawing a room re-groups
  instantly. A human can pin any marker to a room — or explicitly to
  unzoned — via `room_assignment_overrides` (pin > geometry; a pin to a
  since-rejected room falls back to geometry; clearing the pin returns
  the marker to automatic grouping).
- **Where it surfaces**: the count-review card (#205) gains room boxes +
  labels on the overlay, a Rooms list (accept/rename/redraw/reject/add),
  a per-marker Room selector, and a by-room breakdown ("KITCHEN · 3 —
  2× GPO, 1× downlight"). Accepted counts stay per (page raster, symbol
  type) — the room breakdown is a VIEW over live markers, not a second
  count grammar.
- Audit: `document.ai_extracted` (kind `rooms`) on mapping;
  `document.ai_corrected` (kinds `room` / `room-assignment`) on review,
  add, pin and clear.
- Storage: `rooms` + `room_assignment_overrides`
  (migration `20260703160000_epic5_rooms.sql`). Zone definitions may
  eventually map to job-bible site areas (Epic 4) — flagged, deliberately
  NOT built here.
- **Accuracy AC prod-gated**: detected room names vs a human's listing on
  a reference floor plan, boundary errors visible in the overlay — joins
  the standing owner-preview session.

## Cable-run estimates (#211)

Pure geometry + factors — **no model calls, no AI spend**. A heuristic is
valuable only while its assumptions are explicit, and harmful the moment it
pretends to be a measurement, so "estimate" is in the label everywhere and
every run stores its full input snapshot (reproducible from that alone).

- **Metric anchor = human calibration, not the scale string.** Page rasters
  carry no physical size, so the title-block scale ALONE cannot yield
  lengths. The estimator two-taps a dimension they know (a grid bay, a
  dimensioned wall) and enters its real mm — one straight reference plus
  the raster aspect fixes mm-per-normalised-unit on both axes exactly.
  This *is* the issue's "verify the parsed scale against a known
  dimension"; the sheet's effective title-block scale (human override
  wins, #197) is recorded and displayed as a **cross-check** on every
  calibration. **No calibration → no estimate, flagged (409)** — never a
  unit-guessed number; degenerate references (points too close) are
  refused.
- **Board input = manual pins** (the issue's accepted v1): named pins
  ("DB-1", "MSB") tapped onto the sheet; each live device marker (#205)
  runs to its NEAREST pin by **Manhattan distance** (in-building runs
  follow walls, not diagonals).
- **Factors are data, not code**: `estimateMm = manhattan × routingFactor
  × slackFactor + riseDropMm`, defaults visible (1.15 / 1.1 / 4000mm) and
  editable per run; the applied set is stored on the result and printed
  under every output. Changing factors recomputes transparently — a new
  draft run supersedes the old one.
- **Explicit acceptance is the only path onward**: runs are born `draft`;
  a human accepts (acceptor + timestamp, audited as
  `document.cable_estimate_accepted`). Recomputing never carries
  acceptance over. `acceptedCableRuns` is the #213 seam — takeoff
  assembly reads nothing else.
- **Staleness is structural**: markers, pins or calibration moving after
  a run flips it to "inputs changed since this run — recompute"
  (snapshot-vs-current comparison, same contract as #205 counts).
- Storage: `board_pins` + `sheet_calibrations` + `cable_estimate_runs`
  (migration `20260703180000_epic5_cable_estimates.sql`); engine
  `api/_lib/cable-estimate.js` (pure, unit-tested). Audit
  `document.cable_estimated` (calibration + runs) and
  `document.cable_estimate_accepted`.
- Real routing (tray runs, ceiling paths) is beyond what drawings encode
  and stays permanently out of scope, per the issue.
- **Accuracy AC prod-gated**: spot-check against a human's scaled
  measurement on a reference sheet, deviation reported alongside — joins
  the standing owner-preview session.

## Cross-sheet references and links (#212)

A drawing set is a web, not a pile. Two deliberately small structures:

- **Reference callouts** ("Find references" per document, prompt `sr-v1`,
  cached per raster): "REFER E-501", detail bubbles, section markers —
  verbatim text + target sheet number + provenance. **Resolution is never
  stored**: refs re-resolve on every read against the registry's effective
  sheet numbers (#197 overrides win), so correcting a sheet number fixes
  resolution instantly. Unresolved refs list honestly ("no analysed sheet
  numbered E-999"). Spend kind `extract-refs`; re-extraction supersedes
  the page's previous refs.
- **Entity links** (v1 kind `same-board`): proposals come from a **pure
  scan** — exact identifier matches between schedule boards (#207) and
  board pins (#211), no model call, no spend. Identifiers normalise
  (case/dashes/spacing) but nothing fuzzy. Proposals carry confidence +
  evidence and **never take effect until a human confirms**; rejected
  pairs persist so re-scans never re-propose them; confirmed links can be
  unlinked, rejected ones re-confirmed. Humans add links by hand (born
  confirmed, canonically ordered, duplicate pairs refused).
- **Duplicate-count warnings**: any live link (proposed OR confirmed —
  a proposal is already a reason to check) whose BOTH sides carry live
  accepted counts flags each side in the counts card: "possible
  double-count … check the same scope isn't counted twice before
  assembling a takeoff." This is the #213 guard the issue asks for.
- Storage: `sheet_refs` + `entity_links`
  (migration `20260703200000_epic5_cross_sheet_links.sql`; run-log kind
  CHECK widened with `sheet-refs`). Pure helpers in
  `api/_lib/entity-links.js` (unit-tested). Audit: refs land under
  `document.ai_extracted` (kind `sheet-refs`); link reviews and manual
  links under `document.ai_corrected` (kind `entity-link`).
- **Verification criterion prod-gated**: on a real multi-sheet set, a
  human confirms/rejects every proposed link and confirmed links
  round-trip both ways — joins the standing owner-preview session.

## Takeoff assembly (#213)

The capstone: verified extractions assembled into one signed-off quantity
list. **Pure aggregation, no model calls** — correctness and provenance
integrity are the entire job.

- **Only accepted rows assemble**: verified device counts
  (`liveAcceptedCounts`, #205), accepted/edited schedule rows (#202/#207 —
  lighting rows carry their qty cell parsed strictly, a non-numeric qty
  flags the line instead of inventing a number; switchboard rows assemble
  as qty-1 circuit-scope lines), and accepted cable estimate runs (#211 —
  their lines carry `estimate: true` all the way into quoting). Nothing
  unverified is ever pulled in; with nothing accepted, assembly refuses.
- **Provenance per line**: every line resolves back to the exact accepted
  row and sheet (`acceptedCountId` / `rowId` / `cableRunId` + plan/page/
  sha) — the walk-a-sample verification criterion runs on these links.
- **Duplicate-scope warnings** (#212) ride into the assembly: lines on
  linked counted pages flag themselves and the takeoff header lists the
  warnings.
- **Review → adjust → sign off**: adjustments (`human_qty` + note + who/
  when) are recorded and win on read — the legacy prototype's one right
  instinct (AI never overwrites human entries), kept. Manual lines can be
  added to a draft. **Sign-off freezes the version** (audited
  `document.takeoff_signed_off`); signed-off takeoffs are immutable —
  changes mean assembling a new version (the old signed-off stays the
  quoting source until the new draft signs).
- **The Epic 7 contract**: `signedOffTakeoff(sql, tenantId, jobId)` (store)
  returns the latest signed-off takeoff + lines; the typed shape is
  `Takeoff`/`TakeoffLine` in `src/domains/ai-drawings/schema.ts`
  (`effectiveQty` = human adjustment ?? assembled qty is the quoting
  number). Quoting reads NOTHING else from this epic. The legacy blob
  prototype (`ai-takeoff.json` count numbers) is superseded as a takeoff
  source; its file stays only as the #510 spend ledger.
- Storage: `takeoffs` + `takeoff_lines`
  (migration `20260703220000_epic5_takeoffs.sql`), partial-unique one live
  draft + one live signed_off per job. Assembler:
  `api/_lib/takeoff-assemble.js` (pure, unit-tested).
- **Verification criterion prod-gated**: on a real job, walk a sample of
  line items back to their source sheets via provenance and confirm the
  quantities match the accepted counts — joins the standing owner-preview
  session.

## Honest limits (deliberate, this slice)

- **No server-side PDF/OCR pipeline** — pages must have been rendered by the
  existing upload flow (client-side PDF.js → `set-pages`).
- **Switchboard schedules (#207)** ride the same machinery: the
  `switchboard` mapper (`circuitRef/description/protection/cableSize/phase/
  load` — named for `api/job-circuits.js` `circuitBoards` compatibility),
  prompt `sb-v1` with the verbatim-abbreviations rule stated even harder,
  tables keyed by `board_identifier`, and multi-page boards stitched **at
  read time** — same-board tables render adjacently as "part i of n", each
  keeping its own source page and row strips. Lighting and board runs on
  the same page cache and supersede independently. Extracted board rows are
  a review-side register — they do NOT write into `circuitBoards[]` (the
  engineering schedule keeps its single writer); feeding verified rows
  across is a #213-adjacent follow-up.
- The #205 review overlay is a **thin review-only surface** on the documents
  panel (per the issue: Epic 13's plans viewer owns rich rendering —
  coordinate, don't rival). No zoom/pan in the overlay yet; the markers sit
  on a fit-width raster.
- Room extents are **approximate bboxes**, not wall-tracing polygons
  (#206 v1 per its issue) — the redraw affordance is the correction path.
- Cable estimates (#211) group per BOARD, not per circuit — circuit-level
  grouping arrives with schematic circuit recognition (#209, deferred);
  #212's confirmed same-board links tie those boards across sheets but do
  not yet regroup estimates.
- Entity links (#212) are references + identity links only — the "full
  project knowledge graph" stays deliberately out of scope per the issue.
- Accuracy ACs (#201 legend listing, #202/#207 cell-level error rate,
  #204 detection precision/recall, #205 full-loop count match vs an
  independent hand count, #206 room names vs a human's room listing,
  #211 estimate vs a human's scaled measurement with deviation reported,
  #212 confirm/reject every proposed link on a real multi-sheet set,
  #213 walk takeoff lines back to their sheets via provenance)
  need prod — same owner-preview session as the #197/#199 checks.
- **The ≥10-page real-set end-to-end check (final #197 AC) needs production**
  (real Anthropic key + Supabase + a real drawing set) — run it there with
  the flag in owner-preview before closing the issue.
