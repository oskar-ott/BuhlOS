# Phil UI polish v1 (`feat/phil-ui-polish-v1`)

A small, conservative field-UX pass on Phil, drawn from a full UI/UX audit of
every Phil surface (see the audit matrix in the PR). Two coherent, fully-safe
improvements — chosen because the higher-value structural lanes (job action
hub, worker-visible tasks, rejected-hours) are already in flight on open PRs
(#93, #94) and must not be collided with.

Both changes are conflict-free with #93/#94 (no shared files), touch no API
write path, no capture path, and introduce no fake state.

---

## 1. Jobs list now shows "open work on this site"

**Problem (audit gap):** the Phil jobs list (`/phil/jobs`) — the worker's
site picker — showed only name, address, ref and a relative-time caption.
A worker with several sites couldn't tell which one has outstanding work
without opening each. "What needs doing / what's blocked" started one tap too
late.

**Change:** each job row now shows real, job-wide "open work" chips — open
snags and active ITPs — pulled from the existing opt-in `?withStats=1` stats:

- `src/app/phil/jobs/page.tsx` — the list fetch is now `/api/jobs?withStats=1`.
  The enrichment **fails soft** server-side (`api/jobs.js`): a bad per-job read
  returns the core job with zeroed stats, so the list always renders.
- `src/components/phil/philJobsListSignals.ts` — a pure, unit-tested helper
  `jobOpenWork(job)` → `[{key, count, label}]` from `statsSnagsV2Active` /
  `statsItpsActive`, plus `jobOpenWorkSummary` for the screen-reader label.
- `src/components/phil/PhilJobsList.tsx` — renders the chips (icons + labels
  matching `PhilJobAreaCard` exactly) and folds the summary into the row's
  accessible name (announced once, chips marked `aria-hidden`).

**Honest by construction:**
- These are **job-wide site signals**, not a personal to-do list. The scoped,
  per-worker attention still lives on the job screen (`PhilJobAttentionStrip`).
  Labels are neutral nouns ("3 snags", "2 ITPs") — never "yours" / "to do".
- A chip renders only for a **real positive count**. When stats are absent
  (endpoint without `withStats`, or a soft-failed read) the row renders
  **exactly as before** — no fabricated "all clear", no guessed number. This
  graceful degradation means the change carries **zero regression risk**: worst
  case is "no new chips".
- Counts + label vocabulary match what the job screen shows, so the list and
  the job agree.

## 2. Removed an admin-path leak from the Materials panel

**Problem (audit, confirmed):** `JobMaterialsPanel` (a field surface) linked
the worker to `<a href="/admin/materials">` — an **admin-only route a field
worker cannot open**. Tapping it would bounce them to login/403: a dead link
that also drops admin navigation into the worker UI.

**Change:** `src/components/phil/JobMaterialsPanel.tsx` — removed the dead
admin link. The honest under-construction copy now points the worker to the
real next step ("Phone or text your PM — they'll order it through the office").
No link a field worker can't use; still no fake stock counts or request buttons.

---

## What was deferred (and why)

- **Job action hub / "what do I do now?"** — highest-value structural change,
  but it must edit `PhilJobDetail.tsx`, owned by open PR #94. Deferred to avoid
  a collision; do it once #94 lands.
- **Hours / rejected-hours copy clarity** (e.g. "sent for approval" reading as
  done) — those files are hours-sensitive and in #93's territory. Left alone.
- **Capture "Retake" tap target** (`size="sm"` = 32px, < 44px) and capture copy
  — capture is a hard "don't change behaviour" zone; the tap-target nit is low
  value and noted for a later capture-owned pass.
- **`statsPct` / progress %** on the list — deliberately omitted to avoid any
  "% complete" framing.
- Renaming ITP → "Checks" app-wide — out of scope; matched the existing app
  term ("ITPs") for consistency instead.

---

## Tests & validation

- `philJobsListSignals.test.ts` (7) — pluralisation, zero-omission, absent-stats
  → empty (no fabrication), invalid counts ignored, summary join.
- `PhilJobsList.render.test.tsx` (extended) — chips render with stats; **no**
  chips and unchanged row when stats absent; aria summary folded in.
- `JobMaterialsPanel.render.test.tsx` (new) — honest UC stub, **no** `/admin`
  link, no anchor at all, points to PM.

Run green: `typecheck`, `lint`, `test:unit` (1351), `test:api` (185), `build`,
`check:smoke-list` (11), and the route/shell guards (`check:admin-shell`,
`check:production-shell`, `check:route-ownership`, `check:shell-contract`,
`check:sw-cache-version`, `smoke:admin-routes`). Preview Smoke was **not**
dispatched. No time-entry write change, no `jobId:null`, no capture change,
no admin controls leaked, no production/preview data touched.
