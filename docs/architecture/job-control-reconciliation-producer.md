# L0 — clause-classification + reconciliation producer

> Status: **real, runtime producer.** The first producer on the TS App Router
> runtime boundary ([ADR](job-control-runtime-adr.md), #463). Code:
> [`src/server/job-control/reconciliation-producer.ts`](../../src/server/job-control/reconciliation-producer.ts)
> + routes under
> [`src/app/api/job-control/reconciliation/`](../../src/app/api/job-control/reconciliation/).
> Compiles NOTHING — that is L1.

## Why

`compileWorkPackages()` (L1) needs a real, confirmed `ScopeReconciliation`, but
nothing produced or persisted one. This slice is that missing input: it turns a
job's agreed scope clauses into a classified, conflict-checked reconciliation the
office confirms, and stores it for L1 to compile from.

## What it does

- **Reads real scope clauses** — `Job.scopeOfWork[]` (#200) from the `jobs.json`
  blob. The job↔quote link is #244 (not live), so the quote is `null` today and
  is never fabricated.
- **Runs the tested pure engine** — `src/domains/job-control/reconciliation.ts`
  (#366): `seedReconciliation` / `reconcile`, `classifyClause`, `detectFindings`,
  `reconciliationStatus`. No reconciliation logic is duplicated here.
- **Accepts admin classifications** — a `{ clauseId: classification }` map over
  the domain's closed ten-class set (`priced`, `general_allowance`, `excluded`,
  `by_others`, `reuse_existing`, `pc_provisional`, `variation_trigger`,
  `closeout`, `admin_only`, `unclear`). Unknown values are rejected — no invented
  classifications. (The brief's suggested names — `field`, `needs_confirmation` —
  are NOT the domain's; we follow the domain. `priced`/`general_allowance` are the
  field-delivered work; `unclear` is the not-yet-classified state.)
- **Preview then confirm.** Preview returns a draft reconciliation + warnings and
  persists nothing. Confirm persists the result.
- **Conservative by default.** Any clause the office does not explicitly classify
  stays `unclear` and is surfaced as a warning (`unclassifiedClauseIds` +
  `clause_unpriced_unclassified` findings). **Unclassified scope never silently
  becomes field work.**

## Routes

| Route | Method | Auth | Writes |
|---|---|---|---|
| `/api/job-control/reconciliation/preview` | POST | admin-only | no |
| `/api/job-control/reconciliation/confirm` | POST | admin-only | `jobs/<jobId>/scope-reconciliation.json` |

Preview body: `{ jobId, classifications? }`. Confirm body:
`{ jobId, sourceHash?, classifications? }` — when `sourceHash` is supplied it is
checked against the current scope; a stale confirm is rejected with `409`
(`code: "stale_source"`), writing nothing.

## Persistence

The confirmed envelope at `jobs/<jobId>/scope-reconciliation.json`:

```jsonc
{
  "jobId": "...",
  "reconciliation": { /* domain ScopeReconciliation — L1 reads this */ },
  "status": "red | amber | green",
  "warnings": [ /* findings snapshot at confirm */ ],
  "sourceHash": "<sha256 of clauses + quote>",
  "confirmedBy": "...", "confirmedAt": "...",
  "generatedAt": "...", "updatedAt": "..."
}
```

## Auth

- **Preview** (read-only) uses the lighter unverified `decodeSessionCookie` +
  `isAdminRole` gate, like the #463 runtime-check route.
- **Confirm** (write) uses the ADR-required **authoritative** HMAC-verified check
  (`verifyViaApi` → /api/auth?action=me): a forged/unsigned cookie that fools the
  unverified decode cannot reach the write. The gate lives in the pure,
  injectable `authorizeAdminViaVerify` / `confirmReconciliationAuthorized`
  (so it is unit-tested without Next), with the route wiring real `verifyViaApi`.

## Backup coverage

The confirmed store `jobs/<jobId>/scope-reconciliation.json` is **backed up**: it
falls under the existing `jobs/` PREFIX_STORE in `api/_lib/backup-manifest.js`
(`isCoveredKey(...)` → true), which the snapshot job (`api/_lib/backup.js`)
enumerates by prefix and copies every `*.json` under. The manifest comment now
names the document explicitly. (`scripts/check-backup-manifest.js` scans only
`api/` writers, so it neither requires nor flags this TS write — coverage here is
via the prefix, not the CI guard.)

## Known limitations / follow-ups

- **Quote link.** No job↔quote link yet (#244); reconciliation is clause-only
  until that lands.
- **Warnings snapshot is clause-only.** The persisted `warnings` keep
  `{ key, kind, severity, clauseId, message }` — fine for the clause-based
  findings that exist today. The two line-based findings
  (`alternate_in_base_total`, `priced_line_no_clause`) only arise once a quote is
  linked (#244); when that lands, add `ref` to the persisted warning and pass it
  through, or have consumers re-derive line findings from the live preview /
  recover the line key from the finding `key`.

## Next slices

- **L1** — compile preview/confirm: read this persisted reconciliation, run
  `compileWorkPackages()` + `diffCompile()`, persist `jobs/<jobId>/job-control.json`.
- **L2** — field-gated read returning `{ workPackages, evidenceLinks }`.
- **L3** — wire into `/phil/jobs/[jobId]` → `buildAreaTaskContext(...)`.
