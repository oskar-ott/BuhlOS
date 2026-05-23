# 21 · Rebuild decision record (ADR)

> ADR-style record of every binding rebuild decision. Each entry: context, decision, consequences, alternatives rejected. Update when a decision is revised; do not edit existing decisions in-place — append a new ADR that supersedes.

---

## ADR-001 · Rebuild the frontend

- **Context:** The legacy frontend has three coexisting admin architectures, two coexisting Phil architectures, no type safety, no tests, 60+ "Site Office" leaks, mock data masquerading as live, and six blank-page production incidents in 10 days. Every additional change creates a new regression.
- **Decision:** Rebuild the frontend from scratch in Next.js + TypeScript + Tailwind under `src/`.
- **Consequences:**
  - Legacy `public/*.html` files stay deployed until each is replaced.
  - New app is additive — mounts on non-colliding routes first.
  - Two surfaces coexist for the duration of the rebuild (~6 phases).
  - Migration cost is amortised across phases; no big-bang.
- **Alternatives rejected:**
  - Incremental rewrites inside existing `public/*.html` — Phase 1A judged unfixable.
  - Total rewrite in a new repo — loses git history and Vercel project; higher risk.
  - Switch frameworks (Vite + React vs Next.js) — Next.js App Router won for SSR + middleware + typedRoutes + file-system routing eliminates `vercel.json` route sprawl.

## ADR-002 · Retain the backend

- **Context:** `api/*.js` (86 endpoints) + `api/_lib/*` + Vercel Blob storage works. `api/_lib/auth.js` (HMAC session) and `api/_lib/time-entries.js` (well-formed hours model) are particularly good. Backend rewrite is high-risk and would block the frontend rebuild.
- **Decision:** Keep `api/*.js` + `api/_lib/*` + Vercel Blob during Phase A–D. Wrap in typed clients in `src/domains/<domain>/client.ts`. Migrate to Postgres in Phase F+ when domain shapes are stable.
- **Consequences:**
  - New app calls existing endpoints.
  - Endpoint contracts must be reverse-engineered (Zod schemas in domain code).
  - Patch semantics replace full-document writes incrementally (Phase D+).
- **Alternatives rejected:**
  - Rewrite backend in TypeScript first — would delay any user-facing improvement.
  - Move directly to Postgres — premature; domain shapes still evolving.

## ADR-003 · Use the same repo

- **Context:** Switching repos would lose git history (audit trail of regressions) and require Vercel project re-setup. Same-repo also simplifies coexistence during rebuild.
- **Decision:** All rebuild work lands in the existing `oskar-ott/BuhlOS` repo on a new `src/` tree.
- **Consequences:**
  - `package.json` extends in place (Phase A adds Next + TS + Tailwind deps).
  - `.gitignore` extends in place.
  - Legacy `public/` + `api/` + `scripts/` stay where they are.
- **Alternatives rejected:**
  - New repo + Vercel project migration — too much risk for too little gain.

## ADR-004 · Introduce Next.js under `src/`

- **Context:** Next.js App Router gives server components, middleware-based auth gates, typed routes, and file-system routing that eliminates `vercel.json` route sprawl over time.
- **Decision:** Next.js 15+ App Router with all new code under `src/`.
- **Consequences:**
  - `vercel.json` continues to own legacy URLs until cutover.
  - New routes must not collide with `vercel.json` claimed paths.
  - File-system routing supersedes `vercel.json` rewrites for new surfaces.
- **Alternatives rejected:**
  - Next.js Pages Router — no middleware, no server components, deprecated direction.
  - Vite + React Router — would require manual SSR + middleware reimplementation.
  - Remix — smaller ecosystem; less Vercel-native.

## ADR-005 · Keep legacy app stable during rebuild

- **Context:** The business depends on `buhlos.com` working today; we cannot afford a multi-week regression while the rebuild lands.
- **Decision:** Phase A scaffold mounts on non-colliding routes (`/command-centre`, `/v2/login`, `/v2/phil`). Legacy URLs continue to be owned by `vercel.json` rewrites and served by `public/*.html` until each cutover. Each cutover requires a precondition gate (see [16-migration-strategy.md]).
- **Consequences:**
  - Long coexistence window (~6 phases).
  - Two architectures visible to admins (acknowledged tradeoff).
  - Cutover happens incrementally, one rewrite at a time.
- **Alternatives rejected:**
  - Flip all routes at once when "ready" — high blast radius, low rollback granularity.
  - Build entirely in parallel and switch DNS at the end — requires duplicate infrastructure; unnecessary.

## ADR-006 · Non-colliding routes first

- **Context:** `vercel.json` claims `/`, `/login`, `/admin/*`, `/phil`, `/my-day`, etc. Mounting the new app on any of these in Phase A would either (a) be silently overridden by `vercel.json` (the page never renders) or (b) require flipping rewrites (premature cutover).
- **Decision:** Phase A mounts only on routes `vercel.json` does not claim: `/command-centre`, `/v2/login`, `/v2/phil`, and other `/v2/*` or `/hours/*` etc. as needed.
- **Consequences:**
  - "v2" URLs in the address bar during Phase A–B (acknowledged temporary).
  - Tests can hit both surfaces in parallel.
- **Alternatives rejected:**
  - Flip `/login` in Phase A — auth not yet hardened in new app.
  - Mount new app at the same canonical URLs and remove rewrites — premature cutover.

## ADR-007 · Do not flip production routes until preview verified

- **Context:** Premature cutover risks blank-page regressions and trust erosion.
- **Decision:** Each cutover requires: (a) end-to-end test passing on preview; (b) one-week shadow period where both surfaces are reachable; (c) second-human approval; (d) explicit rollback plan documented.
- **Consequences:**
  - Cutover cadence is slow (~one major cutover per phase).
  - Total rebuild timeline extends but ships safely.
- **Alternatives rejected:**
  - Cutover on PR merge — no shadow period, no preview verification window.
  - Cutover behind feature flag — adds complexity; flag itself becomes a bug surface.

## ADR-008 · App shell before features

- **Context:** Phase 1A audit showed feature work on the legacy stack creates regressions. Building on an unsound foundation repeats the problem. The original Phase A draft had hours-shaped scope creep that the user caught.
- **Decision:** Phase A is foundation only — no features. Hours is the first feature, and it lands in Phase B on the established shell.
- **Consequences:**
  - Phase A produces no user-visible improvement (just shells).
  - Phase A is short (~1 PR) and easy to review.
  - Phase B has a clean foundation to build on.
- **Alternatives rejected:**
  - Ship Phil hours in Phase A — the user explicitly requested this initially; the audit conflict was surfaced and the decision is foundation-first.

## ADR-009 · Hours is the first feature loop

- **Context:** [[project_buhlos_phil_hours_pipeline]] specifies hours as the first field-deployable feature. Legacy hours is the only end-to-end loop that works today. `api/time-entries.js` + `api/_lib/time-entries.js` is well-formed and reusable.
- **Decision:** Phase B builds the hours loop (Phil capture → Admin approval → CSV export) on the new shell.
- **Consequences:**
  - Tradies see immediate benefit (faster Standard Day submission).
  - Admin sees immediate benefit (queue-shaped approval UX).
  - The hours pipeline becomes the reference end-to-end loop for tests + future feature templates.
- **Alternatives rejected:**
  - Start with jobs — too big; not field-deployable in one phase.
  - Start with gear — useful but not as load-bearing as hours.
  - Start with snags — admin-heavy; less worker-facing benefit.

## ADR-010 · Gear is the second loop

- **Context:** After hours proves the loop pattern, gear is the next field-shaped feature with admin counterparty.
- **Decision:** Phase C builds gear assignment + scan check-out/in.
- **Consequences:** Phil gains QR scan flow; admin gains real-time gear visibility.
- **Alternatives rejected:** Start with jobs in Phase C — jobs is too big without evidence (Phase D dependency).

## ADR-011 · Jobs / evidence is the third loop

- **Context:** Photo capture, task completion, and snag raising all hang off the job entity. Job structure must be solid before evidence makes sense.
- **Decision:** Phase D builds the jobs entity + photo / evidence / snag loops.
- **Consequences:**
  - `/admin` and `/admin/*` cutover happens during Phase D (per-section batches).
  - The jobs data model gets patch-endpoint replacements for the legacy full-doc writes.

## ADR-012 · ITP / RFI / materials / plans / variations later

- **Context:** These are valuable but not blocking for field deployment. Each depends on jobs + evidence (Phase D).
- **Decision:** Phase E ships these four domains in parallel feature streams.

## ADR-013 · UNDER CONSTRUCTION over fake-it

- **Context:** Half-built features that look complete create field support pain and erode trust (per [[feedback_hide_unfinished_features]]).
- **Decision:** Every incomplete feature renders `UnderConstructionPanel`. Nav entries for UC features are visible but non-interactive.
- **Consequences:** Phase A admin sidebar has 1 live + 5 UC entries; Phase A Phil tab bar has 2 live + 3 UC tabs.
- **Alternatives rejected:**
  - Hide UC nav entries entirely — users lose sight of the roadmap.
  - Render placeholder content that looks live — banned (R-15).

## ADR-014 · No direct production deploys

- **Context:** Two production outages in three days from `vercel deploy --prod` on feature branches.
- **Decision:** Remove `deploy:prod` from `package.json` (Phase A done). Lock Vercel project to `main`-only auto-deploy (Phase B). Remove `GUARD_OVERRIDE` support (Phase B).
- **Consequences:** Production updates only via merge to `main`. Rollback uses `vercel promote <previous-deploy>`.
- **Alternatives rejected:** Stronger local guard — local guard can be bypassed (already proven).

## ADR-015 · Mock data must be visibly labelled

- **Context:** Legacy admin silently falls back to `window.BUHLOS_MOCK` when API returns empty; no UI indication. Admins can act on fake data.
- **Decision:** `DemoModeBanner` is mandatory at root layout. `fixtures.isDemoMode()` drives it. The `BUHLOS_MOCK` silent-fallback pattern is banned by ESLint and convention.
- **Consequences:** Phase A always shows the banner (all fixtures, no real domain data). Phase B+ flips per-domain to live as wiring lands.

## ADR-016 · Old naming banned from user-facing UI

- **Context:** "Site Office" and "Switchboard" (as product label) appear 60 + 117 times in legacy code; some leak to users (`phil.html:1548-1549`).
- **Decision:** ESLint rule `no-restricted-syntax` rejects `/site[-_ ]?office/i` literals in new code. The boot migration deletes legacy `localStorage` keys. Existing leaks in `public/*.html` are not edited; they go away when the legacy surface is quarantined and deleted.
- **Consequences:** New code never carries the deprecated naming. Legacy carries it until cutover.

## ADR-017 · Phase A must not include hours

- **Context:** During the original Phase A session, the user requested Phil hours as the focus. The audit specified Phase A as foundation only. The conflict was surfaced (per [[20-agent-rules]] #29) and resolved in favour of audit-first.
- **Decision:** Phase A is foundation only. Phil hours is Phase B.
- **Consequences:** Phase A is a small, reviewable PR; Phase B is the first user-visible improvement.
- **Alternatives rejected:** Hybrid Phase A + hours — ADR-008 makes this an anti-pattern.

## ADR-018 · Phase 1B audit pack is mandatory pre-read for Phase A

- **Context:** Without the audit pack, coding agents drift toward generic SaaS dashboard patterns and miss the construction-operations specificity.
- **Decision:** The Phase A prompt ([08-next-claude-code-prompt.md] updated by Phase 1B) requires reading the 1B docs first.
- **Consequences:** Future Phase A sessions cannot start without the audit context.

## ADR-019 · Service worker is push-only post-rebuild

- **Context:** SW cache versioning is a recurring foot-cannon (blank-page incidents traced to stale `_shell.js` in cache). Next.js handles its own caching natively.
- **Decision:** Phase G rewrites `public/sw.js` to handle Web Push only. Shell-caching is removed; Next.js owns asset caching.
- **Consequences:** Push notifications continue. `CACHE_VERSION` checks become unnecessary post-Phase-G.

## ADR-020 · Vercel Blob continues until domain shapes stabilise

- **Context:** Postgres migration is desirable but premature while domain shapes are evolving.
- **Decision:** Vercel Blob remains the persistence layer through Phase E. Phase F+ migration to Postgres (Drizzle preferred) once shapes are settled. Dual-write + dual-read transition.
- **Consequences:** Patch endpoints (Phase D+) operate on Blob until migration. Domain schemas in `src/domains/<domain>/schema.ts` become Postgres schema source-of-truth at migration time.

---

## Process for adding ADRs

- New decisions append a new ADR with a new number (ADR-021, ...).
- Revised decisions append a new ADR that explicitly **supersedes** the old one (e.g. "ADR-021 supersedes ADR-008").
- Never edit existing ADR text in place except to add a "Status: Superseded by ADR-XXX" line at the top.
- Every ADR includes: context, decision, consequences, alternatives rejected.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md)
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md)
- [15-risk-register.md](15-risk-register.md)
- [16-migration-strategy.md](16-migration-strategy.md)
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md)
- [20-agent-rules.md](20-agent-rules.md)
- [00-executive-summary.md](00-executive-summary.md)
