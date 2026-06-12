# Legacy quotes module — capability audit & migrate-vs-integrate decision (#172)

**Date:** 2026-06-12 · **Scope:** `api/quotes.js` (1,647 lines), `api/quote-documents.js` (173), `api/quote-stats.js` (107), plus the two HTML surfaces deleted by the legacy cutover (PR #376). Read-only audit — no production behaviour changed.

---

## 1. Executive summary & recommended decision

> **Recommendation: MIGRATE-BY-REBUILD.** Build v2 quoting fresh (#183 onward) using the legacy module as a *proven design reference*, not a runtime dependency. Keep the legacy API deployed but unlinked as the read path for the two existing draft shells; retire it when #183 reaches parity. There is **no data-migration project** — production contains 2 draft quotes whose only content is uploaded plan images.

Three facts decide it:

1. **The UI is already gone.** PR #376 (2026-06-12) deleted `public/admin/quotes.html` + `quote.html`; `/admin/quotes` 307s to `/command-centre`. "Integrate" (v2 UI over the legacy API) would couple new UI to a 1,647-line endpoint with no write guards, no concurrency control, a convert that bypasses `api/jobs.js`, and a retired AI model.
2. **Production usage was ~zero** (§3). 2 quotes, both `draft`, 0 accepted / 0 converted / 0 revisions; **no** structure / materials / labour / pricing / notes / provisional / ai-review / pricing-request blob has *ever* been written. The only real content is 30 plan PNGs across the two quotes. Nothing to port, no live workflow to protect.
3. **The design is the asset.** The module is a complete, coherent quoting system on paper — 9 section blobs, 10 statuses, category-markup totals math, a sourcing loop, acceptance records, revision lineage, quote→job convert. Epic 7's children map almost 1:1 onto it (§6). Rebuilding against the same *concepts* on v2 routes + blob-guards (and Supabase Phase 1's quote tables when dual-write starts) is the cheapest way to a trustworthy quoting tool.

**What "integrate" would have bought is already lost** (the working UI), and **what "migrate" usually costs is absent** (data volume). Hybrid is not warranted: `api/quote-documents.js` could survive standalone, but #385 (document revision lineage) and #365 (workbook import) are better built on the v2 foundation.

---

## 2. Post-cutover reality (supersedes this issue's "Current state")

| Piece | Status today |
|---|---|
| `public/admin/quotes.html` + `quote.html` | **Deleted** by #376; `/admin/quotes[/:id]` → 307 `/command-centre` |
| `api/quotes.js`, `api/quote-documents.js`, `api/quote-stats.js` | **Deployed and live**, admin-tier only, reachable by URL — but no surface links to them |
| AI review (`action=ai-review`) | **Broken in production**: hardcoded `claude-3-5-sonnet-latest` (quotes.js:1067) is a retired model (see #378). Fails gracefully — error stored in `rawModelNotes`, review saved as `needs_review` |
| Quoting as a business workflow | **Does not exist in the product right now.** The capability gap is total, which is why #120/WS2 calls quoting the pipeline middle |

The cutover shipping without quoting complaints is consistent with §3's usage census.

---

## 3. Production data inventory (read-only Blob census, 2026-06-12)

Direct `@vercel/blob` list + read using the local env token:

- **`quotes.json` registry: 2 quotes, both `status: "draft"`.** 0 with `acceptance`, 0 with `convertedJobId`, 0 with `parentQuoteId` (no revisions ever made).
- **`quotes/` prefix: 32 blobs total** = 2 × `documents-index.json` + 30 uploaded documents (PNG pages, ~220–650 KB each — two uploads of what looks like the same ~10-page plan set, likely the AI-takeoff experiments).
- **Sections that have NEVER been written by anyone:** `structure.json`, `materials-estimate.json`, `labour-estimate.json`, `notes.json`, `pricing.json`, `provisional.json`, `ai-review.json`, `pricing-requests.json` — zero instances under `quotes/`.
- Conclusion: the module was exercised as a **document dump twice**; estimating, pricing, acceptance and conversion were never used in production. Migration cost of real quote data: **nil**. (Keep the 2 shells + images readable until #183; or archive and re-upload the plans to the v2 tool when it exists.)

---

## 4. Capability map — the API layer

### 4.1 Storage model

- **Registry** `quotes.json`: quote shells — id, name, builder, contact{Name,Email,Phone}, siteAddress, dueDate, expectedStartDate, jobType, description, status, notes, `convertedJobId`, `acceptance`, `reasonLost`, `parentQuoteId`, `version`, audit stamps.
- **Per-quote sections** under `quotes/<id>/`: `structure.json` (areaGroups→areas→workPackages{stage,tasks}), `materials-estimate.json` (rich line items incl. category/unit/unitCost/source/confidence/status), `labour-estimate.json` (lines: area/system/stage/task, estimatedHours × crewSize × riskFactor, rateType/hourlyRate), `notes.json` (assumptions/exclusions/risks/clarifications), `pricing.json` (per-category materialMarkupPct, labourSellRate, labourCostMode per-line|shared, contingencyPct, gstPct, validityDays, overrideTotalExGst), `provisional.json` (PS/allowance items), `ai-review.json`, `documents-index.json` (+ binary files under `documents/`), `pricing-requests.json` (wholesaler RFQ drafts with reply capture).

### 4.2 Statuses (quotes.js:88–92)

`draft → reviewing → estimating → submitted → accepted → won | lost | declined → converted_to_job | archived` — but transitions are **free-form via PATCH** except three action-boundary guards: can't accept/convert from lost/declined/archived, can't unaccept unless accepted, convert is terminal. Loss reasons (`reasonLost{category,reason,at,by,prevStatus}`) captured on lost/declined, cleared on won.

### 4.3 Actions (16 + CRUD), one line each

| Action | What it does |
|---|---|
| GET list / GET id | List enriches counts (documents/materials/labourLines/hours); single returns the full 9-section bundle + computed totals |
| POST / PATCH / DELETE | Create shell (no section init) / edit basics + status (+reasonLost) / soft-archive |
| `structure` GET/PATCH | Full-replace areaGroups; ids minted server-side |
| `materials` GET/POST/PATCH/DELETE | Line CRUD; bulk add via `lines[]` |
| `labour` GET/POST/PATCH/DELETE | Line CRUD |
| `notes` GET/PATCH | Full-replace four lists |
| `pricing` GET/PATCH | Merge-with-validation (markup −50..500%, contingency 0–50, GST 0–30, validity 1–365, override ≥ 0) |
| `provisional` GET/POST/PATCH/DELETE | PS/allowance CRUD |
| `totals` GET | Server-side `computeQuoteTotals` (§4.4) |
| `pricing-requests` GET/POST/PATCH/DELETE | Wholesaler RFQ: drafts a subject/body email (mailto only — never sends), tracks drafted→sent→replied→won/lost, captures replyTotalExGst |
| `metrics` GET | Win rate, cycle days, 30d inflow, 90d won value |
| `ai-review` POST/GET | Anthropic call on ≤12K chars of pasted scope → suggested areaGroups/systems/tasks/materials/risks/assumptions, saved as suggestions only — **model retired, currently errors gracefully** |
| `accept` / `unaccept` | Acceptance record {acceptedAt/By, clientName/Role, reference, acceptedAmountExGst, method email|verbal|po|signed|other}; unaccept → submitted |
| `convert` | §4.6 |
| `duplicate` / `revise` | Copy structure+materials+labour+notes (NOT documents), re-id everything, status→draft; revise computes `version` against the root via `parentQuoteId` |
| `benchmark` | Walks 180 days of per-user time-entry blobs → hours-per-area on past jobs, for estimating reference |

### 4.4 Totals math (server, quotes.js:788–898)

Materials: qty × unitCost with **per-category markup**. Labour: hours × crew × risk, cost at per-line or shared rate, sell at `labourSellRate`. + provisional sums (no markup) → contingency % → optional fixed-price override → GST. Returns full breakdown incl. **internal margin $ / %** (PS excluded from margin). This math is the spec for #214/#193/#195/#223.

### 4.5 Auth

Whole module: `requireAuth` + `isAdminRole` tier gate (quotes.js:1538) — admin tier only, no per-action differences. `quote-stats.js` uses `requireAuth(req,res,{roles:['admin']})` which is **tier-aware** (`roleSatisfies`, auth.js:153–171) — not the literal-role bug class.

### 4.6 Convert — the flagged risk, confirmed

`action=convert` (quotes.js:1164–1298) **writes `jobs.json` directly via `writeBlob`** (line 1258) — it does NOT go through `api/jobs.js` POST, so it bypasses the draft/publish lifecycle, jobs-API validation and any side effects. It also seeds `jobs/<id>/data.json` and `jobs/<id>/materials-list.json` directly. Mapping is real and decent: quote areaGroups → job areaGroups (re-id'd), stage-unioned roughInTasks/fitOffTasks, materials copied (source/confidence dropped), `fromQuoteId` stamped; quote becomes terminal `converted_to_job`. **Irreversible.**

- **Today's exposure:** the action is still reachable (admin-only, no UI). If v2 quoting coexists with the legacy API, a double write-path to `jobs.json` exists. Mitigation in §7.
- **v2 requirement (#244):** convert must go through the jobs API (the duplicate-job pattern from #190 — pure mapper → create-path validators — is the template).

### 4.7 Other risks/oddities found

- No blob-guard validators on `quotes.json` / `quotes/*` (writes pre-date #157 guards; only generic rev-stamping applies); no concurrency control — parallel section PATCHes are last-write-wins; `touchQuote` swallows errors; totals recomputed per GET (fine at current volume); pricing has no historical snapshot — re-pricing after acceptance silently changes what totals would print; `acceptedAmountExGst` may be null so pipeline value can under-report; PATCH can set any status directly (e.g. jump to `converted_to_job` without seeding a job).

### 4.8 `api/quote-documents.js`

Typed tender-doc register per quote: 25 MB cap, dataUrl upload via `@vercel/blob put` under `quotes/<id>/documents/`, drawingNumber/revision/status (current|superseded|archived), PATCH status, DELETE archive. Self-contained and sane; v2 can consume it as-is initially.

### 4.9 `api/quote-stats.js`

Pipeline rollup: byStatus, active/terminal split, conversionRate, **stale thresholds per active status** (draft 3d / reviewing 5d / estimating 7d / submitted 10d / accepted-not-converted 5d). Good spec for the v2 pipeline widget.

---

## 5. What the deleted UI could do (parity bar for v2)

From git history (`9f5f174:public/admin/quotes.html|quote.html`):

- **List page:** status tabs + search; metrics strip (win rate, 30d inflow, 90d won value); **"lessons learned" panel** aggregating 6 months of loss reasons by category; create modal.
- **Workspace (11 tabs):** Overview (basics + derived activity timeline) · Documents (upload/supersede/archive) · AI Review (paste scope → suggestions → **"apply selected"** merges into structure/notes/materials as `ai_suggested`/`needs_review`) · Structure (groups→areas→work packages, bulk add incl. numbered ranges) · Materials (single/bulk-parse "40 x Twin GPO — Iconic") · Sourcing (RFQ cards, mailto + copy-body, reply capture, best-price KPI) · Labour (lines + totals + **"load reference jobs"** benchmark) · Provisional · Pricing & totals (category markup table, labour modes, contingency/GST/validity/override, live margin grid) · Risks & assumptions · Summary.
- **Summary tab:** **Print Internal** (full costing incl. labour + margin) vs **Print Client** (scope + totals only, explicitly excludes internal breakdowns, validity + signoff block) — browser print, no PDF generation; acceptance capture + undo; convert button.
- **Never existed:** e-signature, real email send, PDF files, templates, approval workflow, concurrent-edit safety, quote→job actuals feedback.

The internal-vs-client print split is exactly #186; keep it.

---

## 6. Gap table — Epic 7 targets vs legacy

| Epic 7 child | Legacy had… | Verdict for v2 |
|---|---|---|
| #183 builder foundation | 9-section model, server totals | **Rebuild** on v2 routes; reuse storage concepts + section names |
| #193 labour calculator | lines × crew × risk, two cost modes, benchmark action | Rebuild; keep the math, wire benchmark to real job history (#350) |
| #195 material calculator | per-category markup, rich lines, bulk parse | Rebuild; supplier-products data already exists for #208 |
| #214 margin calculator | full margin grid in `computeQuoteTotals` | Port the math near-verbatim (it's the spec) |
| #223 contingency | contingencyPct 0–50 in pricing | Carry concept |
| #208 supplier pricing | RFQ loop with reply capture (mailto only) | Rebuild on suppliers register; add real send later |
| #186 internal vs client doc | printInternal / printClient split | Carry the split exactly |
| #243 branded PDFs | browser print only | New build |
| #240 acceptance tracking | acceptance record (method enum, amount, reference) | Carry the record shape; add sent/viewed states |
| #229 version history | parentQuoteId + version, copy-on-revise | Carry; fix #384 (revise drops pricing + provisional) at rebuild |
| #232 approval workflow | none | New build |
| #245 templates | none | New build |
| #246 AI quote drafts | ai-review suggestions loop (retired model) | Rebuild on current model; the apply-suggestions UX is proven |
| #244 convert quote→job | working convert that bypasses api/jobs.js | Rebuild THROUGH the jobs API (see §4.6) |
| #365 workbook import / #372 progress claims / #385 doc lineage | absent / absent / partial (supersede flag) | New builds on the v2 foundation |

---

## 7. Risks & immediate mitigations (no behaviour changed by this audit)

1. **Live unlinked convert** writing `jobs.json` directly: admin-only and unused in practice (0 conversions ever). Leave as-is for now; **disable `action=convert` (410) as the first commit of #183** so the legacy write-path dies before v2 creates a second one.
2. **No write guards on quote stores:** add `quotes.json` + `quotes/<id>/*` validators to `api/_lib/blob-guards.js` when #183 starts writing them (registry is in the backup manifest already; per-quote sections ride the `quotes/` prefix).
3. **Retired AI model** (quotes.js:1067): covered by #378's sweep; don't fix inside the dead module — v2 AI work (#246) starts fresh.
4. **The two draft quotes + 30 plan images:** harmless; leave readable. Re-home the images when #183 lands document handling.

## 8. Sequencing for Epic 7 (follows from the decision)

1. **#183 quote builder foundation** — v2 routes, section model per §4.1, blob-guard validators, totals math ported from §4.4; first commit disables legacy `convert`. Anticipate Supabase Phase 1 (`quotes` tables exist in `20260611142758_phase1_core_schema`): keep the domain model table-shaped, dual-write when #152 wiring lands.
2. **#193 + #195 + #214 + #223** — calculators on the foundation (the legacy math is the acceptance spec).
3. **#186 + #243** — internal/client split, then real PDFs.
4. **#240** acceptance (carry record shape) → **#232** approval → **#229** versions (fixing #384 semantics).
5. **#244 convert** through `api/jobs.js` (the #190 fresh-ids-by-construction pattern), closing the loop to #120/WS2.
6. Then #208 / #245 / #246 / #350 / #365 / #372 / #385 as capacity allows.
7. Retire `api/quotes.js` + redirect-tombstone it once #183+#244 reach parity; update `docs/route-ownership.md` at each step.

---

*Sources: full read of the three endpoints at `e3646d2`; deleted UI read from git object `9f5f174`; production Blob census via read-only `@vercel/blob` list/fetch on 2026-06-12. Issue: #172.*
