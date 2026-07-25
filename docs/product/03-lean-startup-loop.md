# 03 · Lean-startup loop (2026-07)

**Status: ratified — product-owner decision, 2026-07-25.** This document sets
**how work is chosen and validated** from here on. It builds on the scope cut
of [02-lean-reset.md](02-lean-reset.md): that reset produced a lean core; this
document adds the **Measure** and **Learn** halves of the Build–Measure–Learn
loop so the product grows by evidence, not by momentum.

It is a product-process document. It does **not** amend the Phil constitution,
the task-led architecture ADR, or any engineering gate — every existing check,
guard and governance rule still applies. What it changes is the *selection*
gate: **"should this be built at all?"** now has an explicit answer process.

## The staged intent (ratified 2026-07-25)

The product owner's declared trajectory, in order. Each rung is a
**kill / persevere gate**: the next rung is not started until the current one
is proven — or consciously re-planned if it fails.

| # | Rung | Proof signal | Target |
| --- | --- | --- | --- |
| 1 | **Hours spine proven** | Real crew logs hours daily; boss approves on a phone; a real pay week exports to Xero as draft timesheets and the pay run is finished inside Xero — for a full Wed→Tue cycle without paper fallback. | Weeks (Aug 2026) |
| 2 | **A few more features proven** | 2–3 additional features (pull-based — see below) each pass their own weekly hypothesis with real users. | ~Oct 2026 |
| 3 | **Basic multi-aspect product** | The business gets clear value from BuhlOS across several aspects of its operations (hours + the proven pulls), daily, without chasing. | End 2026 |
| 4 | **Friendly external pilot** | One other contractor uses it (free) for real work. Second company proves it's a product, not a tool. | Months after rung 3 |
| 5 | **First paying customer** | At least one business pays real money. | Mid-2027 |

If a rung slips badly past its target, that is a **signal to be examined at
the next weekly review**, not a scheduling detail to be quietly absorbed.

## The weekly loop (aligned to the pay week, Wed→Tue)

One cycle per pay week, reviewed at weekly hours closeout:

1. **One hypothesis per cycle**, written down *before* building:
   *"We believe [specific crew/office behaviour]. We'll know it's true if
   [observable signal] by [Tuesday closeout]."*
2. **Build the smallest thing that tests it** — dark behind a flag, flipped
   Live only for the test (existing flag system; no new infra).
3. **Review at closeout**: did the signal happen?
   - **Persevere** — keep it Live, pick the next hypothesis.
   - **Tweak** — adapt and re-test next cycle (the default posture for crew
     friction: adapt until it sticks).
   - **Kill** — re-hide the flag, no-trace rule applies, no sunk-cost rescue.
4. **Measurement is observation and conversation, not dashboards.** At the
   current scale (a handful of real users) the right metric is e.g. *"how many
   workdays this week did each worker log hours without being chased?"* —
   answered by looking at `/hours` and asking on site. **Do not build
   analytics infrastructure**; that would itself be waste.

## Pull, not push (the feature-selection rule)

- **Nothing new gets built and nothing hidden gets un-hidden unless a real
  user asked for it or a proven loop demands it.** "The vision needs it" is
  not a pull.
- The ~25 built-but-hidden features are an **arsenal, not a roadmap**. When a
  real pull matches one, un-hide and adapt it rather than building fresh —
  that is this repo's speed advantage. Until then they stay dark, no-trace.
- The discipline for rung 2 is to **listen for the pull**: what does the crew
  or office still do on paper, in texts, or in Excel after hours is live?
  That list — not the backlog — nominates the next features.
- Every feature/behaviour PR should name the hypothesis or pull it serves
  (one line in the PR body), the same way Phil-surface PRs cite principles.

## Investment posture

Ratified appetite: a **significant bet** of the owner's time and money ahead
of proof — spent on **iteration depth, not feature breadth**. Engineering
hygiene (CI, guards, tests) stays; the counterweight is slice size: each
experiment must be small enough that the gates cost minutes, not days.

## Commercial posture (toward rungs 4–5)

- **Do not build multi-tenancy speculatively.** But from now on, avoid
  *deepening* single-tenant assumptions in new work where a tenant-neutral
  shape costs nothing extra. Tenant isolation becomes the first
  infrastructure hypothesis **when pilot conversations start**, not before.
- **Before any external pilot**, the software's ownership and the host
  business's licence arrangement must be formalised in writing (the software
  is owner-funded and built off payroll; the host business is its first
  reference customer).
- The pilot is free. If a friendly contractor won't use it for free, nobody
  will pay for it — that is the cheap way to learn, before bigger bets.

## What this changes for contributors and agents

- **Selection gate:** before starting product work, identify the rung and the
  hypothesis/pull it serves. Work that serves neither waits.
- **Weekly cadence beats big-bang:** prefer a pay-cycle-sized slice with a
  testable signal over a multi-week build.
- **Kill is a first-class outcome.** Re-hiding a flag after a failed test is
  success of the process, not failure of the work.
- Everything else — flag discipline, no-trace rule, Phil governance,
  task-led architecture rules, CI gates, preview verification — is unchanged.
