# BuhlOS Job Builder redesign — campaign plan & prototype-vs-repo audit

> **Status:** in progress (Wave 1 landed). Source of truth for turning the
> Claude-Design *BuhlOS Job Builder* prototype into the real builder. The
> prototype (`BuhlOS Job Builder.dc.html` + its Build Prompt) is the **look &
> microcopy** reference; this doc is the **behaviour + sequencing** contract.
> Gated by the **`job_builder_redesign`** flag (admin-tier, default OFF).

## The finding (read this first)

The Job Builder is **not a greenfield build — it is ~85–90% already implemented.**
The design author's own foundation PR (#792) states it: *"the existing admin app
already covers ~80% of the prototype; the Job Builder §5 is done."* Rebuilding it
would duplicate a mature surface **and** two in-flight campaigns (#792 primitives;
the Plan Studio stack #849–852) and conflict heavily. So this is a **gap-fill +
primitives-adoption + polish campaign**, run in coordinated **waves**, each landing
dark behind `job_builder_redesign` and preview-verified before it becomes default.

Governance: this follows `CLAUDE.md`'s Constitution Gate — no architecture
principle changes. Task-led invariants hold (areas/tasks are facets; key off
canonical identity; `taskInstanceId` is not real; don't deepen area-owned task
arrays); proof stays package-granular by default; **truth-over-theatre (P7)** — the
prototype's placeholder counts/dollars/crew are **not** license to hardcode; naming
avoids "Switchboard/Site Office". `npm run check:full-ci` before every PR.

## Prototype step → repo reality → gap

| Design step (Build Prompt §5) | Repo support today | Gap → wave |
|---|---|---|
| **New Job** (blank / from blueprint) | `NewJobForm` + `StartFromBlueprintCard` + `domains/jobs/blueprints.ts` | Visual only → **Wave 1 ✅** |
| **Shell · rail · readiness · Overview** | `JobBuilderCockpit` (rail·canvas·inspector) + `buildBuilderReadiness`; Overview KPIs/"what's stopping publish"/"what the field sees" | Polish to prototype fidelity → **Wave 2** |
| **Basics** | cockpit Basics + `ClientContractSection` (admin-only contract block) | Polish → Wave 2 |
| **Documents** (upload + visible-to-crew + auto-fill) | plans tab (link-out) + `job-doc-import` (BOQ/scope import) | Consolidate into a Documents step; extract-card auto-fill UX → **Wave 4** |
| **Plan Studio (AI, `ai_drawings`)** | **In flight** — #850 (`PlanStudioPanel`) + #849/#851/#852 | Land the Plan Studio stack → coordinate |
| **Scope** + **Triage** | cockpit Scope + `ReviewQueue` (keyboard 1–8 triage) + reconciliation | Polish → Wave 2 |
| **Structure** (groups/areas/tasks; blank-task blocker) | cockpit Structure + readiness blank-task blocker | Polish → Wave 2 |
| **Spec & circuits** → Power/circuits + board schedule | **Built** — `api/job-circuits.js` + `CircuitScheduleApp` (#620/#622) | Add the **Product-spec** tab (brand/model/cut-out/supplier per system) → **Wave 3** |
| **Field modules** | cockpit Field modules (per-job `JobModules`) | Polish → Wave 2 |
| **Deliver** (hub cards + "Opens in BuhlOS") | separate link-out tabs (plans/materials/gear/itps/risks) | Consolidate into a single Deliver hub-cards step with real counts → **Wave 4** |
| **Crew** / **Phil preview** / **Publish** | cockpit Crew (assign/lead) · `buildPhilPreview` · publish gate (`canPublish`) | Polish → Wave 2 |
| **Blueprints** (save/consume templates) | `SaveAsBlueprintCard` + `StartFromBlueprintCard` + `domains/jobs/blueprints.ts` | Done; polish → Wave 2 |
| Design tokens (navy/yellow, Hanken/Inter/Plex) · shared primitives | `brand-navy`/`accent-yellow` tokens live; **#792** adds Bar/KpiStrip/Seg/Avatar/PageHead/Row/Dot | Adopt #792 into the cockpit → **Wave 2** |

**Genuinely missing** (everything else exists in some form): the **Product-spec**
data model + tab; the **Deliver/Documents** IA consolidation + auto-fill extract-card
UX; and pixel-fidelity polish via the #792 primitives.

## Wave plan

- **Wave 1 — New Job re-skin + campaign foundation (this PR).** `job_builder_redesign`
  flag (`.js`+`.d.ts`, admin-tier, default OFF, expiry 2026-12-31). `NewJobRedesign`
  renders the prototype's two-path "Start a new job" screen, reusing the exact
  create/blueprint logic (`createJob`/`buildCreatePayload`/`validateJobBasics`/
  `listBlueprints`/`instantiateBlueprint`). `new/page.tsx` flag-gates it; OFF = the
  current New Job, unchanged. Render test + `tsc` + `check:full-ci`.
- **Wave 2 — cockpit polish (depends on #792).** Adopt the #792 primitives into
  `JobBuilderCockpit`/`JobBuilderClient` and tighten the top-bar (readiness ring +
  draft/published pill + Save/Preview/Publish), rail (segmented readiness bar + step
  sub-labels + phone/link glyphs) and Overview/Basics/Scope/Structure/Crew/Preview/
  Publish to prototype density + microcopy. Flag-gated; reuse all existing domain
  wiring. **Coordinate with #849–852** (the Plan Studio tab): both edit the tab set —
  keep both.
- **Wave 3 — Spec & circuits: Product-spec tab (landed).** The product half of the
  prototype's §5.7: per-system product lines (qty · product · who supplies, "" = we
  supply) + a per-system edge-case note. Storage: `job.productSpec` on the job record
  (the switchboards/circuits precedent — rides JobSchema passthrough, one job GET
  carries it); `api/job-spec.js` is the only writer (GET job-visible, PUT
  canManageJob, validation mirroring job-circuits, ids preserved/minted, qty junk →
  null never a fake 0). Typed twin `src/domains/job-spec/` (Zod + client). Builder
  tab "Spec & circuits" gated by `job_builder_redesign`; the Power/circuits half
  links out to the shipped circuit schedule (reuse, don't duplicate). Phil does NOT
  consume the spec yet (office register only — stated honestly in the schema).
  Landed out of order (before Wave 2) because Wave 2 depends on the still-open #792.
- **Wave 4a — Deliver hub-cards step (landed).** The prototype's single **Deliver**
  step: one card per live hub (Plans & docs · Materials · Gear · ITPs/QA · Risks &
  RFIs) with a module pill + an "Opens in BuhlOS" link-out. **Real counts only** —
  the builder page now loads the job with `&withStats=1` (the same enrichment the
  job hub uses; comparable cost), so Plans (`statsDocumentsCurrent`), ITPs
  (`statsItpsActive`) and Gear (expired/expiring tags) show live numbers, while
  Materials and Risks/RFIs (not in the aggregate) show **no number at all** rather
  than an invented one (P7 — adding those counts to the withStats aggregate is the
  noted follow-up). While `job_builder_redesign` is ON the five per-hub link-out
  tabs collapse into this step; OFF is today's rail, byte-for-byte. The per-wave
  flag props also collapsed into one `redesignEnabled` prop (spec + deliver).
- **Wave 4b — Documents step (landed).** The builder's **Documents** tab
  (`DocumentsSection`, joining the Build group while `job_builder_redesign` is ON):
  the job's document register (title · category · status pill) with upload (the
  shell-neutral `DocumentUploadButton`) and a per-file **"Visible to field"**
  toggle. (Per-field AI auto-fill + a row-level "Open" view landed in Wave 4c
  below; the richer extract-card UX stays out of scope — see "Optional / later".)
  - **Concept:** per-file field visibility — the office keeps a document (head
    contract, commercial PDF) on the job without publishing it to the crew.
  - **Where stored:** `Document.visibleToField` (additive boolean, **default
    true** — an absent field means visible, so every pre-existing row behaves
    exactly as before).
  - **Who consumes:** `api/plans.js` — PATCH accepts the boolean (the builder tab
    is the writer); the GET list filters `visibleToField === false` rows out for
    every **non-admin** viewer (field + LH), so the Phil plans viewer only ever
    receives what the crew may see. Clients stay 403'd from the endpoint entirely.
  - **Enforced now:** yes, server-side (not a client-side hide; no query-param
    bypass, unlike the archived filter).
  - **Limitations:** visibility is per-file, not per-page; admin surfaces are
    unaffected (admins always see everything, hidden rows honestly labelled).

- **Wave 4c — upload flow: AI metadata auto-fill · view · pdf.js self-host (landed).**
  Three field-driven fixes to the Documents step, all still dark behind the flags:
  - **AI metadata auto-fill** (behind `ai_drawings`, resolved by the caller as
    `aiAutofillEnabled`): the single-file uploader shows a **"✨ Fill from file"**
    button that reads the picked file and **proposes** title / category / discipline /
    drawing № / revision via `POST /api/doc-metadata` — it fills the editable form and
    **never submits** (house rule: AI assists, the human saves). PDFs use the shared
    `pdf-text.js` text layer (no OCR pretence — a scanned PDF with no text layer falls
    back to the file name); images ≤5 MB use a vision block; anything else is
    filename-only. Metered through the shared per-job AI ledger (`ai-spend.js`, $5 cap):
    flag-dark → 404, unconfigured → 503, cap reached → 402 (before any spend), off-enum
    category/discipline **dropped, not coerced** (P7). Off in batch + revise mode.
  - **View a document:** each register row now carries an **"Open"** link
    (`Document.url`, new tab) mirroring `DocumentsList` — works for every category
    (contract, cert, photo…), not just plans.
  - **pdf.js self-host:** page-prep loaded pdf.js from a jsdelivr URL that 404'd
    (4.0.379 ships ESM only — there is no UMD `pdf.min.js`), so page pre-render was
    dead everywhere, not merely on CDN-blocked networks. The pinned legacy build
    (`pdf.min.mjs` + `pdf.worker.min.mjs`) is now committed under `public/pdfjs` and
    served same-origin via a `type="module"` shim (a failed load rejects rather than
    hangs; the "couldn't pre-render" note is muted, not alarming). `pdfjs-dist` pinned
    as a devDependency; `unpdf` added as the runtime PDF-text dep (byte-identical to the
    copy on the in-flight AI-batch branch — a trivial future merge).

- **Stability recovery (landed).** Field-testing verdict ("slow, buggy, confusing")
  drove a focused recovery slice:
  - **One-place plan flow:** the builder's Plan Studio tab now mounts the full
    sheet-analysis panel (`SheetUnderstandingPanel` — the same component the
    documents page uses) under the accept panel, so upload → **analyse** → accept
    happens in one tab; freshly mapped rooms auto-refresh the accept list
    (`onRoomsChanged` → `refreshToken`), plus a manual Refresh.
  - **AI failures are actionable:** the ai-drawings client now distinguishes the
    two 503s — `UNCONFIGURED` (missing `ANTHROPIC_API_KEY`; the message names the
    exact env var, from a real incident where the key was saved as "Antropic") vs
    `STORE_UNAVAILABLE` — and Plan Studio has explicit `CAP_REACHED` copy. Bulk
    accept re-syncs in `finally` so a half-applied batch never shows a stale list.
  - **Faster loads:** the builder page resolves flags first, then runs its three
    loads (job · workers · reconciliation) in **parallel** instead of sequentially,
    and only requests the `withStats` enrichment (6 extra blob reads) when the
    redesign's Deliver tab — its sole consumer — can render. The two AI panels are
    code-split (`next/dynamic`) out of the builder bundle.
  - **Unsaved-edit safety:** a browser `beforeunload` warning joins the in-app
    tab guard while anything is dirty.

- **UI/UX polish (landed).** Professionalisation pass after the stability slice:
  the redesign rail's **Build group reads in work order** (basics → scope →
  documents → Plan Studio → structure → spec → modules; legacy rail untouched);
  the Plan Studio tab composes **top-down as the flow** (upload header → analysis
  panel via a new `analysisSlot` prop → detected rooms → accept); the analysis
  panel is titled **"Plan analysis"** in plain language (was "AI sheet
  understanding") and its unavailable state shows the actual reason unwrapped
  (missing `ANTHROPIC_API_KEY` vs missing store); **"Unsaved changes"** renders in
  the warning tone so dirty state reads as attention.

Optional / later (large, own decisions): the richer AI auto-fill **extract-card** UX
(accept-cards across the whole register) and OCR for scanned PDFs; binding analysis
results to a specific document revision (re-diff #851 already warns on drift);
promoting the redesign to admin default (a governance change — needs the flag proven
on preview first, per `docs/feature-flags.md`).

## Coordination with in-flight PRs

- **#792** (shared admin primitives) — the Wave 2 foundation. Wave 2 depends on it
  merging (or rebasing onto it).
- **#849–852** (Plan Studio: rooms→areas bridge + builder tab + re-diff + tasks) —
  the "Plan Studio (AI)" step of the prototype. These merge on their own track; Wave 2
  reconciles the tab set (both add builder tabs — trivial keep-both merge).

## Definition of done (per wave)

Renders inside `AdminShell`; no new routes (or registered in `route-ownership.md` +
guard same PR); all data from real APIs, honest empty/error/UC states, **no invented
numbers**; keyed off canonical task identity; landed behind `job_builder_redesign`
(`default:false`, expiry); `npm run check:full-ci` green; preview-verified (the
builder reads `api/*.js`, so `next dev` can't fully exercise it); any touched
governing doc updated in the same PR.
