# Wiki sync — source of truth and how the published handbook stays honest

The GitHub Wiki (https://github.com/oskar-ott/BuhlOS/wiki) is the **readable
published handbook**. It is *not* the source of truth. This file records the
source-of-truth hierarchy and the standing rule for keeping the wiki in sync with
the repo. For the history of how the wiki was first built and how to re-audit it,
see [`docs/wiki-audit/wiki-source-audit.md`](wiki-audit/wiki-source-audit.md).

## Source-of-truth hierarchy

When two of these disagree, the higher one wins:

1. **Repo docs (`/docs`, `README.md`, `CLAUDE.md`)** — the source of truth.
   Durable decisions, the constitution package, architecture, ADRs.
2. **GitHub Wiki** — the readable, published handbook. Derived from repo docs;
   never the origin of a decision.
3. **ChatGPT / Claude memory** — working context only. Reflects what was true
   when written; verify against repo docs before acting on it.
4. **Prompts** — execution instructions for a task, not permanent truth. A prompt
   may direct work; it does not amend the constitution. Architecture-relevant
   prompts must pass the Constitution Gate (see `CLAUDE.md`).

If repo docs and current code disagree, document the disagreement and update the
docs **only if the code/history proves the newer rule is correct** — do not invent
architecture from chat or from a prompt alone.

## The wiki-touch rule

Any merged change that alters a documented product principle, workflow, or
architecture decision **must** be reflected in the wiki, after the repo-docs PR
merges. Order is always:

1. **Repo docs PR first** (this is where the decision is recorded and reviewed).
2. **Wiki sync after merge** — update the affected wiki page(s) to match.

Do **not** edit the external GitHub Wiki directly as the way to record a decision.
The repo has no automated wiki-publish pipeline today, so wiki updates are a manual
follow-up; keeping the decision in `/docs` first means nothing is lost if the wiki
edit lags.

## Per-page stamp convention

Every wiki page should carry, at top or bottom:

```
Source of truth: /docs/<path> (and any sibling docs)
Last synced from repo docs: <commit sha> (<date>)
```

This lets the next person see at a glance whether a page is current against `main`.
A page with no stamp is treated as unverified.

## Suggested wiki pages (and their source docs)

| Wiki page | Source of truth in repo |
|---|---|
| Home | `README.md` |
| BuhlOS Constitution | `docs/phil-constitution.md` + `docs/architecture/00-rebuild-non-negotiables.md` |
| Task-Led Job Architecture | `docs/architecture/task-led-job-architecture.md` + `task-led-jobs-adr.md` |
| Phil Field Interface | `docs/phil-architecture.md`, `docs/phil-governance.md`, `docs/phil-field-validation.md` |
| Admin / Boss Interface | `README.md` (Architecture table) + `docs/architecture/01-target-rebuild-structure.md` |
| Current Architecture Limits | `docs/architecture/proof-review-model.md`, `docs/architecture/task-blockers.md`, `docs/field-readiness/KNOWN_LIMITATIONS.md` |
| Decision Log | `docs/architecture/*-adr.md` |
| Next Build Priorities | `docs/phil-implementation-roadmap.md` + north-star epic [#120](https://github.com/oskar-ott/BuhlOS/issues/120) |

## Sync required after this PR merges

The constitution/docs update in this PR (task-led job architecture, the ADR, the
proof-review model, this hierarchy) is **not yet reflected in the wiki**. After
merge, sync at least: **Home**, **BuhlOS Constitution**, **Task-Led Job
Architecture** (new), **Current Architecture Limits**, and **Decision Log**, each
stamped with the merge commit.
