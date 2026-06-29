# BuhlOS Admin — design prototype (visual reference only)

These files are the clickable HTML/React **mock** from the separate BuhlOS *design*
project, committed here per the BuhlOS Admin implementation brief §0 so the
look-and-behaviour target lives in the repo (rather than in a Downloads zip)
while the whole-webview redesign is built.

## ⚠️ Reference only — do NOT wire any of this into the app

- **Visual + behavioural target, not production code.** The real build derives
  **all** data from the domains (`src/domains/<domain>/`) and the `api/*.js`
  endpoints named in the brief. Never import from here.
- **`admin-data.js` is mock data.** Never copy numbers, statuses or logic out of
  it — honesty is law (CLAUDE.md / brief §0: no invented numbers, no mock-only UI).
- Where the mock and the brief (or `src/components/ui` + `src/styles/tokens.css`)
  disagree, **the brief and the real design system win.** The prototype only
  settles *visual* questions — spacing, the certainty-chip look, heatmap tints.
- Some mock affordances have no valid production audience and are intentionally
  **not** ported (e.g. the office/field surface switch — the role tiers are
  disjoint, so no admin-surface user can reach Phil). See each PR for the call.

## File → surface map (brief sections)

| File | Surface / brief § |
| --- | --- |
| `admin-shell.jsx`, `admin-app.jsx`, `admin-icons.jsx` | §1 Shell, nav, primitives |
| `admin-command.jsx` | §2 Command Centre board |
| `admin-jobs.jsx` | §3 Jobs portfolio + hub |
| `admin-builder.jsx`, `admin-builder-sections.jsx`, `admin-builder.css` | §4 Job Builder cockpit |
| `admin-hours.jsx` | §5 Hours weekly pay-run |
| `admin-inbox.jsx` | §6 Field-to-office inboxes |
| `admin-resources.jsx` | §7 Resources (People, Gear) |
| `admin-company.jsx` | §8 Company (Quotes/Reports/QA/ITP/Settings) |
| `admin-base.css`, `admin.css`, `admin-extra.css`, `tweaks-panel.jsx` | shared styling / dev tweaks panel |

Source: `BuhlOSPhil (4).zip` → `admin/`. The authoritative spec is the brief's
prose, not these files.
