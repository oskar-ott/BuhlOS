# 04 · UI/UX audit

The current UI vs the target product direction. The product is an **electrical/construction operations platform**, not a generic SaaS dashboard. Two distinct interfaces — BuhlOS Admin (desktop) and Phil (mobile) — over one shared backbone.

---

## Target product direction

### BuhlOS Admin

- **Desktop-first** — used at a desk, monitor, mouse + keyboard. Not designed for touch.
- **Left-sidebar navigation** — persistent nav, sectioned (Run / Deliver / People / Win / Insights / Settings). The user lives in the sidebar.
- **Action / control-centre focused** — every screen surfaces "what needs attention" first, "browse data" second.
- **Operational, not generic dashboard** — KPI tiles must reflect real operational state (pending hours, open alerts, crew on site), not vanity metrics.
- **No old pill-tab admin navigation** — the legacy `admin.html`'s top-tab pattern is forbidden in the rebuild.
- **No generic SaaS layout** — no "Welcome back, [user]!" hero, no marketing-style empty states, no fake gradients.
- **Serious industrial interface** — dense, information-rich, contractor-aesthetic. Dark sidebar acceptable; otherwise neutral.

### Phil

- **Mobile-first** — designed for a phone in a tradesman's hand, usually one-handed.
- **Field optimised** — readable in direct sunlight; minimum 16px text; high-contrast surfaces.
- **Large touch targets** — 44pt minimum, 56pt preferred for primary actions.
- **One-thumb usable** — bottom-anchored action bar, primary CTAs reachable from thumb arc.
- **Practical in sun / with gloves** — no hover states, no pinch-zoom required, no tiny dismiss `x`s.
- **Low typing** — Phil should never need typed input for routine work. Pick from list, tap, scan, photo.
- **Fast actions** — every primary action ≤2 taps from the home screen.
- **Focused on:** hours, gear, jobs, evidence capture, ITPs, and requests. Nothing else.

---

## What the current UI does right

### BuhlOS Admin (operations.html SPA)

The `/admin/operations` Command Centre SPA is the closest current surface to the target. Things to keep conceptually:

- **Dark sidebar with sections** (Operations / Quality & Plans / Field & Logistics / Commercial / Admin). Information architecture is sensible.
- **"BL" brand mark + "BuhlOS · Command Centre"** brand block at top of sidebar — clean.
- **KPI tiles with sub-labels** (`Active jobs / across all sites`) — proper grounded labels, not generic.
- **"Alerts — sorted by urgency"** — exactly the right framing for the surface.
- **`live` and `v1` tags on nav items** — explicit honesty about feature state. Carry this forward.
- **`uc` (Under Construction) styling** — pages like Quotes/Reports clearly marked. Per [[feedback_hide_unfinished_features]] this is the right pattern; expand it to every incomplete feature.
- **The Quick Actions card** ("Review pending timesheets", "Open jobs board", etc.) — operational, not vanity.

### Phil (phil.html)

- **Bottom tab bar** (Today / Jobs / Gear / Snag / More) — correct mobile pattern.
- **Big Phil logo** on the login screen — brand presence.
- **Standard-day button (7h 36m)** in hours — domain-correct UX.
- **"Sign out?" confirm before logout** — small but right.
- **Black-yellow palette** consistent with brand.

### Cross-cutting

- **Yellow `--accent: #ffcc00`** — strong, consistent brand colour.
- **Navy `--header: #0d1f35`** — heavy, serious, contractor-appropriate.
- **`Inter Tight` for headings, Inter for body** — typography stack is fine.
- **Three-state task selectors** (Not started / In progress / Done) — domain-correct.

---

## UI patterns that must be banned in the rebuild

### Generic SaaS visual debt

- **Marketing-style empty states** ("Nothing here yet!" with a friendly graphic). Construction operations is not a fluffy product.
- **Hero greetings** ("Good morning, [name]!"). Skip the small talk.
- **Generic feature badges** (NEW · PRO · BETA). Use only domain-specific markers like `v1` / `live` / `under construction`.
- **Gradients on KPI tiles, buttons, or backgrounds** — except the brand yellow `--accent`.

### Legacy patterns still present

- **Top pill-tab navigation** (`admin.html` legacy + `project.html`). Banned.
- **Inline `<style>` blocks per page** (40-60KB inline CSS in some pages). Banned — use Tailwind tokens.
- **Per-file mock data** (Phil's `MOCK_JOBS`/`MOCK_AREAS`/...). Banned — fixtures live in `src/domains/*/fixtures.ts`.
- **Full-page-replacement modals** (`document.body.innerHTML = ...` in Phil's signin / wrong-app screens). Banned — use proper component overlays.
- **`alert()` for "feature not built yet"** (operations.html: "Plan upload — FEATURE UNDER CONSTRUCTION..."). Banned — show an actual `<UnderConstructionPanel />`.
- **TODO comments referencing not-yet-built endpoints** (Phil's `// TODO: POST to /api/snags (not yet built)`). Banned — either wire it or hide the feature.
- **`window.PAGE = { id, title, render }` global** for shell coordination. Banned — React composition replaces this.
- **`SHELL.boot()` trailing call** as a runtime contract enforced by a static grep. Banned — Next.js renders mean no manual boot.
- **`buhl-site-office-tweaks` localStorage key** and similar deprecated names. Banned.
- **Mocked data falling back invisibly** (`window.BUHLOS_MOCK` fills empty API responses with fake jobs). Banned — fixtures must be visually marked.

### Forbidden text content

- **"Site Office" anywhere user-visible** — `phil.html:1548-1549`, `_shell.js:592` ("bühl admin · site office"), login.html comments. ALL must be replaced with "BuhlOS Admin" / "BuhlOS".
- **"Switchboard" as a UI label** (not the equipment kind — the deprecated naming kind). Currently still in some places.
- **"Birdwood IV3232"** as visible text anywhere outside the live job record. Pre-deploy check exists; expand to all customer-facing surfaces.
- **"Demo" / "Sample"** when the data is actually live. Conversely, mock data MUST say "DEMO MODE".

---

## Legacy layouts still present

| Layout                                                  | Lives in                                  | Why it must go                                                          |
| ------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Top horizontal pill-tabs                                | `public/admin.html` (legacy admin)        | Pre-rebuild visual era. Reachable at `/admin-legacy`.                   |
| Horizontal job dashboard                                | `public/project.html` (legacy job view)   | Pre-rebuild visual era. Reachable at `/jobs/:id`.                       |
| `_shell.js` multi-page admin sidebar                    | `public/admin/<page>.html` (×24 pages)    | Architecturally fine; visually OK; but coexists with the SPA shell.    |
| Self-contained SPA shell                                | `public/admin/operations.html`            | Closest to target — but inline 3,246-line file is unmaintainable.       |
| `lh-home.html` field-control layout                     | `public/lh-home.html`                     | Third surface between admin and Phil. Decide its home in the rebuild.   |
| `my-day.html` tradie home (legacy Phil)                 | `public/my-day.html`                      | Functionally working but visually pre-Phil. Phil is the canonical surface. |
| `my-gear.html` standalone gear page                     | `public/my-gear.html`                     | Should be a Phil sub-screen, not a standalone page.                     |
| `phil-hours.html` standalone hours page                 | `public/phil-hours.html`                  | Should be a Phil sub-screen.                                            |
| `client.html` per-job client read-only page             | `public/client.html`                      | Single page; OK; will be rebuilt as part of Admin's public-views slice. |

---

## Design drift

- **Two CSS layer eras coexist**:
  - `public/theme.css` (44KB) — the older shared design system, used by admin.html, project.html, my-day.html, lh-home.html, login.html.
  - `public/css/buhlos.css` + `public/css/buhlos-admin.css` — the newer BuhlOS-era CSS used by `_shell.js`-driven pages.
  - `public/admin/operations.html` — has its own inline `<style>` redefining the whole token set.
- **Three different sidebar styles** between operations.html, `_shell.js`-driven pages, and `lh-home.html`.
- **Multiple "primary" button styles** (`.btn.primary`, `.btn-yellow`, `.alert-cta.primary`, etc.).
- **Inconsistent badge styles** (`.pill`, `.side-badge`, `.nav-badge`, `.nav-tag`).
- **Inconsistent KPI tile styles** between Phil's stat blocks and admin's kpi-tile blocks.

The rebuild collapses this into one Tailwind-token system + one component library.

---

## Inconsistent branding

| Surface                       | Brand mark                | Brand name shown                | Subtitle                     |
| ----------------------------- | ------------------------- | ------------------------------- | ---------------------------- |
| `operations.html` sidebar     | `BL` (yellow block)       | `BuhlOS`                        | `Command Centre`              |
| `_shell.js`-driven sidebar    | `b` (lowercase, yellow)   | `bühl admin`                    | `site office` 🚫              |
| `lh-home.html` (LH)           | (varies)                  | `bühl`                          | `Field control`               |
| `login.html` (public)         | `BuhlOS` heading          | `BuhlOS`                        | "Site office system" comment 🚫 |
| `phil.html` (Phil)            | Phil logo SVG (V3 per [[project_phil_logo_v3]]) | `Phil`        | (none)                        |
| `manifest.json` (PWA)         | `/icon-192.png`           | `BuhlOS`                        | n/a                          |
| `admin.html` (legacy)         | `bühl admin`              | `bühl`                          | (varies)                     |

Three different brand marks. Two different brand names ("bühl admin" vs "BuhlOS"). Two surfaces still say "site office". The Phil logo per [[project_phil_logo_v3]] is correct in the new `phil.html` but the manifest icons don't carry it.

---

## Places where BuhlOS and Phil are confused

1. **Login → my-day**, not login → /phil. Tradies and apprentices land on the legacy `my-day.html`, not on Phil. The PWA install drops them onto `/my-day` not `/phil`.
2. **Phil app's wrong-app screen** says "Phil is for the crew. Clients use the **Site Office** portal" and offers a "**Go to Site Office**" button. Both phrases are deprecated; should be "BuhlOS" or "client portal".
3. **`my-gear.html` and `phil-hours.html`** are not under `/phil/*` and don't share Phil's layout. They look like 2024-era tradie pages, not Phil sub-screens.
4. **The "Open in field" action** in admin (`public/components/open-in-field.js`) jumps to legacy `/my-day` for some routes and `/phil` for others.
5. **Workspace shell** (`public/components/workspace-shell.js`) is a third pattern — neither Admin shell nor Phil shell. Unclear which surface it belongs to.

---

## Unfinished features that pretend to work

Per [[feedback_hide_unfinished_features]] half-broken UI must be hidden or labelled. These features are NOT labelled but ARE broken:

| Feature                                | Where                                       | Pretends to                                                              |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Job Builder (SPA section)              | `operations.html#sec-builder`               | Looks functional but "+ New job" `alert()`s "use the legacy admin"        |
| ITP review                             | `operations.html#sec-itp`, `admin/itp.html` | Marked `v1` but `itp_review_self` independent-reviewer rule incomplete   |
| Plans upload                           | `operations.html#sec-plans`, `admin/plans.html` | `alert()`s "Plan upload — FEATURE UNDER CONSTRUCTION"                |
| Materials request                       | `operations.html#sec-materials`             | Renders mock data; no real request → order → deliver loop                |
| Phil snag raise                        | `phil.html:1524`                            | Has a Save button but TODO says "POST to /api/snags (not yet built)" — endpoint exists, just unwired |
| Phil login                             | `phil.html showLoginScreen`                 | Posts to `/api/auth?action=signin` (404). Login does nothing visible.    |
| Phil My Gear                           | `phil.html#renderGear`                      | All mock data; no API wire-up                                            |
| Phil Today                             | `phil.html#renderToday`                     | All mock data; standard-day button writes nothing real                   |
| Variations creation                    | `admin/variations.html`                     | Modal exists; no clear linkage to Job/RFI                                |
| Reports tiles                          | `admin/reports.html`, `operations.html`     | Some metrics real, some UC                                               |
| Client signin                          | `client.html`                                | Read-only client portal; functional but doesn't enforce job-scoped visibility client-side |

**Recommendation:** every feature on this list must either:
- (a) be wired end-to-end and labelled `live`,
- (b) be visually labelled `UNDER CONSTRUCTION` and disabled, or
- (c) be hidden from the nav until the loop matures.

No middle ground.

---

## Specific UI debt to clean up in the rebuild

- **Inline `<style>`** blocks in every HTML page (40-200KB CSS inline per page). All goes to Tailwind / shared CSS modules.
- **Inline `<script>`** blocks (50-400KB JS inline per page). All goes to React components / typed modules.
- **HTML files >100KB** (admin.html 436KB, project.html 482KB, operations.html 162KB, my-day.html 98KB). Banned — every screen is a React route.
- **Web components in `public/components/`** (22 files). Migrate to React components in `src/components/`.
- **`document.body.innerHTML = '...'`** screen replacement. Banned.
- **`location.href = '...'`** for in-app navigation. Banned — use `<Link>` / `useRouter`.
- **`window.confirm()` and `alert()`** for product flows. Banned — use proper modals.

---

## Accessibility (current state, not yet a target focus)

- **No formal a11y testing** has happened.
- Most buttons have visible labels (good).
- Focus styling is custom and inconsistent across surfaces (operations.html vs `_shell.js` vs Phil).
- Touch targets in Phil are reasonable but not measured.
- Screen reader landmarks are unset.

**Recommendation:** the rebuild should add `audit` (a11y) as a routine final step on every shipped slice. Use the design `accessibility-review` skill.

---

## Summary

| Question                                | Answer                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Is the current Admin shell the right direction? | **Yes** — the `operations.html` SPA pattern is right. Rebuild on it.   |
| Is the current Phil shell the right direction? | **Yes** — the bottom-tab + native-feel approach. Rebuild on it.        |
| Is the current legacy admin (`admin.html`) salvageable? | **No.** Discard. Same for `project.html` and `my-day.html`.       |
| Is the current theme/token system reusable? | **Partially.** Yellow + navy + Inter typography keep. CSS implementation rebuilds. |
| How much UI is hidden behind feature flags? | **Effectively none.** `uc` is a CSS class, not a flag. Add proper flags. |
