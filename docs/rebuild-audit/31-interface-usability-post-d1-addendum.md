# 31 · Interface usability · post-D1 addendum

> **Status:** docs only. Addendum to [27-interface-usability-pass.md](27-interface-usability-pass.md). Doc 27 remains the binding UI/UX source of truth.
>
> **Read first:** [27-interface-usability-pass.md](27-interface-usability-pass.md) (the full usability pass — 20 sections), [src/components/phil/PhilJobsList.tsx](../../src/components/phil/PhilJobsList.tsx), [src/components/phil/PhilJobDetail.tsx](../../src/components/phil/PhilJobDetail.tsx).
>
> **Purpose:** capture observations from D1's authenticated production smoke and the live `/api/jobs` data shape, plus surface the [doc 27 §15 quick wins](27-interface-usability-pass.md) that are now actionable before D2/D3/D4 land. This is a delta, not a rewrite — doc 27 covers everything else.

---

## 1 · What we learned shipping D1

D1 went from "build" to "live on `buhlos.com`" inside one session (PR #11, merged at commit `71a91fc` on 2026-05-24). The authenticated smoke against the real job `birdwood-iv3232` surfaced a few facts the planning docs didn't have. They're all small. None blocked D1, but several change the shape of D2/D3/D4 testing.

### 1.1 · `/api/jobs` data shape — what live data actually looks like

The job that the real tradie sees has:

- `roughInTasks`: `[{id, name}, ...]` — 9 tasks. **Canonical**. `effectiveTasks(job, area, stage)` consumes these.
- `fitOffTasks`: `[{id, name}, ...]` — 7 tasks. **Canonical**.
- `stages`: `{ roughIn: [strings], fitOff: [strings] }` — **legacy**. Don't read. Don't write. D3/D4 must not pick this up.
- `areaGroups`: 2 groups (Units / Townhouses), 22 areas total. Each area is `{id, name}` only — **no** `spaceType`, **no** `roughInTasks` override, **no** `fitOffTasks` override on this particular job. (Other jobs may have overrides; `effectiveTasks` correctly falls back to job-level.)
- Site fields: `siteAddress` set, `siteContactName` set, **`accessNotes`, `parkingNotes`, `safetyNotes`, `siteContactPhone`, `ref` all present as empty strings**. `inductionRequired: true`. `typeName: null`.
- A `layout: {units: 15, townhouses: 7}` field exists on this job and is not in [doc 24 §5.1](24-phase-d-jobs-evidence-plan.md). `.passthrough()` handles it; no UI relies on it.

**What this means for D2/D3/D4:**

- Treat empty strings as absent when conditionally rendering. (D1's `PhilJobDetail` already does this — `{job.accessNotes ? ... : null}` — but D3's capture-target picker must too: don't show a "Contact: <empty>" field.)
- `area.spaceType` is rare on real data. Don't design copy that assumes it ("Areas in your kitchen…"). If it's there, use it; if not, the area `name` alone is the affordance.
- The legacy `stages: { roughIn: [strings] }` is on **every** job (it's a global legacy artefact). The grep-test for D3 should look for any `job.stages.roughIn` / `.fitOff` reads in `src/components/phil/`, `src/components/admin/`, and reject them.

### 1.2 · One real worker, one real job

The dev tradie account (`Oskar`, role `tradie`) has `assignedJobIds: ["birdwood-iv3232"]`. That is the only job for that account. D2/D3/D4 testing on real data needs:

- A second tradie account to verify own-only filtering at the API level (admin can fake this temporarily by reading the audit log if no second account exists).
- Multiple captures per area to test the queue (D4 admin review).
- A worker not assigned to the job to verify the 403 path.

**Recommendation:** before D3 / D4 ship, [doc 26 §C field test setup](26-phase-d-testing-checklist.md) should call out the test-account preconditions explicitly. If the dev environment only has one tradie account, that limits what can be smoked. Either provision a second test tradie (preferred — admin can create via legacy `/admin/operations`) or accept that own-only filtering is verified by code review + unit tests, not field smoke.

### 1.3 · The friendly 403 / 404 page works

`/phil/jobs/not-a-real-job` renders the "This job isn't assigned to you" card with a back-link rather than a raw 403 / 404 page. Field test should confirm a similar gentle path exists on evidence URLs (D4): a worker who taps a stale link to evidence on a job they're no longer assigned to should land somewhere recoverable, not on Next.js's default error page.

### 1.4 · Admin redirect from Phil routes is silent

When admin (`tom`) opens `/phil/jobs`, middleware redirects to `/command-centre` with no explanation. That's per `landingFor(admin)`. Field test for D2/D3/D4 should confirm the redirect still happens for **all** new Phil routes. The silent redirect is fine UX-wise (admin doesn't need a "you're an admin, here's the Command Centre" banner — they just want their dashboard) but the test matrix needs an explicit row for each new Phil route × admin role.

---

## 2 · Quick wins from doc 27 §15 — status post-D1

[Doc 27 §15](27-interface-usability-pass.md) lists 7 quick wins for pre-D1 hardening. They were skipped during the D1 build (correctly — D1 was the slice). Now is a good window for some of them, particularly before D2/D3/D4 add new surfaces that would re-introduce the same issues:

| # | Quick win | Status | Owner / when |
| --- | --- | --- | --- |
| 1 | Audit existing pages for unearned elements | Partially done — D1 didn't add any; pre-D1 surfaces (Phase A/B/C) untouched | Optional pre-D2 polish PR (~30 min, docs-only review first) |
| 2 | Audit status pills for tone palette compliance | Done in D1 (`JobStatusTone`); Phase B/C pills not reviewed | Pre-D2 polish if appetite; otherwise rolled into D6 exit polish |
| 3 | Confirm DemoModeBanner is OFF on all real-data routes | **Not run** — risk of accidental banner-on regressions before D2 lands real evidence | **Recommend pre-D2:** Playwright check from [doc 17 §B.9](17-testing-and-quality-plan.md) |
| 4 | Confirm SignOutButton placement (sidebar footer, not top-right) | Believed correct per PR #7 — not re-verified | Skip unless re-introduced |
| 5 | Confirm `/command-centre` welcome card copy is accurate | Need re-verification — Phase C wording may have leaked into the post-D1 state | Pre-D2 — same PR as the evidence queue card, since D4 will edit this page |
| 6 | Lint for `*-client.tsx` under deep route folders | **Existing offender:** `src/app/phil/gear/gear-list.tsx` — predates the binding rule | Documented in §3 below |
| 7 | Phil tab bar audit (order + Snag UC + active indicator) | D1 verified: tab order Today / **Jobs (live)** / Gear / Snag (UC) / More; active indicator works | ✓ done |

The **highest-value** carry-forward is #3 (DemoModeBanner discipline) and #6 (deep-route client component grep). Both are pre-D2/D3 hygiene rather than D-prep.

---

## 3 · Existing RSC client-manifest debt

[Doc 27 §10](27-interface-usability-pass.md) binds: "no client component lives under a deep route folder." [Doc 26 §A.1](26-phase-d-testing-checklist.md) enforces with a grep.

**Two existing offenders on `main` as of `71a91fc`:**

1. `src/app/phil/gear/gear-list.tsx` — `"use client"` (Phase C; predates the binding rule).
2. `src/app/phil/my-day/log-hours-sheet.tsx` — `"use client"` (Phase B; predates the binding rule).

Both have been live for weeks without manifesting the RSC manifest bug. They're not on the critical path right now. **But D3 must not add a third offender** — the doc 26 grep should be re-pointed to scan for *new* offenders, not catalogue the existing ones.

**Recommendation:** when D3 lands, the build session should be reminded that an "existing offender" exists at the path patterns above and the grep test should still pass for **new** code. A follow-up cleanup PR can lift `gear-list.tsx` and `log-hours-sheet.tsx` into `src/components/phil/` to retire the debt entirely. **Don't bundle that cleanup with D3.**

---

## 4 · New observations on doc 27's screen critique (§8-9)

[Doc 27 §8.4-§8.5](27-interface-usability-pass.md) cover the planned Phil jobs list + detail. D1 shipped both. Real-data smoke confirms:

### 4.1 · `/phil/jobs` (§8.4) — observations

- ✓ Status pill is the leftmost element; job name is the largest type.
- ✓ Whole-row tap target.
- ✓ Empty-state copy ("No jobs assigned yet — Ask your PM…") tested via direct URL; production worker has 1 job so the empty state hasn't been seen in production yet.
- ⚠ **"Updated / Created X ago" caption** is honest but could be misleading. The dev job's `createdAt` is `2026-04-13`, so the row shows "Created 41d ago" — a worker may read that as "the job was last touched 41 days ago" which isn't true. Audit-driven last-activity (D3+) will fix this. Until then the caption is correct but uninformative.
  - **Action:** consider dropping the caption entirely on D1 surfaces until D3's evidence-driven last-activity lands. One sentence patch. **Defer to D6 polish** unless it grates.
- ⚠ Long job names — the only live job is "19-23 Birdwood Ave Lane Cove" which is moderate. Names like "Acquisition of 14 Birdwood Avenue (lot 2) for stage 3 fit-off and commissioning" would overflow into the right gutter. Existing `truncate` class handles this with `…`. No blocker.

### 4.2 · `/phil/jobs/[jobId]` (§8.5) — observations

- ✓ Site context block renders only the populated fields. Empty strings correctly skipped.
- ✓ Stage chooser is two equal-weight pills, brand-yellow when active.
- ✓ Area picker shows both groups (Units, Townhouses) with names; no archived items leaked.
- ✓ Task list renders 9 rough-in templates / 7 fit-off templates as a clean vertical list.
- ⚠ **Task state pills are absent** — D1 is read-only; tasks render as plain names. A worker may expect a state pill ("Not started" / "Done") and confusion is possible. D1's choice (no fake pill) is correct per [doc 27 §3 #5](27-interface-usability-pass.md) "no fake live features", but the worker has no signal about state at all.
  - **Action:** D3 should add a small UC pill or "Status lands in D3" copy near the task list header so the worker doesn't wonder.
- ⚠ **Site contact phone** is a `tel:` link. On the dev job the phone is empty, so the link isn't rendered. The conditional handling works, but the conditional logic is brittle — if a future job has `siteContactPhone: " "` (whitespace), the link would render as a useless `tel:`. **Defer:** trim() check in `PhilJobDetail.tsx`. ~1-line fix; rolled into D6 polish or filed separately.
- ⚠ **PhilHeader title** = full job name (e.g. "19-23 Birdwood Ave Lane Cove"). On a narrow viewport (360px) long names can clip with the yellow status dot in the navy header. PhilHeader doesn't truncate. **Action:** add `truncate` class to the title element in `src/components/phil/PhilHeader.tsx`. ~1-line fix; rolled into D6 polish.
- ✓ The "Capture evidence" UnderConstructionPanel is rendered correctly (no fake button).

### 4.3 · `/command-centre` (§9.1) — carry-forward

D4 will add the "X evidence pending review" queue card here. [Doc 27 §9.1](27-interface-usability-pass.md) is explicit about the shape: count + oldest item age + click-through. **Not** a sparkline. **Not** a chart.

D4's PR body should confirm this card is per-job (because cross-job aggregation doesn't have an admin Jobs surface to land on yet — see [doc 30 §6.6](30-phase-d4-admin-evidence-review-spec.md)). If D4 ships without this card because no useful click-through target exists, that's fine; document it.

---

## 5 · Three small polish PRs that pair well with D2/D3/D4 (optional)

None of these are blockers. All are docs-mentionable, low-risk, and can land between D-slices:

| # | Polish item | Why it matters | Estimate |
| --- | --- | --- | --- |
| P-1 | Truncate PhilHeader title (`src/components/phil/PhilHeader.tsx`) | Long job names clip on 360px Android | ~1 line + 1 visual test |
| P-2 | Trim() check on `siteContactPhone` before rendering `tel:` link in `PhilJobDetail.tsx` | Defensive; no real bug today | ~1 line + a unit test |
| P-3 | Lift `gear-list.tsx` and `log-hours-sheet.tsx` into `src/components/phil/` to retire RSC debt | Closes the existing-offender list to 0 | ~30 min; needs careful Prop-edge review |
| P-4 | Drop the "Created X ago" caption from `/phil/jobs` until D3 lands real last-activity | Honest signal-to-noise | ~5 lines |

**Recommendation:** bundle P-1 + P-2 + P-4 into a single ~30-line `ui: D1 polish` PR after D2 ships and before D3 starts. P-3 is its own PR (bigger blast radius if the prop edge is wrong).

---

## 6 · D2/D3/D4 UX preview — anti-patterns to actively avoid

Re-stating from [doc 27 §14](27-interface-usability-pass.md), the ones most likely to creep in during D2/D3/D4 if reviewers aren't watching:

| Anti-pattern | Where it'd creep in |
| --- | --- |
| Toast notifications as primary feedback | D3 capture submit → "Captured!" toast that disappears. **Use** the inline status pill on the strip card instead. |
| `confirm()` for bulk mark-reviewed | D4 admin bulk action → `confirm('Mark 5 reviewed?')` modal. **Use** the visible "Mark N reviewed" CTA that's its own affirmative; no confirmation needed for a reversible action. |
| Three-dot menu where the primary action lives | D4 row with "..." → Mark reviewed. **Use** an inline button. |
| "Recent activity" widget on `/command-centre` | D4's queue card might tempt a sparkline. **Don't.** |
| Profile dropdown in top-right | D4 might add a "who am I" affordance. **Don't** — Settings sidebar section is the home for that. |
| Pill tab navigation across top of admin section | D4 evidence queue might add "Pending / Reviewed / Rejected" pill tabs. **Use** the status filter dropdown in the filter bar instead — same outcome, less clutter, plays with the other filters. |
| "Coming soon" modal | If audit-log read isn't ready in D4, **use** UnderConstructionPanel inside the drawer's History section, not a modal. |
| KPI sparkline on the evidence queue card | The card is a count + age + link. That's enough. |

---

## 7 · Field test additions (extends doc 26 §C)

[Doc 26 §C](26-phase-d-testing-checklist.md) has the field test script for D4 pre-cutover + D6 exit. With the D2/D3/D4 split:

**Pre-D2 field test (read-only smoke; ~10 min):**

- Open `https://buhlos.com/phil/jobs` from a real Phil-account browser (iOS Safari + Android Chrome).
- Confirm assigned job(s) list with status pill + address.
- Tap a job → detail loads with stage chooser + area picker.
- Switch stages — task list updates without a route refresh.
- No capture button visible (UC panel only).

**Pre-D3 field test (sheet + real API; ~15 min):**

- Repeat pre-D2 steps.
- Tap "Capture evidence" → sheet opens.
- Use camera permission → take a photo of anything safe (sky, ground, label).
- Pick stage + area + task.
- Add a note like "TEST D3 capture YYYY-MM-DD HH:MM".
- Submit → sheet closes → "Captured" pill appears in strip.
- Kill wifi → submit again → row shows `pending_sync` → restore wifi → row resolves to `submitted`.

**Pre-D4 field test (admin review; ~15 min):**

- Log in as admin on desktop.
- Open `/v2/jobs/[testJobId]/evidence`.
- Confirm the D3 test rows are visible.
- Mark one reviewed → row flips.
- Reject one with reason "TEST D4 reject YYYY-MM-DD" → row flips, reason visible.
- Bulk-select 2 → "Mark 2 reviewed" → both flip.
- Log out, log in as Phil tradie → confirm pills updated on next refresh.

**Cleanup after each field test:**

- Photo blobs survive (don't manually delete).
- Evidence rows can be marked `rejected` with reason "TEST CLEANUP" to filter out of counts.
- Do **not** create test data in production unless on a known test job (the dev `birdwood-iv3232` is the agreed test target).

---

## 8 · Open questions surfaced post-D1

Adding to [doc 27 §19.1](27-interface-usability-pass.md):

| # | Question | Affects |
| --- | --- | --- |
| 6 | Should the Phil header truncate long job names on 360px? (Yes — but does it need an icon affordance to indicate truncation, like a small `…`?) | D1 polish |
| 7 | When a worker captures evidence without an area, the row shows "Unattached" in the admin queue. Is that the right copy? Alternatives: "No area", "Loose capture", "Site-wide". | D4 (admin queue) |
| 8 | Bulk mark-reviewed N rows where some fail — do we surface a per-row inline error pill, a banner summary, or both? | D4 (admin queue) |
| 9 | Field test cleanup — should rejected-with-reason "TEST" evidence be hideable from the queue by default (`include_test=0` filter)? | D4 (polish) |
| 10 | Should the empty-area "Capture without area" path show a confirmation copy ("You're capturing without an area — is that intentional?") or just submit silently? | D3 |

**Recommendation:** answer 7 (copy choice) and 10 (capture-without-area UX) before D3/D4 ship. The others can be answered post-ship via field feedback.

---

## 9 · Cross-references

- [27-interface-usability-pass.md](27-interface-usability-pass.md) — the binding source; this doc is an addendum.
- [28-d2-d3-d4-evidence-qa-checklist.md](28-d2-d3-d4-evidence-qa-checklist.md) — QA gate.
- [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) — Phil capture spec.
- [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md) — admin review spec.
- [src/components/phil/PhilJobsList.tsx](../../src/components/phil/PhilJobsList.tsx) — D1 list (subject of §4.1 critique).
- [src/components/phil/PhilJobDetail.tsx](../../src/components/phil/PhilJobDetail.tsx) — D1 detail (subject of §4.2 critique).

---

## Document status

| Field | Value |
| --- | --- |
| Document | `docs/rebuild-audit/31-interface-usability-post-d1-addendum.md` |
| Author | Session 4 (non-interference QA / UX planning agent) |
| Branch | `session-4-qa-ux-planning` |
| Status | **Docs-only. Addendum to doc 27.** No app code implied. |
| Phase precondition | D1 shipped (PR #11 merged at `71a91fc`). |
| Next action | Review §5 polish list and §8 open questions. Apply or defer per appetite. Read alongside doc 27 — doc 27 is binding; this is a delta. |
