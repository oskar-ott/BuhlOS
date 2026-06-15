# Variation / daywork approval workflow

> Status: **domain foundation, real.** Schema + types + pure transition logic
> for the builder-approval lifecycle of a variation or daywork. Code:
> [`src/domains/variations/`](../../src/domains/variations/). No UI, no API, no
> persistence, no Phil wiring yet — those are follow-on slices (see §Later
> slices). Sits beside the daywork register
> ([`src/domains/dayworks/`](../../src/domains/dayworks/), #370): that domain
> owns the per-job docket + signature; this one owns the **approval state** a
> variation or daywork passes through.

## Why

Variations and daywork are where construction jobs leak money. The builder asks
for an extra; the crew does it; weeks later the claim is contested — "we never
approved that." The safe loop is **approval before work**. This domain models
that loop and the one dangerous shortcut around it, so the rule is enforced in
code rather than in someone's memory.

## The normal path — approval before work

```
builder requests an extra/change
  → BuhlOS raises a variation/daywork quote/request   draft → sent_to_builder
  → builder approves                                   approved
  → work is released to the crew                       released_for_work
  → worker completes it                                completed
  → evidence / hours / materials are attached          (link only, elsewhere)
  → admin claims it                                    claimed
  → admin invoices it                                  invoiced
```

The defining rule: **`released_for_work` is only reachable from `approved`.**
There is no `draft → released_for_work` and no `sent_to_builder →
released_for_work`. Work is not pushed to the field until the builder has said
yes.

Side paths off the normal line:

- `sent_to_builder → rejected` — builder declines.
- `sent_to_builder → expired` — the offer lapses with no decision.
- `approved → cancelled` — withdrawn before any work.
- `completed → disputed`, `claimed → disputed` — contested after the fact.

## The exception — `work_at_risk`

Sometimes work starts before approval: a verbal go-ahead, an emergency, or
programme pressure. That is not the happy path and the model never pretends it
is. It is the explicit `work_at_risk` status, enterable only from `draft` or
`sent_to_builder`, and it **demands a named authorisation**:

- `reason` — what was instructed, required.
- `authorisedBy` / `authorisedAt` — who internally took the risk, and when,
  required.
- `source` — categorised "why we started without approval", optional: builder
  verbal instruction · boss/internal approval · emergency/safety · programme
  delay risk · other.

A `work_at_risk` record always raises a **`WORK AT RISK — approval not
received`** blocker for admin follow-up. From there it can be retroactively
`approved` (clearing the risk), `completed` (work finishes, still unapproved),
or `cancelled`.

If at-risk work reaches `completed` (or beyond) without a recorded approval, it
stays **claim-risk flagged** — it may not be claimable, and admin must chase the
approval before invoicing.

## What the model guarantees

- Work cannot be released to the crew without a recorded builder approval —
  except via the explicit, authorised `work_at_risk` override.
- At-risk work is never anonymous: reason + authoriser + timestamp are required.
- At-risk and unapproved-but-completed work are always surfaced as blockers, not
  silently absorbed.
- `claimed` only follows `completed`; `invoiced` only follows `claimed`.
- Transitions are pure: a rejected transition returns the original record
  unchanged, so the model can never silently advance unapproved work.

## Why Phil only ever sees approved/released variation tasks

Workers should not be responsible for quoting or for judging whether an extra is
authorised — that is commercial work that belongs in BuhlOS. The field surface
(Phil) should therefore only receive variation/daywork tasks once they are
`approved` and `released_for_work` (or explicitly released at risk, with the
risk visible). The crew does the work; the office owns the money. This domain is
the gate that makes that division enforceable.

## Later slices

This PR is the pure foundation only. Built on top of it, in order:

1. **BuhlOS admin: request a variation/daywork** from the builder (origination +
   quote/request reference).
2. **Builder-approval tracking** — capture the builder's decision and stamp the
   approval.
3. **Release the approved variation to Phil** — surface released tasks in the
   field.
4. **Evidence / hours / material capture** against the released work (links to
   the existing capture, time-entries and material-request domains).
5. **Claim / invoice status** — progress-claim and invoice tracking, with
   claim-risk surfaced for anything completed without approval.
