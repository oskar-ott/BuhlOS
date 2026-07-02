# AI suggestions — the review conventions (2026-07 standalone AI batch)

> Scope: #246 quote drafts · #262 photo labels · #267 snag suggestions ·
> #347 insights digest · #373 contract obligations · #171 office daily
> summary. All ride the #170 assistant foundation and the shared conventions
> below. All ship **flag-dark** (default OFF, admin-tier): `ai_quote_drafts`,
> `ai_photo_labels`, `ai_snag_suggestions`, `ai_insights_digest`,
> `ai_contract_obligations`, `ai_office_daily_summary`.

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
- **#171 office daily summary** — the #347 two-stage pattern applied daily:
  deterministic fact-gathering over the previous Sydney calendar day
  (`api/_lib/office-summary.js`, pure, fixture-tested — hours via the shared
  per-user blob walk `listEntriesForDate`, snags/evidence per active job,
  blocker observations) → the model only REPHRASES the fact table into a
  short narrative; every numeral is validated against the facts, any miss →
  the deterministic lines render alone (AI absence degrades to facts, never
  to nothing or fakes). Stored per day at
  `analytics/office-summaries/<date>.json` (covered by the `analytics/`
  backup-manifest prefix) with the fact table + a coverage record naming
  read failures ("2 of 14 timesheets unreadable") — partial data is never
  presented as complete. Generated on-demand from /reports and by a daily
  cron (20:30 UTC ≈ 6:30–7:30am Sydney) that no-ops while the flag is dark
  (tested). First non-quiet generation of a date pushes the admin tier
  (`pushedAt` dedupe); a quiet day stores the honest record and sends
  nothing. Relationship to the non-AI 5pm `send-daily-digest` push:
  **coexist, distinct jobs** — 5pm is a same-day one-line scoreboard nudge,
  7am is yesterday's persisted auditable narrative; revisit once live.
  Boundaries: anomalies belong to #347; current-state metrics to #316;
  per-user tailoring is future (#170's dual-principal question).
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

## Enable gates (before flipping any of these flags for the crew)

- `ai_photo_labels` (#262): measure per-photo classification cost on the PR
  preview with REAL evidence JPEGs and record it on #262 first — the issue
  stays open until the number is written down. Re-measure after #261
  thumbnails land (smaller inputs, cheaper calls). Backfills are an explicit
  admin action, capped per batch, cost documented before running.
- `ai_insights_digest` (#347): add the weekly vercel.json cron + admin push
  fan-out when (not before) the flag turns on.
- `ai_office_daily_summary` (#171): measure per-generation cost (one model
  call/day, facts payload scales with active jobs) on the PR preview and
  record it on #171 first — cost measurement stays a pre-flip requirement.
  The daily cron line is already in vercel.json and no-ops while dark
  (tested); confirm CRON_SECRET is set in prod before flipping so the
  morning run actually fires.
- All of them: `ANTHROPIC_API_KEY` must be present in the environment or
  every surface shows its honest "AI is not configured" state.
