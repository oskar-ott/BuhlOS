# Phase D2 · Evidence foundation runbook

> **Status:** shipped — PR #13. Authoritative for D2 (backend foundation only).
> **Read alongside:** [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md), [27-interface-usability-pass.md](27-interface-usability-pass.md), [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md).
>
> Non-numeric filename intentional — sits alongside `phase-c-rollout-runbook.md`. Avoids collision with any `28-*.md` planning doc that future Session 4 PRs may land on its own branch.

---

## 1 · What D2 ships

| Layer | File | Purpose |
| --- | --- | --- |
| Domain | `src/domains/evidence/{schema,types,format,service,client}.ts` | EvidenceItem + state machine + display helpers + typed client |
| Domain | `src/domains/audit-log/{schema,types,client}.ts` | Cross-surface monthly journal (D2 bootstrap) |
| API | `api/evidence.js` | `GET` list, `POST` create, `POST ?action=review` (admin stub for D4) |
| API | `api/photos.js` | `?action=upload-evidence-photo` action branch (33-line addition) |
| Storage | `api/_lib/audit-log.js` | Append-only `audit/<yyyy-mm>.json` helper |

**D2 ships no UI.** D3 wires the Phil capture sheet on top of these endpoints; D4 wires the admin review surface against the same data and the review POST.

---

## 2 · API contract

### `GET /api/evidence?jobId=<jobId>`

| Status | When |
| --- | --- |
| 200 | `{ evidence: EvidenceItem[] }`, newest-first |
| 400 | `jobId` query missing |
| 401 | unauthenticated |
| 403 | role=client; or worker not assigned to `jobId` |

Tradie callers receive only own captures (`capturedById === me.id`). Admin and leading hand receive all captures for the job.

### `POST /api/evidence?jobId=<jobId>`

Body:
```json
{
  "kind": "photo" | "note",
  "areaId": "ar_...",                     // optional
  "stage": "roughIn" | "fitOff",          // optional; required if taskId set
  "taskId": "rt_..." | "ft_...",          // optional; validates against canonical tasks
  "photoId": "1234_xyz",                  // required when kind=photo
  "photoUrl": "https://blob.../...jpg",   // required when kind=photo
  "thumbnailUrl": "https://...",          // optional
  "note": "...",                          // required when kind=note; ≤280 chars
  "clientCapturedAt": "2026-05-25T...",   // optional metadata
  "exifLocation": { "lat": -33, "lng": 151 } // optional
}
```

Server fills `id`, `capturedBy{Id,Name,Role}`, `capturedAt`, `status='submitted'`, `source`, `auditLogIds`, `createdAt`, `updatedAt`. Client cannot set `status` on create.

| Status | When |
| --- | --- |
| 201 | `{ evidenceItem: EvidenceItem }` — canonical written row |
| 400 | invalid body / unknown stage / taskId not on area+stage / areaId not on job / note too long |
| 401 | unauthenticated |
| 403 | role=client; worker not assigned (`canWrite` false) |
| 404 | unknown job |
| 502 | blob write failed |

### `POST /api/evidence?jobId=<jobId>&action=review` (admin only — D4 stub)

Body:
```json
{
  "evidenceId": "ev_...",
  "status": "reviewed" | "rejected" | "submitted",
  "rejectionReason": "..." // required when status=rejected; ≤500 chars
}
```

State machine (`canTransition`):
- `null → submitted` (create only)
- `submitted → reviewed`
- `submitted → rejected`
- `reviewed → submitted` (admin un-review)
- everything else → 400

| Status | When |
| --- | --- |
| 200 | `{ evidenceItem }` — canonical updated row |
| 400 | invalid body / illegal transition / missing rejectionReason on reject |
| 401 | unauthenticated |
| 403 | not admin |
| 404 | evidence not found on job |
| 502 | blob write failed |

### `POST /api/photos?jobId=<jobId>&action=upload-evidence-photo`

Body: `{ dataUrl: "data:image/jpeg;base64,..." }`. Returns `{ id, url, capturedAt }`. 6 MB cap (413). Storage path: `jobs/<jobId>/evidence-photos/<photoId>.jpg`.

---

## 3 · Storage shape

`jobs/<jobId>/data.json` (existing per-job blob, also used by snags + dwellings + task-toggle):

```json
{
  "dwellings": { /* … */ },
  "snags": [ /* … */ ],
  "evidence": [ EvidenceItem, … ],
  "notes": [ /* … */ ]
}
```

Doc 24 §15.0 Decision 2 picked Option A (append to the per-job data blob, full-doc rewrite). Race window ≈ 50 ms; size impact ≈ 200 B/item. Postgres split happens in Phase F+ if and when item counts grow.

`audit/<yyyy-mm>.json` (new):

```json
{
  "entries": [
    {
      "id": "al_...",
      "ts": "2026-05-25T14:30:00.000Z",
      "action": "evidence.captured" | "evidence.reviewed" | "evidence.rejected",
      "actorId": "user-...",
      "actorName": "Sam",
      "actorRole": "tradie" | "admin" | "leadingHand" | null,
      "jobId": "birdwood-iv3232" | null,
      "targetType": "evidence",
      "targetId": "ev_...",
      "summary": "photo evidence captured — \"…\"",
      "metadata": { /* action-specific */ }
    }
  ]
}
```

Append-only. Caps at 5000 entries/month, trims oldest to 4000 on overflow.

`jobs/<jobId>/audit.json` (legacy per-job structural log) — **also written on every evidence event** so the admin audit tab keeps working. Doc 28 §A.5 dual-write rule.

`jobs/<jobId>/evidence-photos/<photoId>.jpg` — binary photo storage. Same namespace pattern as `snag-photos/` and `itp-photos/`.

---

## 4 · Validation rules

| Rule | Server check | Schema refinement |
| --- | --- | --- |
| `kind=note` ⇒ non-empty note | ✓ | ✓ |
| `kind=photo` ⇒ `photoId` + `photoUrl` | ✓ | ✓ |
| `note` ≤ 280 chars | ✓ | ✓ |
| `taskId` ⇒ `stage` | ✓ | ✓ |
| `taskId` resolves against canonical tasks | ✓ (server-only) | — |
| `areaId` exists on job | ✓ (server-only) | — |
| `stage ∈ { roughIn, fitOff }` | ✓ | ✓ |
| `status=rejected` ⇒ non-empty `rejectionReason` | ✓ | ✓ |
| `rejectionReason` ≤ 500 chars | ✓ | ✓ |
| Legacy `stages: { roughIn: [strings] }` never accepted as taskId | ✓ (uses `effectiveRoughInTasks`) | — |
| Client cannot set `status` on create | ✓ (server fills) | — |

Canonical task resolution uses `api/_lib/job-tasks.js#effectiveRoughInTasks` / `effectiveFitOffTasks` — per-area override wins over job-level template.

---

## 5 · Permissions (doc 24 §15.0 #5 + #6; doc 28 §A.4)

| Caller | GET list | POST create | POST review |
| --- | --- | --- | --- |
| unauthenticated | 401 | 401 | 401 |
| client | 403 | 403 | 403 |
| tradie (assigned) | own captures only | ✓ | 403 |
| tradie (not assigned) | 403 | 403 | 403 |
| leadingHand (assigned) | all on job | ✓ | 403 (D4 may revisit) |
| leadingHand (not assigned) | 403 | 403 | 403 |
| admin | all on any job | ✓ on any job | ✓ on any job |

LH read-only on the review action is intentional and matches doc 24 §15.0 Decision 6.

---

## 6 · Audit dual-write (doc 28 §A.5)

Every evidence write fires both:

1. `api/_lib/audit-log.js#append(...)` — new monthly cross-surface journal.
2. `api/_lib/job-audit.js#appendAudit(...)` — legacy per-job structural log.

Both wrapped in `.catch(() => {})` — an audit failure on either path never blocks the evidence write. The new journal's row id is stamped onto the EvidenceItem's `auditLogIds[]` so a future admin drawer can resolve the full history without scanning monthly blobs.

---

## 7 · D3 handoff (what the next session needs)

1. `CaptureSheet.tsx` MUST live in `src/components/phil/` (doc 24 D-26 RSC manifest rule).
2. Photo capture flow: `service.resizeImageToDataUrl(file, 1920, 0.7)` → `POST /api/photos?action=upload-evidence-photo` → consume `{ id, url, capturedAt }` → `POST /api/evidence` with `kind=photo`, `photoId`, `photoUrl`.
3. Note flow: `POST /api/evidence` with `kind=note`, `note`.
4. "Today's captures" strip: `GET /api/evidence?jobId=X` (server already filters to own captures for tradie).
5. Status pill tones: `src/domains/evidence/format.ts#statusTone` (5-tone palette from doc 27 §6.2).
6. Sheet closes on first Submit tap (doc 27 BUG-C-003 lesson from Phase C).
7. Submit response is the canonical row — do NOT re-fetch via GET (Phase C BUG-C-004 lesson; Blob has ~5 s read-after-write window).

---

## 8 · D4 handoff (admin review)

1. Use `POST /api/evidence?action=review` — D2 ships the endpoint, D4 ships the UI.
2. Review UI components MUST live in `src/components/admin/` (mirror of the D3 binding rule).
3. State machine: `canTransition` already enforced server-side. Client can mirror via `src/domains/evidence/service.ts#canTransition`.
4. Audit drawer reads `auditLogIds` on each item, resolves through `audit/<yyyy-mm>.json` blobs. Helper: `src/domains/audit-log/client.ts#entriesForTarget`.
5. Doc 24 §15.0 Decision 6: LH read-only in Phase D. The review endpoint already 403s for non-admin.

---

## 9 · Test-data cleanup

Evidence POSTs in preview / dev create real rows in `jobs/<jobId>/data.json` under `evidence[]`. There is no automated cleanup endpoint yet. Conventions for safe testing:

1. **Note text** — prefix `TEST D2 <ISO timestamp>` so future audits can filter / nuke.
2. **Photo binaries** — uploaded photos go to `jobs/<jobId>/evidence-photos/<photoId>.jpg`. These are NOT auto-cleaned. Manual `del()` via the Vercel Blob dashboard or a one-off script is acceptable for preview testing.
3. **Audit rows** — append-only by design. Tagging a row "TEST" in the summary is the only marker; future analytics filters can exclude.
4. **Production smoke** — read-only checks only. Do NOT create captures on `buhlos.com` unless explicitly part of a field test (per doc 28 §E).

---

## 10 · Known limitations

| ID | Limitation | Mitigation |
| --- | --- | --- |
| D2-L1 | No server-side idempotency for double-submit | D3 capture sheet owns this via disable-on-submit (doc 24 D-22) |
| D2-L2 | Photo upload + evidence create are two POSTs; orphan photos possible if step 2 fails | Acceptable for D2; handover to D3 cleanup story; no auto-GC |
| D2-L3 | Vercel Blob ~5 s read-after-write window | POST response returns canonical row; clients consume directly, don't re-fetch |
| D2-L4 | Full-doc rewrite of `data.json` on every evidence write | Bounded by small per-job evidence counts; Postgres split in Phase F+ |
| D2-L5 | Monthly audit blob caps at 5000 entries | Trim to 4000 on overflow (FIFO); evidence load expected to sit well below |
| D2-L6 | No GET endpoint for the new audit journal | D4 adds it alongside the review UI (admin drawer needs it) |
| D2-L7 | Rejected items can only re-roll via a new POST (preserving rejected row) | D4 reject drawer should offer "re-capture" affordance, not in-place mutation |

---

## 11 · Cross-references

- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — Phase D scope + data model.
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + §6.2 marker dictionary.
- [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md) — sibling runbook precedent.
- `src/domains/evidence/*` — domain implementation.
- `src/domains/audit-log/*` — journal domain.
- `api/evidence.js` — REST handler.
- `api/_lib/audit-log.js` — journal storage.
- `api/photos.js` — `upload-evidence-photo` action branch.
