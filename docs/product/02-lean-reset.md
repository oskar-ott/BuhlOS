# 02 · Lean reset (2026-07)

**Status: ratified — product-owner decision, 2026-07-18.** This document
records the scope reset that supersedes the *breadth* of what shipped after
[01-mvp-rebuild-scope.md](01-mvp-rebuild-scope.md); it does not change the
phase discipline of that document — it re-asserts it.

## The decision

Development ran far past the MVP line: five-plus operational loops deep, with
many features shipped half-proven (the ITP/QA loop, materials, dayworks,
observations, quotes, claims, AI surfaces, …). Pushed to the company as-is,
the product reads as broken. Per the lean-startup instinct this repo was
scoped with, the product is **reset to a lean core that is finished, polished
and provable end-to-end** — and everything else is **hidden, not deleted**.

> Founder's rule: **hide everything that isn't built.** A hidden feature
> leaves **no trace** on kept surfaces — no nav item, no tile, no count, no
> "under construction" panel, no "coming soon" copy, no push notification, no
> search result, no dead link. Reversal is one dial at `/owner`.

## The lean core (everything the product is, right now)

| Piece | Scope |
| --- | --- |
| **Hours** | Field worker logs hours in Phil and attributes them to a job (live) → boss reviews and approves **on a phone** (`/hours/weekly` mobile flow + `/hours/approvals`) → approved hours export to **Xero as draft timesheets** (immutable batches, `/hours/period`). |
| **Jobs — deliberately basic** | Created **in the mobile app**: job name + ServiceMate-or-custom number + site address (`PhilNewJobSheet`, behind `phil_sharpened`). No structure, no "work to be done". |
| **Tag register** | Per job, mobile-first, photo-OCR assisted (`api/tags.js`, `TagRegisterClient`). |
| **Simple ITP builder** *(to build)* | Mobile-only: start ITP → name an area → photos → repeat → generate a plain PDF (area name + photos per area). Its **own** flag; metadata Supabase-first; photo binaries in Blob. The heavy office ITP system stays hidden. |
| **Capture / evidence** | Photo capture into the job (the field loop) stays live. |
| **Supporting plumbing** | Login, employees/People (workers must exist to log hours + map to Xero), gear register, My Day home, leave, onboarding/invite, settings, Command Centre, Owner Console. |

### The payslip boundary (unchanged, deliberate)

The system carries approved hours **into Xero as DRAFT timesheets and stops**
(payroll-boundary ADR #609): no pay runs, approval, STP, tax, super or
payslips. The pay run is finished **inside Xero**. "Seamless to payslips"
means *seamless into Xero, one click from payslips* — accepted by the product
owner 2026-07-18.

### Data-plane direction (product-owner directive, 2026-07-18)

Use **Supabase where it can be**; no unnecessary double stores. Concretely:
finish the staged hours cutover (dual-write → PG-as-source → parity-gated
reads → PG-authoritative payroll read) per the existing roadmap docs, and
build **new** features (the simple ITP builder) Supabase-first for metadata.
Blob remains for binaries (photos) — that is storage, not a double store.

## Hidden (archived, not deleted)

> **Superseded 2026-07-27 by [The gut](#the-gut-2026-07-27):** the features
> below were hidden by this reset and their CODE has since been deleted.
> This section is kept as the record of what was hidden and why. The flags,
> the `/owner` re-enable dial and the "archived, not deleted" mechanism
> described here no longer apply to them — restoring one now means restoring
> from the `pre-gut-archive` tag.

Mechanism: each feature's flag in `api/_lib/feature-flags.js` was
reclassified from owner kill-switch (`default: true`) back to a **dark
launch-gate** (`default: false`) — the sanctioned way to archive a shipped
feature (see `docs/feature-flags.md`). Code, routes, APIs and data all
remained; every flag kept its Owner-Console board presentation, so any feature
could be re-enabled from `/owner` (Live dial / owner preview) without a deploy.

Hidden by this reset: **itp** (the heavy office ITP/QA system, incl.
`/itp-templates` + `/qa`), **observations_inbox**, **material_requests**,
**expenses**, **quotes**, **defects**, **snags**, **dayworks**, **diary**,
**documents**, **circuit_schedule**, **scope_reconciliation**,
**job_control**, **closeout**, **job_photos**, **job_activity** (incl. the
`/activity` feed), **reports**. Already dark and staying dark: RFIs,
certificates, safety docs, minutes, site instructions, progress claims, BOQ
import, proof sign-off, every AI surface, Job Builder redesign.

Still ON (kill-switches): **jobs**, **hours**, **evidence**, **employees**,
**gear**.

### No-trace enforcement (this reset's second half)

Flag-off already hides nav + 404s routes and APIs (#760, three layers). This
reset additionally removed every residual trace on kept surfaces: all
`UnderConstructionPanel` usages (and the component), "coming soon" copy
(login SSO note, Reset-PIN stub, onboarding ITP line), the My Day
quick-capture tiles + expense entry when their pipelines are hidden, the
Capture launcher's observation options, snag items in the Needs-you feed,
Command-Centre tiles/counts/error-chips for hidden sources, the mobile
approvals hub's hidden chips, snag results in search, snag quick-actions,
snag pushes (stale-snag cron, digest line) and their pref rows.

## The gut (2026-07-27)

**Status: done — executes the founder's delete decision.** The reset above
*hid* the non-core features; this pass **deleted their code from the working
tree**. The reasoning is the lean-startup one this repo is scoped with: hidden
code is still code — it anchors every design conversation, every "while we're
in here", every guard and every test run to a product five loops wider than
the one being sold. Archiving on a flag deferred that cost; the gut pays it.

**What was deleted.** The 16 lean-reset flags (`itp`, `observations_inbox`,
`material_requests`, `expenses`, `quotes`, `defects`, `dayworks`, `reports`,
`snags`, `scope_reconciliation`, `job_control`, `closeout`, `documents`,
`circuit_schedule`, `diary`, `job_activity`) **and** the never-lit launch
gates that were never going to be lit (`rfi_register`,
`certificates_register`, `safety_docs`, `minutes_register`,
`site_instructions_register`, `variations_register`, `progress_claims`,
`job_doc_import`, `admin_proof_review`, every `ai_*` surface,
`job_builder_redesign`, `admin_job_field_view`) — each feature's API
handler(s), `src/domains` code, routes, components, server modules,
importers, smoke scripts and tests, and finally the flag itself (registry +
`FLAG_PRESENTATION` + the `FlagKey` union). The registry is down from 66 flags
to 30. Root one-off migration scripts and `docs/prototype/` went with them.

**What stayed.** The lean core — jobs, hours (incl. the whole Xero/payroll
path), evidence, employees, gear, the per-job tag register, `job_photos`,
`signup_link`, `itp_simple` — plus the plans surfaces (visible-adjacent,
deliberately untouched this round) and all Supabase data-plane machinery.
`api/job-profitability.js` and the hub's Profitability + Budget cards stayed
by the owner's step-5 call.

**Data was NOT deleted.** Only code. Every blob store (including hidden
features' `data.json` slices) is untouched and still in the backup manifest.

**Restoring.** The pre-gut tree is tagged **`pre-gut-archive`**:

```bash
git show pre-gut-archive:api/snags.js > api/snags.js        # one file
git checkout pre-gut-archive -- src/domains/observations     # one feature
git diff pre-gut-archive..HEAD --stat                        # what went
```

A restored feature also needs its flag re-added to `api/_lib/feature-flags.js`
(registry + presentation) and `api/_lib/feature-flags.d.ts`.

**Route contract.** The deleted top-level routes (`/observations`,
`/material-requests`, `/expenses`, `/defects`, `/reports`, `/qa`,
`/itp-templates`, `/activity`, `/v2/quotes`, `/v2/dayworks`) now `307` to
`/command-centre` — the [`route-ownership.md`](../route-ownership.md) §6
"no modern equivalent yet — single honest entry" pattern, so a bookmark lands
somewhere real instead of 404ing. `/admin/materials` was re-pointed the same
way. Deleted per-job sections just 404.

**Leftovers** are tracked on **#923** (the step-5 dead-code sweep): the plans
surfaces, the stale route prefixes still listed in `src/middleware.ts` (a
parallel session owns that file), and the zero-consumer endpoints the gut left
alone because no deleted feature owned them.

## Operational notes

- **Runtime overrides beat code defaults.** If a feature was ever toggled at
  `/owner`, `flags.json` may carry a `true` override that keeps it visible
  after this deploy. After release: open `/owner` and set any still-live
  hidden feature to **Off** (or clear the override).
- **Re-enabling** a feature is the reverse: `/owner` → Live (or preview it
  first owner-only). Nothing was deleted.
- **Gear** stays on this pass (it is built and proven, and the tag-register
  plumbing is adjacent); hiding it later is one flip.
- The cross-surface architecture direction (task-led jobs) and the Phil
  constitution are **unchanged** by this reset — hiding features removes
  slots, it does not amend principles. Field-visible changes still
  preview-verify before `main` per the standing rules.

> **Follow-on (2026-07-25):** how work is *selected and validated* after this
> reset is governed by [03-lean-startup-loop.md](03-lean-startup-loop.md) —
> the weekly Build–Measure–Learn cadence and the pull-based feature rule.

## What happens next (sequenced — status stamped 2026-07-18)

1. ✅ **Lean surface shipped**: the hide pass merged (PR #910) and the
   residual traces the step-5 audit found were closed the same day
   (#915 → PR #917). Outstanding operational step: the owner's `/owner`
   sweep for stale `flags.json` overrides.
2. **Hours money-path proving** — NEXT, needs the product owner in the
   loop: Xero flags on in preview, real org connect (Demo Company (AU)),
   worker/pay-item mappings confirmed, one batch → draft timesheets.
   All code + schema are merged and migrated; nothing left to build first.
3. ◐ **Mobile approval polish**: pending-hours reminder cron wired (#392 →
   PR #911), then rescheduled to the week boundary by owner directive —
   Sunday 18:00 + Monday 07:30 Sydney, two-week window (PR #914); one
   payroll-export model done (#895 → PR #905). Remaining: anointing
   `/hours/weekly` as THE approval path (product call).
4. **Lean field app on**: `phil_sharpened` preview-verified (mobile job
   create + 5-slot nav), then defaulted, per governance P15.
5. ✅ **Job page strip** (#916 → PR #922, owner preview-walked and merged
   2026-07-18): both job pages are down to identity + tags + capture
   (+ ITP link); photos gallery restored to the core (`job_photos`
   kill-switch, default ON); everyone can create jobs (office New-job +
   Phil mobile create). Internal dead-code sweep: #923.
6. ✅ **Simple ITP builder** built (#912 → PR #913): `itp_simple` flag,
   Supabase-first metadata migrated dev+prod, Blob binaries, job-page
   link-out. Dark until the owner previews and flips.
7. **Hours data-plane cutover** to Supabase per the directive above
   (in progress in a parallel working session).
8. ✅ **The gut** (2026-07-27): the hidden features' code deleted from the
   tree — see [The gut](#the-gut-2026-07-27) above. Restore point:
   `pre-gut-archive`.
