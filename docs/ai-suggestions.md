# AI suggestions — the review conventions (2026-07 standalone AI batch)

> Scope: #246 quote drafts · #262 photo labels · #267 snag suggestions ·
> #347 insights digest · #373 contract obligations. All five ride the #170
> assistant foundation and the shared conventions below. All five ship
> **flag-dark** (default OFF, admin-tier): `ai_quote_drafts`,
> `ai_photo_labels`, `ai_snag_suggestions`, `ai_insights_digest`,
> `ai_contract_obligations`.

## The rule

**AI assists. AI never silently decides.** Every AI output in the platform is
a *suggestion*: grounded in real records, carrying provenance and confidence,
reviewable, editable, rejectable — and it becomes real job/quote/snag/scope
data only through an explicit human action, through the **same write path**
a human would have used.

## Shared layer

| Module | Owns |
| --- | --- |
| `api/_lib/ai.js` (#170) | The ONE model gateway: `aiComplete`, capped `max_tokens`, honest `AiError` (`UNCONFIGURED` → caller 503s, `PROVIDER_FAILED` → 502), usage returned for spend records. Model ids are env-configurable bare aliases (#378). |
| `api/_lib/ai-suggestions.js` | The suggestion envelope (`suggestionEnvelope`) — id, type, model, promptVersion, confidence (0..1), `sources` `{store,id}` refs, review fields; the review state machine (`reviewSuggestion`): `suggested → accepted \| edited \| rejected \| superseded`, terminal states immutable, `edited` requires the human correction payload; `parseModelJson` (strict — prose is a failure, not a partial answer); `ungroundedNumerals` (the #347 grounding validator). |

Storage stays **feature-local** (per-quote doc, evidence rows, per-job blobs,
digest blobs) — there is deliberately no central "AI suggestions" store.
New AI data concepts introduced by the batch are all **draft data**
(suggestions/proposals awaiting review) or **derived read-model data** (the
digest); none are production data until a human accepts them, and audit-log
entries record both the suggestion event and the human decision.

## Per-feature contracts

- **#262 photo labels** — additive `labels[]` + `aiLabelRuns[]` on evidence
  rows. Closed 12-label electrical taxonomy (server whitelist in
  `api/_lib/photo-labels.js`, typed mirror `src/domains/evidence/labels.ts`,
  sync-tested). Lazy classify-on-review (admin triggers; capture never waits
  on a model). Idempotent per (photo, modelVersion) incl. zero-label runs;
  failures write no marker (re-attemptable). Human labels always win; a
  human-removed AI label is `rejected` and **never resurfaces**. Suggestions
  render tentative and hide below confidence 0.5.
- **#267 snag suggestions** — pure projection (`defect-suggestions.ts`) over
  `possible-defect` labels ≥ 0.75 (or human-confirmed), minus sticky
  dismissals and photos already linked from a snag. Accept = the EXISTING
  `POST /api/snags` create with `evidenceIds` (no second snag pipeline);
  dismiss = one sticky, audited evidence-row stamp carrying the confidence so
  precision is measurable.
- **#347 insights digest** — two-stage: deterministic anomaly rules
  (`api/_lib/insights-anomalies.js`, pure, fixture-tested, documented
  thresholds) → the model only REPHRASES findings; every numeral in the prose
  is validated against the findings payload, any miss → deterministic
  template fallback (never blocked, never unvalidated prose). Stored per week
  at `analytics/digests/<weekStart>.json` (registered in the backup
  manifest) with the findings JSON for later audit; quiet weeks store a
  no-findings record and send nothing. Generation is on-demand from /reports
  (cron-capable via CRON_SECRET; the vercel.json cron line lands when the
  flag turns on). Coverage footer states what the digest does and does not
  see. Boundary: per-record staleness detection belongs to #175.
- **#246 quote drafts** — drafts live in the quote doc's additive `aiDraft`
  field; totals never read it. Paste-first input (12,000-char truncation
  disclosed); the Epic-5 takeoff input is a typed, stubbed contract. Accepted
  lines enter sections through the normal doc write with
  `source: 'ai_suggested'`, `needsPricing: true`, rate 0 — the AI never
  prices anything.
- **#373 contract obligations** — TEXT-FIRST extraction (PDF text extraction
  is blocked on #197 and the UI says so) into
  `jobs/<jobId>/contract-extractions.json` proposals with verbatim
  `sourceQuote` + `sourceLocation`. Accept appends a `ScopeOfWorkItem`
  through the #200 write path with a visible `[Source: …]` provenance suffix;
  clauses then flow into reconciliation as `unclear` — the AI's suggested
  classification is a review hint, never applied automatically.

## Testing conventions

Model calls are always mocked (the ai-assistant harness pattern:
`createRequire` + cache injection); no live Anthropic calls in CI. Every
feature tests: flag-dark 404, tier gates, honest 503/502, the review
transitions, and that nothing unreviewed becomes authoritative.
