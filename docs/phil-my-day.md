# Phil · My Day

`/phil/my-day` implements the approved final **Phil My Day** design (from the
Claude design handoff `Phil My Day.html` + `phil/myday-v2.css`) — a
payroll-focused home that opens straight into the week timesheet.

> Supersedes the interim "A · Right Now" job-hero layout. In the design session
> the user removed the job hero ("this is bad remove") and crew review; the job
> now lives only in the greeting subtitle.

## Layout (top → bottom)

1. **Greeting** — a **navy header band** (full-bleed, flush under the shell
   app-bar so the top reads as one navy header, matching the design's `.md-hdr`):
   `Arvo, {firstName}` (time-of-day computed in `BUSINESS_TIMEZONE`: Morning /
   Arvo / Evening) + a mono subtitle `{weekday day month} · on {job}` + a yellow
   **initials avatar**. The name rides on the session cookie (`session.name`, no
   fetch); the "on {job}" line shows only when there's exactly one assigned job
   (no active-job signal exists, so we never guess).
2. **Rejected-hours alert** — the most recent rejected entry with "Fix &
   resubmit". The only real "needs you" signal on this surface; kept at the top
   (a rejected day is about the hours flow right here), not the design's bottom
   slot.
3. **This week** — `PhilWeekStrip`: a Mon–Sun payroll strip with per-day hours,
   a week total, and a "Today not logged" flag. Pure logic in `philWeek.ts`.
   The strip is also a **directory**: today + every past day is a link to
   `/phil/my-day?fixDate=<date>` (the same deep-link the "Hours rejected" push
   uses), so a missed day is one tap from the hours form preselected to that
   date — no scrolling to the date chip and picking the day by hand. A rejected
   day auto-opens fix-and-resubmit; future days are inert (nothing to act on).
   The log action's title flips to "Log hours for this day" when the selected
   date isn't today.
   **Soft-navigation contract:** the page keys `LogHoursSheet` by `fixDate`
   (`key={fixDate ?? "no-fix-date"}`) so a SAME-PAGE client-side navigation
   (strip tap / Needs You item while already on My Day) remounts the sheet and
   its `useState` initialisers re-seed from the new date. Without the key the
   URL changes but the form silently keeps the old date — the original v1 bug,
   guarded by the strip-tap smoke test in `phil.spec.ts`.
4. **Log today's hours** — `LogHoursSheet`, restyled to the design's **compact
   yellow action** (`md-act.log`) instead of a screen-filling navy block. There
   is **no form-card wrapper** — the elements sit as standalone bars on the page
   surface, like the design's action bars: a quiet inline job line (`{job}` +
   "Assigned job" pill, not a boxed field — the job already headlines the
   greeting), the yellow "Log today's hours" button, a compact "Day" date **chip**,
   and a quiet "Custom hours or a note" disclosure. **Behaviour is unchanged** —
   the same submit handler, disabled gating, "Submit Standard day" aria-label and
   `{id,name}` payload; only the presentation moved. The redundant "No entry yet"
   card was dropped (the week strip already shows today's state).
   - **Smoke-required, kept visible:** the date `input[type=date]` (the
     field-readiness helper fills it) and the "Assigned job" pill text.
5. **Heads-up note** — a quiet honest line about one-allocation-per-submission
   (replaces the loud yellow/black under-construction hazard tape, which was not
   in the design).

The centre **Capture shutter** stays on the shell (`PhilTabBar`) — present on
every Phil screen.

## Week strip states (`philWeek.ts` — all real)

| State | Meaning |
|---|---|
| `logged` | a real entry exists for that date (its hours are shown) |
| `today` | the cell is today (prompts "log now" when no entry yet) |
| `miss` | a **past weekday** with no entry — a soft "you haven't logged this" nudge, never a claim of wrongdoing |
| `off` | a weekend with no entry |
| `upcoming` | a future weekday in this week (nothing to show yet) |

Every cell is derived from the worker's real time entries + the calendar.
Nothing is fabricated. The rolling 7-day window the page already fetches always
covers this week's Monday→today, so no extra fetch is needed.

## Honesty gate — design elements NOT shipped (would be fake state)

| Design element | Why omitted |
|---|---|
| **"Submit timesheet"** (weekly batch → office) | Logging a day already creates it as `submitted` (`buildStandardDayPayload`). There is **no weekly batch-submit workflow** — the week helpers are for the *admin* approval rollup. A "Submit timesheet" button would do nothing real. |
| **"Needs you" — "Open RFI"** | RFIs don't exist in Phil (no route, no data). |
| **"Needs you" — "L2 fix is held"** | No "holds" data source feeding a cross-job My Day list. |
| **"Needs you" — "ITP ready to mark · Mark"** | No My-Day-level aggregation of "your ITPs ready to mark". ITP marking lives on the job screen. |
| **Compact job strip + "9 on site · 7:00 start · 19° clear"** | The user removed it in the design session; and start-time / weather aren't wired (weather has no integration). |

These are real product gaps (a weekly-submit workflow, an RFI surface, a
cross-job needs-you feed) — backend/feature work, not UI. They can be wired
later; until then My Day shows only what's real.

## Styling — visual parity with the design

The design's "feel" comes from two things the app's global tokens don't provide:
**JetBrains Mono microcopy** (every label / range / status word) and **filled,
tinted week-cell backgrounds**. The app's global palette is cool-slate; the
prototype is warm navy + soft-gold with tinted `*-bg` state colours.

Rather than restyle the global tokens (which would touch all of Phil + admin),
the parity lives in a **scoped CSS module** — `src/components/phil/myDay.module.css`
— the same isolation pattern as `src/app/v2/login/login.module.css`:

- **JetBrains Mono** is loaded via `next/font` in the page and its CSS variable
  is applied **only to the My Day wrapper**, so it never restyles the rest of
  the app. (Inter / Inter Tight already load globally via `next/font`.)
- The two genuinely-missing values — the tinted state backgrounds
  (`--md-green-bg` etc., from the prototype `ops-base.css`) and the mono face —
  live scoped in the module. Everything else reuses the global brand tokens
  (`--brand-navy`, `--accent-yellow`, `--text`, `--border`) so My Day stays
  consistent with the shell and the unchanged `LogHoursSheet`.
- `PhilWeekStrip` renders the design's filled cells (green logged · yellow-ring
  today · dashed amber `miss` · faded `off`) at the design's exact dimensions
  (46px cells, 9px radius, mono 7–8.5px labels), and the greeting gets the
  Inter-Tight name + mono subtitle + yellow initials avatar.

**Known divergence (honest):** the hours area is the unchanged `LogHoursSheet`
(its own navy "Standard day" card), not restyled to the design's compact
"Log today's hours" button — it's the real, tested write surface and restyling
its internals is out of scope. Yellow uses the app token `#ffcc00` (vs the
design's softer `#f5d020`) to stay consistent with the shell's Capture FAB.

## Tests

- `philWeek.test.ts` — the week logic: Mon–Sun states, total, today
  not/logged, ISO week number, the `miss` nudge, and **no fabricated hours**.
- `PhilWeekStrip.render.test.tsx` — structure smoke: the seven weekday labels,
  real range/total, the honest "log now" prompt, the history link, and the
  day-cell directory links (today + past days link to `?fixDate=<date>`,
  future days don't).
- The hours flow + shell + Capture FAB stay covered by Preview Smoke
  (`phil.spec.ts`, `field-readiness.spec.ts`); their selectors (`phil-shell`,
  "Submit Standard day", the job radiogroup, the Capture FAB) are untouched.
