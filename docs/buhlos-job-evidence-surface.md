# BuhlOS Job Evidence Surface — v1 contract

_Status: shipped (this slice extends it). Owner surface: the admin Job interface._

## What it is

The **Job Evidence Surface** lets a BuhlOS admin open a job and understand, at a
glance, the photo / note evidence the field has captured on it — without leaving
the job. It is deliberately **job-scoped**: there is no global Evidence inbox and
no top-level Evidence sidebar item. Evidence belongs inside the job interface.

It is two cooperating pieces, both already in `main`:

| Piece | File | Role |
| --- | --- | --- |
| **Overview summary card** | `src/components/admin/JobEvidenceSummary.tsx` | A calm, read-only summary on the job hub (`/v2/jobs/[jobId]`). Status breakdown + provenance + latest capture, deep-linking to the full queue. |
| **Review queue tab** | `src/app/v2/jobs/[jobId]/evidence/page.tsx` + `EvidenceQueue`/`EvidenceDrawer`/`EvidenceFilterBar` | The full per-job review surface (thumbnails, drawer, review / reject / un-review). Admin write; leading-hand read-only. |
| **Pure derivation** | `src/domains/jobs/job-evidence.ts` (`summariseJobEvidence`) | Turns the real evidence list into the summary. No fetch, no React, fully unit-tested. |

## Data source & contract

Evidence is persisted **per job** in `jobs/{jobId}/data.json` under an
`evidence: []` array and read via `GET /api/evidence?jobId=<id>` (already scoped
to one job, newest first). The summary is derived from the real
`EvidenceItem` rows — never fabricated. Fields the surface relies on
(`src/domains/evidence/schema.ts`):

| Field | Used for | Notes |
| --- | --- | --- |
| `jobId` | defensive job filter | summary ignores rows from other jobs |
| `status` | `submitted`→to review, `reviewed`, `rejected` | `uploading` / `pending_sync` are **client-only** and never serialise |
| `source` | provenance: `phil`→field, `admin`→office | written by `api/evidence.js` `sourceForUser()`; `system` is reserved/unwritten |
| `kind` | `photo` / `note` split | |
| `taskId` / `areaId` / `stage` | "missing context" (none attached) | a real quality signal, not invented |
| `capturedById` / `capturedByName` / `capturedAt` | distinct worker count + latest caption | |

## What v1 surfaces (this PR)

The overview card answers, from real data only:

- **Does this job have any evidence?** — honest empty state when not.
- **How much, and what state?** — total, `to review` / `reviewed` / `rejected` pills.
- **Did it come from the field (Phil)?** — `N from the field · M from the office`,
  read off the real `source` stamp. _Added in this slice._
- **Photos vs notes?** — a plain `kind` split. _Added in this slice._
- **Anything unattached?** — captures linked to no task / area / stage.
- **When was the latest capture, and by whom?**
- **Where do I review the detail?** — deep link to the `/evidence` tab.

## Deferred — and why (no faking)

These are **not** shown because the data to back them honestly does not exist yet:

- **Failed uploads.** The server only ever persists `submitted | reviewed |
  rejected`. The `uploading` / `pending_sync` states live in the Phil capture
  sheet's local component state and never reach the blob, so a failed upload
  leaves **no server record**. Showing a "failed uploads" count today would be
  fabricated. Surfacing it needs a new persistence/telemetry model on the
  capture client (out of scope here; must not touch the capture flow).
- **ITP / snag linkage.** `EvidenceItem` carries `taskId` / `areaId` / `stage`
  but **no `itpId` / `snagId`**. Convert-to-snag creates a separate snag record;
  it does not back-link onto the evidence row. A "linked to ITP/snag" signal is a
  later slice (either a new field on capture, or a cross-reference join).
- **Thumbnails on the hub.** Intentionally left to the `/evidence` tab — the
  hub stays a calm summary, not a photo wall.

## Constraints honoured

- Read-only. No new writes, no new API, no API behaviour change.
- Job-scoped. No global Evidence module / inbox / sidebar item.
- No fabricated rows, counts, thumbnails, statuses, or upload-success state.
- No change to Phil capture, Phil hours, or any time-entry surface.

## Recommended next slice

Add a job-linkage signal to evidence (decide: new `snagId`/`itpId` on capture
vs. a derived cross-reference), so the summary can also answer "is this evidence
attached to an ITP/snag?" — the one admin question this surface still cannot
answer from real data.
