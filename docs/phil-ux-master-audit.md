# Phil UX Master Audit — the Fisher-Price bar

> **HISTORICAL RECORD — EVIDENCE (frozen).** The measured facts herein remain valid evidence (level 2 of the hierarchy in `docs/phil-field-validation.md`); its *recommendations* were re-classified by `docs/phil-constitution-ratification.md` (notably: the anti-#133 ruling was retracted to a criterion). Cite the package, not this document, for current direction.

**Date:** 2026-06-12 · **Audited against:** `origin/main @ a7809de` (post-cutover #376, post-#418 — the whole crew now lands on Phil) · **Method:** full source-level desk audit (every Phil screen component, verbatim copy, Tailwind/CSS sizes, WCAG contrast math on real tokens, flow tap-counts) + the cached design bundle. This is the **desk half of [#132](https://github.com/oskar-ott/BuhlOS/issues/132)**; the on-site half (real electrician, real sun, real gloves) still must happen — protocol at the end.

**The bar:** a tired electrician on a 38°C day, dirty hands, 37 unread texts, boss calling, 15 defects — uses Phil without thinking. Zero cognitive load. Fisher-Price simple, Milwaukee tough, enormous power hidden underneath.

---

## 1 · The verdict

**Phil is top-decile field software with a genuinely world-class capture flow — and it is not yet a Fisher-Price toy.** It is currently a very honest, very well-engineered *reading* app. The bones are exceptional: real 44px+ targets almost everywhere, honest empty/error states, no fake numbers, no `alert()`, consequence-copy confirm dialogs, per-point auto-saving checks, a camera that opens on the same tap. Most trade software never gets within a kilometre of this.

But against the stated bar, Phil fails in five concentrated, fixable ways:

1. **It whispers when it should shout.** My Day alone uses **15 distinct font sizes — eleven of them 10px or smaller, one literally 7px**. The most important warning a worker can see ("Today not logged") is ~9px amber. Sunlight + safety glasses + 50-year-old eyes = invisible.
2. **The home screen doesn't answer "what now?"** My Day is a stack of up to 7 cards — including a *permanent apology about a backlog item* — in a different visual dialect (JetBrains Mono, warm gold/navy) from the rest of the app (Inter, cool slate). It shows everything; it decides nothing.
3. **The job page demotes its own brain.** A 14-section, ~3.5-screen, 40–50-element scroll, where the ranked decision engine — the thing that makes Phil "a good leading hand" — sits in a card renamed **"Quick actions"** (deliberately, to avoid a "digital-foreman feel"). That rename surrenders the product's core promise: *tell me what to do*.
4. **Zero offline.** Post-cutover, Phil is the crew's only app, installs as a PWA, and renders nothing without signal. A PWA with no offline is a promise the app breaks daily on real sites. The failure copy is honest — but honesty about failure isn't resilience.
5. **The first five minutes are the weakest.** A worker who signs in with a username + 4-digit PIN faces a form labelled for office email+password, then an optional **nine-screen** onboarding tour. The brief is right: users skip instructions. The product mostly doesn't need the tour — so the tour is an admission the login isn't self-evident.

Fix those five and Phil isn't "good for construction software." It's just good — Uber-Driver good, Apple-Camera good.

---

## 2 · Test scorecard

| Test | My Day | Jobs list | Job page | Capture | Hours sheet | Gear | ITP record | Plans |
|---|---|---|---|---|---|---|---|---|
| **3-second** (where am I / what do I do) | ⚠️ Partial — log button is clear; 7 cards compete | ✅ | ❌ 14 sections; primary action not visually dominant | ✅ camera *is* the screen | ✅ one huge yellow button | ✅ | ✅ | ✅ |
| **10-foot** (primary action visible at arm's length+) | ⚠️ button yes; status words no (7–9.5px) | ✅ | ❌ "Quick actions" card blends into the stack | ✅ | ✅ 56px yellow | ✅ | ⚠️ per-point Save is small-ish | ✅ |
| **Glove** (≥44–48px, no precision) | ⚠️ 48px radios ✓; date input is native-small | ✅ 88px rows | ❌ **Mark done = 40px**; contacts Call/Text ≈ 40px | ⚠️ tray remove “×” needs hit-area check | ✅ chips 44px-ish, button 56px | ✅ + confirm dialogs | ✅ 48–64px | ✅ 64px rows |
| **Sunlight** (contrast × size) | ❌ 8.5–9.5px muted/amber microtype; `opacity-50` day cells | ✅ | ⚠️ text-[10px]/[11px] labels; 1.23:1 card borders | ✅ | ⚠️ 9px subtitle on the main button | ✅ | ✅ | ✅ |
| **Walking / one-thumb** | ✅ actions low, header high | ✅ | ⚠️ 3.5 screens of scroll; anchors help | ✅ bottom-sheet | ✅ | ✅ | ✅ | ✅ |
| **Interruption** (resume in 1s) | ⚠️ note text lost on nav (acceptable — 2-tap flow) | ✅ | ⚠️ selected area/scroll lost on back | ✅ **photos survive close/reopen** | ✅ idempotent (409 explains itself) | ✅ | ✅ per-point persistence | ✅ |
| **Stress** (reduces it?) | ⚠️ needs-you is calm ✓; card pile isn't | ✅ | ⚠️ wall of sections = "where do I even start" | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Apple test** (nothing removable) | ❌ defer-note, leave link, week-strip detail | ✅ | ❌ Tags? Documents always? Site always? | ✅ | ⚠️ "More options" could hide deeper | ⚠️ 5 buttons/asset | ✅ | ✅ |
| **Zero-training** | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Offline** | ❌ | ❌ | ❌ | ⚠️ in-flight resilience only | ❌ | ❌ | ❌ | ❌ |

---

## 3 · The seven findings that matter (cross-cutting, with evidence)

### F1 — The type system is the #1 sunlight failure
`myDay.module.css` font sizes in use: **22, 18×2, 15.5, 14×4, 13, 12.5×2, 11.5, 11, 10, 9.5×2, 9×3, 8.5×4, 7**. Fifteen sizes; eleven instances ≤10px. Across all Phil components: ~100 `text-xs` + dozens of `text-[11px]`/`text-[10px]`. Contrast *ratios* are mostly excellent (body 17.85:1, navy-on-yellow CTA 10.98:1, muted 7.58:1) — but ratio doesn't save 8.5px outdoors. The week-strip's "off/upcoming" cells additionally sit at `opacity: 0.5`, and card borders measure **1.23:1** (invisible in glare; cards must separate by spacing/elevation, not hairlines).
**Fix:** a hard floor. Glanceable info ≥14px; nothing interactive or status-bearing below 12px; collapse the app to **4 sizes** (22 hero / 16 body / 14 secondary / 12 caption-only). Delete the 7px style today.

### F2 — My Day shows everything and decides nothing
Stack: greeting → week strip (7 cells × 3 data each + header + footer link) → log sheet (status + job + button + date + disclosure) → leave link → needs-you feed → **permanent "Heads up: split-day logging is on the backlog" note**. Plus a *different design language* (Mono + gold) from every other screen — Phil literally changes skin between tabs, the exact "stitched together" feeling the product forbids.
A backlog apology is admin furniture in the worker's living room. The week strip duplicates what `/phil/hours` does. Leave/licences/inductions are records, not "today."
**Fix:** see Big Call 1 — one hero card that answers "what now," one glance row, needs-you, nothing else.

### F3 — The job page buried its own foreman
Render order: hero → **"Quick actions"** → Needs attention → Work to do → Capture → Issues → Checks → Test and tag → Plans → Documents → Site details → Who to call → Not connected yet. ~14 sections, ~2100px (~3.5 screens), 40–50 interactive elements, 9 font sizes, 13+ colour tokens. The command panel is architecturally brilliant (pure ranked model, honest limitations) but visually it's *one more card*, and its title was deliberately reframed from "Next on this job" to "Quick actions" to avoid a "digital-foreman feel."
**That reframe is backwards.** Phil's mission statement *is* the good leading hand: "tell me what to do, show what matters." A ranked decision engine labelled like a shortcuts tray gets skimmed past. And "Needs attention" sitting as a *separate sibling* under it is the unresolved duality #132 already flagged — two cards both claiming "look here first."
**Fix:** Big Call 2 — the command panel *becomes the screen's hero*, absorbs attention items, and the reference sections collapse.

### F4 — Phil is a reading app
Nearly every section carries an explainer sentence ("Things on site that need fixing. Tap Report snag to raise one." · "Your recent evidence on this job. Tap a card for the full photo and status." · "The job's key people — tap to ring or text."). Individually charming; collectively a wall. The users *skip paragraphs* — so the paragraphs are decoration that costs scan time.
**Fix:** explainers appear only in empty states (where they teach) and vanish once real content exists. A populated list explains itself.

### F5 — No offline, and the app now has no fallback
`sw.js` is push-only (correct post-cutover choice), no route/data caching, no queued writes. Capture's *in-flight* story is excellent (failed photos stay in the tray with bytes, retry button, partial-save accounting) — but an app-kill loses the tray, and every screen is blank without signal. Basements, lift shafts, tilt-slab cores: this is where electricians work.
**Fix:** [#135](https://github.com/oskar-ott/BuhlOS/issues/135) (read cache: job home, plans, today's tasks) + [#143](https://github.com/oskar-ott/BuhlOS/issues/143) (capture outbox in IndexedDB) + [#139](https://github.com/oskar-ott/BuhlOS/issues/139) (honest failure states) are no longer "Phil hardening" — post-cutover they are **the** adoption risk. Treat as P0-adjacent.

### F6 — First-run is the weakest five minutes
Workers authenticate with **username + 4-digit PIN** (set in the invite flow), but `/v2/login` presents office-flavoured fields (the "Work email" copy is a frozen test hook from the desktop design). Then an optional **9-screen** tour (Welcome → Identity → Hours → Gear → Jobs → Job Interface → Site Data → Permissions → Ready). The brief's user "skips instructions, taps the first obvious button" — a 9-step tour exists *because* screens still need explaining; it will be skipped, and the one thing that must be unmistakable (how do I get in?) speaks the wrong dialect.
**Fix:** a worker-mode login (big "Name + PIN" with a numeric keypad feel), and cut the tour to **3 cards max** (Log hours · Capture · Your jobs) — or delete it once Big Calls 1–2 land and the UI self-teaches. *(Needs issue — see §7.)*

### F7 — Glove misses on the highest-frequency controls
`Mark done` — likely the single most-tapped button in the product — is `min-h-[40px]` with `text-xs`. Contacts "Call"/"Text" compute to ~40px. Tray remove "×" hit-area unverified. Everything else respects 44px+ (rows 52–88px — genuinely great).
**Fix:** 48px floor on Mark done / Call / Text / tray-remove. One-line class changes.

---

## 4 · Screen-by-screen

### 4.1 My Day (`/phil/my-day`)
**Gets right:** named-day quick log ("Log today's hours" + standard day 7h36 = 1–2 taps, best-in-class); tappable week-strip days deep-linking `?fixDate=`; needs-you feed limited to *real* items (rejected hours, assigned snags, calibrations); manifest shortcut "Log today's hours"; skeletons; idempotent submits (409 explains itself).
**Friction:** F1+F2 above; date input is a native `type=date` (small, fiddly, office-flavoured) when 95% of use is "today" (already default) or "tap the day on the strip"; "More options → Custom hours" opens a *modal* for what eight chips already do inline in the resubmit sheet; success banner auto-dismisses in 6s (fine) but the page still shows seven cards after success rather than a calm "done" state.
**Redesign sketch (Big Call 1):**
```
┌──────────────────────────────┐
│ Arvo, Sam        Thu 12 Jun  │   16px, one line, no card
│──────────────────────────────│
│  ████  LOG TODAY  7h 36m ████│   ← ONE hero, 64px, yellow.
│  on 100 Arthur St            │     States: log → logged ✓ →
│                              │     fix rejected → all clear 🎉
│  M T W T F   31.2h this week │   ← glance row, 14px, tap → hours
│──────────────────────────────│
│  NEEDS YOU (2)               │   ← only if real items
│  ● Tue hours — fix           │
│  ● Switchboard snag          │
└──────────────────────────────┘
```
Kill: defer note (move the one-allocation rule into the sheet's job picker as a single line), leave link (→ More tab), the Mono/gold dialect (one design language app-wide). Expected: 7 cards → 3; zero sub-12px text; the screen *answers* instead of *listing*.

### 4.2 Jobs list (`/phil/jobs`)
**Gets right:** 88px rows, status pill + open-work chips + last-activity, graceful stat degradation.
**Friction:** **API order, no intelligence** — the job you logged hours on yesterday should be first (today's-job-first sort, or a pinned "Your job today" header card); chips at `text-[11px]`.
**Fix:** sort by (today's attribution → last activity), bump chips to 12px+. One-job workers should skip this screen entirely — tab tap could land directly on the job (list only for >1).

### 4.3 Job page (`/phil/jobs/[jobId]`) — the make-or-break
**Gets right:** the command model itself (ranked, honest, never fakes counts); attention strip capped at 3; work-tree counts chips only when >0; in-page anchors; context carry-through into snag/capture sheets; tap-to-call (#412); "Not connected yet" honesty.
**Friction:** F3+F4; task completion is deep (tap area → auto-scroll → stage pill → find task → 40px Mark done ≈ 3–4 taps + visual search, ×15/day); selected area + scroll position lost on back-nav (interruption fail); **section creep is back** — "Test and tag" and "Who to call" have re-joined an already-long stack (the #98/#99 simplification arc is being eroded one good feature at a time); Documents renders five rows of register metadata a worker rarely needs (Plans is the worker-shaped door).
**Redesign sketch (Big Call 2):**
```
┌──────────────────────────────┐
│ ← Jobs   100 Arthur St  ●Act │  compact hero
│──────────────────────────────│
│  NOW ▸ Continue East Gym     │  ← hero card = command model.
│        rough-in · 3 to go    │    Blockers render HERE (red),
│  ▸ Check: switchboard 2/6    │    not in a sibling strip.
│  ▸ Fix Tuesday's hours       │    Tap = deep-link incl. area+stage.
│──────────────────────────────│
│  [ 📷 Capture ]  [ ⚠ Issue ] │  two fat ambient buttons, 56px
│──────────────────────────────│
│  Work to do            8/30 ─┤  L2: collapsed accordions w/ counts
│  Issues (3) · Checks (2)    ─┤
│  Plans · Docs · Tags        ─┤
│  Site & contacts            ─┤  L3: one reference group
└──────────────────────────────┘
```
Principles: **L1 = one next thing** (command model, absorbing attention), **L2 = the work**, **L3 = reference, collapsed**. "Quick actions" → **"Now"** (or "Next on this job" restored): short, imperative, foreman-true. Remember last-opened area per job (localStorage) so back-nav resumes. This is *also* my read on [#133](https://github.com/oskar-ott/BuhlOS/issues/133): **don't add a 5-tab job interface** — tabs hide state and multiply navigation for gloved thumbs; collapse-by-default progressive disclosure on one scroll keeps interruption-recovery (everything findable by thumb-drag) while killing the wall. Let the field test confirm.

### 4.4 Capture — the crown jewel (protect it)
Same-tap OS camera from the FAB (iOS correctly handled), tray ≤10 with per-photo resize status, photos **survive accidental close**, sequential upload with per-photo progress ("Saving photo 3 of 7…"), partial-failure honesty ("4 saved · 2 failed — the failed ones are still here" + retry, bytes preserved), the office path in perfect tradie English ("Not job related — a fine, damaged gear, paperwork" / "e.g. Parking fine on the ute"), optional context collapsed by default with a *permissioned skip* ("a photo on the job is enough"). **This flow already passes the Apple test.**
Remaining friction: FAB from My Day forces a job pick every time → default to **last-captured/attributed job** with one-tap change ([#145](https://github.com/oskar-ott/BuhlOS/issues/145)-adjacent); app-kill loses the tray (→ [#143](https://github.com/oskar-ott/BuhlOS/issues/143) outbox); tray "×" hit-area check; voice note ([#147](https://github.com/oskar-ott/BuhlOS/issues/147)) belongs here eventually.

### 4.5 Hours sheet + history
**Gets right:** the 56px yellow button with the standard day; chips 4–10h; honest week summary verdicts; rejected→resubmit pre-filled with the original job; plain status words ("Waiting for approval", "Rejected — fix needed", "Why it bounced back").
**Friction:** the button subtitle is 9px; "Custom hours" detours through a modal; the date `input` is the only office-control on the screen; resubmit hides behind a `sm` "Fix rejected hours" button when it's the #1 needs-you action (on /hours it should arrive expanded when deep-linked).
**Fix:** chips inline under "More options" (kill modal); date selection = the week strip (it already is) + a "different day" link; subtitle 12px+.

### 4.6 Gear
**Gets right:** handover handshake copy ("It stays YOUR responsibility until they accept — declines and 5-day timeouts hand it straight back" — superb), consequence-stating confirm dialogs (the correct glove-safety pattern), calibration warnings with dates, honest UC for QR.
**Friction:** up to 5 buttons per asset card (button soup at scale; fine ≤3 assets, noisy at 10); "Confirm in hand" ("Got it") is low-value relative to its prominence.
**Fix:** keep Return + Hand over visible; fold Damaged/Missing/Got-it behind one "Condition…" secondary that opens a 3-option sheet (still big buttons, still confirm dialogs). QR scan stays the epic answer ([#303](https://github.com/oskar-ott/BuhlOS/issues/303)).

### 4.7 ITP recording
**Gets right:** page-based per-point persistence (interruption-proof), camera-first photo points with auto-save, pass-criterion hints ("Pass: 100–120 kPa"), witness-role lockouts with reasons, decimal keypad.
**Friction:** value/note/signoff points each need an explicit "Save" → 9–12 taps for a 5-point check.
**Fix:** auto-save on change/blur with a quiet "Saved ✓" pill (photo points already do this) → ~5 taps + typing. Keep "Update" affordance for edits.

### 4.8 Plans
**Gets right:** current-revisions-only (a worker can *never* build off a superseded sheet — post-#418 this is a safety feature), the all-superseded message tells them to call the PM.
**Friction:** opens in a new tab via the OS viewer — workable, but no pinch-zoom in-app, no offline ([#135](https://github.com/oskar-ott/BuhlOS/issues/135) should cache current sheets per assigned job), thumbnails absent (titles only — a drawing is a *picture*; show it).
**Fix:** thumbnail grid now; cached sheets with the offline read pass.

### 4.9 More / onboarding / login
More tab is honest and thin ✓ (sign-out, push opt-in, replay tour). Onboarding: 9 screens → 3 (see F6). Login: worker-mode PIN entry (F6, needs issue). Invite flow's 3-step PIN setup is good.

---

## 5 · Benchmarks — where Phil loses today, specifically

| Benchmark | Their trick | Phil today | Verdict |
|---|---|---|---|
| **iPhone Camera** | The viewfinder *is* the UI; shutter unmissable | Capture FAB → same-tap camera | **Phil matches.** Genuinely. |
| **Uber Driver** | One card: the next job. Accept/decline. Everything else hidden | My Day = 7 cards; job page = 14 sections | Phil loses — adopt "one next thing" (Big Calls 1–2) |
| **Things 3** | Today list is sacred; nothing else leaks in | Leave/licences/backlog-notes leak into Today | Phil loses — Today is for today |
| **Google Maps** | Glanceable at speed: one number, one arrow, huge | 7–9.5px status words carry the state | Phil loses — the *state* must be the big thing |
| **Toyota dashboard** | ~4 type sizes, idiot lights, zero prose | 15 sizes on one screen + explainer sentences | Phil loses — type amnesty + empty-state-only prose |
| **Milwaukee Packout** | Modules click together; one system language | My Day in Mono/gold vs app in Inter/slate | Phil loses — one dialect |
| **ATM / McDonald's kiosk** | Big targets, forced linear choice, no recovery needed | Capture + Hours yes; job page no | Mixed |
| **Makita charger** | State = one colour at 3 metres | Week strip cells at 46px w/ 8.5px words + 50% opacity | Phil loses — colour+size must carry state |

---

## 6 · The Big Calls (radical, in order of conviction)

1. **My Day becomes a state machine, not a feed** (sketch §4.1). One hero: *Log today → Logged ✓ → Fix Tuesday → All clear.* Week glance row. Needs-you. Nothing else. Kill the defer note today (5-minute change); fold the one-allocation rule into the sheet.
2. **The job page leads with "Now"** (sketch §4.3). Command panel = hero; absorbs the attention strip (resolves the #132 duality: a blocker *is* the top-ranked item, rendered red); primary action deep-links to area+stage; L2 work accordions; L3 reference collapsed. Rename "Quick actions" → **"Now"**. My #133 verdict: **no tab bar inside the job** — progressive disclosure on one scroll; validate on site.
3. **Type amnesty**: 4 sizes, 14px glanceable floor, 12px absolute floor, kill `opacity-50` state styling, kill the Mono/gold dialect. Mostly CSS — the cheapest big win in the audit.
4. **Offline becomes P0**: read cache for assigned jobs + current plans ([#135](https://github.com/oskar-ott/BuhlOS/issues/135)), capture outbox ([#143](https://github.com/oskar-ott/BuhlOS/issues/143)), a global "No signal — showing saved copy" banner pattern ([#139](https://github.com/oskar-ott/BuhlOS/issues/139)). The cutover made this existential.
5. **Worker-grade entry**: PIN-first login + 3-card tour (F6).
6. **One-job fast paths everywhere**: capture defaults to last job; jobs tab deep-lands when only one; "Continue where you left off" remembered per job.

## 7 · Missing features (mapped to backlog; ✗ = needs issue)

| Capability | Status |
|---|---|
| Offline read cache / capture queue / honest failures | [#135](https://github.com/oskar-ott/BuhlOS/issues/135) / [#143](https://github.com/oskar-ott/BuhlOS/issues/143) / [#139](https://github.com/oskar-ott/BuhlOS/issues/139) — raise priority post-cutover |
| Daily briefing ("what am I doing today") | [#136](https://github.com/oskar-ott/BuhlOS/issues/136) — implement *as* Big Call 1, not as another card |
| Scope context on the task | [#368](https://github.com/oskar-ott/BuhlOS/issues/368) (P0, already chartered) |
| Perf budget (4G cold start) | [#138](https://github.com/oskar-ott/BuhlOS/issues/138) |
| Reachability/glove/sunlight formal pass | [#141](https://github.com/oskar-ott/BuhlOS/issues/141) — this audit is its desk input |
| In-job search · recents/favourites · long-press · voice · camera niceties · gestures | [#144](https://github.com/oskar-ott/BuhlOS/issues/144) [#145](https://github.com/oskar-ott/BuhlOS/issues/145) [#146](https://github.com/oskar-ott/BuhlOS/issues/146) [#147](https://github.com/oskar-ott/BuhlOS/issues/147) [#148](https://github.com/oskar-ott/BuhlOS/issues/148) [#149](https://github.com/oskar-ott/BuhlOS/issues/149) |
| Tabbed job interface decision | [#133](https://github.com/oskar-ott/BuhlOS/issues/133) — this audit recommends **against**; field-verify |
| **Worker-mode login (name + PIN keypad)** | ✗ needs issue (`phil: worker-grade sign-in`) |
| **My Day hero state machine** (the Big Call 1 redesign) | ✗ needs issue (could absorb #136) |
| **Type-scale amnesty + one design dialect** | ✗ needs issue (`phil: legibility floor — 4 sizes, 12px minimum`) |
| **Resume-last-area memory on the job page** | ✗ needs issue |
| **"Who else is on this job today" (crew visibility)** | ✗ needs issue (closest is admin-side [#337](https://github.com/oskar-ott/BuhlOS/issues/337)) |
| **All-clear / week-done win state** (calm gamification) | ✗ needs issue (P3) |
| Haptic confirmation on submit/mark-done | ✗ minor; fold into polish |

## 8 · Do NOT touch (already at or above the bar)

Capture's destination model + failure recovery + verbatim copy · the command **model** (`buildPhilJobCommandModel` — UI changes, model stays) · gear confirm-dialog pattern + handover copy · per-point ITP persistence · honest empty states · the 409/resubmit hours loop · "Capture evidence" / "Report snag" strings (frozen test hooks) · 88px job rows · current-revisions-only plans rule.

## 9 · Priority plan

**This week (copy + CSS, near-zero risk):** delete the My Day defer note & leave-link card · kill 7–10px styles, bump status words to ≥14px, drop `opacity-50` states · "Quick actions" → "Now" · 48px floor on Mark done / Call / Text / tray-× · explainer sentences → empty-states only · success-state calm-down on My Day.
**Next (structural, 1–2 weeks):** Big Call 1 (My Day hero state machine, absorbing #136) · Big Call 2 phase 1 (attention merges into command panel; L3 reference collapses; resume-last-area) · jobs-list today-first sort + one-job deep-land · ITP auto-save · capture last-job default · gear condition sheet.
**Big bets (charter now, build next):** offline trio (#135/#143/#139) · worker-mode login · #133 decision after the on-site test · thumbnail/zoomable cached plans.

**Expected impact (honest estimates):** task completion 4 taps→2 (×15/day ≈ 1–2 min + the "where was I" cost gone) · job orientation ~15s→~3s per open (×20/day ≈ 4 min) · capture −2 taps × 10–20/day · hours already optimal (don't touch the 2-tap log) · sunlight legibility from "squint" to "glance" — unmeasurable and the most important line in this document. Adoption risk concentrates in offline: every blank screen in a basement teaches the crew to keep using texts.

## 10 · On-site protocol for #132 (the half a desk audit can't do)

One electrician, their own phone, midday sun, gloves on, no coaching. Tasks: (1) open the app cold and say aloud what they'd do first; (2) log a standard day; (3) find what to do next on their job and do one task; (4) photograph a defect and send it to the right place; (5) fix a rejected day (seed one); (6) from 2 metres, read today's status off the home screen; (7) lift-shaft/airplane-mode minute — narrate what they believe happened. Record: time-to-first-action, wrong taps, every squint/phone-raise, every "what does this mean," and the one question that matters at the end: *"would you use this tomorrow without being told to?"* Findings gate #133 and the Big Calls.

---
*Compiled by the wiki/audit session. Facts verified in source at `a7809de`; verbatim strings preserved; contrast computed from `src/styles/tokens.css`. Brutality calibrated to the brief; admiration where earned is also evidence.*
