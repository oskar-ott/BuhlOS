# Production effective-flag verification

**Purpose.** Establish, with evidence, what a feature flag actually resolves to
in production for a given viewer — never from memory, never from the registry
alone. Background and vocabulary: [../feature-flags.md](../feature-flags.md)
"What a flag proves" and "Flipping a flag".

**Why a runbook.** Resolution is env `FLAG_*` › `flags.json` override ›
registry default, then targeting. Two of the three inputs live outside git,
so repository contents alone cannot establish effective state — CI proves
only that registry, typed union and docs agree (`npm run check:flag-docs`).

## Steps

1. **Registry default (repo, ~1 min).** On current `main`:
   `node -e "const {REGISTRY}=require('./api/_lib/feature-flags');console.log(REGISTRY['<flag>'])"`.
   Note `default`, `target`, `killSwitch`, `expires`.
2. **Effective state (production, ~2 min).** Sign in as the owner on the
   production host and open `/owner`. Find the flag on the feature board (or
   the collapsed *System · data-plane* group for `supabase_*` /
   `phil_jobs_summary_read`). Record **state** (On / Preview only / Off /
   Pinned by env) and **source** (env › blob › default). A *Pinned by env*
   flag cannot be changed at `/owner`; the env var is the truth.
3. **Env presence (Vercel dashboard, ~2 min, names only).** Project →
   Settings → Environment Variables, filter `FLAG_`. Record which `FLAG_*`
   names exist per environment (Production / Preview / Development). Never
   copy values into a doc, a chat or a ticket; `1`/`0` for a flag is fine to
   note as "on"/"off".
4. **Targeting (repo).** `admin-tier` flags are on only for admin-tier
   viewers; a field account never sees them even when the flag is on. If the
   question is "can a field worker see X", say which tier you checked as.
5. **Runtime override awareness.** If the source is *blob*, someone flipped
   it at `/owner`; the audit journal (`feature_flag.toggled`) says who and
   when — `/owner` → Audit trail, or `/api/audit-log?action=feature_flag.toggled`.
6. **Stamp it** in the feature's own doc (status block) and here:

| Flag | Registry default | Effective (viewer tier) | Source | Env names present (Prod) | Checked by | Date |
| --- | --- | --- | --- | --- | --- | --- |
| `invoice_capture` | off · admin-tier | | | | | |
| `receipt_capture` | off · global | | | | | |
| `job_purchases` | off · global | | | | | |
| `job_materials_spend` | off · admin-tier | | | | | |
| `phil_sharpened` | off · global | | | | | |
| `workshop_stock` | off · global | | | | | |

## What this does not prove

- That the feature is **externally configured** (mailbox rules, DNS, webhooks,
  secrets, migrations applied) — see the feature's runbook.
- That it is **operationally proven** — only real use, checked, does that.

## Rollback

A flag flipped by mistake at `/owner`: flip it back there (audited). A flag
pinned by env: change the env var in Vercel and redeploy — an owner action.
