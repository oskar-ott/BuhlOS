# ADR — a TypeScript App Router runtime boundary for job-control

**Status:** Accepted (2026-06-15). Foundation only — no producer/persistence yet.

## Problem

The job-control compiler is TypeScript and tested:
`compileWorkPackages()`, `reconcileScope()`, `diffCompile()` in
`src/domains/job-control/**`. But every runtime surface that can read/write
Vercel Blob is **plain CommonJS JavaScript** — the `api/*.js` Vercel functions
and `api/_lib/blob.js`. JS Vercel functions cannot `require()` the TypeScript
domain code (it is compiled for the Next app bundle, not for the standalone
functions). The audit (see git history of #368/L1) found **no** runtime that can
both (1) call the tested TS compiler and (2) persist `jobs/<jobId>/job-control.json`:
no App Router route handlers, no server actions, no TS-side blob helper, no TS
script runner.

So the L1 producer (compile → persist) had nowhere to live.

## Rejected option — port the compiler to JS

Re-implementing `compileWorkPackages`/`reconcileScope`/`diffCompile` (~600 lines)
in `api/_lib/job-control.js` would create **two sources of truth** for the
compile algorithm: the tested TS engine and a hand-kept JS copy. Drift between
them is a correctness hazard (a field worker could see provenance the office's
own numbers disagree with — a P7 violation). Rejected.

## Decision

Introduce a **narrow TypeScript App Router runtime boundary** for job-control
producer/read endpoints, so future endpoints reuse the tested TS domain code
directly:

- `src/app/api/job-control/**/route.ts` — TS App Router route handlers (run in
  the Node runtime; can import `@/domains/job-control/**`).
- `src/server/job-control/blob.ts` — a small TS blob helper mirroring
  `api/_lib/blob.js` (read/write JSON by key over `@vercel/blob`).

This PR proves the boundary with one harmless GET route
(`/api/job-control/runtime-check`) and the blob helper. It compiles **no real
job** and writes **no production data**.

### Why this coexists with `api/*.js` (no Vercel config change)

`next.config.ts` already states the invariant: *"vercel.json owns legacy URL
routing; new surfaces mount on their own paths and serve directly."* The root
`api/` Vercel functions and the Next App Router are separate systems; a path
like `/api/job-control/runtime-check` has **no** `api/job-control*.js` file, so
Next serves it. `vercel.json` has no `/api/*` catch-all (only the `functions`
entry + cron paths). `typedRoutes` is unaffected — route handlers are not page
routes.

## Constraints

- TS route handlers are **only** for job-control runtime production/read
  boundaries unless separately approved. Do not migrate other `api/*.js` routes.
- Existing `api/*.js` routes and `api/_lib/blob.js` remain **untouched**.
- **No** Phil UI, Capture, My Day, or product-behaviour change in this PR.
- **No** Supabase, no new storage provider.
- **Auth:** route handlers reuse the existing TS session helpers
  (`decodeSessionCookie` + `isAdminRole`). The runtime-check route is admin-only
  and read-only. NOTE for future write endpoints (L1): a real mutation must use
  the **authoritative** `verifyViaApi()` check (HMAC-verified), not just the
  unverified cookie decode.
- **Backup coverage (future L1):** `scripts/check-backup-manifest.js` scans only
  `api/`, so a TS write under `src/server/**` is invisible to it. When L1 writes
  `jobs/<jobId>/job-control.json`, that key must be registered in
  `api/_lib/backup-manifest.js` (and the guard likely extended to scan
  `src/server`), or the store never gets backed up.

## Next slices (not in this PR)

1. **L0** — clause-classification + reconciliation producer → persist `ScopeReconciliation`.
2. **L1** — compile preview/confirm → persist `jobs/<jobId>/job-control.json`.
3. **L2** — field-gated read returning `{ workPackages, evidenceLinks }`.
4. **L3** — wire into `/phil/jobs/[jobId]` → `buildAreaTaskContext(...)` (lights up #462).
5. **Field validation** — #132 Appendix A with two workers.
