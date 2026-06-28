# Phil 4G cold-start + job-home performance budget (#138)

Field phones on 4G with flaky signal pay full price for every byte and every
round trip. A multi-second job screen reads as "the app is broken" and erodes
make-or-break field trust. This doc sets the **budget** Phil's two hot paths
must hold, and the **measurement methodology** that produces the numbers — so a
regression is caught against a written line, not a vibe.

It does **not** describe a new fetch architecture. The fetch-sequencing work this
issue originally scoped already shipped (see "What already shipped"); this doc is
the budget + methodology + the one remaining image-weight fix that landed with it.

---

## Scope: the two hot paths

| Path | Definition (what we measure) |
| --- | --- |
| **Cold start** | PWA launch → My Day **interactive** (`/phil/my-day`). The worker taps the home-screen icon at the ute; the clock stops when the day's tiles are on screen and tappable. |
| **Job home** | Tap a job → **content** (`/phil/jobs/[jobId]`). The clock stops when the job's structure (the LCP element — the job header + task/stage spine) has painted. |

Both are measured on the deployed **preview**, never localhost: `next dev` cannot
run the `api/*.js` functions the pages read from (repo rule — see
`docs/local-verification-limits` / CLAUDE.md), so a local run measures a
different, fake app.

---

## These numbers are the POST-CUTOVER experience — read this first

The budget below describes the app **as it is served by `main` with the streaming
path on**, i.e. the experience a worker gets *after* the cutover to the new Phil
job-detail path. Two things make that distinct from "what a random field phone
shows right now", and the budget must not be mistaken for current field reality:

1. **The fast job-home path is flag-gated.** `/phil/jobs/[jobId]` renders the
   summary-backed shell + streamed detail **only when `FLAG_PHIL_JOBS_SUMMARY_READ`
   is on** (`src/app/phil/jobs/[jobId]/page.tsx`). With the flag off the page
   reverts to the prior single blocking read (byte-identical to pre-flag), which
   is *slower* and is **not** what this budget describes. Measure with the flag in
   the same state as production.
2. **Installed PWAs lag the deploy.** The home-screen shortcut and the cached
   shell on a worker's phone were installed at some earlier point; until the
   service worker updates and the worker re-launches, the bytes on *their* device
   are not the bytes `main` serves today. The budget is the target for the
   freshly-served app, which is what the field converges to — not a claim about
   every installed phone this minute.

So: **this is the budget for the post-cutover, flag-on Phil.** It is the line the
served app must hold; it is not a measurement of the laggiest installed phone in
the field. Re-baseline after the Supabase Phase 1 data-fetch change (it reshapes
the reads these budgets depend on).

---

## The budget

Starting proposal from issue #138, tuned against the baseline once it is captured
on the preview. Until a row's "Measured" column is filled from a preview run
(see methodology), treat the budget as the **target**, not an achieved fact —
this repo does not ship invented numbers (Phil constitution P7).

### Cold start — `/phil/my-day`

| Stage | Budget (Slow 4G, 4× CPU) | Measured (preview, 3-run median) |
| --- | --- | --- |
| TTFB (incl. server-side blob reads) | ≤ 1.5 s | _fill from preview_ |
| Content render (My Day interactive) | ≤ 3.0 s | _fill from preview_ |

### Job home — `/phil/jobs/[jobId]`

| Stage | Budget (Slow 4G, 4× CPU) | Measured (preview, 3-run median) |
| --- | --- | --- |
| TTFB (incl. server-side blob reads) | ≤ 1.5 s | _fill from preview_ |
| Content render (job structure painted) | ≤ 2.5 s | _fill from preview_ |

### Phil route-group first-load JS (from `next build`)

The transferred JS the browser must parse before the route is interactive. Read
from the `next build` route table (the `First Load JS` column) for the Phil
routes; record the worst Phil route here. This is a *static build* number — no
preview or auth needed — so it can be filled at PR time directly from CI's build
step.

| Route | Budget (First Load JS) | Measured (`next build`, this branch) |
| --- | --- | --- |
| `/phil/my-day` | ≤ 180 kB | **170 kB** (11.4 kB route + 103 kB shared) — within budget |
| `/phil/jobs/[jobId]` | ≤ 200 kB | **194 kB** (35 kB route + 103 kB shared) — within budget |

> The First Load JS numbers above are **build-static** (they come from the CI
> `next build` route table — no preview, no auth, no invented value) and were
> read off this branch's build. The Lighthouse rows (TTFB / content render) and
> the image-byte table stay as preview-fill placeholders because they require an
> authed preview run, which can't be faked locally.

> Budgets above are the agreed starting line. Tune them **down** toward the
> measured baseline once captured — never up to excuse a regression without a
> recorded reason.

### Image budget — no full-res images in lists

A list/grid view must never load full-resolution capture photos. Every list
image renders the **thumbnail** (`thumbnailUrl`), falling back to the full image
only when no thumbnail exists. Full resolution is correct **only** in a
single-image, full-screen view (a lightbox / evidence drawer the worker has
explicitly opened).

| Surface | Image source | Status |
| --- | --- | --- |
| Job-home "Today's captures" grid | `thumbnailUrl ?? photoUrl` | **Fixed (#138)** — was full-res `photoUrl` |
| Job photo gallery tiles | `thumbnailUrl ?? url` | Already correct (`PhilPhotosGallery`) |
| Evidence drawer (full-screen, opened) | `photoUrl` (full-res) | Correct — single deliberate image |
| Photo lightbox (full-screen, opened) | `url` (full-res) | Correct — single deliberate image |

**Rule:** any new Phil list/grid that renders a capture image keys off
`thumbnailUrl ?? <full-url>`. `thumbnailUrl` is on `EvidenceItem`
(`EvidenceItemSchema`, `src/domains/evidence/schema.ts`) and is populated by
`api/evidence.js`; it is `null` for legacy captures taken before thumbnailing,
which is exactly why the fallback exists.

---

## Measurement methodology (run this verbatim)

The numbers above must come from this exact procedure. Recording a number without
this procedure makes it un-reproducible and it does not count.

### Device class / throttling preset
- **Tool:** Chrome DevTools **Lighthouse** panel (or `lighthouse` CLI), Mobile
  form factor.
- **Network:** **"Slow 4G"** throttling preset (Lighthouse's default mobile
  throttle: ~150 ms RTT, ~1.6 Mbps down). This approximates flaky regional 4G.
- **CPU:** **4× slowdown** (Lighthouse mobile default). Approximates a mid-range
  Android against the dev machine.
- **Real-hardware check:** verify the headline numbers **once** on an actual
  mid-range Android phone on real 4G (DevTools remote debugging → the same
  preview URL). The emulated preset is the repeatable proxy; the phone is the
  ground truth (field evidence outranks the emulator).

### Target
- The deployed **preview URL** for this PR (Vercel preview). **Not** localhost —
  `next dev` can't run `api/*.js`, so a local Lighthouse run measures a hollow
  app.
- Run with the production flag state for `FLAG_PHIL_JOBS_SUMMARY_READ` (see the
  POST-CUTOVER note). Note the flag state next to the recorded numbers.

### Authed session — how the cookie enters the run
Both paths require a logged-in Phil session; an unauthenticated run just measures
the `/v2/login` redirect. Get the session cookie into Lighthouse one of two ways:

1. **DevTools Lighthouse panel (simplest):** log in to the preview as a field
   user in that Chrome profile first, then open the Lighthouse panel on
   `/phil/my-day` (or the job URL) and run "Analyze page load". The panel reuses
   the tab's existing session cookie. Keep "Clear storage" **ticked** for the
   cold-start run (we want a true cold cache) — the auth cookie survives a
   storage clear because it's an `httpOnly` cookie on the document, re-sent on
   the navigation, not page localStorage.
2. **`lighthouse` CLI:** capture the `SESSION_COOKIE` value from the logged-in
   browser (DevTools → Application → Cookies) and pass it through:
   `lighthouse <preview-url>/phil/my-day --preset=mobile --extra-headers='{"Cookie":"<SESSION_COOKIE>=<value>"}' --only-categories=performance`.

Record **which** method and **which** field user (role) was used, because role
changes what loads (a tradie sees own-captures only; an LH sees more).

### Run count
- **3 runs per path, report the median.** A single Lighthouse run on throttled
  mobile is noisy; the median of 3 is the recorded number. Discard a run with an
  obvious anomaly (a cold lambda, a network blip) and re-run.
- For the PR's repeatability evidence, capture **two independent run-sets** (e.g.
  two separate 3-run medians, ideally a few minutes apart) and show they land in
  the same band. Divergence between the two sets means the measurement isn't
  stable yet — investigate before trusting the number.

### What to read off each run
- **TTFB** → Lighthouse "Time to First Byte" / the Server Response Time audit
  (this is where the server-side blob reads live — the jobs.json monolith read
  is ~3.5 s, the `/api/data` taskState read ~3–5 s; see the comments in
  `src/app/phil/jobs/[jobId]/page.tsx`).
- **Content render** → First Contentful Paint for the shell, Largest Contentful
  Paint for "content painted". For job-home, LCP is the job structure.
- **First Load JS** → not from Lighthouse — read from the `next build` route
  table (CI's build step prints it).
- **Image weight** → DevTools Network tab, filter Img, on the job with photos:
  record total image bytes for the captures grid before vs after the
  `thumbnailUrl` change (see below).

---

## Image-weight evidence (the #138 code change)

The one code change in #138: the job-home "Today's captures" grid
(`src/components/phil/TodaysCapturesStrip.tsx`, `CaptureThumb`) now renders
`src={item.thumbnailUrl ?? item.photoUrl}` instead of the full-res `photoUrl`,
mirroring the existing `PhilPhotosGallery` tile. `loading="lazy"` is kept so
off-screen captures stay off the cold-start budget entirely.

Record on the preview, on a job that has captured photos with thumbnails:

| Metric | Before (full-res) | After (thumbnail) |
| --- | --- | --- |
| Captures-grid image bytes (Network → Img) | _fill from preview_ | _fill from preview_ |

Method: DevTools Network, filter **Img**, hard-reload the job home, sum the
bytes of the capture-grid images (the horizontal "Today's captures" strip).
Compare the branch (after) against `main` (before). The two-independent-run
repeatability evidence (above) applies here too — capture the byte numbers twice
and show they match.

---

## What already shipped (do not re-touch)

The fetch-sequencing refactor #138 originally described is **already in `main`**.
`/phil/jobs/[jobId]` is a single `Promise.all` of the eleven job sub-reads, with
a summary-backed shell painted first behind `<Suspense>` and the slow taskState
read streamed in as a promise:

- **Streaming shell** — summary-backed header paints before the heavy detail
  loads (#682).
- **Job-detail projection** — the cheap jobs-summary read backs the shell (#685,
  `docs/architecture/phil-jobs-summary-projection.md`).
- **Streamed taskState** — the slow `/api/data` overlay is lifted out of the
  blocking wave and streamed into `PhilJobDetail` (#689).

Re-implementing any of this risks regressing the streaming shell and the
fail-soft / error-discard semantics (sub-loaders fail to empty; a
forbidden/not-found open discards them with no side effects). **Out of scope for
this budget.**

---

## Out of scope (explicit future work)

- **A CI perf gate.** This doc is a written budget + a manual, repeatable
  measurement — not an automated regression gate. A Lighthouse-CI / budget-JSON
  gate is deliberately deferred (issue #138 "Future considerations").
- **Service-worker caching.** Repeat-visit speed via the SW read cache is #135's
  territory; do not touch `public/sw.js` from here (coordinate to avoid
  double-touching it).
- **Route-level code splitting** of the Phil bundle, if `First Load JS` blows the
  budget — a follow-up, only if the build numbers demand it.
- **Re-baseline after Supabase Phase 1** — the data-fetch shape changes, so the
  TTFB-side numbers will move and the budget must be re-measured.
