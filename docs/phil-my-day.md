# Phil · My Day

`/phil/my-day` implements the approved final **Phil My Day** design (from the
Claude design handoff `Phil My Day.html` + `phil/myday-v2.css`) — a
payroll-focused home that opens straight into the week timesheet.

> Supersedes the interim "A · Right Now" job-hero layout. In the design session
> the user removed the job hero ("this is bad remove") and crew review; the job
> now lives only in the greeting subtitle.

## Layout (top → bottom)

1. **Greeting** — `Arvo, {firstName}` (time-of-day computed in
   `BUSINESS_TIMEZONE`: Morning / Arvo / Evening) + `{weekday day month} · on
   {job}`. The name rides on the session cookie (`session.name`, no fetch); the
   "on {job}" line shows only when there's exactly one assigned job (no
   active-job signal exists, so we never guess). Rendered on warm paper, not a
   second navy band (the shell app-bar is the only navy).
2. **Rejected-hours alert** — the most recent rejected entry with "Fix &
   resubmit". The only real "needs you" signal on this surface; kept at the top
   (a rejected day is about the hours flow right here), not the design's bottom
   slot.
3. **This week** — `PhilWeekStrip`: a Mon–Sun payroll strip with per-day hours,
   a week total, and a "Today not logged" flag. Pure logic in `philWeek.ts`.
4. **Log today's hours** — the unchanged `LogHoursSheet` (preselected via
   `initialJobId` when there's one job). Its client payload and the hours
   write/attribution path are byte-for-byte unchanged.
5. **Under construction** — the unchanged multi-job allocation note.

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
  real range/total, the honest "log now" prompt, and the history link.
- The hours flow + shell + Capture FAB stay covered by Preview Smoke
  (`phil.spec.ts`, `field-readiness.spec.ts`); their selectors (`phil-shell`,
  "Submit Standard day", the job radiogroup, the Capture FAB) are untouched.
