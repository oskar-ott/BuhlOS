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

## Honest limits (deliberate, this slice)

- **No server-side PDF/OCR pipeline** — pages must have been rendered by the
  existing upload flow (client-side PDF.js → `set-pages`).
- **Lighting schedules only so far** — the switchboard mapper + board
  grouping is #207; no revision diff (#203), no device recognition
  (#204/#205).
- Accuracy ACs (#201 legend listing, #202 cell-level error rate on a real
  schedule) need prod — same owner-preview session as the #197/#199 checks.
- **The ≥10-page real-set end-to-end check (final #197 AC) needs production**
  (real Anthropic key + Supabase + a real drawing set) — run it there with
  the flag in owner-preview before closing the issue.
