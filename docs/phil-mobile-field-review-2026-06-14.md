# Phil Mobile Field Review — Job Screen, Capture, My Day

**Issue:** [#132](https://github.com/oskar-ott/BuhlOS/issues/132) — phil: mobile UX field review — job screen + capture + my day
**Epic:** [#121](https://github.com/oskar-ott/BuhlOS/issues/121) (Phil Mobile) · North star [#120](https://github.com/oskar-ott/BuhlOS/issues/120)
**Date:** 2026-06-14 · **Author:** desk review (Claude) · **Basis:** `main @ 961f0bc` (clean tree)
**Status:** Desk decisions ratified. One acceptance criterion remains for a human: the on-site observation of ≥2 workers (protocol in §A below + `docs/phil-field-validation-kit.md`).

> **Authority note.** Where this document and the frozen historical docs disagree, the governing
> package wins: `docs/phil-constitution.md` + `docs/phil-architecture.md` + `docs/phil-constitution-ratification.md`.
> `docs/phil-ux-master-audit.md` and `docs/phil-ux-architecture-v2.md` are **frozen historical records** — cited
> here for *measured evidence* only, never for live direction (the ratification retracted several of their
> recommendations; see §11). This review supersedes the prior dated note nowhere — it is the first dated field-review doc.

---

## 1. Executive verdict

- **Command panel vs attention strip: MERGE** — collapse "Quick actions" + "Needs attention" into one ranked "what now" surface; today they are two stacked decision cards above the work, derive the same ITP/snag/induction signals through *two code paths with divergent counts*, and both claim "look here first."
- **Tabbed job interface: REVISE (do not ship as drawn; prototype + field-test against P9)** — the 5-tab design (Overview·Work·Issues·Checks·Plans) stacks a second nav bar on top of the global tab bar and risks an "Overview" that duplicates the other tabs; the constitution forbids pre-deciding for *or* against, so it must be revised to a P9-safe form and tested in the field, not ratified from a desk.
- **My Day: keep the hero state-machine (it is already shipped and correct), finish the #422 trim so the hero is the only answer above the fold, and field-probe the "which job am I on today" / day-plan question — do not rebuild.**
- **Capture: extend, do not rebuild** — Capture v2 is genuinely camera-first, glove-sized and honest; the work is wiring per-task required-evidence (#368), converging the two capture shells, and an offline outbox — never a redesign.
- **Standing pause rule: NARROW** — replace the blanket "no job-screen code" freeze with a precise split: the reversible, anti-creep-positive **merge is permitted now** under the section-count render-test; the genuinely contested items (tab *name*, tabs #133, day-plan reframe) stay field-gated; a new top-level section stays permanently barred.

---

## 2. Repo state / audit basis

Repo-safety gate (run before any analysis):

| Check | Result |
|---|---|
| Current branch | `main` |
| HEAD | `961f0bc7bbf25b89b1367c70f7687dd995b4ea27` |
| Working tree | Clean (only untracked: `.claude/launch.json`, `.design-cache/`, `.mcp.json`, `docs/supabase-migration-research-audit.md`) — no tracked modifications |
| `origin/main` | `961f0bc` — HEAD ≡ origin/main (0 ahead / 0 behind) |
| Worktrees | One (the main checkout). No active Phil worktree |
| Stash | One unrelated (`audit-stash-itp-wip` on `phase-e1a-itp-domain`) |
| Open PRs on these surfaces | Only [#456](https://github.com/oskar-ott/BuhlOS/issues/456) (`feat/job-control-task-context` — Phil task scope-context **view-model only, no UI**) — itself gated by #132, so this review *unblocks* it rather than conflicting |
| Can proceed docs-only | **Yes** — this is the one new file; no application code touched |

This task is **docs-only**: no UI changed, no Phil surface rebuilt, no application code modified. Evidence was gathered read-only from the shipped code, the design bundle (`.design-cache/phil-full-interface/bundle.tar.gz`, extracted), and the governance docs, cross-checked by a multi-agent read-only sweep and by direct file reads of every decisive component.

---

## 3. Current Phil surfaces reviewed (as shipped on `main`)

**Job screen** — `src/app/phil/jobs/[jobId]/page.tsx` → `PhilJobDetail.tsx`, render order:
`← All jobs` → **Hero** (`PhilJobHero`: name + status pill + address, no actions) → **"Quick actions"** (`PhilJobCommandPanel`, `#phil-job-next-h`) → **"Needs attention"** (`PhilJobAttentionStrip`, `#phil-job-attention-h`) → **Work to do** (`#phil-job-work`) → **Capture evidence** (`#phil-job-capture`) → **Issues** (`#phil-job-snags`) → **Checks** (`#phil-job-itps`) → Test & tag (`#phil-job-tags`) → **Plans** (`#phil-job-plans`) → Documents (`#phil-job-documents`) → **Site details** (`#phil-job-site`, incl. induction) → Who to call (`#phil-job-contacts`) → "Not connected yet" (`#phil-job-more`).

- **"Quick actions"** renders *only* from the #96 command model (`buildPhilJobCommandModel`): a hard `blocked` notice, one primary CTA (56px navy), ranked secondary rows (44px), honest `limitations`. It deliberately **suppresses** the model's info/warning `attention` array.
- **"Needs attention"** renders ≤3 viewer-scoped rows from `deriveAttention` (rejected snags → assigned snags → pending ITPs → induction), each with a reason line + one anchor chip; renders nothing when empty.

**My Day** — `src/app/phil/my-day/page.tsx`: greeting band → **`PhilMyDayHero`** (the #422 state machine, `data-testid="my-day-hero"`, *already live*) → `PhilWeekStrip` ("This week" Mon–Sun, `?fixDate=` day links) → `LogHoursSheet` (yellow "Log today's hours") → optional fetch-error notice → `PhilNeedsYouFeed`. Capture is **not** on this page — it lives on the global shell FAB.

**Capture v2** — global FAB (`PhilTabBar`, 56px, `aria-label="Capture"`) fires the OS camera in the *same tap* and opens `PhilCaptureLauncher` (multi-photo tray ≤10 → destination radiogroup: assigned jobs *or* "Send to the office" → optional note + collapsed "Add area or stage" → "Save N photos"). A second, in-job `CaptureSheet` (`aria-label="Capture evidence"`, single-photo, full-screen) is reached from the job's "Capture evidence" CTA.

**Tabbed design (un-ratified)** — `.design-cache/phil-full-interface` → `Phil - Full Interface.html` §04 "Inside a job (tabbed)": a sticky in-job sub-nav (Overview·Work·Issues·Checks·Plans) that **coexists with** the global bottom tab bar. The same bundle still ships the shipped single-scroll model (§03) as a parallel, unresolved option; the originating chat (`chats/chat35.md`) ends with the user replying only "a" and never confirming the swap.

---

## 4. Field-use principles applied

Reviewed through the eyes of an electrician on site: one-handed, gloves, midday sun, noisy, low patience, weak signal, no training, wants to *act* not read. Anchored to the constitution (`docs/phil-constitution.md`):

- **P4** — every surface answers *where am I, what is this, what's the most useful next thing* in 3 seconds.
- **P7** — truth over theatre: real records or named absence, never invented numbers or divergent counts for one fact.
- **P9** — critical state (blockers, rejections, safety holds, unsaved work) is visible on the surface you are on, **never behind a tab, menu, gesture or scroll**. *This is the criterion that governs the tabs question.*
- **P10** — fixed cognitive budget: Level 1 carries **at most one decision**; new capability enters an existing slot, never a new top-level section; *adding requires removing*; enforced by a section-**count** test.
- **P11** — speak site, in the voice of a good leading hand; explanatory prose only where there's nothing else to show.
- **P8** — sunlight-legible at arm's length, gloved-thumb targets, resume by place + next action in ≤1 gesture.

---

## 5. Decision: command panel vs attention strip — **MERGE**

**What each shows today.** The command panel ("Quick actions") = next-best-action engine (primary CTA + ranked secondaries + limitations + hard blocker). The attention strip ("Needs attention") = viewer-scoped exceptions (rejected/assigned snags, pending checks, induction), max 3, empty-hidden. The codebase is *aware* of the duality and splits deliberately so the two never show the same row text (`PhilJobDetail.tsx` L106-109; `PhilJobCommandPanel.tsx` L43-52).

**Why merge anyway — three converging arguments:**

1. **It is a correctness hazard, not just clutter (P7).** The two surfaces derive the *same* ITP/snag/induction signals through **two independent code paths with different status filters** — `buildPhilJobCommandModel` (job-wide; `WORKER_ITP_STATUSES`, `OPEN_SNAG_STATUSES`) vs `deriveAttention` (viewer-scoped; pending-only ITPs, open/in-progress snags). The same job can show panel **"Complete 3 checks"** and strip **"2 ITPs to start"** — divergent counts for one concept. Induction can appear in **three** places (command attention, the strip, *and* `PhilJobSiteCard`). One ranked source of truth ends this.
2. **It violates the cognitive budget (P10).** Two stacked decision cards both claiming "look here first" sit *above* the actual Work and the yellow Capture CTA, pushing real work below the first thumb-zone. P10 says Level 1 carries **at most one decision**.
3. **Both desk audits and the ratification already point here.** Master-audit Big Call 2: command panel becomes the hero and *absorbs the attention strip — "a blocker is the top-ranked item, rendered red."* The ratification rates **"merging attention into the ranked panel"** as **⚠️ likely correct — ship, reversible**.

**Zero-urgent state:** with nothing flagged, the strip is already hidden and the panel still shows ambient "Report an issue / Log hours" rows + two permanent `limitations` footnotes ("Rejected hours aren't shown…", "Material requests aren't in the app yet"). Merged, the empty state should be a single calm line ("Nothing flagged on this job right now"), limitations demoted to one muted line — not a populated card implying busyness.

**Many-urgent state:** today a blocker can render in the panel *and* an exception list render below it. Merged, the single highest-ranked item leads (a hold → red; a rejection → amber), with the rest as compact ranked rows — the worker reads one thing first, always.

**Recommendation (no implementation).** One surface — keep the command model as the sole authority (it already carries the `attention` array the panel currently throws away). It renders the single top-ranked item as the lead; remaining exceptions and actions as ranked rows beneath; honest absence as one line. The standalone `PhilJobAttentionStrip` retires; `deriveAttention`'s viewer-scoped exceptions fold into the model's ranking so there is **one** count per concept. **This removes a top-level card → anti-creep-positive.** Smoke-safe: "Quick actions" and "Needs attention" are **not** referenced by any Playwright smoke (only `Capture evidence`, FAB `Capture`, `?fixDate=`, and the `#phil-job-*` anchors are load-bearing).

**Field-gated rider (do not desk-decide):** the *name* — "Now" vs "Quick actions" vs restored "Next on this job" — is explicitly field-gated by the ratification ("the team already deliberated once and chose the opposite"). Merge the structure now; let the field session pick the word.

---

## 6. Decision: tabbed job interface — **REVISE (prototype + field-test against P9; do not ship as drawn)**

**Verdict rationale.** This is *not* a flat reject — the constitution forbids that. The ratification is explicit: **"ONE-SCROLL / NO-TABS — CRITERION SURVIVES, MECHANISM DOESN'T … #133 is an experiment judged by [P9] in the field test — not pre-decided in either direction. (The audit overstepped by recommending against; the charter compounded it.)"** So the honest verdict is: **the bundle's 5-tab design is not ratifiable as drawn, but the mechanism is not rejected — revise it to a P9-safe form and let the field decide.**

**Against the design as drawn:**
- **Two stacked nav bars.** The in-job sub-nav (Overview·Work·Issues·Checks·Plans) sits *on top of* the persistent global tab bar (My Day·Jobs·Capture·Gear·More). A job screen carries **two** horizontal nav strips — up to 10 small tap targets for one gloved thumb, the active-tab cue a thin yellow underline on 10px uppercase mono (subtle in glare). The design's own defence ("the bottom bar never changes what's inside a job") doesn't remove the second strip from the worker's eye.
- **P9 risk.** Tabs hide state behind navigation. A rejected snag or a hold living on the "Issues" or "Overview" tab is invisible while the worker is on "Work" — exactly what P9 forbids unless critical state is mirrored into a persistent header.
- **"Overview" duplication.** Overview is disciplined (hero + ≤3 quick actions + ≤3 attention) but every item's job is to *bounce you to another tab* — so the same snag shows on Overview **and** Issues (teleport-by-tab replacing teleport-by-scroll). And "Overview" is the one mild office-word in an otherwise good worker-language set.
- **Near-empty tabs.** A small job has 0–2 issues and 1–3 checks; two whole tabs for near-empty lists is heavier than the contextual count-chips the scroll model already uses.

**For the design (honest credit):**
- It answers a **real field complaint** — the only field evidence in play — from the originating chat: *"how do you navigate in the job interface, I'm afraid it's too disjointed."* The scroll model asks the worker to hold three mental models (scroll-to / expand-inline / push-a-page); that disjointedness is genuine.
- **Plans becomes one tap** from anywhere in the job (vs buried mid-scroll) — a clear win.
- **Capture stays the global FAB** across every tab — correctly never folded into the sub-nav.
- Worker-language is mostly right: Work (not Tasks), Issues (not Snags), Checks (not ITPs), Plans (not Drawings) — matching the shipped #100 copy pass. The older `Phil Job Interface Bible.html` set (Overview·Tasks·Drawings·Evidence·RFIs·More) is enterprise language and must **not** leak back.

**Recommendation (no implementation).** Re-scope [#133](https://github.com/oskar-ott/BuhlOS/issues/133) from "decide tabs" to: *prototype two navigation treatments and field-test both against P9 + interruption-recovery-≤1-gesture* —
(a) a **P9-safe tabbed** variant where critical state (blocker/rejection) lives in a persistent header chip that follows you across tabs, the second nav bar's weight is reduced, and "Overview" is dropped or renamed; and
(b) the **lighter alternative** the user was actually offered (option B in the chat): keep the single scroll but add a sticky section-jump chip bar.
Ship neither to production until the field session shows one beats the shipped scroll on *time-to-find-plans*, *did-they-miss-a-blocker*, and *interruption recovery*. **Minimum evidence before shipping any tab pattern:** ≥2 workers, on their own phones, find Plans and a rejected item under both treatments without missing the blocker, and prefer the new nav unprompted. The cached design stays as a reference artifact; do not delete it.

---

## 7. Decision: My Day direction — **HERO STATE MACHINE (already shipped — confirm + trim, don't rebuild)**

**Key finding: the #422 hero is live.** `buildMyDayHero` (`src/domains/phil/my-day-hero.ts`) and `PhilMyDayHero` are wired into the page with the exact priority the issue wants — **fix-rejected > log-today > submit-draft > next-job > all-clear** — and the legibility floor already landed (smallest font in `myDay.module.css` is **12px**, not the "7px" the audit measured; Mono/gold is gone). So this is a *confirm-and-finish*, not a build.

Answers to the required questions:

1. **The one thing My Day does first:** answer "what now" in one hero card. It already does.
2. **Above the fold:** greeting + the hero + a one-line week glance (total + day dots). Today the *full* week strip and log sheet still sit above the fold below the hero.
3. **Should rejected hours outrank logging today?** **Yes — and it already does** (priority 1 > 2). Endorsed: a bounced day blocks payroll, so it's the louder call.
4. **Should next-job-action outrank all-clear?** **Yes — and it already does** (priority 4 before 5; they're mutually exclusive). Endorsed.
5. **Remove / collapse / demote:** the hero sits *on top of* the old stack rather than replacing it — a rejected day can render in **four** places at once (hero, week-strip red cell, log-sheet StatusLine, needs-you feed). **Collapse the week strip to a one-line glance row** so the hero is genuinely the only answer above the fold; keep the per-day `?fixDate=` deep-links. Nothing else needs removing (leave/licences are already off the page; the split-day note is already gone).
6. **Belongs in [#422](https://github.com/oskar-ott/BuhlOS/issues/422):** the week-strip glance-row collapse; the stale-doc fix; *update #422 to record that the hero shipped* and re-scope to the remaining trim. #422 absorbs [#136](https://github.com/oskar-ott/BuhlOS/issues/136) (daily briefing) per the ratification.
7. **Belongs in [#427](https://github.com/oskar-ott/BuhlOS/issues/427):** the hero's `all-clear` state already exists; #427 extends calm win-states to area-100%, job-100% and "week squared away" — keep P3.
8. **Rejected (do not do):** rebuilding My Day into a payroll-first dashboard (the ratification: *"we would never rebuild My Day as a timesheet-first surface"*); a mixed dashboard; or desk-committing to the full v2-charter "day-plan" reframe.

**Field-gated rider:** whether the home should be a Day view or job-rooted for single-job crews — and whether the day screen should surface today's *work* (a foreman line), not just hours — is **field-gated** (ratification). Linked real gap: the next-job hero only fires for *exactly one* assigned job (`soleJob`); a 2+-job worker with hours in falls straight to "All clear" with no job to open. That "which job am I on today" active-signal question is a field probe, not a desk fix.

---

## 8. Decision: Capture direction — **EXTEND, do not rebuild**

Capture v2 passes the field bar: the FAB fires the OS camera in the *same tap* (iOS-safe), the FAB is 56px and on every screen (1–2 taps from anywhere), photos resize client-side for site signal, tray remove buttons have 44px hit areas, and **"Send to the office" is honest** — it works with zero assigned jobs, uploads to a separate `office-inbox/` prefix, creates the observation only when all photos land, and pushes to admin-tier users (the real replacement for texting the boss). **Do not redesign it.**

Improvements needed *before* field validation (all extensions):

- **Wire per-task required-evidence (#368) — highest value.** `requiredEvidence` exists only in `src/domains/job-control` and is **never imported by any capture component**; `CaptureSheet`'s `initialContext` only ever carries `{stage, areaId}`, never `taskId`. Today, attaching a photo to a specific task is 4+ gated taps behind a disclosure whose copy actively discourages it ("Skip it — a photo on the job is enough"), so most captures land job-level with no task link. [#368](https://github.com/oskar-ott/BuhlOS/issues/368) closes this with a pre-tagged "capture evidence for this task" deep-link — **needs-issue (already filed, P0).**
- **Converge the two capture shells.** The global launcher (multi-photo bottom sheet) and the in-job `CaptureSheet` (single-photo full-screen) diverge in shell, submit copy and close semantics for the same intent. Make the in-job sheet *be* the launcher preselected to that job — **needs-issue (new).**
- **Default the FAB to the last-captured/attributed job** so capture from My Day doesn't force a job pick every time — **needs-issue (#145-adjacent).**
- **Offline capture outbox** so an app-kill doesn't lose the tray — **needs-issue ([#143](https://github.com/oskar-ott/BuhlOS/issues/143)).**

Smoke-load-bearing (do not rename): `Capture evidence`, FAB `aria-label="Capture"`, `Take a photo`, `Where does this go?`, `Send to the office`, `Add area or stage`, `Log something without a photo`.

---

## 9. Prioritised fix list

Each item labelled **do-now** (safe, non-layout, near-zero-risk) / **needs-issue** / **rejected**.

| # | Fix | Label | Where |
|---|---|---|---|
| 1 | Correct `docs/phil-my-day.md` — it still claims JetBrains-Mono microcopy, 7–8.5px labels, and a navy un-restyled hours button; all false on shipped `main` (Inter, 12px floor, yellow `.logAction`). Stale doc will mislead the field reviewer. | **do-now** | `docs/phil-my-day.md` |
| 2 | Update issue states per this review (#422 hero shipped + re-scope; #133 re-scoped; #136 fold; see §10). | **do-now** | GitHub |
| 3 | Job-screen `Mark done` / Call / Text to the ratified 48px glove floor if still <48px (ratified-permanent invariant, sizing not layout). | **do-now** *(or fold into #423)* | `PhilJobAreaDetail`, contacts |
| 4 | **Merge** "Quick actions" + "Needs attention" into one ranked "what now" surface; retire `PhilJobAttentionStrip`; one count per concept; render from `buildPhilJobCommandModel`; guard with the section-count test. | **needs-issue (new)** | §5 |
| 5 | Re-scope #133: prototype a P9-safe tab variant **and** the sticky chip-bar alternative; field-test both; ship neither as-drawn. | **needs-issue** | [#133](https://github.com/oskar-ott/BuhlOS/issues/133) |
| 6 | Collapse the My Day week strip to a one-line glance row so the hero is the only above-fold answer (keep `?fixDate=` deep-links + smoke). | **needs-issue** | [#422](https://github.com/oskar-ott/BuhlOS/issues/422) |
| 7 | Wire per-task required-evidence deep-link into capture (`taskId` carry + "capture evidence for this task"). | **needs-issue** | [#368](https://github.com/oskar-ott/BuhlOS/issues/368) |
| 8 | Converge the two capture shells (in-job sheet → launcher preselected to the job). | **needs-issue (new)** | §8 |
| 9 | FAB default-to-last-job from My Day. | **needs-issue** | [#145](https://github.com/oskar-ott/BuhlOS/issues/145)-adjacent |
| 10 | Multi-job "which job today" active-signal so the next-job hero fires for 2+-job workers (field-probe first). | **needs-issue (field-gated)** | §7 |
| 11 | Offline read cache + capture outbox + honest-fail (the post-cutover adoption risk: Phil has no fallback app). | **needs-issue** | [#135](https://github.com/oskar-ott/BuhlOS/issues/135)/[#143](https://github.com/oskar-ott/BuhlOS/issues/143)/[#139](https://github.com/oskar-ott/BuhlOS/issues/139) |
| 12 | Extend all-clear → area/job/week win-states. | **needs-issue** | [#427](https://github.com/oskar-ott/BuhlOS/issues/427) |
| 13 | Crew-on-this-job-today line (reference zone, honest presence only — no new top-level section). | **needs-issue** | [#426](https://github.com/oskar-ott/BuhlOS/issues/426) |
| — | Add a 5-tab interface as drawn (two nav bars). | **rejected (as drawn)** | §6 |
| — | Rename "Quick actions" → "Now" from the desk. | **rejected (field-gated — the field session decides)** | §5 |
| — | Rebuild My Day as a payroll-first / mixed dashboard. | **rejected** | §7 |
| — | Redesign Capture v2. | **rejected** | §8 |

---

## 10. Issues to update / close / create

**Update**
- [#132](https://github.com/oskar-ott/BuhlOS/issues/132) — post this doc; tick the desk criteria (duality decision, tabbed verdict, written findings, prioritised labelled fix list, standing-rule re-scope). The single open criterion is the human on-site observation of ≥2 workers (§A protocol).
- [#422](https://github.com/oskar-ott/BuhlOS/issues/422) — record that the hero state machine **shipped**; re-scope remaining to: week-strip glance row, stale-doc fix, multi-job active-signal (field-probe). Note it absorbs #136.
- [#133](https://github.com/oskar-ott/BuhlOS/issues/133) — re-scope from "decide tabs" to "prototype P9-safe tab variant + chip-bar alternative; field-test both"; status BLOCKED → READY-TO-PROTOTYPE. Record: not ratified as drawn; not rejected as mechanism.
- [#368](https://github.com/oskar-ott/BuhlOS/issues/368) — confirm P0; note the capture↔task binding has **zero** UI wiring today (the highest-value capture extension).
- [#427](https://github.com/oskar-ott/BuhlOS/issues/427) / [#426](https://github.com/oskar-ott/BuhlOS/issues/426) — keep P3 / P2; both must enter existing slots, never a new top-level section.

**Close (with pointer)**
- [#136](https://github.com/oskar-ott/BuhlOS/issues/136) — fold into #422 ("daily briefing" was the symptom report for "work missing from the day screen"); close pointing at #422.

**Create (new, under #121)**
- *phil: merge the job "Quick actions" + "Needs attention" into one ranked "what now" surface* — Decision A build issue (one source of truth; kills divergent ITP/snag counts; render-test-guarded; smoke-safe).
- *phil: converge the two capture shells* — in-job `CaptureSheet` becomes the launcher preselected to the job.

---

## 11. Standing rule decision — **NARROW**

The standing rule was a blanket freeze: *"no more Phil job-screen code until the worker preview produces a Class-A blocker or repeated Class-B friction from ≥2 workers"* (`docs/phil-job-worker-first-finish-review.md`) + *"Phil job-screen layout changes are PAUSED pending a human UX review"* (#121 standing rule 1).

I do **not** lift it wholesale — the on-site observation that gates it is real and unmet, and the constitution explicitly field-gates the contested calls. I do **not** preserve it unchanged — that would unblock nothing, defeating #132's purpose. **Narrow it** to:

**Permitted now (desk-decided, reversible, anti-creep-positive, smoke-safe):**
- The **command↔attention merge** (§5). It *removes* a top-level card, ends a P7 divergent-count hazard, and the ratification pre-rated it "ship, reversible." Built under the P10 section-count render-test, rendered from `buildPhilJobCommandModel`. The field session **confirms** it reads in 3s and ranks the right thing (and owns the name).
- The **My Day week-strip glance-row trim** (§7) and the **stale-doc / glove-floor** fixes (§9 #1–#3).

**Still frozen — field-gated, await the human on-site session:**
- The merged surface's **name** ("Now" vs "Quick actions" vs "Next on this job").
- The **tabbed interface #133** — prototype + test, ship nothing as drawn.
- The **My Day day-plan / active-job-signal reframe**.

**Permanent guards (always on, regardless of the pause):**
- **Anti-creep (P10):** no new top-level job-page section, ever; adding requires removing; enforced by the section-count test.
- **Model-driven next actions:** the "what now" surface renders from `buildPhilJobCommandModel`; never hardcoded; never faked counts (P7).
- **Smoke-load-bearing strings/anchors:** `Capture evidence`, FAB `Capture`, `?fixDate=`, the `#phil-job-*` anchors, `phil-shell` testid, manifest `start_url=/phil/my-day`.

---

## 12. What to build next

In order:

1. **Run the field session** (§A) — the one remaining #132 criterion; a human runs `docs/phil-field-validation-kit.md` with ≥2 workers. Everything field-gated waits on it.
2. **Ship the merge** (§5) — the reversible win that resolves the duality and the divergent-count hazard; the highest-leverage, lowest-risk job-screen change available now.
3. **Finish #422 trim** (§7) — week-strip glance row so the hero is the sole above-fold answer.
4. **#368 capture↔task binding** (§8) — the biggest capture gap; pre-tagged per-task evidence.
5. **Offline track (#139 → #143 → #135)** — the post-cutover adoption risk; Phil is the crew's only app with no fallback.
6. **#133 prototype + test** — only after the field session reports.

Win-states (#427), crew line (#426), voice/camera polish (#147/#148) follow, each entering an existing slot.

---

## Appendix A — Field session protocol (the remaining #132 criterion; a human runs it)

Written before the visit, per #132 AC. Full instrument: `docs/phil-field-validation-kit.md`. **One electrician, their own phone, midday sun, gloves on, no coaching** (≥2 workers total).

**Tasks to observe** (record time-to-first-action, wrong taps, every squint/phone-raise, every "what does this mean"):
1. Open the app cold; say aloud what you'd do first. *(Pass: acts in ≤3s; reads the My Day hero.)*
2. Log a standard day. *(Pass: ≤2 taps, no help.)*
3. On your job, find what to do next and do one task. *(Pass: finds Work without scrolling past meta-lists; the "what now" surface points right.)*
4. Photograph a defect and send it to the right place. *(Pass: camera in one tap; correct destination; "Capture evidence" understood.)*
5. Fix a rejected day (seed one). *(Pass: hero → fix → resubmit, one path.)*
6. From 2 metres, read today's status off the home screen. *(Pass: legible in sun.)*
7. Lift-shaft / airplane-mode minute — narrate what you believe happened. *(Pass: honest failure, not a blank/false-success.)*

**Augmented questions for this review** (settle the field-gated items):
- **Duality/merge:** show the merged "what now" surface — does one card reading top-to-bottom feel clearer than two? Did you miss any blocker?
- **Tabs (#133):** show both prototypes vs the shipped scroll — which finds Plans and a rejected item fastest? Did a tab hide something you needed (P9)? Which would you actually use?
- **My Day framing:** does the home want *today's work* on it, or are hours-as-receipt enough? For 2+ jobs, which job should it open?

**The one question that matters:** *"Would you use this tomorrow without being told to?"*

**Pass/fail bar:** the layout-narrowing holds unless the session produces a **Class-A blocker** (a core action — plans/capture/issues — broken, fake/misleading state, or data loss) or **repeated Class-B friction** (the same too-slow / too-bossy / too-many-taps complaint from ≥2 workers). Compile results into a dated addendum to this doc.
