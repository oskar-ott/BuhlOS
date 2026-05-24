# 27 · Interface usability pass

> Cross-cutting UX brief for both surfaces (Phil and BuhlOS Admin). Anchors the "no generic SaaS, no spreadsheet, no thinking required" principles into one place so each Dx slice can be evaluated against the same bar.
>
> **Status:** docs only. No app code. This doc is upstream of every Phase D build prompt — anything that contradicts this doc in a build prompt is wrong.
>
> **Read first:** [10-product-definition.md](10-product-definition.md), [13-ui-information-architecture.md](13-ui-information-architecture.md) §Foundational rules + §Visual tokens + §Banned patterns, [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §6 + §7.

---

## 1 · Executive summary

The owner's concern: **the interfaces are not intuitive.** That is the right concern, and this doc is the binding response.

There are two surfaces and they fail in different ways:

- **Phil** fails when it makes a worker think. A tradesman on a ladder in sunlight with one glove is the worst case — and is the common case. Every screen must answer the question "what do I tap next?" without reading.
- **BuhlOS Admin** fails when it looks like a generic SaaS dashboard or a spreadsheet. Workflow is queues that need a decision, not vanity counters. The admin should always see what needs their attention first, in queue order.

The shared root cause of "not intuitive" is **trying to look like a SaaS app**. Legacy SaaS conventions — header tabs, sidebar with 12 sections, dense table-first listings, KPI cards along the top, three-dot menus, settings buried in profile dropdown — are all decisions that *delay* the operator. They look professional and are professionally wrong for an electrical/construction operations platform.

This pass defines:

- The simplicity rules for Phil (§4).
- The clarity rules for BuhlOS Admin (§5).
- A single visual marker system that every surface reuses (§6).
- Screen-by-screen critique points for the shipped surfaces and the planned Phase D surfaces (§8 + §9).
- Quick wins that don't need new architecture (§15).
- A paste-ready UI hardening prompt for a future Claude Code session (§18).

---

## 2 · Core UX problem

When a worker, an admin, or the owner opens a BuhlOS / Phil screen for the first time:

| Surface | Worst-case start | Correct first-second experience |
| --- | --- | --- |
| Phil · My Day | Worker, sunlight, gloves, 8m up a ladder | "Standard day" is the biggest thing on screen. One tap submits. |
| Phil · Jobs | Worker arriving on site | Their assigned jobs, top-to-bottom, biggest first; tap one. No tabs. |
| Phil · job detail | Worker mid-task | Job name, address, what they're doing right now (stage + area). Capture button always accessible at the bottom edge. |
| Phil · Snag (Phase D.5) | Worker spots a fault | One tap to camera, one line to describe, one tap to submit. |
| BuhlOS · Command Centre | Admin at 8am | "12 hours awaiting your approval" / "3 evidence items to review" / "1 snag escalated" — each is one click to act. |
| BuhlOS · /hours/approvals | Admin during payroll | Pending entries grouped by worker, approve/reject inline, bulk approve a week. |
| BuhlOS · /gear | Admin assigning a tool | One worker, one tool, one tap. Not a CRM. |
| BuhlOS · /jobs (Phase D) | PM checking on a site | Status pill, address, last activity, evidence count. Click into a job. |

If any of these fail the "first second" test, the design is wrong, no matter how many features it has.

---

## 3 · Design principles

Five binding principles. Every Dx UI decision is evaluated against these.

1. **Earn every element.** If you can't say why an element is on screen *for the worker doing this task right now*, remove it. Examples of unearned elements: KPI cards on the worker's home, breadcrumb on a one-screen flow, settings icon in the top right of Phil, three-dot menus that hide the obvious action.
2. **One primary action per screen.** Big, obvious, bottom of viewport on Phil; top-right or inline on Admin. Everything else is secondary. If a screen has two equally-weighted CTAs, you're asking the user to decide before you've helped them.
3. **Status is the first thing read.** Status pill is bigger and earlier than any other detail. A worker scanning their gear should see "Damaged" or "Missing" before the asset name. An admin scanning evidence should see "Pending review" before the photo thumb.
4. **Loading, empty, error, pending — never silent.** Every async surface has all four states explicitly. A blank panel is a bug. A spinner without context is a bug.
5. **No fake live features.** UC pill, UC panel, or the feature is removed. Never an `alert()`, never a "coming soon" modal, never a card that says "0 jobs completed this week" against a non-existent data source. (Per [13] §Banned patterns + [21] ADR-013.)

---

## 4 · Phil simplicity rules

These are binding for every Phil screen — Phase B `/phil/my-day`, Phase C `/phil/gear`, Phase D `/phil/jobs/*`, Phase D.5 `/phil/snags`, and any future Phil surface.

### 4.1 · Physical reality

- **Form factor:** phone in portrait, minimum 360px wide.
- **Worker context:** ladder, sunlight, dust, gloves, gaffer-taped phone.
- **Maximum task time:** Standard day in <15 seconds. Snag raise in <30 seconds. Job evidence capture in <60 seconds.
- **Battery cost:** assume 8-hour day on one charge. No background animations, no auto-polling. Stale-while-revalidate fetches only.

### 4.2 · Interaction rules

- **One-thumb usable.** No two-finger gestures. No long-press for primary actions. No tiny "x" close buttons in modal corners — full-width "Cancel" at the bottom.
- **Tap target ≥ 48 × 48 px.** Buttons, list rows, every interactive surface. Status pills are visual, not interactive (a status pill is too small to tap).
- **Typing is a last resort.** Pickers, sheets, scanners first. When typing is unavoidable: large font, large input, autocomplete where possible, numeric keypad for hours.
- **One primary action per screen.** Bottom edge. Sticky. Not behind a floating action button — *the* button.
- **Sunlight contrast.** Brand tokens already account for this. Black-on-yellow for primary, navy-on-white for body. No grey-on-grey.
- **Cancel is always a tap.** A worker who tapped Capture by accident gets out in one tap, no data loss.

### 4.3 · Information density

- **One screen, one job.** Don't combine "today's hours" with "today's gear" and "today's snags" on one screen. The Today tab does hours. Jobs tab does jobs. Gear tab does gear. (This is already the bottom-tab IA in [13] §Phil.)
- **No tables.** A list of three jobs is three big rows, not a table. A list of evidence captures is a vertical scroll of photo-thumb + note + status pill, not columns.
- **No counts unless real.** "12 jobs assigned" with `12` derived from `me.assignedJobIds.length` is fine. "0 jobs completed this week" against a non-existent calculation is banned.
- **No queue counts on Phil.** Workers don't see "5 entries pending approval" — that's admin meta.

### 4.4 · Status visibility

For every entity Phil shows the worker, the status is the first thing they see:

| Entity (Phil) | Status priority order |
| --- | --- |
| TimesheetEntry | submitted → approved / rejected (rejected with reason in red) |
| GearAsset (own) | assigned → damaged / missing / returned |
| Job (assigned) | active vs on_hold vs complete |
| Evidence (Phase D, own) | pending_sync → submitted → reviewed / rejected |
| Snag (Phase D.5, own) | open → fixed → closed |

Each status pill uses the marker system in §6.

### 4.5 · Anti-patterns banned on Phil

- Admin-shaped dense tables.
- Tab bars at the top of a screen (the bottom-tab navigation is the only nav).
- Dropdowns deeper than one level (a worker won't find anything in a sub-menu).
- Toasts as primary feedback — use inline status changes instead.
- Spinners without context.
- "Premium feel" font weights — use system semi-bold/bold; readability beats elegance.
- Empty states that say "No data" without telling the worker what to do next.
- Capture flows that ask the worker to type a long sentence.
- Screen transitions slower than 200ms.

---

## 5 · BuhlOS admin clarity rules

Binding for every admin surface. Refines [13] §Foundational rules.

### 5.1 · Frame the operator

- **Form factor:** desktop or large laptop, ≥1280px wide, mouse + keyboard.
- **Admin context:** sitting still, has a real screen, looking at queues.
- **Maximum task time:** approve one timesheet entry in <5 seconds. Bulk-approve a week in <30 seconds. Review one evidence item in <10 seconds.
- **What the admin should never have to do:** refresh the page to see new data; click into a row to learn the status; scroll horizontally; learn a new pattern per page.

### 5.2 · Interaction rules

- **Status-first rows.** Every list row has its status pill at the left edge or as the first significant column. The admin scans down the status column, not the name column.
- **Bulk actions visible.** If a queue contains 30 items and the natural action is "approve them all," there's a bulk-approve action above the list. The selection model is a single checkbox column (no per-row dropdown).
- **Detail drawers, not modal dialogs.** Click a row → drawer slides in from the right. Drawer has the row's full detail + actions. Body still scrolls. The admin can dismiss the drawer with `Esc` or click outside.
- **Actions grouped by outcome.** "Approve / Reject" are visually paired. "Reviewed / Rejected" are paired. "Assign / Transfer" are paired. Not scattered across menus.
- **Search where it earns its place.** A list of 5 jobs doesn't need search. A list of 50 evidence items needs search by job + capturedBy + date.
- **No three-dot menus for the primary action.** If "approve" is the primary action, it's a button, not a menu item. Three-dot menus are only for archive / delete / settings — destructive or rare actions.

### 5.3 · Information density

- **Queues, not dashboards.** The home is "things that need your decision," not "things that happened." Queue cards show count + oldest item age + a one-click drill-in.
- **No KPI cards on `/command-centre` until Phase F reports.** Until there's real aggregated data, the home is queue counts only. (Per [21] ADR-013 + [13] §Banned patterns.)
- **Density toggle (compact / regular / roomy)** is per-user, persists in localStorage. Default is regular. Compact removes vertical whitespace but never reduces font size below 14px or tap targets below 32px.
- **One column wider than necessary.** Address columns, note columns — let them breathe. Truncating with `...` is a bug if the full content matters; either show the full text or open a drawer.

### 5.4 · Visual hierarchy

- **Three weights of text only.** Body (regular), label (medium), heading (semi-bold). No more.
- **Two accents on a page.** Brand yellow for primary action and the current row indicator. Status pill tones are separate (success/info/warning/danger/neutral). Anything else is decoration.
- **Status pill placement is consistent.** Left of the row title in tables; top-right of cards; first in detail drawers.

### 5.5 · Anti-patterns banned on Admin

- KPI cards along the top of `/command-centre` with fake numbers.
- "Charts" before real data exists. Phase F+ only.
- Pill tab navigation across the top of a section. Sidebar only (per [13] §Banned patterns).
- Buttons that open `alert()` / `confirm()` / `prompt()`.
- "Coming soon" modals. Use `UnderConstructionPanel`.
- Three-dot menus where the primary action lives.
- Cluttered "recent activity" widgets that aren't really audit log entries.
- Page-level breadcrumbs that don't help navigation ("Home / Admin / Jobs / Edit Job" — the sidebar already shows where you are).
- "Profile dropdown in top-right" pattern for settings. Settings is its own sidebar section.
- Confirmation modals for low-stakes actions (don't confirm a search filter; do confirm a delete).

---

## 6 · Visual marker system

One marker system used by both surfaces. Markers are the project's single source of truth for "what state is this thing in?" Every Dx PR that introduces a new status MUST update this table.

### 6.1 · Tone palette

Five tones. No more.

| Tone | Use | Token | When |
| --- | --- | --- | --- |
| **success** | Action complete, state stable, no attention needed | `--state-success` | approved · reviewed · returned · assigned · complete · good |
| **info** | In flight; needs no action yet | `--state-info` | submitted · in_progress · captured · pending_sync · saved |
| **warning** | Needs attention soon; recoverable | `--state-warning` | on_hold · needs_info · pending_review · maintenance |
| **danger** | Failed, lost, broken, must act | `--state-danger` | rejected · failed · lost · damaged · missing · wont_fix · failed_upload |
| **neutral** | No status / pending / archived (no signal) | (no accent) | draft · archived · pending · UC · empty |

This palette already exists per [13] §Visual tokens. This doc binds it as the only allowed mapping.

### 6.2 · Marker dictionary

For every marker shipping in Phase A/B/C/D/D.5/E:

| Marker | Tone | Surface | Where shown | Action prompted |
| --- | --- | --- | --- | --- |
| **submitted** | info | Phil + Admin | TimesheetEntry, EvidenceItem | Admin: review. Worker: wait. |
| **approved** | success | Phil + Admin | TimesheetEntry | Worker: done. Admin: export. |
| **rejected** | danger | Phil + Admin | TimesheetEntry, EvidenceItem | Worker: read reason + edit + resubmit. Admin: none (already acted). |
| **needs action** | warning | Admin (Command Centre) | Aggregate queue badge | Admin: open queue. |
| **blocked** | warning | Phil + Admin | JobTask | PM: triage. Worker: pick another task. |
| **captured** | info | Phil + Admin | EvidenceItem (server-acknowledged but not yet reviewed) | Admin: review. Worker: see in own history. |
| **reviewed** | success | Phil + Admin | EvidenceItem | Worker: done. Admin: done. |
| **missing** | danger | Phil + Admin | GearAsset | Admin: recover + mark good. Worker: don't take it. |
| **damaged** | danger | Phil + Admin | GearAsset | Admin: repair + mark good. Worker: don't use. |
| **returned** | success | Phil + Admin | GearAsset | Admin: re-assign. Worker: handed in. |
| **assigned** | success | Phil + Admin | GearAsset, Job | Worker: it's yours. Admin: tracked. |
| **good** *(post mark-good)* | success | Admin | GearAsset (cleared by admin reset, see PR #9) | Admin: re-assignable. Worker: visible if held. |
| **UNDER CONSTRUCTION** | neutral | Both | Nav items, panels | None — feature not yet built. |
| **pending sync** | info | Phil | EvidenceItem during upload | Worker: hold position; will retry. |
| **failed upload** | danger | Phil | EvidenceItem when retry failed | Worker: tap Retry. |
| **open** | warning | Phil + Admin | Snag (Phase D.5) | Admin: triage. |
| **in_progress** | info | Admin | JobTask, Snag | PM: monitor. |
| **complete** | success | Phil + Admin | JobTask, JobStage | Done. |
| **draft** | neutral | Worker | TimesheetEntry | Worker: complete + submit. |
| **archived** | neutral | Admin | GearAsset, Job | Hidden by default; shows when "include archived" toggled. |

### 6.3 · Marker conventions

- **Shape:** pill with rounded corners, 4px vertical padding, 8px horizontal padding, 12-14px text. Never larger than the body text it sits with.
- **Icon usage:** an icon is allowed inside a pill *only* if it adds information the colour doesn't (e.g., a "lock" icon on a `reviewed` pill to signal immutability). Otherwise: text only.
- **Tone is never the only signal.** Colour-blind safe = the label text says the state. The pill is a colour reinforcement, not a colour code.
- **Multiplicity:** an entity has exactly one current status pill. Layered pills (e.g., "submitted" + "needs_info") collapse into the most actionable one ("needs_info" wins).
- **Animation:** pills don't animate. Only the row they belong to may animate (e.g., briefly highlight on state change).

### 6.4 · "How to add a new marker" rules

When a new entity in Phase D / E / F introduces a new state:

1. Map the state to one of the five tones in §6.1. **Do not invent a new tone.**
2. Add a row to §6.2 dictionary in the same docs PR.
3. Reuse an existing label if the state semantically matches. Don't introduce "verified" when "approved" already exists.
4. Run the visual marker grep test (§13 of doc 26) to catch regressions.

---

## 7 · Navigation recommendations

### 7.1 · Phil

- **Bottom tab bar, 5 tabs, fixed.** Today · Jobs · Gear · Snag · More.
- UC tabs are visible but non-interactive — the user sees the roadmap (per [21] ADR-013).
- No drawer nav. No top tabs. No nested tab groups.
- The active tab indicator is a brand-yellow dot + label colour change. Not a bar above or below.
- A worker on `/phil/jobs/[jobId]/capture` (a deep flow) sees the bottom tab bar still — they can bail out to Today with one tap.

### 7.2 · BuhlOS Admin

- **Left sidebar, single column, 14 sections.** Order per [13] §"Left sidebar sections" (Command Centre · Hours · Jobs · Workers · Gear · Materials · Plans · ITP · RFIs · Defects · Variations · Reports · Settings · Support).
- Each section name + lucide icon + optional real-count badge.
- UC sections render with the "UC" pill, no link, `cursor: not-allowed`.
- Active section: brand-navy left border, ink background.
- No top-bar tabs for sub-navigation. Use a sub-sidebar OR tab pills inside the section if needed (e.g., `/hours` has Overview / Approvals tabs at section top).
- Breadcrumbs only for ≥3-deep pages (`/jobs/[jobId]/evidence/[evidenceId]` would breadcrumb; `/jobs` does not).

---

## 8 · Phil screen-by-screen critique

### 8.1 · `/phil/my-day` (Phase B — shipped)

**Strengths:** Standard Day button is correctly the biggest thing. One-tap submit works.

**Watch-outs going into Phase D:**

- The page must not grow a "Today's evidence" section or "Today's snags" section. Today is hours. Other tabs are other things.
- Header should not gain a notification bell, settings cog, or worker avatar that opens a profile. Profile is the More tab.
- If a worker has rejected hours from yesterday, surface that inline near the Standard Day button — not in a top banner that competes with the primary action.

### 8.2 · `/phil/hours` (Phase B — shipped)

**Strengths:** chronological history with status pills.

**Watch-outs:**

- Tap on an approved entry → drawer / detail view, not a separate page (kills back-button context).
- Rejected entries should let the worker edit + resubmit inline (per Phase B brief). The rejection reason text is in red, not a yellow warning.

### 8.3 · `/phil/gear` (Phase C — shipped)

**Strengths:** confirmation sheet pattern; Mark good supports off-site repair (PR #9).

**Watch-outs (lessons feeding back into Phase D evidence):**

- BUG-C-003 (sheet stays open after action, worker re-taps, duplicate history) — **Phase D's CaptureSheet must close on first tap of Submit, success banner lands when async settles.** Already in the plan §8 rule #6.
- BUG-C-004 (Blob read-after-write 5s lag) — **Phase D's evidence POST must return canonical EvidenceItem so client doesn't immediately re-fetch.** Add to §9.2 of plan if not present.

### 8.4 · `/phil/jobs` (Phase D — planned)

**Critique points for the build session:**

- The list is vertical, full-width rows. Each row: job name (large), address (smaller), status pill (left edge), "last activity X ago" (small, right-aligned).
- No filters above the list. A worker has 1–5 jobs; filtering is meaningless.
- Tap → `/phil/jobs/[jobId]`. No "view" button at the right edge; the whole row is the tap target.
- Empty state: "No jobs assigned yet. Ask your PM." Not a "+ New Job" button — workers don't create jobs.

### 8.5 · `/phil/jobs/[jobId]` (Phase D — planned)

**Critique points:**

- Header: job name + status pill + ref. NOT a hero image, NOT a progress bar across the top.
- Site context block: address, access, parking, safety, induction — collapsible if long, but expanded by default.
- Area-groups → areas: vertical list, each area is a big card with name + space type. Archived hidden. No "0 of 5 areas complete" — that's PM data.
- Stage chooser: two pills, Rough-in / Fit-off, equal weight. Worker taps one to filter the task list.
- Task list (when area + stage selected): big rows with task name + state pill. Tap toggles state via `/api/task-toggle` (D3+).
- Floating CTA at bottom: **Capture evidence**. Always visible. Always one tap to open the sheet.
- "Today's captures" strip: own captures only, horizontally scrollable, thumb + time. Tap → drawer with full detail.

### 8.6 · `/phil/jobs/[jobId]/capture` (Phase D — planned)

**Critique points:**

- Full-screen modal. Not a half-sheet, not a popup.
- Camera prompt first, automatic. Fallback to gallery button only if camera permission denied.
- Preview after pick. Worker can retake.
- Stage + area + task pickers: only show if context can't infer them. If worker is already on an area+stage selection, prefill.
- Note: 280 chars max, but the field is small (3 lines) by default. Most workers won't type more than 10 words.
- **Submit button: full-width, bottom edge, sticky. Disabled on tap until POST returns. Single tap = single capture (idempotent per §11 D-22 of plan).**
- **Sheet closes on tap, banner lands after** (per the BUG-C-003 lesson from Phase C).
- Cancel: full-width grey button just above Submit, equal height.

### 8.7 · `/phil/snags` (Phase D.5 — planned, not Phase D)

**Critique points for when D.5 ships:**

- One-screen flow. Photo → area → 1-line description → submit. <30 seconds.
- No status filter (worker sees their own snags only).
- Tap a snag → drawer with full history.

---

## 9 · BuhlOS admin screen-by-screen critique

### 9.1 · `/command-centre` (Phase A → Phase B → Phase C — shipped, Phase D adds evidence count)

**Strengths:** queue-shaped, no fake KPI cards.

**Watch-outs going into Phase D:**

- The new "X evidence pending review" line (Phase D §13 D6) must be a queue card, not a sparkline. Card shows count + oldest item age + click-through to `/jobs?filter=evidence-pending`.
- Welcome card copy was wrong post-Phase-C (BUG-C-001, fixed in PR #6). Phase D must update copy in the same PR that ships the evidence count — don't leave a stale "Phase C is evidence + snags" line.
- Do NOT add a "Recent activity" widget here. Activity has its own page (`/activity`).
- Do NOT add a "Today's profit" or "Hours this week" sparkline. Phase F+ Reports owns analytics; Command Centre is decisions only.

### 9.2 · `/hours/approvals` (Phase B + PR #6 fix — shipped)

**Strengths:** clean queue. PR #6 fix (extracted `HoursApprovalsQueue` to `src/components/admin/`) confirmed the right structural pattern.

**Lessons for Phase D evidence review:**

- Server component renders the page shell + permission gate + initial server-fetch.
- Client component (`HoursApprovalsQueue` pattern) handles interactivity, lives in `src/components/admin/`.
- Each row: status pill (left) + worker name + date + hours + actions (Approve / Reject inline).
- Reject opens a small modal with required reason. Reason ≤500 chars (legacy convention).
- Bulk approve = single checkbox column + "Approve N" button when ≥1 selected.

### 9.3 · `/gear` (Phase C — shipped)

**Strengths:** detail drawer pattern; visibility logic for the Mark condition section (PR #9).

**Lessons for Phase D:**

- **Visibility logic for action sections is non-trivial.** PR #9 shows "Mark condition" iff held *or* damaged/missing in depot. Phase D evidence-review section visibility must handle "evidence captured by worker not currently assigned" cleanly. Don't hide the row; surface a flag pill ("Worker no longer on this job — review with care").

### 9.4 · `/jobs` admin list (Phase D — planned)

**Critique points for the D4 build session:**

- Columns (compact density): status pill · name · ref · address · PM (when populated) · evidence count · last activity.
- Sort: last activity desc by default.
- Filter row: status, evidence-pending, PM. Real filters, no decorative dropdowns.
- Search: name + ref substring. No fuzzy search; substring is enough.
- Row hover: cursor + subtle background. Click → drawer? Or full-page navigation? **Recommendation:** full-page navigation for `/jobs/[jobId]` since the detail is rich and benefits from URL stability. The /command-centre + /hours/approvals patterns use drawers because their detail is shallow; jobs is deeper.
- No KPI card row above the list. The list is the surface.

### 9.5 · `/jobs/[jobId]` admin detail (Phase D — planned)

**Critique points:**

- Header: name + status pill + ref + admin actions ("Edit on legacy" button until Job Builder rebuild lands).
- Three sections, vertically stacked, each with its own H2: **Overview · Evidence · Hours**.
  - Overview: site context block (read-only), area groups → areas read-only, task templates read-only.
  - Evidence: link to `/jobs/[jobId]/evidence` + count + first 3 photo thumbs as a preview strip.
  - Hours: count + link to `/hours?jobId=...` (filtered view).
- No tabs across the top. Sections are vertically scrolled. Sticky H2 headings if it improves scan.

### 9.6 · `/jobs/[jobId]/evidence` review (Phase D — planned)

**Critique points:**

- Status-first rows. Each row: status pill · photo thumb (48×48) · note excerpt · target (area + stage + task or "unattached") · captured-by · captured-at · actions (Mark reviewed / Reject).
- Reject opens modal with required reason.
- Bulk-select checkbox column. Bulk "Mark N reviewed" button when ≥1 selected.
- Filters: status · capturedBy · date range · unattached-only.
- Drawer on row click: full-size photo, full note, target detail, full history (capture event, any rejections, current state).
- Empty state: "No evidence captured for this job yet." Not "0 records."

### 9.7 · `/activity` (Phase D — planned, simple cutover)

**Critique points:**

- Vertical feed. Each event: timestamp + actor + action verb + target link.
- Filters: actor, action type, target entity, jobId.
- Default scope: evidence events + task toggles (per §15.1 #8 decision when answered).
- No charts. No graphs. No "events per hour" bars.

---

## 10 · Component rules

Phase A established the primitives in `src/components/ui/`. Phase D will need more. Rules for adding components:

- **Add to `src/components/ui/` only if used in ≥2 surfaces.** Anything Phil-only goes in `src/components/phil/`. Anything Admin-only goes in `src/components/admin/`.
- **Match the existing tokens.** No new colour values, no new font sizes. If you need one, add it to `src/styles/tokens.css` in a separate PR with rationale.
- **No CSS modules. No styled-components.** Tailwind utilities + tokens only (per [14] §B "Non-stack choices").
- **No client component lives under a deep route folder.** Per risk D-26 + binding rule in [25] §Common preamble. Client components live in `src/components/{phil,admin,ui}/`, never at `src/app/<route>/foo-client.tsx`.
- **Storybook-friendly props.** Every new component takes its data via props, never reads from React Context or a store inside the file. The page composes; the component renders.
- **`children` is rare.** Composition is via explicit named slots (`header`, `actions`, `footer`) not a generic children prop. Easier to grep for usage.

---

## 11 · State / status rules

For every entity with a lifecycle:

- **The status enum is defined once** in `src/domains/<domain>/schema.ts`. Never inline in a component.
- **The status pill component takes a status enum value.** It maps to a tone via a single switch. No per-domain pill components — one `<Pill tone="success">approved</Pill>` for all.
- **The transition matrix is encoded as a `canTransition(from, to)` helper** in `src/domains/<domain>/service.ts`. Server-side enforcement is authoritative.
- **Optimistic UI is allowed for low-risk actions** (mark task complete, approve hours) — but the optimistic state is replaced by the server's canonical response, not the client's guess.
- **Pending sync is a client-only state.** Server never knows about `pending_sync`; it's how the client renders "we've handed off but not yet confirmed". Once server returns the EvidenceItem, the pending_sync pill is replaced.

---

## 12 · Empty / loading / error / pending rules

Every async surface needs all four. Not three. Not "we'll add empty state later."

| State | Visual | Copy guideline |
| --- | --- | --- |
| Loading | Skeleton blocks matching the final layout (rows of the right height, pills as grey blocks) | No copy, no spinner with text |
| Empty | Plain prose + (optional) tertiary CTA | "No jobs assigned yet. Ask your PM." Not "0 results." |
| Error | Banner (warning tone) + Retry button + the underlying message (truncated) + a link to a more detailed error page if the error has a code | "Couldn't load your jobs. Retry?" + "(error: network timeout)" small |
| Ready | Normal | n/a |
| Submitted/saved | Brief affirmative pill ("Saved" / "Submitted") that decays to normal in 1.5s | "Saved" not "Successfully saved your changes" |
| Upload pending | Inline progress on the item + sheet stays open | Progress percent, not text |
| Pending sync | Item shows `pending_sync` pill (info tone) | "Will sync when reconnected" if `navigator.onLine === false` |
| Failed upload | Item shows `failed_upload` pill (danger tone) + Retry button preserved the photo + note | "Retry upload" |

**No silent fallbacks.** If the API failed and you rendered fixtures, the DemoModeBanner must be visible. If the DemoModeBanner is hidden, the data is real. (Per [21] ADR-015.)

---

## 13 · What to remove, hide, or demote

When the Phase D build sessions land, these are the items to actively NOT add (or to remove if a prior PR sneaked them in):

- KPI cards on `/command-centre` (until Phase F).
- "Recent activity" widget on `/command-centre`. The activity feed has its own page.
- Profile dropdown menu in the top-right. Profile is the "More" tab on Phil, the Settings sidebar section on Admin.
- Per-row three-dot menus where the primary action exists as a button.
- Page-level breadcrumbs on shallow pages (≤2 segments deep).
- "Toast" notifications as primary feedback. Inline status changes are primary.
- Greyed-out features that look interactive but aren't. Use UC pill.
- Helper text that explains the feature ("This is the jobs list where you can see all jobs"). The screen explains itself.
- Welcome carousels, onboarding tours, "did you know" panels.
- Decorative illustrations on empty states. A short sentence is enough.

---

## 14 · Anti-patterns (cross-reference)

These are banned, with the rule that enforces them:

| Pattern | Banned by |
| --- | --- |
| Generic SaaS dashboard framing | [13] §Banned patterns + [10] §D |
| KPI cards on home before real data | [21] ADR-015 + this doc §5.3 |
| Silent mock fallback | [21] ADR-015 + lint |
| Half-built features that look complete | [21] ADR-013 + this doc §3 #5 |
| `alert()` / `confirm()` / `prompt()` | ESLint `no-alert` |
| Inline `<style>` blocks | ESLint `no-restricted-syntax` |
| `window.location.href = ...` for in-app nav | [14] §E UI rules |
| Pill tab navigation across top of admin section | [13] §Banned patterns |
| Duplicate admin shells | Lint (no two `function AdminShell`) |
| "Switchboard" / "Site Office" labels | ESLint `no-restricted-syntax` + boot migration |
| Client component under deep route folder | [24] D-26 + [25] §Common preamble + [26] §A.1 grep |
| Three-dot menus for primary actions | this doc §5.2 |
| Profile dropdown for settings | this doc §13 |
| Toast notifications as primary feedback | this doc §13 |

---

## 15 · Quick wins (no architecture change)

These can land in small follow-up PRs before Phase D D1 starts:

1. **Audit existing pages for unearned elements.** Remove any UI on Phase A/B/C surfaces that doesn't pass §3 #1. Likely candidates: helper text, illustrations, "X of Y" counters that don't matter.
2. **Audit status pills.** Confirm every pill on every surface uses the §6 tone palette and a §6.2 dictionary label. Fix any drift.
3. **Confirm DemoModeBanner state.** Run the Playwright check from [17] §B.9 — banner must be OFF on all real-data routes (Phase B + Phase C).
4. **Confirm the SignOutButton is in the right place.** Sidebar footer per PR #7. Not in the top-right of every page.
5. **Confirm `/command-centre` welcome card is accurate** — PR #6 fixed BUG-C-001 (was stale Phase C copy). Verify post-Phase-D update lands in the same PR as the evidence count.
6. **Lint check for any new `*-client.tsx` under deep route folders.** Run the [26] §A.1 grep on `main` now to confirm zero existing offenders. (As of `52d629e`, the only known offender was the `approvals-client.tsx` Session 2 fixed in PR #6 — but a fresh grep is cheap insurance.)
7. **Phil tab bar audit.** Today / Jobs / Gear / Snag / More — confirm Snag is UC, all others are correct. Confirm tab order matches §7.1.

---

## 16 · Phase-by-phase UI priorities

Each Dx slice has a UI focus aligned to this doc:

| Slice | UI focus | Binding §s |
| --- | --- | --- |
| D1 · jobs domain + Phil read-only | Phil jobs list + detail. **Status-first, big rows, one CTA.** | §4, §8.4, §8.5 |
| D2 · evidence domain + capture sheet | Capture sheet UX. **Sheet closes on submit (BUG-C-003 lesson). One-tap idempotent.** | §4.2, §8.6, §11, §12 |
| D3 · persistence + audit log + real wiring | DemoModeBanner OFF for evidence. Server returns canonical EvidenceItem (BUG-C-004 lesson). | §6, §11, §12 |
| D4 · admin Jobs + cutover | Admin status-first rows. Drawer or full-page (recommendation: full-page). Reject modal required reason. | §5, §9.4, §9.5, §9.6 |
| D5 · admin Activity + cutover | Vertical feed. No charts. Filters work. | §5, §9.7 |
| D6 · exit polish + Command Centre evidence count | Queue card, not sparkline. Welcome copy updated. | §5.3, §9.1 |
| D.5 · snags | One-screen Phil flow. Admin triage queue (queue-shaped, not table). | §4, §5 |
| E · ITP / RFI / Materials | (TBD — Phase E gets its own usability pass) | future |

---

## 17 · Claude Code handoff rules

When a Dx build session opens:

- Read this doc (§3 + the relevant §8.x or §9.x) as part of the preflight reads in [25].
- For every new UI element, justify it against §3 #1 ("earn every element") in the PR body.
- Use §6 marker dictionary for any new status pill. Add new entries to §6.2 in the same PR.
- If a design decision contradicts this doc, **stop and ask** ([20] §29). Don't silently diverge.
- After the slice ships, walk §15 quick wins one more time — anything still applicable becomes a polish task.

---

## 18 · Ready-to-paste UI hardening prompt

For a future Claude Code session that does a polish pass on existing surfaces (Phase B + C) before Phase D D1 opens. Scope is small and safe.

```
You are Claude Code working as a UI hardening session for BuhlOS / Phil.

Scope: small audit + polish pass across Phase A/B/C surfaces. NO new
features. NO Phase D code. Apply binding rules from
docs/rebuild-audit/27-interface-usability-pass.md.

Read first:
  docs/rebuild-audit/27-interface-usability-pass.md   ← binding rules
  docs/rebuild-audit/10-product-definition.md
  docs/rebuild-audit/13-ui-information-architecture.md
  docs/rebuild-audit/20-agent-rules.md

Branch:     ui-hardening-pre-phase-d (from latest origin/main)
PR title:   ui: hardening pass (visual markers, unearned elements, demo banner)

In scope (any subset of these that produces a green PR):

  - Audit + fix:
      - Any status pill not using the §6 tone palette
      - Any status pill label not in the §6.2 dictionary
      - Any unearned element on Phase A/B/C surfaces (§3 #1)
      - Any helper text that explains the feature
      - Any "Recent activity" widget on /command-centre (delete it)
      - Any profile dropdown in top-right (move to Settings or More tab)
      - Any three-dot menu where the primary action exists as a button
      - Any toast as primary feedback (replace with inline status)

  - Lint-level grep (must be empty after your PR):
      git ls-files 'src/app/phil/jobs' 'src/app/(admin)/jobs' \
        | xargs grep -l '"use client"' 2>/dev/null

  - DemoModeBanner check: run Playwright [17] §B.9 — banner must be OFF
    on every real-data route (Phase B + Phase C). Fix any leak.

  - Phil tab bar audit: confirm tab order Today / Jobs / Gear / Snag / More
    + Snag is UC + active indicator is brand-yellow dot.

Out of scope:

  - Any new feature
  - Any Phase D code
  - vercel.json edits
  - api/*.js edits
  - public/*.html edits
  - Routing changes
  - Auth changes
  - Backend changes

Tests:

  - Existing suite must pass (typecheck · lint · test · build · 4 legacy
    guards).
  - Add a Vitest test asserting <Pill tone={tone}> only takes one of the
    5 tone strings (drift-prevention).

PR body must include:

  - List of every element removed/changed, with the §-reference from doc 27
    that justifies it.
  - Before/after screenshots if any visual change is non-trivial.
  - Confirmation no Phase D code touched, no API change, no vercel.json
    change.

Final report: as standard.
```

---

## 19 · Open questions for Oskar

These are usability questions this doc can't resolve without product input:

### 19.0 · Resolved (Session 3)

- **Tone palette = 5 tones (success/info/warning/danger/neutral).** Locked per [13] §Visual tokens. No new tones without ADR.
- **Marker dictionary anchored.** Every Phase D status maps to an existing label where possible (`captured`, `reviewed`, `rejected` reuse Phase B/C semantics).
- **Detail surface for `/jobs/[jobId]`:** full-page navigation (not drawer) — detail is rich, URL stability matters.

### 19.1 · Still open

1. **Density default for Admin** — compact vs regular? (Recommendation: regular. Power users can switch to compact.)
2. **Admin pages drawer vs full-page** for sibling rich pages beyond `/jobs/[jobId]` — e.g. `/workers/[id]`, `/gear/[assetId]`. (Recommendation: full-page for any page with ≥3 sections or any page that benefits from URL stability for sharing.)
3. **Phil offline messaging** — when `navigator.onLine === false`, show a top banner ("Offline — captures will sync") or only an inline pill on the affected item? (Recommendation: top banner, dismissible, sticky until reconnected.)
4. **Bulk actions visibility** — only when ≥1 row selected, or always visible as a disabled CTA that becomes active on selection? (Recommendation: always visible disabled — discoverability matters.)
5. **Tab bar bottom safe-area on Phil** — iOS bottom inset can clip the active CTA bar. Confirm safe-area-inset-bottom is honoured in the Phil shell.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — user roles + product surfaces.
- [13-ui-information-architecture.md](13-ui-information-architecture.md) — sidebar/tab IA + visual tokens. This doc binds the application of [13]'s tokens; [13] defines them.
- [20-agent-rules.md](20-agent-rules.md) §"Communication posture" — when to stop and ask.
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md) — ADR-013 (UC over fake-it), ADR-015 (mock data labelled).
- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) §6 + §7 — admin/Phil split + UI states.
- [25-phase-d-build-prompts.md](25-phase-d-build-prompts.md) §Common preamble — RSC manifest pattern + binding hard rules.
- [26-phase-d-testing-checklist.md](26-phase-d-testing-checklist.md) §A.1 — pre-merge grep for D-26 regressions.
- [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md) — Phase C live state + lessons that feed back into Phase D (added in PR #9; will be available after merge).

---

## Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/27-interface-usability-pass.md` |
| Author | Session 3 (Phase D planning agent) |
| Branch | `phase-d-jobs-evidence-plan` |
| Status | **Draft — cross-cutting binding doc; review alongside [24]** |
| Phase precondition | None (this is upstream of every phase). |
| Next action | Oskar reviews §3 principles + §6.2 marker dictionary + §19.1 open questions. After review, Phase D build sessions cite this doc in preflight reads. A pre-D1 UI hardening session can optionally land §18's paste-ready prompt to clear quick wins. |
