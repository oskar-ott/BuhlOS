# Field-readiness rollout pack

A practical, honest answer to one question: **is BuhlOS / Phil ready to use
onsite?**

**Short answer (snapshot `main @ 55ca30c`, 2026-06-05):** not ready for real
field roll-out; ready for **controlled internal dogfood with supervision**.
Current readiness rating: **2 / 5**.

## Read in this order

1. **[ROLL_OUT_STATUS.md](./ROLL_OUT_STATUS.md)** — the verdict: what's solid, what blocks roll-out (P0/P1/P2), what's safe vs unsafe for dogfood, the 0–5 readiness scale with the current rating, and the exact gates before a limited field pilot.
2. **[DOGFOOD_CHECKLIST.md](./DOGFOOD_CHECKLIST.md)** — the practical checklist for a supervised internal dogfood session: before / admin setup / field worker / office review / cleanup / stop conditions / report template.
3. **[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)** — a blunt, per-domain list of what is **not** finished, so a polished surface isn't mistaken for a production-ready one.
4. **[NEXT_HARDENING_LANE.md](./NEXT_HARDENING_LANE.md)** — the prioritised roadmap (P0/P1 before pilot → P1/P2 after dogfood → future only), each item with why-it-matters, status, recommended PR, risk, and dependencies.

## How to keep this pack honest

- Every status label (`MERGED` / `OPEN PR` / `IN PROGRESS` / `NOT STARTED` / `DEFERRED` / `FUTURE` / `DECISION NEEDED`) reflects `git log` + `gh pr` at the snapshot above. `main` moves fast — re-verify with the commands in [ROLL_OUT_STATUS § Status accuracy](./ROLL_OUT_STATUS.md#status-accuracy) before relying on a line.
- When you ship or fix something, update its label here **and** in ROLL_OUT_STATUS in the same PR. Don't let a closed limitation read as open, or a placeholder read as built.
- This pack is **docs-only**. It does not open work, change app code, or claim readiness.

## Related existing docs

- [../route-ownership.md](../route-ownership.md) — route owners, statuses, legacy/deprecated routes, and the guards.
- [../testing/Seeded-Authenticated-QA.md](../testing/Seeded-Authenticated-QA.md) · [../qa/authenticated-smokes.md](../qa/authenticated-smokes.md) — seeded QA accounts and authed smokes.
- [../testing/Claude-Authed-Preview-Smoke.md](../testing/Claude-Authed-Preview-Smoke.md) · [../testing/Known-Risk-Areas.md](../testing/Known-Risk-Areas.md) — Preview Smoke and the standing risk register.
- [../rebuild-audit/35-current-product-state-audit.md](../rebuild-audit/35-current-product-state-audit.md) — the deeper (earlier) product-state audit this pack distils for rollout.
- [../phil-capture.md](../phil-capture.md) — Phil photo/evidence Capture: shipped-state reference (what's real, metadata, honest states, permissions, tests, what's not built).
