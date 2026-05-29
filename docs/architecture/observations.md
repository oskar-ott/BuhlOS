# Observations — the field-to-office loop (PR 3 / PR 4)

> Status: **v1 foundation, live.** Conversion to RFI / Variation / Material
> Request records **intent only** — those downstream modules are not built yet
> and the UI says so. Nothing here fakes a record.

## 1. What an observation is

An **observation** is a piece of *site truth* captured in the field (Phil) or
the office (BuhlOS) that may or may not require action. It is the **general
field-to-office item** — deliberately broader than Evidence or a Snag so a
worker can capture *anything* in one flow and the office classifies/triages it.

Examples: "Bench location moved from plan", "Need 20m more tray", "Access denied
to Level 1", "Extra GPO requested by client", "Safety issue near switchboard",
"Need builder to confirm mounting height".

### How it relates to the records we already had

| Concept | What it is | Lifecycle | Relationship to Observation |
| --- | --- | --- | --- |
| **Evidence** (`src/domains/evidence`) | A photo / note that proves work or records a condition. | `submitted → reviewed / rejected` | An observation **may link** to an evidence row (`linkedEvidenceId`); evidence review is unchanged. Photo capture is still the Evidence flow — the Phil chooser offers it as the prominent first option. |
| **Snag** (`src/domains/snags`) | A specific quality defect with a verify/close lifecycle. | `open → in_progress → resolved → verified → closed` (+ rejected) | An observation can be typed `defect` and **may link** to a snag (`linkedSnagId`). It does **not** auto-create a snag in v1 — "convert to Defect/Snag" records intent (see §5). |
| **RFI / Variation / Material Request** | Formal office workflows (question, commercial change, procurement). | not built | An observation can be typed `rfi` / `variation` / `material_request` and flagged for conversion. **Conversion is intent-only in v1** — no pricing, approval, or procurement record is created. |
| **Job history** | The audit trail of what happened on a job. | — | Observations are job-linked and filterable today; a full job-history timeline is a later slice. |

**Rule of thumb:** Evidence *proves*, a Snag *tracks a defect to closure*, an
Observation *captures site truth and routes it to the office*. When unsure, a
worker logs an observation ("Not sure — office review").

## 2. Data model

Persisted in a **new top-level blob `observations.json`**: `{ observations: [] }`.

Cross-job by design (the inbox is cross-job), so a single-document read is the
right shape and avoids the every-job fan-out `api/snags-all.js` pays. A
brand-new blob also cannot corrupt existing job / evidence / snag data.

> **Concurrency:** whole-document read-modify-write (same pattern as
> `employees.json` / `invites.json`). Two truly-concurrent writes last-write-win.
> Acceptable at small-business field volume; a per-record store split is Phase F+.

Schema + types: `src/domains/observations/{schema,types}.ts`.

- **Required:** `id` (`ob_…`), `jobId`, `jobName` (denormalised), `type`,
  `title`, `status`, `priority`, `source`, `requiresAction`, `createdById`,
  `createdByName`, `createdByRole`, `createdAt`, `updatedAt`.
- **Optional:** `description`, `stage`, `areaId`/`areaName`, `taskId`/`taskName`,
  `linkedEvidenceId`, `linkedSnagId`, `photoUrls[]`, `assignedToId`/`Name`,
  `dueDate`, `resolutionNote` + `resolvedAt`/`By`, `convertedTo` +
  `convertedTargetId` + `convertedAt`/`By`.

| Enum | Values |
| --- | --- |
| `type` | `note` · `blocker` · `rfi` · `variation` · `defect` · `safety` · `material_request` · `plan_mismatch` · `client_instruction` · `evidence` |
| `status` | `new` · `needs_action` · `in_review` · `converted` · `resolved` · `record_only` |
| `priority` | `low` · `normal` · `high` · `urgent` |
| `source` | `phil` · `buhlos` · `system` |
| `convertedTo` | `rfi` · `variation` · `defect` · `snag` · `material_request` · `task` |

**`requiresAction`** is inferred from `type` (`note`/`evidence` → false, the rest
→ true) unless the client sends an explicit override. It drives the inbox
"needs action" surfacing independently of `status` (which tracks workflow
position). Status is server-owned: every create writes `new`.

## 3. API — `api/observations.js`

| Method | Route | Who | Does |
| --- | --- | --- | --- |
| GET | `/api/observations` | admin-tier | cross-job inbox + filters (`status`, `type`, `priority`, `requiresAction`) |
| GET | `/api/observations?jobId=X` | field/LH assigned + admin (non-client) | one job's observations |
| POST | `/api/observations?jobId=X` | `canWrite` (field/LH assigned, admin any) | create; status `new`; `requiresAction` inferred |
| PATCH | `/api/observations` (id in body) | admin-tier | triage / resolve / convert |

Validation: invalid `type`/`status`/`priority` → 400; missing `title` → 400;
missing `jobId` on create → 400; unknown job → 404; `linkedEvidenceId`/
`linkedSnagId` must resolve on the job → 400; unknown id on PATCH → 404;
unauthenticated → 401; wrong tier → 403.

Permissions use the shared tier helpers (`canWrite`, `isAdminRole`) from
`api/_lib/auth.js` — see [PR 2 role normalisation](../../src/lib/auth/roles.ts).
The cross-job inbox is gated **admin-tier** to exactly match
`canAccessSurface('admin')`, so the API agrees with the page gate (no "UI lets
me in but the API 403s me").

## 4. BuhlOS Observations Inbox — `/observations`

`src/app/(admin)/observations/page.tsx` + `src/components/admin/ObservationsInbox.tsx`.

Exception-first triage surface (not a raw table): summary cards (new/needs-action,
high/urgent, blockers, resolved/record-only), filters (status/type/priority/job/
source), and a detail drawer with triage (needs-action / in-review / record-only),
priority, assign-to-me, resolve + note, and **conversion-intent** buttons. A
"Observations to action" card also lands on the Command Centre.

## 5. Conversion is intent-only (v1)

"Convert to RFI / Variation / Defect / Material Request" sets `convertedTo`,
stamps the actor, and moves the observation to `converted`. **No downstream
record is created** — the inbox labels it "module coming". This is the honest
v1: it captures the office decision without faking an RFI/Variation/procurement
system. Building those modules (and real Snag creation from a `defect`
observation) is the next slice.

## 6. Phil capture — classify-simple

`src/components/phil/PhilCaptureLauncher.tsx` (FAB in `PhilTabBar`). Capture-first:
the worker picks a job (auto on a job home), then chooses **Take a photo /
evidence** (the existing, unchanged CaptureSheet) or a plain-English
classification (Site note, Blocker, Issue/defect, Need material, Doesn't match
plan, Builder/client said, Safety, Question for office, Variation, "Not sure —
office review"). The worker never sees the internal type taxonomy — the mapping
lives in `WORKER_CAPTURE_OPTIONS` (`src/domains/observations/service.ts`).

Offline is **not** faked: a failed POST shows an honest "no connection — try
again" with no silent loss. A durable offline queue is a later slice.

## 7. Not built yet (honest backlog)

- RFI / Variation / Material Request modules (conversion is intent-only).
- Auto-create a Snag from a `defect` observation.
- Photo attachment *on the observation itself* (photos stay the Evidence flow;
  `photoUrls`/`linkedEvidenceId` exist for when it's wired).
- Cross-surface audit-log entries for observation create/update (the record's
  own actor/timestamp stamps are the v1 trail).
- Offline capture queue.
- Full job-history timeline.
