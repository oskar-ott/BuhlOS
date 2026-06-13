# Phil Field Validation Kit — running #132 for real

**Purpose:** execute the Constitution field-validation protocol with actual electricians. This kit operationalises the protocol verbatim — it adds zero philosophy. The facilitator is a human (Oskar or delegate). Claude's role ends at this document and resumes only when the filled sheets come back for compilation into the per-principle ✅/⚠️/❌ report.

**Session pinned against:** production Phil (post-cutover — the crew's real app). ~45 minutes per participant. Phone in *their* hands, outdoors if possible, gloves available.

---

## ⚠️ The one methodological trap — read this twice

This session tests the **Constitution (how workers think)**, *not* the current screens' compliance with it. The desk audit already predicts several current screens will fail these scenarios. **A current-screen failure can be evidence FOR a principle.**

Example: if the participant can't say what My Day tells them within 3 seconds, that does **not** falsify P4 ("Phil answers what-now in 3s") — the audit predicts that failure. P4 is falsified only if the worker *doesn't want* a what-now answer ("don't tell me what to do, just give me the timesheet"). For every observation, record **which of the two** you saw:

- **[UI]** — the current screen failed the principle *(expected; feeds the fix backlog)*
- **[PHIL-X]** — the worker's behaviour/expectation contradicted the principle itself *(this is the gold; it amends the Constitution)*

## Rules (verbatim from the protocol — binding)

Do not explain Phil. Do not defend Phil. Do not lead. Never ask "wouldn't it be better if…". Observe, listen, record. Count only: hesitation · confusion · incorrect assumptions · unexpected workflows · contradictions · workarounds · ignored UI · reality-vs-philosophy conflicts. Compliments and feature ideas are noise — note them in the margin, score nothing for them.

## Participants

Minimum: 1 apprentice · 1 qualified electrician · 1 leading hand (your crew covers this). Preferred later rounds: hospital, warehouse, service, one-van contractor — book separately; do not block on them.

---

## Pre-session seeding (30 min, admin account — follow exactly)

Uses the repo's own test-data rules (`docs/testing/Test-Data-Rules.md`): everything prefixed, parked and purged after.

1. **Job**: create `QA_SEED_FIELD_VALIDATION_JOB` ("100 Arthur St — validation"). Structure: area group **"Level 3"** with 4 areas (e.g. East Gym, Corridor, Switch Room, Amenities), rough-in + fit-off task templates. **Publish it.**
2. **Scenario-3 state** in one area (East Gym): all rough-in tasks complete **except 2** (name them as GPO tasks); attach an ITP instance with **one point unrecorded**; ensure at least one photo of evidence exists and one task that "needs a photo" has none.
3. **Plans**: upload 2 sheets via the v2 documents page; supersede one so exactly one **current** revision exists.
4. **Participant account**: send a real **invite** to a spare email → the participant will accept it live (Scenario 0). Assign the account to the seed job. Assign 1–2 **gear** items to it.
5. **Rejected-hours seed**: the day before, submit an entry from that account, then **reject it as admin** with reason "Wrong job — should be Arthur St" → populates Needs-you + the fix flow.
6. **Cleanup after the session**: park the job to Draft, run `npm run qa:list-smoke-jobs`, purge via the cleanup card. Never touch `QA_SEED_FIELD_ACTIVE_JOB` (the standing smoke fixture).
7. **Kit**: the participant's own phone if possible (install via invite), gloves, midday light, a second person taking the sheet notes, voice-record with permission.

---

## Scenario 0 (added — tests the door) · *5 min*

Participant accepts the invite and sets their PIN on their own phone, no help.
**Watch:** time to signed-in; any hesitation at the sign-in form labels; whether they later re-enter without help.
**Maps:** P8 · audit F6 · issue #421. Mark [UI] vs [PHIL-X].

## Scenario 1 — 7:00am, toolbox talk done · *5 min*

Say only: **"You and Jack are on Level 3 rough-in."** Hand them the phone. Ask only: **"What would you do first?"** Silence. Record everything for 3 minutes.
**Watch for:** do they look for *the foreman's instruction* in the app (it isn't there — P3/allocation gap, expected [UI])? Do they navigate by place ("Level 3") or by list? Do they ignore the app entirely and just start (also data)?
**Maps:** P3 · P4 · P2.

## Scenario 2 — the interruption · *10 min, mid-task*

Get them working (mark a task, start a capture). Then interrupt for real: hand them a different phone ringing, ask an unrelated question, walk them 20 m away. Resume after several minutes (protocol says 45 — compress honestly; note the duration).
**Ask nothing.** Watch: where do they go first? What do they look for? What did they forget? Did anything half-done survive (capture tray should; form text won't)?
**Maps:** P8 (interruption) · P14. Mark [UI]/[PHIL-X] per observation.

## Scenario 3 — "ready to leave?" · *5 min*

In East Gym (seeded: 2 GPO tasks open, 1 ITP point missing, photo gap). Ask only: **"How would you know this area is ready to leave?"**
**Watch:** do they *walk-down* mentally (completion + exceptions — P14's model)? Do they find the open items in the app or recite them from the seed brief? Do they treat photo/ITP/tasks as one "doneness" or separate chores?
**Maps:** P14 · P5 · P13 · (P4 on the area view).

## Scenario 4 — priorities change · *3 min*

Say: **"Foreman's just pulled you onto the Switch Room instead."** Ask: **"How would you expect the app to reflect that?"**
**Record verbatim** whether they expect the foreman to override the app or the app to lead. This is the purest P3 test in the session.
**Maps:** P3 · the allocation concept.

## Scenario 5 — the home screen, 3 seconds · *2 min*

Cold open My Day. Ask: **"What does this screen tell you?"** Start counting silently.
≤3s coherent answer = pass for the *screen*; >3s = record **[UI] failure** (audit predicts this). Then the follow-up that tests the *principle*: **"When you open your phone for work in the morning, what do you want it to say?"** — verbatim answer; this is P4's real test.
**Maps:** P4 · P10 · F2.

## Scenario 6 — find what you need · *5 min*

On the job page: **"Where would you go to find what you need?"** (deliberately vague). Then concrete: "find the drawing for where you're working" · "flag that you're short of conduit" · "see what's left in the Corridor".
**Watch:** scroll behaviour (do they scan all 14 sections?), wrong taps, whether they ever notice "Quick actions" unprompted — then ask, pointing at it: **"What do you reckon that section's for?"** (the naming probe). Count taps per task.
**Maps:** P4 · P9 · P10 · the #133 criterion (did anything critical get missed *because* it was below the fold?).

## Scenario 7 — one piece of work, or four activities? · *7 min*

Ask them to: photograph their work · note something for the office · record the ITP point · raise the missing-GPO defect — phrased as site work, not app features ("show the office the East Gym rough-in", "that GPO's missing — what do you do?").
**Watch:** do they reach for the camera FAB for everything (capture-as-one-act = P13 confirmed) or hunt separate sections per record type? Glove the hand for at least one capture.
**Maps:** P13 · P12 · P6.

## Provisional-tier probes (after the scenarios — neutral, scripted)

1. **Run vs room:** "Walk me through how you'd tackle a level with twenty rooms of the same work." *(run-lens demand — listen for batching by kind vs finishing rooms; ask the LH whether they'd allow it)*
2. **Stage:** "How do you know what kind of work an area's up for when you walk in?" *(stage-as-memory/evidence)*
3. **Morning answer:** already asked in S5 — cross-check.
4. **Hours:** "Show me how you'd put in your day." *(should be ≤2 taps; watch the 7h36 button land)*
5. **The most important question, verbatim, last:** **"If you had this tomorrow, what would annoy you after using it every day for six months?"** — record every word.

---

## Observation sheet (one per participant per scenario)

| Time | What happened (verbatim quotes, taps) | Hesitation/confusion? | [UI] or [PHIL-X] | Principle(s) |
|---|---|---|---|---|

Global counters per participant: wrong taps __ · squints/phone-raises __ · "what does this mean?" __ · times they ignored the app and acted offline __ · unprompted workarounds __ .

## Scoring rubric (filled by Claude from the sheets — not on-site)

Per principle (P3, P4, P5, P8, P10, P13, P14 + any incidentally evidenced):
- **✅ Confirmed** — ≥2 participants behaved as the principle predicts, zero [PHIL-X] marks against it.
- **⚠️ Needs amendment** — behaviour matched in substance but contradicted in form (e.g. they want "what now" but from the foreman's mouth only).
- **❌ Contradicted** — any participant's natural behaviour broke the principle itself ([PHIL-X]), not just the current UI.
P15 is scored on the session having happened at all. [UI] marks score nothing against the Constitution — they are routed to the existing fix backlog (#421–#427 et al.).

## After the session

Return to Claude: the sheets (photos fine), the recording or its notes, and the six-month-annoyance answers verbatim. Claude compiles the final per-principle report (✅/⚠️/❌, evidence-only, no redesigns) — and **if every principle survives, the Constitution is declared frozen**, all future UX issues derive from it, and the ratified dispositions execute in one pass.

---

## Appendix — SEALED PREDICTIONS (do not read before the session)

*Pre-registered so the desk work can be proven wrong honestly. Facilitator: skip this page until the sheets are in.*

1. **S1:** the worker will look for (or state aloud) the foreman's instruction and not find it in the app — [UI] for P3's allocation gap; they will NOT expect the app to know first. P3 confirmed via S4 ("the foreman overrides the app" said as obvious).
2. **S5:** current My Day fails the 3-second test for ≥2 of 3 participants ([UI], audit F2); but the morning-answer question yields a what-now-shaped want ("where I am / what I'm on / anything wrong") — P4 confirmed in substance.
3. **S6:** ≥1 participant scrolls past "Quick actions" without engaging; when asked, describes it as generic shortcuts, not "what's next" ([UI] naming evidence).
4. **S7:** all participants reach for the camera first for ≥3 of the 4 record types — P13 confirmed; the defect may be the exception (some will ask a human instead — record it).
5. **S2:** resume is by *place* ("I was in East Gym") not by list — P14/P8 confirmed; at least one piece of half-entered text is lost and noticed ([UI]).
6. **S3:** "ready to leave" answered as completion + exceptions ("done except…") — P14's model confirmed; the ITP gap is the item most likely *forgotten* without the app.
7. **Run probe:** the tradesman describes run-batching for rough-in; the LH adds a finishing-stage caveat ("but I make them finish rooms at fit-off") — run lens stays a context-dependent view, exactly as demoted.
8. **Hours:** the 7h36 one-tap lands as the single most-liked thing in the session.
9. **Six-month annoyance:** at least one answer is about signal/offline or re-finding things after interruptions — elevating #135/#143/#139 and #425.

*If ≥3 of these predictions are wrong, the desk work overfitted and the Constitution's provisional tier must be re-examined rather than frozen — say so plainly in the final report.*
