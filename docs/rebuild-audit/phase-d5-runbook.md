# Phase D5 · Evidence hardening + field rollout runbook

> **Status:** shipped — PR #16 (this PR). Hardening pass on top of D2/D3/D4 evidence loop.
> **Read alongside:** [phase-d2-runbook.md](phase-d2-runbook.md), [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md), [27-interface-usability-pass.md](27-interface-usability-pass.md), [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md), [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md), [phase-c-rollout-runbook.md](phase-c-rollout-runbook.md).
>
> Non-numeric filename intentional — sibling of `phase-d2-runbook.md` and `phase-c-rollout-runbook.md`.

---

## 1 · What D5 ships

D5 closes the gaps the planning docs flagged as `D4-4` and `D4-11` risks plus the admin un-review path the docs marked optional:

| Surface | Change |
| --- | --- |
| `api/audit-log.js` | New `GET` endpoint. Filters monthly journal blobs by `targetType` + `targetId` + `jobId`. Role-aware: tradies see entries about their own captures only. |
| `src/domains/audit-log/{schema,types,client}.ts` | `evidence.unreviewed` action added; `AuditLogListResponseSchema` + `listAuditForTarget` typed wrapper. |
| `src/components/admin/EvidenceDrawer.tsx` | History section now consumes the read endpoint (UC placeholder retired). Shows action-icon + actor + ISO time, sorted newest-first. |
| `src/components/admin/EvidenceUnreviewModal.tsx` | New confirmation modal for `reviewed → submitted`. Optional reason captured in audit summary only. |
| `src/components/admin/EvidenceQueue.tsx` | Wires the un-review modal; drawer footer surfaces "Un-review" for reviewed items (admin only). |
| `api/evidence.js` | Adds `evidence.unreviewed` audit verb for the `reviewed → submitted` transition; carries optional `reason` into audit summary + metadata. |
| `src/domains/evidence/schema.ts` | `ReviewEvidencePayloadSchema.status` now accepts `'submitted'` (un-review); adds optional top-level `reason`. |
| `scripts/smoke-evidence-routes.js` | Live HTTP smoke against any deployment URL. 18 checks covering HTML route gating + API auth wall. |
| `package.json` | New `npm run smoke:evidence-routes` script entry. |
| `docs/rebuild-audit/phase-d5-runbook.md` | This doc. |

**Tests added:** 3 (un-review schema variants) + the existing audit-log enum-in-sync test updated. Full vitest **284/284**.

**No D3 capture UI changes.** No vercel.json. No public/*.html. No new admin routes. No snags/ITPs/RFIs/materials.

---

## 2 · New endpoint: `GET /api/audit-log`

```
GET /api/audit-log?targetType=evidence&targetId=<id>&jobId=<jobId>[&months=N]
```

| Status | When |
| --- | --- |
| 200 | `{ entries: AuditLogEntry[] }`, newest-first |
| 400 | missing `targetType` / `targetId` / `jobId`, or unsupported `targetType` |
| 401 | unauthenticated |
| 403 | role=`client`, or worker not assigned to job |
| 500 | journal read failed |

- `targetType` is closed to `'evidence'` in D5; D.5 / E1 add more.
- `months` defaults to 2 (scans the current + previous monthly blobs). Server caps at 12.
- Tradie filter: only entries the tradie was the actor for, OR entries about evidence the tradie captured. Cheaper than a per-entry membership check — D5 resolves ownership once per request via the per-job evidence read.
- LH / admin: every matching entry on the job.

---

## 3 · State machine — updated

D2/D3/D4 covered three transitions; D5 adds the fourth:

```
                      ┌── client-only ──┐
                      │                 │
draft ─► uploading ─► pending_sync ─► submitted ─► reviewed
                                          │           │
                                          ▼           │ (D5 un-review)
                                       rejected       ▼
                                                   submitted
                                       (workers re-capture
                                        instead of round-trip)
```

| From | To | Verb | Audit action |
| --- | --- | --- | --- |
| `null` | `submitted` | (create) | `evidence.captured` |
| `submitted` | `reviewed` | mark reviewed | `evidence.reviewed` |
| `submitted` | `rejected` | reject with reason | `evidence.rejected` |
| `reviewed` | `submitted` | un-review | **`evidence.unreviewed`** (D5) |

Everything else → 400 server-side (`canTransition` rejects).

---

## 4 · Un-review UX

- Surfaced only in the drawer footer (not as a row action — the row is for primary triage, the drawer is where the admin makes a considered decision).
- Admin-only — LH never sees the button.
- Confirmation modal mirrors the reject modal shell, but the reason field is optional (the un-review is itself a "I made a mistake" signal; making the reason required would block the corrective action).
- Reason ≤500 chars, capped client + server.
- The reason becomes the audit summary (`evidence un-reviewed — "<reason>"`) and lands in `metadata.unreviewReason`. The row's `rejectionReason` field is untouched (reserved for rejected items only).
- After un-review, the row reverts to `status='submitted'`, the `reviewedById/Name/At` fields stay set (so the worker sees "Previously reviewed by Anna" if D4 surfaces that copy — D5 does not).

---

## 5 · Drawer history wiring

- Fetches on drawer open + on item status change.
- Loading state: dashed placeholder.
- Error state: rose-tinted alert.
- Empty state: dashed placeholder ("No audit entries yet.") — should be rare after D2's dual-write.
- Each entry: an action icon (different per verb), the server-rendered summary, actor name + role + ISO time.

Three icons:
- `evidence.captured` → sky/blue pen icon
- `evidence.reviewed` → emerald/green check icon
- `evidence.rejected` / `evidence.unreviewed` → rose/red X icon (the same icon for both is intentional — they're both "stepped-on" transitions vs the linear `captured → reviewed` happy path)

---

## 6 · Production smoke script

```
npm run smoke:evidence-routes                 # buhlos.com
npm run smoke:evidence-routes -- <preview>    # any vercel preview
```

18 unauthenticated checks covering:
- 9 HTML routes (gated + legacy)
- 6 API GETs (auth wall returns 401 JSON)
- 3 API POSTs (D2/D3 + D4 review + D3 photo upload)

Exit 0 if all pass, 1 if any fail. **Run this after every D-phase merge** as part of the production smoke ritual.

If a check fails:
- `404 text/html` on an API endpoint → the endpoint isn't deployed yet (CDN miss, or the deploy didn't include it). Wait ~60s and retry, then escalate.
- `200 text/html` on a gated route → middleware regression. Stop the rollout and inspect `src/middleware.ts`.
- `401 application/json` on `/api/auth?action=login` with fake creds → expected and correct.

---

## 7 · Field test script (manual, with credentials)

Run this on the preview before promoting any D-phase release. ~10 minutes.

**Tradie:**
1. Log in as a tradie assigned to `birdwood-iv3232`.
2. `/phil/jobs` → confirm assigned jobs visible only.
3. Open `birdwood-iv3232` → site context, stage chooser, area picker render.
4. Tap **Capture evidence** → sheet opens full-screen.
5. Take/pick photo → preview + file size shows.
6. Note: `TEST D5 Field Test <ISO timestamp>` (max 280 chars; counter visible).
7. Pick stage + area + task.
8. Submit → sheet closes; "Evidence captured" green banner; new card in Today's captures with `Submitted` pill.
9. Tap card → drawer shows photo + note + target.
10. Refresh page → strip still shows the item.

**Admin:**
11. Log in as admin.
12. Open `/v2/jobs/birdwood-iv3232/evidence` → row visible with the test note.
13. Tap row → drawer slides in; **History** section shows `evidence.captured` row.
14. Tap **Mark reviewed** → row flips to `Reviewed` pill; History adds `evidence.reviewed` row.
15. Tap the reviewed row → drawer footer now shows **Un-review** copy + button.
16. Tap **Un-review** → modal opens; submit with reason `Wrong area — TEST D5`.
17. Row flips back to `Submitted` pill; History adds `evidence.unreviewed` row.
18. Tap **Reject** → reject modal blocks empty reason; submit with reason `TEST D5 reject`.
19. Row flips to `Rejected` pill with reason inline; History adds `evidence.rejected` row.

**LH:**
20. Log in as a LH assigned to the job.
21. Open `/v2/jobs/birdwood-iv3232/evidence` → "Read-only — leading hand" pill in header card.
22. Confirm Review / Reject / Un-review buttons are **not** present on rows or in the drawer.

**Cleanup:**
- Evidence rows persist; they're labelled `TEST D5 Field Test <ISO>` so post-test filtering / manual removal is trivial.
- Photo blobs persist at `jobs/birdwood-iv3232/evidence-photos/*` (no auto-GC — D2-L2).
- Audit rows persist in `audit/<yyyy-mm>.json` (append-only).
- The script's manual deletion path: use the Vercel Blob dashboard to remove `jobs/birdwood-iv3232/evidence-photos/<photoId>.jpg` + (optionally) edit the job's `data.json` to remove `evidence[]` entries with the TEST prefix.

---

## 8 · Permissions matrix (full evidence loop)

| Caller | GET evidence | POST capture | POST review | POST un-review | GET audit-log |
| --- | --- | --- | --- | --- | --- |
| anonymous | 401 | 401 | 401 | 401 | 401 |
| client | 403 | 403 | 403 | 403 | 403 |
| tradie (assigned) | own only | ✓ | 403 | 403 | own activity / own captures only |
| tradie (not assigned) | 403 | 403 | 403 | 403 | 403 |
| LH (assigned) | all on job | ✓ | 403 | 403 | all on job |
| LH (not assigned) | 403 | 403 | 403 | 403 | 403 |
| admin | all | ✓ | ✓ | ✓ | all |

---

## 9 · Known limitations (post-D5)

| ID | Limitation |
| --- | --- |
| D5-L1 | Audit-log scans `months` recent blobs, default 2. A capture > 2 months old won't show in the drawer unless the caller passes `&months=N`. Acceptable for evidence on active jobs; revisit when long-tail jobs ship. |
| D5-L2 | Un-review doesn't reset `reviewedById/Name/At` on the row. The audit-log captures the un-review event, but the row still shows "Reviewed by Anna" until a fresh review writes new values. Acceptable: the row stays in the `submitted` queue, so any next reviewer's name overwrites. |
| D5-L3 | No durable offline queue for capture (carried from D3-L1). |
| D5-L4 | No bulk reject — by design (D4 §6.5). |
| D5-L5 | No automated cleanup endpoint for test evidence (carried from D2-L2). The smoke script is read-only by design. |
| D5-L6 | LH's view of audit-log is per-job — they see all entries on jobs they're assigned to, not just their own activity. Acceptable for site-team visibility; tighten if a privacy review demands it. |

---

## 10 · Field rollout checklist (Oskar)

Run before letting workers use the system in anger:

- [ ] `npm run smoke:evidence-routes` against `buhlos.com` → 18/18 pass.
- [ ] Field test §7 — tradie + admin + LH — all 22 steps pass.
- [ ] One worker captures evidence on a real (non-TEST) job → admin reviews it within an hour.
- [ ] Admin un-reviews their own decision once to verify the audit log records both events.
- [ ] Confirm Vercel Blob storage hasn't grown unexpectedly (check the Blob dashboard for `jobs/<id>/evidence-photos/` size; sanity-check vs the expected number of captures).
- [ ] Confirm no Sentry / Vercel error spike in the 60 minutes after first real worker use.

If any item fails — pause rollout, file a hardening branch, repeat.

---

## 11 · Cross-references

- [phase-d2-runbook.md](phase-d2-runbook.md) — D2 API contract + storage shape.
- [24-phase-d-jobs-evidence-plan.md](24-phase-d-jobs-evidence-plan.md) — Phase D scope + data model.
- [27-interface-usability-pass.md](27-interface-usability-pass.md) — UI rules + §6.2 marker dictionary.
- [29-phase-d3-phil-capture-spec.md](29-phase-d3-phil-capture-spec.md) — Phil capture spec.
- [30-phase-d4-admin-evidence-review-spec.md](30-phase-d4-admin-evidence-review-spec.md) — admin review spec (D4-4 history risk, D4-11 un-review risk both retired by D5).
- `api/audit-log.js` — new read endpoint.
- `scripts/smoke-evidence-routes.js` — production smoke script.
