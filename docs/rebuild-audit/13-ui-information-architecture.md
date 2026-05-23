# 13 · UI information architecture

> Defines navigation, screen purpose, and what belongs (and does not belong) on every surface. This is the IA contract for both BuhlOS Admin and Phil; coding agents must not invent new sections or rearrange these without a doc update.

---

## Foundational rules

### BuhlOS Admin

- **Desktop-first.** Minimum supported width 1280px. Mobile layout is "view-only" — admin actions require a real screen.
- **Left sidebar primary nav.** No top-tab navigation for sections. No hamburger.
- **Action / control-centre orientation.** The home is *queues that need a decision*, not vanity cards.
- **Operational queues, not vanity KPIs.** "Pending hours" is a queue; "% jobs on time" is a vanity chart. Vanity comes in Phase F reports when there's real data.
- **Dense but not cluttered.** Tables with status pills. Information at the glance density, with one-click drill-in.
- **Serious industrial visual language.** Brand navy + ink + accent yellow. Single accent per screen. Status pills with consistent tone mapping.
- **No legacy pill-tab admin navigation.** The legacy `public/admin/_shell.js` shell uses pill tabs across the top of each page; the rebuild explicitly does not.
- **No generic SaaS dashboard layout.** No "KPI cards at top, chart in middle, recent activity at bottom" template.

### Phil

- **Mobile-first.** Minimum supported width 360px. Tested in direct sunlight.
- **Field-first.** Every screen is built for a one-thumb interaction during work.
- **One-thumb usable.** No fields that require two-handed typing for routine flows. Hours capture is one tap.
- **Large tap targets.** 48px minimum.
- **Low typing.** Pickers, sheets, scanners — typing is a fallback, not the default.
- **Works in sunlight + gloves.** High contrast, no thin lines, no tiny tap targets, no swipe-only patterns.
- **Fast task completion.** Standard day in <15 seconds. Snag raise in <30 seconds. Time-on-screen is a cost.
- **Only field-relevant information.** No queue counts. No KPIs. No admin meta. If a tradie doesn't need it to do today's work, it isn't in Phil.

---

## BuhlOS Admin information architecture

### Left sidebar sections

The new admin sidebar has the following sections, in order:

1. **Command Centre** — the home
2. **Hours** — approvals + overview
3. **Jobs** — list + builder + detail
4. **Workers** — people + profiles
5. **Gear** — assets + assignments
6. **Materials** — catalog + requests
7. **Plans / Documents** — drawings + revisions
8. **ITP / QA** — templates + completions
9. **RFIs** — requests for info
10. **Defects** — snags
11. **Variations** — scope/price changes
12. **Reports** — phase-F intelligence
13. **Settings** — org + integrations
14. **Support** — internal ops

Phase A renders the sidebar with **Command Centre live** and everything else as `UnderConstructionPanel` (no click-through to a fake page).

### Sidebar visual contract

- Section icon (lucide-react) + label.
- Optional count badge ("Hours · 12") only when the count is *real* — never against a fixture.
- UC entries render with the "UC" pill in `accent-yellow` and are non-interactive (`cursor: not-allowed`, no `<Link>`).
- Active section: brand navy left border + ink background.

### Section: Command Centre

| Field | Value |
| --- | --- |
| **Purpose** | Surface the queues that need a human decision right now. |
| **Primary actions** | Click into the queue with the most urgent decisions. |
| **Secondary actions** | Open a search palette to jump anywhere. |
| **Data shown** | Pending hours count + oldest entry. Open snags by job. Plans needing acknowledgement. RFIs awaiting answer. Variations awaiting client. Active jobs at risk of overrun (Phase F). |
| **Empty state** | "Nothing waiting. Have a coffee." — single line, no fake call-to-action. |
| **UC state (Phase A)** | "Welcome to BuhlOS Admin. Hours loop coming next." (per audit prompt) |
| **What does NOT belong** | Charts. Multi-month trend graphs. Marketing copy. Onboarding tutorials. Notifications widget. |
| **Domain entities** | aggregates across `TimesheetEntry`, `Defect`, `PlanAcknowledgement`, `RFI`, `Variation`, `Job` |

### Section: Hours

| Field | Value |
| --- | --- |
| **Purpose** | Approve / reject timesheets; export weeks; spot edits. |
| **Primary actions** | Approve / reject. Bulk-approve a whole week. Open an entry for detail. |
| **Secondary actions** | Export CSV. Re-open an approved entry. Spot-edit on behalf of worker. |
| **Data shown** | Pending entries grouped by worker. Recently-rejected entries. This week's export status. |
| **Empty state** | "No entries to approve." |
| **UC state (Phase A)** | Sidebar item shows UC pill; clicking is disabled. |
| **What does NOT belong** | Per-worker pay rates (those live in Workers). Timesheet design wizards. Holiday calculations. |
| **Domain entities** | `TimesheetEntry`, `TimesheetApproval`, `WorkerProfile`, `Job` |

### Section: Jobs

| Field | Value |
| --- | --- |
| **Purpose** | List jobs, build new jobs, drill into one. |
| **Primary actions** | New Job (Job Builder). Open a job. Filter by status. |
| **Secondary actions** | Archive completed. Duplicate template. Export. |
| **Data shown** | Status (draft/active/on_hold/complete/archived), PM, target completion, % complete (Phase D+), labour spend (Phase B+). |
| **Empty state** | "No jobs yet." with "+ New Job" call-to-action. |
| **UC state (Phase A)** | UC pill. |
| **What does NOT belong** | Per-task progress widgets (those live inside a job). Worker availability widget (that's in Workers). |
| **Domain entities** | `Job`, `JobStage`, `JobArea`, `JobTask` |

### Section: Workers

| Field | Value |
| --- | --- |
| **Purpose** | Manage user accounts + worker profiles + licensing. |
| **Primary actions** | Add worker. Edit profile. Reset password / PIN. Change role. Archive. |
| **Secondary actions** | View hours history per worker. View snag history. |
| **Data shown** | Name, role, licence class, current crew, last seen. |
| **Empty state** | "Add your first worker." |
| **UC state (Phase A)** | UC pill. |
| **What does NOT belong** | Org-chart visualisation. Performance reviews. |
| **Domain entities** | `User`, `WorkerProfile`, `Role` |

### Section: Gear

| Field | Value |
| --- | --- |
| **Purpose** | Asset register + who has what. |
| **Primary actions** | Add asset. Assign to worker. Mark returned / lost / maintenance. |
| **Secondary actions** | View scan history per asset. |
| **Data shown** | Asset name, serial, current holder, condition, last scan. |
| **Empty state** | "Add your first asset." |
| **UC state (Phase A)** | UC pill. |
| **What does NOT belong** | Inventory accounting valuations. Depreciation curves. |
| **Domain entities** | `GearAsset`, `GearAssignment`, `GearScan` |

### Section: Materials

| Field | Value |
| --- | --- |
| **Purpose** | Catalog + requests + delivery reconciliation. |
| **Primary actions** | Create supplier order from requests. Mark delivered. |
| **Secondary actions** | Edit catalog. |
| **Data shown** | Open requests by job, pending orders, delivery discrepancies. |
| **Empty state** | "No open material requests." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `MaterialItem`, `MaterialRequest`, `Supplier` |

### Section: Plans / Documents

| Field | Value |
| --- | --- |
| **Purpose** | Versioned drawings + spec docs + acknowledgement tracking. |
| **Primary actions** | Upload new revision. Publish (supersede prior). View acknowledgements. |
| **Secondary actions** | Archive. Move to area / stage. |
| **Data shown** | Current revision, prior revisions, % workers acknowledged. |
| **Empty state** | "No plans uploaded for this job." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `PlanDocument`, `PlanRevision`, `PlanAcknowledgement` |

### Section: ITP / QA

| Field | Value |
| --- | --- |
| **Purpose** | Templates + completions + independent sign-off. |
| **Primary actions** | Edit template. Review a submitted completion. |
| **Secondary actions** | Export compliance pack. |
| **Data shown** | Pending reviews, recent sign-offs. Four-eyes enforcement explicit in the UI. |
| **Empty state** | "No ITPs awaiting review." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `ITPTemplate`, `ITPCheckpoint`, `ITPCompletion` |

### Section: RFIs

| Field | Value |
| --- | --- |
| **Purpose** | Track Requests For Information against design ambiguities. |
| **Primary actions** | Open RFI thread. Send response. Close. |
| **Data shown** | Open RFIs by job, oldest unanswered. |
| **Empty state** | "No open RFIs." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `RFI` |

### Section: Defects

| Field | Value |
| --- | --- |
| **Purpose** | Triage and close field-raised snags. |
| **Primary actions** | Assign. Set priority. Mark fixed / verified / closed. |
| **Secondary actions** | Bulk close. Email summary. |
| **Data shown** | Open snags by job, by priority. Recently closed (audit). |
| **Empty state** | "No open defects." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `Defect`, `Evidence` |

### Section: Variations

| Field | Value |
| --- | --- |
| **Purpose** | Capture and invoice unplanned scope. |
| **Primary actions** | Create variation. Send to client. Mark invoiced. |
| **Data shown** | Status pipeline, by job. |
| **Empty state** | "No variations on this job." |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `Variation` |

### Section: Reports

| Field | Value |
| --- | --- |
| **Purpose** | Phase F+ business intelligence: utilisation, profitability, accuracy. |
| **Primary actions** | Pick report. Filter date range. Export. |
| **Data shown** | Aggregations only. |
| **Empty state** | "No data in this range." |
| **UC state (Phase A–E)** | UC pill — reporting is post-MVP. |
| **What does NOT belong** | "Pretty" KPI dashboards before there's real data. |
| **Domain entities** | aggregates over everything |

### Section: Settings

| Field | Value |
| --- | --- |
| **Purpose** | Organisation settings, integrations, density/theme. |
| **Primary actions** | Configure Xero / Resend / push. Set defaults. |
| **Data shown** | Current configuration. |
| **Empty state** | n/a (always populated). |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `Organisation` |

### Section: Support

| Field | Value |
| --- | --- |
| **Purpose** | Internal ops dashboard (queue health, cron last-run, error rates). |
| **Primary actions** | Re-run cron. Reset stuck job. |
| **Data shown** | Cron run history, recent errors, recent slow endpoints. |
| **Empty state** | n/a. |
| **UC state (Phase A)** | UC pill. |
| **Domain entities** | `IntegrationEvent`, `Alert`, `AuditLog` |

---

## Phil information architecture

### Bottom tab bar

Five tabs, fixed position bottom of screen:

1. **Today** — `/v2/phil` (Phase A placeholder; `/phil/my-day` in Phase B)
2. **Jobs** — list of assigned jobs (Phase B–D)
3. **Gear** — my gear + check-out/in (Phase C)
4. **Snag** — quick raise (Phase D)
5. **More** — profile / sign-out / settings

Phase A: **Today** and **More** live as placeholders; Jobs / Gear / Snag are UC (rendered, non-interactive).

### Tab: Today (`/phil/my-day` in Phase B)

| Field | Value |
| --- | --- |
| **Purpose** | The one screen a tradie opens at start and end of day. |
| **Primary field action** | **Log hours** (one-tap "Standard day · 7h 36m"). |
| **Secondary actions** | Quick-pick a different job for today's hours. Custom hours entry. View today's tasks. |
| **Required data** | Today's date, active job assignment, last hours entry status. |
| **One-tap requirement** | The Standard Day button must complete the hours submission in one tap, with the active job pre-selected. |
| **What must NOT be shown** | Other workers' hours. Approval queue. Snag triage. Settings. |
| **Avoid admin leak by** | Never showing counts, queues, or "pending X" indicators. |
| **Domain entities** | `TimesheetEntry`, `Job`, `JobAssignment` |

### Tab: Jobs

| Field | Value |
| --- | --- |
| **Purpose** | List of my assigned jobs; drill into a job for tasks / plans / capture. |
| **Primary field action** | Open a job. |
| **Secondary actions** | Set as active job for hours capture. |
| **Required data** | Assigned jobs with status / address. |
| **One-tap requirement** | Setting active job is a tap. |
| **What must NOT be shown** | Jobs not assigned to me. PM-only data (profitability, hours roll-up). |
| **Domain entities** | `Job`, `JobAssignment`, `JobStage`, `JobArea`, `JobTask` |

### Tab: Gear

| Field | Value |
| --- | --- |
| **Purpose** | What I have, what I need to return, scan to borrow. |
| **Primary field action** | Scan QR to check out / check in. |
| **Secondary actions** | Mark damaged. Flag missing. |
| **Required data** | Current assigned gear, recent scans. |
| **One-tap requirement** | Scan → confirm. |
| **What must NOT be shown** | Asset financial value. Other workers' gear. |
| **Domain entities** | `GearAsset`, `GearAssignment`, `GearScan` |

### Tab: Snag

| Field | Value |
| --- | --- |
| **Purpose** | Raise a defect fast. |
| **Primary field action** | Photo → area → 1-line description → submit. |
| **Secondary actions** | Add note. Set priority (default normal). |
| **Required data** | Active job + areas list. |
| **One-tap requirement** | Photo + submit can be a 30-second loop end-to-end. |
| **What must NOT be shown** | Snag triage queue. Closure workflow. Other workers' snags. |
| **Domain entities** | `Defect`, `Photo`, `Evidence` |

### Tab: More

| Field | Value |
| --- | --- |
| **Purpose** | Profile, sign-out, preference toggles. |
| **Primary field action** | Sign out. |
| **Secondary actions** | Change PIN. Toggle reminders. |
| **Required data** | Display name, role, last sign-in. |
| **What must NOT be shown** | Admin features. Other users. |
| **Domain entities** | `User`, `WorkerProfile` |

### Inside a Job (Phil)

The "Individual Job Interface" inside a job has its own one-screen flow:

- **Header:** Job name, address, my role on this job, today's status.
- **Stages strip:** horizontal scroll of stages, current stage highlighted.
- **Areas grid:** current stage's areas as large tiles with progress.
- **Tasks list (per area):** big tap-rows, status visible.
- **Quick actions floating bar:** Log hours · Raise snag · Capture photo · Acknowledge plan revision.

### Capture screens

- **Log hours sheet** (modal): "Standard day 7h 36m" big button + custom hours grid (whole numbers 4-12) + job picker (defaults to active).
- **Snag raise sheet** (modal): Photo (required) → area → text → submit.
- **Plan acknowledgement modal:** blocking when worker arrives on site with unread revision.

### Requests screens (Phase E)

- **Material request:** pick item from catalog → qty → submit.
- **RFI:** photo + 1-line description → submit.

### ITPs / checklists (Phase E)

- **Checklist:** tick checkpoints (photo where required) → submit for review.
- **No sign-off button for the submitter** — independent reviewer signs off, per the four-eyes rule.

---

## Banned patterns (UI)

Explicitly forbidden in the rebuild. Each ban references the rule it enforces.

### Duplicate shells

- One AdminShell only (`src/components/admin/AdminShell.tsx`). One PhilShell only.
- No "v2 of v2 of legacy shell".
- Enforced by lint: no two files containing `function AdminShell`.

### Old admin pill navigation

- The legacy `public/admin/_shell.js` pill-tab navigation across the top of each page is **discarded**. The rebuild uses left-sidebar only.

### Hidden legacy labels

- Any UI string containing "Site Office", "site-office", or "Switchboard" (as a product label) is rejected by the ESLint `no-restricted-syntax` rule defined in `.eslintrc.json`.

### Mock metrics with no banner

- Numbers and lists rendered from fixtures must show `DemoModeBanner`. Removing the banner without flipping `fixtures.isDemoMode()` to false is a banned PR.

### Fake working states

- A button that opens an `alert()` is banned. A button that opens a modal that says "coming soon" is banned. Use `UnderConstructionPanel` at section level instead.

### Multiple login concepts

- One canonical login at `/v2/login` (Phase A parallel) and later `/login` (post-cutover). No PIN-vs-password tabs in the new login — same field, the user types either. The legacy login pin/password tab toggle was deprecated even within legacy code.

### Multiple Phil homepages

- One Phil home: `Today`. Not "My Day vs Hours vs Gear" as separate homepages.
- The legacy parallel `/my-day` + `/my-gear` + `/phil-hours` surfaces are quarantined to `/legacy/*` at cutover.

### Multiple admin architectures

- One admin architecture: AdminShell + (admin) route group. No SPA-vs-multi-page-vs-legacy coexistence.
- Until cutover, the legacy three-architecture mix continues *as legacy* through `vercel.json` — but the rebuild adds zero new admin architectures.

---

## Visual tokens (Phase A → carried forward)

- `--accent-yellow: #ffcc00` — single accent per screen.
- `--brand-navy: #0d1f35` — admin sidebar, Phil header background.
- `--accent-ink: #0f172a` — text on light surfaces.
- `--surface: #ffffff`, `--surface-subtle: #f6f7f9`, `--surface-raised: #ffffff`.
- `--state-danger`, `--state-success`, `--state-warning`, `--state-info` — status pills.
- `--density-unit` — drives compact / regular / roomy via Tailwind spacing utilities.

Status pill tone mapping:

| Status | Pill tone |
| --- | --- |
| `live`, `approved`, `complete` | success |
| `submitted`, `in_progress`, `assigned` | info |
| `pending`, `draft` | neutral |
| `rejected`, `lost`, `wont_fix`, `damaged` | danger |
| `needs_info`, `on_hold` | warning |

Consistent everywhere. No per-screen overrides.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — who uses these screens.
- [11-operational-workflow-map.md](11-operational-workflow-map.md) — workflows backing each screen.
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) — entities each screen composes over.
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md) — folders the components live in.
- [04-ui-ux-audit.md](04-ui-ux-audit.md) — Phase 1A audit of the legacy UI.
