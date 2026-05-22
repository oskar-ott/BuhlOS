# 03 · Data model audit

Every data structure the app stores, reads, or pretends to have. Source of truth: the `api/*` endpoints, `api/_lib/*`, `public/admin/admin-data.js`, `public/phil.html` local mocks, `OVERVIEW.md`, and direct file reads.

---

## Storage layers in play

| Layer                              | Where                                          | Real? | Typed? | Notes                                                                                  |
| ---------------------------------- | ---------------------------------------------- | ----- | ------ | -------------------------------------------------------------------------------------- |
| Vercel Blob (JSON files)           | `BLOB_READ_WRITE_TOKEN` env var, `_lib/blob.js` | Yes   | No     | The only real persistent store. Keys listed below. Concurrency = last-write-wins.       |
| Session cookie (`buhl_session`)    | HMAC-signed in `_lib/auth.js`                  | Yes   | No     | Payload: `{ userId, role, exp }`. No serverside session store.                          |
| `localStorage`                     | Browser, per device                            | Yes   | No     | Currently holds `buhl-site-office-tweaks` (deprecated key) and the "remembered name".  |
| `sessionStorage`                   | Browser, per tab                               | Yes   | No     | `_shell.js` caches the sidebar fan-out for 15s under `buhl.admin.sidebar.v1`.           |
| `window.BUHLOS_MOCK`               | `public/admin/admin-data.js`                   | No    | No     | Loaded by `operations.html` *before* `boot()` runs. Fallback when API is empty.        |
| Phil local `MOCK_*`                | Inline in `public/phil.html`                   | No    | No     | `MOCK_JOBS`, `MOCK_AREAS`, `MOCK_TASKS`, `MOCK_HOURS`, `TODAY_TASKS`, `GEAR_TYPES`.    |
| Hardcoded arrays in pages          | Various inline `<script>` blocks               | No    | No     | e.g. `MAT_CATEGORIES`, `FITOFF` task list, etc. (see grep results).                    |
| Google Sheets                      | Not found                                     | n/a   | n/a    | No Sheets integration.                                                                  |
| Database client                    | Not found                                     | n/a   | n/a    | No Postgres/Mongo/etc. The project has *never* had a real DB.                          |

**Verdict:** all real data is in Vercel Blob JSON. All structure is by convention. No type system.

---

## Vercel Blob keys (the actual data)

All keys are JSON files. Reads via `readBlob(key, fallback)`; writes via `writeBlob(key, data)` with `addRandomSuffix: false` for deterministic paths.

| Key                                          | Shape                                                  | Real? | Survives rebuild? |
| -------------------------------------------- | ------------------------------------------------------ | ----- | ----------------- |
| `users.json`                                 | `{ users: User[] }`                                    | Yes   | Yes               |
| `jobs.json`                                  | `{ jobs: Job[] }`                                      | Yes   | Yes               |
| `job-types.json`                             | `{ jobTypes: [{ id, name }] }`                         | Yes   | Yes               |
| `jobs/{jobId}/data.json`                     | `{ dwellings: {...}, snags: Snag[], notes: Note[] }`   | Yes   | Yes (refactor)    |
| `jobs/{jobId}/hours.json`                    | `{ entries: HoursEntry[] }` (legacy format)            | Yes   | Yes               |
| `jobs/{jobId}/tags.json`                     | `{ tags: Tag[] }`                                      | Yes   | Yes               |
| `jobs/{jobId}/temps.json`                    | `{ temps: Temp[] }`                                    | Yes   | Yes               |
| `jobs/{jobId}/photos-index.json`             | `{ [dwellingId]: Photo[] }`                            | Yes   | Yes               |
| `jobs/{jobId}/photos/{photoId}.jpg`          | Image bytes                                             | Yes   | Yes               |
| `time-entries.json` (and per-status indices) | New-format timesheets                                  | Yes   | Yes (primary)     |
| `assets.json`                                | `{ assets: Asset[] }`                                  | Yes   | Yes (refactor → GearAsset) |
| `access-requests.json`                       | `{ requests: [...] }`                                  | Yes   | Yes               |
| `password-resets.json`                       | `{ resets: [...] }`                                    | Yes   | Yes               |
| `notification-prefs.json`                    | per-user prefs                                          | Yes   | Yes               |
| `quotes.json` + per-quote sub-keys           | Quotes ecosystem                                        | Yes   | Yes (deferred)    |
| `suppliers.json` + sub-keys                  | Supplier / wholesaler / product                         | Yes   | Yes (deferred)    |
| `activity.json` (or sharded)                 | Activity stream events                                  | Yes   | Yes (→ AuditLog)  |
| `contacts.json`                              | Customer/builder contacts                               | Yes   | Yes               |
| `job-templates.json`                         | Job-creation templates                                  | Yes   | Yes               |
| `itp-templates.json`                         | ITP checklists                                          | Yes   | Yes               |
| `plans/*`                                    | Plan files (URLs in index)                              | Yes   | Yes               |
| `push-subscriptions.json`                    | Web Push subscriptions                                  | Yes   | Yes               |

Reads/writes go via small helpers in `api/_lib/blob.js`. The `setNoCache` helper adds aggressive no-cache headers on every response.

---

## Current data shapes (verified from code)

### User

```ts
type User = {
  id: string;                    // 'u_<nanoid>'
  username: string;
  role: 'admin' | 'leadingHand' | 'tradie' | 'apprentice' | 'client';
  passwordHash: string;          // bcrypt; stripped before client sees it
  assignedJobIds: string[];
  hourlyRate?: number;           // tradie/leadingHand only
  // additional fields seen in expansion but not strictly typed:
  email?: string;                // sometimes present, sometimes the username doubles as email
  name?: string;                 // display name
  xeroEmployeeId?: string;       // for payroll export — referenced but not enforced
  createdAt: string;             // ISO
  lastSeenAt?: string;
  archived?: boolean;
};
```

Concerns:
- `role` is a flat string. Login expands the admin landing-mapping to also accept `boss`/`owner`/`manager`/`office`/`pm`/`estimator`, but those don't actually exist as stored roles in `users.json` — `landingFor()` was forward-looking.
- `email` vs `username` mismatch. Phil's login form asks for `email`; the API matches case-insensitive `username`.
- No `WorkerProfile` separation — payroll fields (hourly rate, Xero ID) live on User directly.
- No org concept. Single-tenant by design.

### Job

```ts
type Job = {
  id: string;                            // 'birdwood' / 'BIR-IV3232'
  name: string;
  status: 'active' | 'paused' | 'complete' | 'archived';
  type?: string;                         // 'jt_<id>' references job-types.json
  clientUserId?: string;                 // for client portal
  areaGroups: AreaGroup[];               // dwelling hierarchy
  roughInTasks: { id: string; name: string }[];
  fitOffTasks: { id: string; name: string }[];
  createdAt: string;                     // ISO
  // mock-data fields seen in admin-data.js but not in real Job blob:
  address?: string;
  builder?: string;
  client?: string;                       // display name (not the userId)
  stage?: string;                        // free-text current stage
  health?: 'ok' | 'risk' | 'over';
  quotedHours?: number;
  actualHours?: number;                  // derived; not stored
  contractValue?: number;
  crew?: string[];                       // usernames; not in real blob
  startDate?: string;
  lastFieldUpdate?: string;
};

type AreaGroup = {
  id: string;                            // 'ag_<nanoid>'
  name: string;                          // 'Stage 1'
  areas: { id: string; name: string }[]; // 'ar_<nanoid>'
};
```

Concerns:
- The dwelling hierarchy is `Job → AreaGroup → Area`. There's no Stage entity — only a flat `roughIn` / `fitOff` task split.
- Mock data carries `stage`, `health`, `quotedHours`, `actualHours`, `crew` — these are inferred at render time in the real flow but the mock pretends they're stored.
- "Job" mixes concerns: project setup (areas, tasks) and operational state (status, health, current stage).

### Dwelling (inside `data.json`)

```ts
type Dwelling = {
  roughIn: { tasks: { [taskId: string]: 'not_started' | 'in_progress' | 'complete' } };
  fitOff:  { tasks: { [taskId: string]: 'not_started' | 'in_progress' | 'complete' } };
};
// keyed by areaId in the data.json:
type JobData = {
  dwellings: { [areaId: string]: Dwelling };
  snags: Snag[];
  notes: Note[];
};
```

Concerns:
- Only two stages (roughIn / fitOff). Real electrical jobs have more (rough-in → fit-off → commissioning → handover; plus stage-specific sub-tasks like switchboard install). Mock data shows this gap.
- Task progress is per-dwelling-per-task. No timestamp on each transition. No `completedBy`.
- No evidence requirement (per-task photo) — Photos live in `photos-index.json`, decoupled.

### Snag

```ts
type Snag = {
  id: string;
  dwellingId: string;
  stage: 'roughIn' | 'fitOff';
  description: string;
  priority: 'high' | 'medium' | 'low';
  raisedBy: string;                      // username
  raisedAt: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  // expanded in /api/snags-all but not strictly typed:
  assignedTo?: string;
  status?: 'Open' | 'Closed';
  category?: string;
};
```

### HoursEntry (legacy) — `jobs/{jobId}/hours.json`

```ts
type HoursEntry = {
  id: string;
  date: string;                          // YYYY-MM-DD
  crew: { userId?: string; name: string; hours: number; hoursMins?: { hours, minutes } }[];
  notes: string;
};
```

### TimesheetEntry (canonical, new format) — keyed differently in newer blobs

```ts
type TimesheetEntry = {
  id: string;
  userId: string;
  username: string;
  workerName: string;
  date: string;                          // YYYY-MM-DD
  hours: number;                         // decimal
  type: 'ordinary' | 'overtime';
  jobId?: string;
  status: 'submitted' | 'approved' | 'rejected';
  submittedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectReason?: string;
};
```

This is the shape the rebuild should standardise on. Old `HoursEntry` is the legacy migration source.

### Photo

```ts
type Photo = {
  id: string;
  url: string;
  stage?: string;
  group?: string;
  caption?: string;
  uploadedBy: string;
  date: string;                          // 'DD/MM/YYYY'
  time?: string;                         // 'HH:mm'
};
```

Concerns:
- Date format is locale string, not ISO. Hard to query.
- No link to a Task (only to dwelling + free-form stage/group).

### Tag (Test & Tag certificate)

```ts
type Tag = {
  id: string;
  dwellingId: string;
  description: string;
  tagNumber: string;                     // 'T-001'
  testedBy: string;
  testDate: string;
  expiryDate: string;
  result: 'pass' | 'fail';
};
```

### Temp (temporary board)

```ts
type Temp = {
  id: string;
  dwellingId: string;
  boardType: 'board' | string;
  description: string;
  installedBy: string;
  installedDate: string;
  removedDate: string | null;
  photoUrl: string | null;
};
```

### Asset (gear)

```ts
type Asset = {
  id: string;
  name: string;
  kind: 'tool' | 'tester' | string;
  currentHolderId?: string;              // userId
  expectedReturn?: string;               // ISO date
  calibrationDue?: string;               // ISO date
  archived?: boolean;
};
```

### Quote (huge file — 71KB endpoint)

Not deeply inspected during this audit. Park for the rebuild.

### Suppliers, wholesalers, products

Not deeply inspected during this audit. Park.

### Activity log

`api/activity.js` reads/writes activity events. Shape per event is `_lib/activity.js`'s domain. Not inspected in detail; treat as the source for the future `AuditLog` entity.

---

## Mock-only data structures (no API backing)

These live in `public/admin/admin-data.js` (admin) or inline in `public/phil.html` (Phil). They are shaped to *look* like the API but are not persisted.

| Mock structure                       | Source                              | Pretends to be              |
| ------------------------------------ | ----------------------------------- | --------------------------- |
| `BUHLOS_MOCK.jobs`                   | `admin/admin-data.js`               | `/api/jobs` response        |
| `BUHLOS_MOCK.workers`                | `admin/admin-data.js`               | `/api/users` (subset)       |
| `BUHLOS_MOCK.hoursByJob`             | `admin/admin-data.js`               | `/api/time-entries` per job |
| `BUHLOS_MOCK.materialsByJob`         | `admin/admin-data.js`               | `/api/materials-list`       |
| `BUHLOS_MOCK.assetsByJob`            | `admin/admin-data.js`               | `/api/assets`               |
| `BUHLOS_MOCK.jobBuilderTemplates`    | `admin/admin-data.js`               | `/api/job-templates`        |
| `BUHLOS_MOCK.itps` (likely)          | `admin/admin-data.js`               | `/api/itp-templates` + `/api/job-itps` |
| `BUHLOS_MOCK.plans` (likely)         | `admin/admin-data.js`               | `/api/plans`                |
| `BUHLOS_MOCK.variations` (likely)    | `admin/admin-data.js`               | n/a (no API for variations) |
| Phil `MOCK_JOBS`                     | `public/phil.html`                  | `/api/jobs`                 |
| Phil `MOCK_AREAS`                    | `public/phil.html`                  | `/api/job-areas`            |
| Phil `MOCK_TASKS`                    | `public/phil.html`                  | `/api/data` task structure  |
| Phil `MOCK_HOURS`                    | `public/phil.html`                  | `/api/time-entries`         |
| Phil `TODAY_TASKS`                   | `public/phil.html`                  | n/a                         |
| Phil `GEAR_TYPES`                    | `public/phil.html`                  | gear taxonomy               |

**Risk:** the admin command centre boots with `BUHLOS_MOCK` already loaded *as a fallback*. If the API returns empty (fresh org, no jobs yet, or a transient backend error), the admin sees mock jobs and acts on them. There is no `DEMO MODE` watermark.

---

## Missing core entities (need to exist in rebuild)

These concepts are needed by the product but don't have first-class data structures today.

| Entity              | Status today                                                | Why needed                                                                 |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Organisation**     | Not modelled (single-tenant).                              | Future-proofs against multi-org. Even for one org, makes config/branding addressable. |
| **WorkerProfile**    | Payroll fields live on `User`.                             | Split identity (login, role) from payroll/site profile (rate, Xero, RDO).   |
| **Role**             | Flat string on User.                                       | Promote to first-class so permissions can be added without touching User.   |
| **Permission**       | Hard-coded `canWrite` / `canManageJob` functions.          | Becomes table-driven for the rebuild.                                       |
| **JobStage**         | Only `roughIn` / `fitOff` exist as task arrays on Job.     | Real jobs have stages: planning → rough-in → fit-off → commissioning → handover. |
| **JobArea**          | Exists as part of `AreaGroup.areas[]`.                     | Promote to first-class so it can carry status + audit.                      |
| **JobTask**          | Exists as `{id, name}` arrays on Job + state in Dwelling.  | Promote so each task can have completion timestamps, evidence requirements, owner. |
| **TimesheetApproval**| Exists implicitly in TimesheetEntry status fields.        | Promote so approvals are auditable independently (who, when, why).          |
| **GearAsset**        | `Asset` exists.                                            | Rename / enrich; current Asset doesn't model location/site/scan history.    |
| **GearAssignment**   | Exists implicitly as `Asset.currentHolderId`.              | Promote so handovers can be tracked over time.                              |
| **GearScan**         | Not modelled.                                              | Needed for Phil's QR scan flow.                                             |
| **Evidence**         | Photos exist but are not linked to specific tasks/ITPs.    | Add as an entity that links photo → task / ITP completion / RFI / snag.    |
| **PlanDocument**     | Plans exist in `/api/plans` but not in shapes inspected.   | Promote with revision tracking.                                             |
| **PlanRevision**     | Not modelled.                                              | Needed so workers acknowledge a specific rev.                               |
| **PlanAcknowledgement** | Not modelled.                                           | Compliance: "did this worker see Rev 03 before working?"                    |
| **ITPTemplate**      | Exists in `/api/itp-templates`.                            | Standardise shape across new schema.                                        |
| **ITPCheckpoint**    | Embedded in template.                                      | Promote — each checkpoint can require evidence + reviewer.                  |
| **ITPCompletion**    | Exists implicitly.                                         | Promote with `needs_info` / `independent_review` first-class states.        |
| **RFI**              | Not modelled.                                              | New feature in rebuild.                                                     |
| **Defect**           | `Snag` ≈ Defect.                                           | Rename, enrich (handover-readiness link).                                   |
| **MaterialItem**     | Exists implicitly in materials-list responses.             | Promote.                                                                    |
| **MaterialRequest**  | Not strictly modelled — partial in materials-list.         | First-class request → order → deliver loop.                                 |
| **Variation**        | UI exists but no dedicated entity.                         | First-class entity, links to Job and (optionally) RFI.                      |
| **Alert**            | Counts surfaced in sidebar but no `Alert` record.          | Promote so an alert can be acknowledged / resolved / linked.                |
| **AuditLog**         | `activity.json` exists.                                    | Make this the canonical immutable log of every mutation.                    |

---

## Recommended target schema (sketch)

This is the schema [01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md) builds on. Each entity lives in its own `src/domains/<entity>/` folder with its TypeScript types in `src/domains/<entity>/types.ts`.

```
Organisation
└── User
    ├── WorkerProfile
    ├── Role
    └── Permission

Job
├── JobStage
│   └── JobArea
│       └── JobTask
│           └── Evidence
├── ITPTemplate
│   └── ITPCheckpoint
│       └── ITPCompletion
│           └── Evidence
├── PlanDocument
│   └── PlanRevision
│       └── PlanAcknowledgement
├── Variation
├── RFI
├── Defect (Snag)
├── MaterialItem
│   └── MaterialRequest
└── TimesheetEntry
    └── TimesheetApproval

GearAsset
├── GearAssignment
└── GearScan

Alert (cross-cutting)
AuditLog (cross-cutting, immutable)
```

Each entity should:
1. Live in `src/domains/<plural-name>/`.
2. Have `types.ts` defining its shape.
3. Have `fixtures.ts` for typed mock data (replaces ad-hoc mock objects).
4. Have `schema.ts` defining Zod validators for inputs.
5. Have `client.ts` defining the typed API client that calls `/api/<plural-name>`.

---

## Migration considerations

When the new app starts persisting through the same `api/*` endpoints, the Blob keys are reused. The data shapes are mostly forward-compatible, but a few mismatches need handling:

1. **Three-state task values** — already migrated to `not_started | in_progress | complete`. No work needed.
2. **HoursEntry vs TimesheetEntry** — both formats exist in old Blob keys. The new app should write only the new format and treat old entries as read-only.
3. **Photo date format** — `'DD/MM/YYYY'` strings. New writes should be ISO. Reads need a tolerant parser.
4. **Snag → Defect rename** — keep storing under `snags` array on Blob for compatibility. Domain code uses `Defect` internally.
5. **WorkerProfile split** — Blob still stores everything on `User`. New code reads `WorkerProfile` derived from `User` until a future migration splits the blob.

No schema migration is required for Phase 1 of the rebuild. The new app can read/write the existing Blob keys with no changes.
