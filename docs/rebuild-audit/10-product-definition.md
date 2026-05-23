# 10 · Product definition

> **Read this before writing any code.** Phase 1A audit found the largest single failure mode of the legacy build was UI-first thinking applied to a domain that is not a generic SaaS workflow. This document anchors what BuhlOS / Phil actually are so future coding agents do not turn them into another dashboard demo.

---

## A. Product definition

### What BuhlOS is

**BuhlOS is the operating backbone of an electrical-contracting business.** It is the single source of truth for every job, worker, hour, asset, plan, defect, RFI, and variation the business handles. It is the layer through which work is *planned*, *captured from the field*, *reviewed*, *approved*, and *reported on*.

BuhlOS is not a CRM. It is not a project management tool. It is not a generic SaaS dashboard. It is a domain-specific operating system for an electrical contractor that does residential, commercial, and sub-contracted construction electrical work.

### What BuhlOS Admin is

**BuhlOS Admin is the desktop control interface** over the BuhlOS backbone. It is used in the office (or wherever the operator has a keyboard and a real screen) by the people who plan, review, approve, and report on work. It assumes:

- A real keyboard, a real cursor, a real screen.
- The user is sitting still, not on a ladder.
- The user is thinking about *queues* and *decisions*, not capturing evidence.
- The user has time to scroll a list, open a modal, type a paragraph.

BuhlOS Admin is sometimes called "Command Centre" in the UI. The two terms are equivalent: the product surface is "BuhlOS Admin" / "BuhlOS Command Centre".

### What Phil is

**Phil is the field-worker interface** over the same BuhlOS backbone. It is used on a phone, on site, by a tradesman, apprentice or labourer. It assumes:

- A glove. A finger. Sunlight. Dust. Rain. Gaffer-taped phone.
- The user has 15 seconds, not 15 minutes.
- The user wants to *finish* the thing, not read about it.
- The user does not care about queues, dashboards, KPIs, charts, settings, or admin meta-features.

Phil captures the things only field workers can capture: their hours, their gear handover, their photos, their defects, their ITP completions. It surfaces only what the worker needs to do their next task.

### What the shared BuhlOS backbone is

Phil and BuhlOS Admin are two interfaces over **one shared domain model and one shared API**. They are not separate apps. They are not separate codebases. They are not separate auth systems. They are not separate databases.

The same `Job` that a project manager builds in BuhlOS Admin is the `Job` a tradesman opens in Phil. The same `TimesheetEntry` Phil submits is the entry the admin approves. The same `Photo` Phil captures is the photo the admin attaches to a defect.

| Layer | Owned by | Visible in |
| --- | --- | --- |
| API + persistence | shared | both |
| Domain types + validation | shared | both |
| Auth + role model | shared | both |
| Routes + UI components | per surface | one |

The corollary: **a feature is not done until its loop closes through both surfaces** (Phil capture → Admin review → entity update → audit record → reporting).

### What the product is NOT

BuhlOS is **not** any of the following, and any rebuild step that drifts toward them should stop:

- A generic SaaS dashboard. The home screen is not "KPIs". It is the queues that need an operator's decision.
- A project management tool. There is no kanban board for "in progress / done". The unit of work is the *task on a stage in an area on a job*, not the "card".
- A timesheet SaaS. The hours pipeline is one of many loops, not the whole product. (But it is the first.)
- A CRM. Clients are a side surface; the centre of gravity is jobs and field work.
- A document storage system. Documents (plans) are versioned and acknowledged; they are not just "files".
- An AI/automation platform. AI plan interpretation is on the roadmap but is not the spine.
- A multi-tenant SaaS. One organisation today; multi-tenant is a Phase F+ concern.

### Why the rebuild is necessary

The legacy frontend reached a state where:

1. **Three admin architectures co-exist** in `public/` (`admin.html`, `admin/operations.html` SPA, `admin/<page>.html` multi-page shell). A change in one breaks the others by accident.
2. **Two Phil architectures co-exist** (`phil.html` + `my-day.html` / `my-gear.html` / `phil-hours.html`). The PWA manifest still starts at `/my-day` while sidebar UX assumes `/phil`.
3. **No type safety, no tests, no build step.** 89 API endpoints + 23 admin pages + 21 web components + a service worker share JSON shapes by convention. Renaming a field is a multi-file shotgun edit.
4. **Mock data masquerades as live.** `window.BUHLOS_MOCK` is loaded on every Command Centre boot; if the API returns empty, fake "Birdwood IV3232" / "Arthur St Warehouse" jobs render with no banner.
5. **`buhlos.com` shipped the wrong build twice in three days** (2026-05-20, 2026-05-22) via direct `vercel deploy --prod` from feature branches with the `check-prod-branch.js` guard bypassed by `GUARD_OVERRIDE`.
6. **Deprecated naming still leaks to users.** `public/phil.html:1548-1549` literally tells a client to "Go to Site Office". `localStorage` carries `buhl-site-office-tweaks`. The deprecated dev surface `public/dev/site-office/` is still in the deploy.

Every additional change to the frontend creates a new regression risk. The cheapest path forward is to build a clean Next.js + TypeScript shell in parallel, ship one operational loop at a time on it, and quarantine the legacy surfaces under `/legacy/*` as each loop lands.

### What went wrong structurally in the old build

- **UI-first thinking, no domain model.** Pages defined their own ad-hoc objects. The same concept (`Job`) had different field names in different files.
- **No phase discipline.** Half-built features (Materials, Variations, Reports) were merged with the rest. UNDER CONSTRUCTION was added retroactively, not at design time.
- **Deploy-time gates instead of design-time gates.** The four `scripts/check-*.js` guards block deploys but don't catch logic bugs. The override (`GUARD_OVERRIDE=YES-I-KNOW`) was used in anger.
- **Surface multiplication.** Every "I'll just hack it in `public/`" added another HTML file. Each became load-bearing for some user. None could be deleted.
- **No tests.** Six blank-page production incidents in 10 days, all of which would have been caught by a single Playwright smoke test of `/admin/operations`.

### What "good" looks like

After the rebuild:

- One canonical URL per concept. `/command-centre` is the admin home. `/phil/my-day` is the worker home. No mirror routes.
- One canonical TypeScript type per entity. `Job` is defined in `src/domains/jobs/types.ts` and nowhere else.
- Every page renders from real backend data, *or* displays the `DemoModeBanner`. Never both. Never silent fallback.
- Every navigation entry is either live or shows `UnderConstructionPanel`. Never half-broken.
- Every mutation has a Zod schema, a server-side check, and an `AuditLog` write.
- `main` is the only branch that deploys. There is no override.
- Every PR runs typecheck + lint + test + build in CI. Production only updates after the merged commit lands and Vercel rebuilds.
- The first end-to-end loop (hours) is shippable and used daily before the second (gear) is started.

---

## B. User groups

Each user is described from the perspective of their *job to be done*, not their org-chart title. A person may wear two of these hats — that's fine; they switch surface accordingly.

### Boss / Owner

- **Who:** The business owner. Wears all hats when something goes wrong.
- **JTBD:** "Tell me whether the business is healthy this week, and let me unstick the things that are stuck."
- **Sees:** Command Centre with money/job health at a glance, hours awaiting approval, snags piling up, jobs slipping. Can pivot to any detail.
- **Does not see:** Field-capture surfaces (they don't capture from the office).
- **Actions:** Approve hours when delegated approvers can't. Override pricing on a variation. Sign off on a job handover. View revenue/cost reports.
- **Creates:** Decisions. Rarely raw data.
- **Decisions supported:** Resource allocation, pricing changes, hire/fire, client conversations.

### Admin staff

- **Who:** Office admin / bookkeeper. Owns timesheets, payroll prep, supplier reconciliation, basic invoicing.
- **JTBD:** "Make sure every hour worked is captured, approved, and exported to payroll. Keep supplier and material costs accurate."
- **Sees:** Hours approval queue (primary surface). Payroll summary. Variations needing invoice. Supplier orders.
- **Does not see:** ITP, RFI, defect detail. (They can navigate to it, but it's not their queue.)
- **Actions:** Approve / reject hours. Export approved hours. Reconcile supplier invoices. Mark variations invoiced.
- **Creates:** Approvals. CSV exports. Supplier records.
- **Decisions supported:** Payroll runs. Cash flow tracking. Cost reconciliation.

### Project manager

- **Who:** Runs one or more jobs. Plans, schedules, fights fires.
- **JTBD:** "Keep my jobs on track. Know who's where, what's stuck, what's coming."
- **Sees:** Jobs dashboard (their jobs first). Plans needing acknowledgement. ITPs needing sign-off. Snags on their jobs. Variations on their jobs. Hours rolled up to their jobs.
- **Does not see:** Other PMs' jobs unless explicitly authorised.
- **Actions:** Build / edit jobs and stages. Assign workers. Sign off ITPs. Resolve snags. Create variations. Communicate with clients.
- **Creates:** Job structure (stages / areas / tasks). Variations. RFIs.
- **Decisions supported:** Daily scheduling. Issue escalation. Client-facing reporting.

### Estimator

- **Who:** Builds quotes from plans. Decides what the job is worth.
- **JTBD:** "Turn an enquiry into a quote that wins work without losing money. Learn from past job actuals."
- **Sees:** Quotes pipeline. Past job actuals (labour, materials, hours) for similar work. AI plan interpretation output. Material price lists.
- **Does not see:** Day-to-day operations queues unless they need them for a quote.
- **Actions:** Create quote. Mark quote sent. Convert quote to job. Adjust template.
- **Creates:** Quotes. Job templates derived from successful quotes.
- **Decisions supported:** Pricing, win/loss strategy, template improvement.

### Tradesman

- **Who:** A licensed electrician working on site.
- **JTBD:** "Finish today's tasks. Log my hours. Capture the things I see. Don't waste my time."
- **Sees:** Phil. My Day (today's assignment). Today's tasks for current area. Gear handover queue. Snag-raise button.
- **Does not see:** Other workers' hours, other crews' jobs, anything administrative, anything dashboard-shaped.
- **Actions:** Log hours (one-tap Standard day in <15 seconds). Mark task complete. Raise snag. Acknowledge plan revision. Hand over gear.
- **Creates:** TimesheetEntry. Photo. Defect. PlanAcknowledgement. ITPCompletion (where licensed to).
- **Decisions supported:** "Can I knock off?" "Should I raise this as a snag or just fix it?"

### Apprentice

- **Who:** Worker in training. Reduced licence; reduced authority.
- **JTBD:** Same as tradesman, but with explicit "I cannot sign off ITPs unless a licensed lead has co-signed" gating.
- **Sees:** Same as tradesman.
- **Does not see:** Sign-off-only flows (independent ITP review, plan publishing).
- **Actions:** Same as tradesman minus ITP sign-off. Can mark ITP as ready-for-review.
- **Creates:** Same as tradesman minus ITPCompletion.signOff.
- **Decisions supported:** "Have I done my part correctly?"

### Subcontractor / future

- **Who:** A non-employee tradie on a specific job for a specific scope.
- **JTBD:** "Show me my scope. Let me hand back what I've done. Pay me for it."
- **Sees:** Phil-shaped surface, scoped to assigned jobs only.
- **Does not see:** Other jobs, other workers' hours, internal cost data.
- **Actions:** Log hours against the sub's tasks. Mark scope complete. Submit invoice (Phase F+).
- **Creates:** TimesheetEntry (sub-bound). Invoice (later).
- **Decisions supported:** "Is my work accepted?"
- **Status:** Future (Phase F+).

### Builder / client

- **Who:** The external builder or end-client paying for the work.
- **JTBD:** "Tell me what's done, what's coming up, and what's costing extra."
- **Sees:** Read-only client portal scoped to their job. Plan revisions. Variations affecting them. Job progress photos.
- **Does not see:** Worker hours, internal costs, other jobs.
- **Actions:** Acknowledge plan revisions. Approve variations (with a workflow). Comment on a photo (later).
- **Creates:** Plan acknowledgements. Variation approvals.
- **Decisions supported:** Budget approval. Plan revision sign-off.
- **Status:** Stub today (`public/client.html`); rebuild in Phase E+ once core loops are solid.

---

## C. Product surfaces

### BuhlOS Admin (desktop)

- **Form factor:** Desktop / large laptop. Mouse + keyboard. ≥ 1280px.
- **Tone:** Industrial control panel. Dense but not cluttered. Serious operator UI.
- **Primary view:** *Command Centre* — queues that need a decision, not vanity charts.
- **Navigation:** Left sidebar with sections grouped by domain. No tabs across the top for navigation. No hamburger.
- **Visual language:** Navy + ink + accent yellow. Single accent per screen. Status pills.
- **Density toggle:** compact / regular / roomy persisted per user.

### Phil (mobile)

- **Form factor:** Phone, portrait, one-thumb operable. ≥ 360px.
- **Tone:** Worker tool. Big tap targets. Minimal copy. Glanceable.
- **Primary view:** *My Day* — today's job, today's tasks, the "log my hours" button.
- **Navigation:** Bottom tab bar with 4–5 destinations. No drawer. No nested tabs.
- **Visual language:** Same brand tokens as Admin but applied for outdoor visibility (high contrast).
- **Sunlight rule:** every action button must remain legible in direct sunlight.

### Shared backend / backbone

- **API:** Serverless functions in `api/*.js` today (Vercel), TypeScript-wrapped clients in `src/domains/*/client.ts`.
- **Auth:** HMAC session cookie `buhl_session` (set by `api/auth.js`, verified by `api/_lib/auth.js`).
- **Persistence:** Vercel Blob JSON today; migrates to Postgres + Drizzle/Prisma when domain shapes are stable.
- **Validation:** Zod schemas at every API boundary, shared between client and server.
- **Audit:** `AuditLog` write per mutation, queryable by entity + actor + time.

### Future external / client surfaces

- **Client portal:** `/client/jobs/:jobId` — read-only per-job status for builder/owner.
- **Subcontractor portal (Phase F+):** Phil-shaped but scoped to sub's assigned scope only.
- **Public quote acceptance (Phase F+):** Per-quote URL with PIN/email gate. No login required.

---

## D. Anti-patterns

The following patterns are **banned** in the rebuild. Every PR that introduces one should be rejected.

### Generic SaaS dashboard framing
- The Command Centre is **not** "KPI cards across the top, chart in the middle, recent activity at the bottom". It is **queues that need a decision** — pending hours, open snags, plans needing acknowledgement, RFIs awaiting answer, variations awaiting approval. Each queue is one click to act.

### Dashboard-first rebuild
- The first feature is not a dashboard. The first feature is a *closed operational loop* — Phil capture → Admin review → entity update → audit → report. Hours is the first loop. Dashboards aggregate completed loops; they don't precede them.

### UI without domain model
- A page that doesn't import from `src/domains/<x>/` is doing something wrong. If a developer is tempted to type a literal object shape in a page, the shape belongs in a domain type first.

### Fake metrics
- "Jobs completed this month" counted from a hardcoded array is forbidden. Either the number is computed from real data or the panel shows `UnderConstructionPanel`.

### Mock data pretending to be live
- The legacy admin has `window.BUHLOS_MOCK` injected silently when the API returns empty. This is **banned**. If fixtures are loaded, `DemoModeBanner` must be visible at shell level.

### Old naming
- "Switchboard" as a product label is banned (electrical-equipment usage is fine). "Site Office" is banned in every context. New code never writes a `buhl-site-office-*` localStorage key. The one-time boot migration deletes legacy keys.

### Half-built features appearing complete
- A nav entry that leads to a placeholder must be either removed from nav or marked UNDER CONSTRUCTION. A "v1" pill on a half-built feature is dishonest and creates field support pain. Default to UC if unsure.

### Multiple admin shells / multiple Phil homes
- One admin shell. One Phil shell. One layout per surface. No "v2 of the v2 of the legacy".

### Adding routes without removing replacements
- `/buhlos/*` mirror routes added "just in case" doubled the deploy contract. New routes only exist when an old route is being retired *or* when no equivalent existed.

### Direct production deploys
- `vercel deploy --prod` from a local CLI or feature branch is banned. The `deploy:prod` script has been removed from `package.json`. Production updates only by merge to `main`.

### Coding agents inventing UI on top of UI
- Future Claude Code / coding agents that try to "add a new card to the dashboard" without referencing a domain or workflow are misaligned with this product. Re-read this document; if the request doesn't match a known workflow or entity, stop and ask.

---

## Cross-references

- [11-operational-workflow-map.md](11-operational-workflow-map.md) — the workflows this product must support, end-to-end.
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) — the entities the UI composes over.
- [13-ui-information-architecture.md](13-ui-information-architecture.md) — the IA that flows from this product definition.
- [20-agent-rules.md](20-agent-rules.md) — the rules future coding agents must obey.
- [00-executive-summary.md](00-executive-summary.md) — Phase 1A executive summary.
- [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md) — binding engineering rules.
