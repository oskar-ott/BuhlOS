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

Mechanism: each feature's flag in `api/_lib/feature-flags.js` was
reclassified from owner kill-switch (`default: true`) back to a **dark
launch-gate** (`default: false`) — the sanctioned way to archive a shipped
feature (see `docs/feature-flags.md`). Code, routes, APIs and data all
remain; every flag keeps its Owner-Console board presentation, so any feature
can be re-enabled from `/owner` (Live dial / owner preview) without a deploy.

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

## What happens next (sequenced)

1. **Lean surface ships**: this hide pass + preview verification.
2. **Hours money-path proving**: Xero flags on in preview, real org connect,
   worker/pay-item mappings confirmed, one batch → draft timesheets
   (needs the product owner in the loop).
3. **Mobile approval polish**: `/hours/weekly` anointed as the approval path;
   pending-hours reminder cron wired; one payroll-export model (#895
   reconciliation).
4. **Lean field app on**: `phil_sharpened` preview-verified (mobile job
   create + 5-slot nav), then defaulted, per governance P15.
5. **Job page strip**: Phil job page + office hub down to identity + tags +
   capture (+ new ITP), preview-verified.
6. **Simple ITP builder** built (own flag, Supabase-first metadata).
7. **Hours data-plane cutover** to Supabase per the directive above.
