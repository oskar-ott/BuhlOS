# Issue conventions — how the BuhlOS/Phil backlog stays coherent

One system for every issue, so the tracker never turns into a junk drawer.
The north star is [#120](https://github.com/oskar-ott/BuhlOS/issues/120)
(jobs born in BuhlOS → consumed in Phil); the backlog is organised into
**18 epics**, indexed in #120's *Epic index* table.

## The shape of an issue

Every feature issue uses the same nine sections (the `Feature` template
enforces this):

1. **`Part of …`** — first line links the epic umbrella (and #120 when
   pipeline-relevant).
2. **Problem** — the real pain, ≤3 sentences.
3. **Goal** — the outcome, ≤3 sentences.
4. **User story** — `As a <role>, I want <capability>, so that <value>.`
5. **Acceptance criteria** — 3–7 *testable* checkboxes.
6. **Current state (audited)** — what exists today, honestly. "Greenfield"
   is a valid answer; *describing shipped work as missing is not.* Check the
   code/docs before writing this section.
7. **Dependencies** — issue refs or "none".
8. **Future considerations** — 1–3 bullets.
9. **Technical notes** — endpoints, domains, constraints, test hooks.

## Titles

`<prefix>: <imperative, specific, lowercase>` — e.g.
`hours: split a day across multiple jobs`, `phil: build offline read cache v1`.

Prefixes: `admin` `phil` `jobs` `bible` `ai-drawings` `ai` `quoting` `xero`
`hours` `capture` `itp` `inventory` `docs` `analytics` `workforce` `portal`
`integrations` `platform`. Epic umbrellas are titled `Epic N — <Name>`.

## Labels

| Group | Labels | Rule |
|---|---|---|
| Epic | `epic:admin-ui` … `epic:infrastructure` (one per epic), `epic` (umbrellas only) | exactly one `epic:*` per issue |
| Priority | `P0-now` `P1-next` `P2-later` `P3-horizon` | exactly one. P0 = unblocks the pipeline or fixes field/office trust. P3 = long-term bet. |
| Surface | `phil` `buhlos` `platform` | one primary surface |
| Type | `bug` `enhancement` `documentation` `question` | as appropriate |

## Tracking

- Each **epic umbrella** carries a `## Children` task list
  (`- [ ] #123 — title`). GitHub ticks these automatically when the issue
  closes — the umbrella *is* the progress view. New issues in an epic must
  be appended to its umbrella list.
- PRs close issues with `Closes #N` in the body, so merging maintains the
  umbrellas for free.
- Filter views: by epic (`label:epic:quoting`), by horizon
  (`label:P1-next`), by surface (`label:phil`).

## Standing product rules (apply to every issue)

- **Stupid simple** — designed for tradespeople; if a worker needs an
  explanation, the design is wrong. Phil is one-handed, gloves, sunlight,
  bad signal.
- **Audit first, extend — don't rebuild.** `/v2/jobs` is the live admin
  surface; legacy `/admin/*.html` modules are still production tools;
  shipped systems (hours loop, capture v2, snags, observations) get
  extended, never recreated.
- **No fake UI** — unfinished features ship dark (feature flags) or
  honestly labelled, never half-broken.
- **AI assists, never silently decides** — outputs carry provenance and a
  human-verify path.
- Numbers/answers must be traceable to real records; missing data is named,
  not faked.

## Splitting and closing

- An issue should be one shippable slice (one PR series). If acceptance
  criteria read like phases, split it and link the parts.
- Close stale/superseded issues with a one-line reason and a pointer —
  never silently.
