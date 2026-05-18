# BuhlOS — Project Overview for LLM Context

**Canonical domain structure:**

| Surface | URL |
|---|---|
| BuhlOS dashboard / login / admin | https://buhlos.com |
| Phil mobile worker app | https://phil.buhlos.com |
| API | https://api.buhlos.com *(same-origin in the current single-deployment build; reserved for a future split)* |
| Docs (optional) | https://docs.buhlos.com |

URL helpers live in [`api/_lib/domains.js`](api/_lib/domains.js) (server) and [`public/lib/domains.js`](public/lib/domains.js) (browser). The single source of truth for any absolute URL — email links, install instructions, deep links, CORS allow-lists, etc. — is one of those modules. Don't hardcode hostnames in components.

Required env vars (see [.env.example](.env.example)):
- `NEXT_PUBLIC_BUHLOS_URL` — defaults to `https://buhlos.com`
- `NEXT_PUBLIC_PHIL_URL` — defaults to `https://phil.buhlos.com`
- `NEXT_PUBLIC_API_URL` — defaults to `https://api.buhlos.com`
- `NEXT_PUBLIC_DOCS_URL` *(optional)* — defaults to `https://docs.buhlos.com`
- `BUHLOS_COOKIE_DOMAIN` *(optional)* — set to `.buhlos.com` once admin and Phil are split across subdomains so the session cookie is shared.

**Stack:** Vercel serverless functions (Node 24) + Vercel Blob storage + plain HTML/CSS/JS frontend
**Purpose:** Job tracking web app for bühl electrical. Field crew log progress on residential electrical jobs (rough-in, fit-off stages), raise snags, upload ITP photos, log hours, manage test & tag certificates and temp board records.

---

## Repository Layout

```
/
├── api/                      # Vercel serverless functions (each file = one route)
│   ├── _lib/
│   │   ├── auth.js           # Session cookies, role checks, canWrite/canManageJob
│   │   ├── blob.js           # readBlob / writeBlob / deleteBlob helpers
│   │   └── validation.js     # nanoid(), validateAreaGroups(), validateTasks()
│   ├── auth.js               # POST login/logout, GET me, POST change-password
│   ├── costs.js              # GET labour cost rollup (admin only)
│   ├── crew.js               # GET crew+client, POST assign/unassign
│   ├── data.js               # GET/POST per-job dwelling data (tasks, snags, notes)
│   ├── hours.js              # GET/POST/DELETE labour hours entries
│   ├── job-types.js          # CRUD job type labels (admin only)
│   ├── jobs.js               # GET/POST/PUT jobs
│   ├── photos.js             # GET/POST/DELETE ITP photos (base64 upload)
│   ├── tags.js               # GET/POST test & tag records
│   ├── temps.js              # GET/POST temp board records
│   └── users.js              # CRUD users (admin), createClient, listTradies
├── public/                   # Static files served at root
│   ├── theme.css             # Shared design system (tokens, components, utilities)
│   ├── login.html            # /login — sign in page
│   ├── jobs.html             # /jobs — job list page
│   ├── index.html            # /jobs/:id — per-job dashboard (main app)
│   ├── admin.html            # /admin — admin + leading hand management panel
│   └── BUHL_LOGO.png
└── package.json              # deps: @vercel/blob, bcryptjs, cookie
```

Vercel zero-config: `public/` becomes the static output root; `api/*.js` files are serverless functions. No vercel.json rewrites needed.

---

## Authentication

**Mechanism:** HMAC-SHA256 signed cookie (`buhl_session`), 30-day expiry.  
**Cookie shape:** `base64url(JSON payload).hmac` where payload = `{ userId, role, exp }`.  
**Secret:** `SESSION_SECRET` env var (must be ≥ 16 chars).  
**Cookie flags:** `httpOnly`, `secure`, `sameSite=lax`.

**Login flow:**
1. POST `/api/auth?action=login` with `{ username, secret }`
2. Server reads `users.json`, bcrypt-compares `secret` against `passwordHash`
3. On success sets cookie and returns `{ user }` (no passwordHash)

**Admin passwords:** bcrypt, min 6 chars  
**Tradie / Leading Hand / Client PINs:** bcrypt, exactly 4 digits

**Session helpers** (`api/_lib/auth.js`):
- `getCurrentUser(req)` — verifies cookie, looks up fresh user from `users.json`, strips `passwordHash`
- `requireAuth(req, res, { roles?, jobId? })` — middleware-style; returns user or sends 401/403 and returns null
- `canWrite(user, jobId)` — true for admin, or tradie/leadingHand with `jobId` in their `assignedJobIds`
- `canManageJob(user, jobId)` — true for admin, or leadingHand with `jobId` in their `assignedJobIds`

---

## Roles & Permissions

| Role | Auth | Can do |
|---|---|---|
| `admin` | password (≥6 chars) | Everything. Sees all jobs. CRUD users, job types, costs. |
| `leadingHand` | 4-digit PIN | Write to assigned jobs (tasks, snags, hours, photos, tags, temps). Manage job setup (areas, checklists) + crew + client on assigned jobs. Cannot create jobs or change job name/type/status. Limited admin panel (Job Setup tab only). |
| `tradie` | 4-digit PIN | Write to assigned jobs. Cannot manage setup, crew, or client. |
| `client` | 4-digit PIN | Read-only. Sees only their linked job. No hours or crew visibility. |

**Job visibility rules:**
- `admin`: sees all jobs
- `tradie` / `leadingHand`: sees jobs in `assignedJobIds`
- `client`: sees job where `job.clientUserId === user.id`

---

## Blob Storage

All data lives in Vercel Blob. Token: `BLOB_READ_WRITE_TOKEN` env var.  
`readBlob(key, fallback)` — lists blobs by prefix, fetches JSON, returns fallback if missing.  
`writeBlob(key, data)` — `put()` with `addRandomSuffix: false` (deterministic key).

### Blob keys

```
users.json                           # { users: [User] }
jobs.json                            # { jobs: [Job] }
job-types.json                       # { jobTypes: [{ id, name }] }

jobs/{jobId}/data.json               # { dwellings: {[dwId]: Dwelling}, snags: [Snag], notes: [Note] }
jobs/{jobId}/hours.json              # { entries: [HoursEntry] }
jobs/{jobId}/tags.json               # { tags: [Tag] }
jobs/{jobId}/temps.json              # { temps: [Temp] }
jobs/{jobId}/photos-index.json       # { [dwellingId]: [Photo] }
jobs/{jobId}/photos/{photoId}.jpg    # actual image bytes
```

---

## Data Shapes

### User
```json
{
  "id": "u_abc123",
  "username": "john",
  "role": "tradie",
  "passwordHash": "$2a$...",
  "assignedJobIds": ["birdwood"],
  "hourlyRate": 85,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```
- `hourlyRate` only present for `tradie` and `leadingHand`
- `assignedJobIds` not meaningful for `admin` (admin sees all jobs regardless)
- `client` users are linked to a job via `job.clientUserId` AND have the jobId in their `assignedJobIds`

### Job
```json
{
  "id": "birdwood",
  "name": "Birdwood Estate",
  "status": "active",
  "type": "jt_abc123",
  "clientUserId": "u_xyz",
  "areaGroups": [
    {
      "id": "ag_abc123",
      "name": "Stage 1",
      "areas": [
        { "id": "ar_abc123", "name": "Lot 1" }
      ]
    }
  ],
  "roughInTasks": [
    { "id": "rt_abc123", "name": "GPO rough-in" }
  ],
  "fitOffTasks": [
    { "id": "ft_abc123", "name": "Install GPOs" }
  ],
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```
- `status`: `"active"` | `"complete"` | `"archived"`
- `areaGroups` defines the dwelling hierarchy: groups contain areas (individual units/lots)
- `roughInTasks` / `fitOffTasks` are the shared checklists for all dwellings on this job

### Dwelling (inside `data.json`)
Keyed by area ID within `dwellings` object:
```json
{
  "ar_abc123": {
    "roughIn": {
      "tasks": {
        "rt_abc123": "not_started",
        "rt_def456": "in_progress",
        "rt_ghi789": "complete"
      }
    },
    "fitOff": {
      "tasks": {
        "ft_abc123": "not_started"
      }
    }
  }
}
```
- Task values: `"not_started"` | `"in_progress"` | `"complete"` (enforced by server validation)
- Previously stored as booleans — migration completed

### Snag (inside `data.json`)
```json
{
  "id": "snag_123",
  "dwellingId": "ar_abc123",
  "stage": "roughIn",
  "description": "Missing conduit in bedroom",
  "priority": "high",
  "raisedBy": "john",
  "raisedAt": "2025-01-01T00:00:00.000Z",
  "resolved": false,
  "resolvedBy": null,
  "resolvedAt": null
}
```
- `priority`: `"high"` | `"medium"` | `"low"`
- Open snag count shown as red corner badge on dwelling cards in UI

### HoursEntry (inside `hours.json`)
```json
{
  "entries": [
    {
      "id": "h_abc123",
      "date": "2025-06-10",
      "crew": [
        {
          "userId": "u_abc123",
          "name": "john",
          "hours": 8.5,
          "hoursMins": { "hours": 8, "minutes": 30 }
        }
      ],
      "notes": "Finished stage 1 rough-in"
    }
  ]
}
```
- `hours` stored as decimal (8.5 = 8h 30m); `hoursMins` is a read-only convenience field added by the API on GET
- `userId` present on new-format entries; legacy entries may have only `name` (no userId)

### Tag (inside `tags.json`)
```json
{
  "tags": [
    {
      "id": "tag_123",
      "dwellingId": "ar_abc123",
      "description": "Power board kitchen",
      "tagNumber": "T-001",
      "testedBy": "john",
      "testDate": "2025-01-01",
      "expiryDate": "2026-01-01",
      "result": "pass"
    }
  ]
}
```

### Temp (inside `temps.json`)
```json
{
  "temps": [
    {
      "id": "tmp_123",
      "dwellingId": "ar_abc123",
      "boardType": "board",
      "description": "Temp board lot 1",
      "installedBy": "john",
      "installedDate": "2025-01-01",
      "removedDate": null,
      "photoUrl": null
    }
  ]
}
```

### Photo (inside `photos-index.json`)
```json
{
  "ar_abc123": [
    {
      "id": "1234567890_abc123",
      "url": "https://blob.vercel-storage.com/...",
      "stage": "roughIn",
      "group": "ag_abc123",
      "caption": "Conduit run bedroom",
      "uploadedBy": "john",
      "date": "01/01/2025",
      "time": "09:30"
    }
  ]
}
```

---

## API Reference

All routes require the `buhl_session` cookie except as noted. All responses are JSON. All routes return 200 on success unless noted.

### `GET /api/auth?action=me`
Returns `{ user }` for current session. 401 if not authenticated.

### `POST /api/auth?action=login`
Body: `{ username, secret }`  
Returns: `{ user }`, sets session cookie. 401 on bad credentials.

### `POST /api/auth?action=logout`
Clears session cookie.

### `POST /api/auth?action=change-password`
Body: `{ currentSecret, newSecret }`  
Must be authenticated. Validates PIN/password rules per role.

---

### `GET /api/jobs`
Returns `{ jobs }` filtered by role visibility (see Roles section).

### `GET /api/jobs?id={jobId}`
Returns `{ job }`. Checks visibility per role.

### `POST /api/jobs`
**Admin only.** Body: `{ name, id?, type?, clientUserId?, areaGroups?, roughInTasks?, fitOffTasks? }`  
Creates job + initialises all per-job blobs (`data.json`, `hours.json`, `tags.json`, `temps.json`).  
Returns `{ job }`.

### `PUT /api/jobs`
**Admin or leadingHand on job.** Body: `{ id, name?, type?, status?, clientUserId?, areaGroups?, roughInTasks?, fitOffTasks? }`  
Leading hands cannot change `name`, `type`, or `status`.  
ID merging: existing area/task IDs preserved when updating by name match; new entries get generated IDs.

---

### `GET /api/users`
**Admin only.** Returns `{ users }` (no passwordHashes).

### `GET /api/users?action=listTradies`
**Admin or leadingHand.** Returns `{ users }` filtered to `tradie` + `leadingHand` roles.

### `POST /api/users`
**Admin only.** Body: `{ username, role, secret, assignedJobIds?, hourlyRate? }`  
Returns `{ user }`.

### `POST /api/users?action=createClient`
**Admin or leadingHand with canManageJob.** Body: `{ username, secret, jobId }`  
Creates client user, adds jobId to their `assignedJobIds`, links `job.clientUserId`.

### `PUT /api/users`
**Admin only.** Body: `{ id, username?, assignedJobIds?, hourlyRate?, secret? }`

### `DELETE /api/users?id={userId}`
**Admin only.** Cannot delete self.

---

### `GET /api/crew?jobId={jobId}`
**Non-client, on job.** Returns `{ crew: [{id, name, role}], client: {id, username}|null }`  
`crew` = all non-client users assigned to the job (including admins).

### `POST /api/crew?action=assign&jobId={jobId}`
**canManageJob.** Body: `{ userId }`. Adds job to user's `assignedJobIds`.

### `POST /api/crew?action=unassign&jobId={jobId}`
**canManageJob.** Body: `{ userId }`. Cannot unassign self.

---

### `GET /api/data?jobId={jobId}`
Returns `{ dwellings, snags, notes }`. Any authenticated user with job access.

### `POST /api/data?jobId={jobId}`
**canWrite.** Body: full `data.json` replacement `{ dwellings, snags, notes }`.  
Validates all task values are `not_started|in_progress|complete`.

---

### `GET /api/hours?jobId={jobId}`
**Non-client, on job.** Returns `{ entries }` with `hoursMins` convenience fields.

### `POST /api/hours?jobId={jobId}` — new format
**canWrite.** Body: `{ date: "YYYY-MM-DD", entries: [{userId, hours, minutes}] }`  
Conflict detection: if a userId already has an entry for that date, returns 409 `{ conflicts, saved }`.  
Add `?force=1` to overwrite conflicts.  
Non-conflicting rows in the same request are always saved.  
Tradies can only write for themselves or other tradies assigned to the job.

### `POST /api/hours?jobId={jobId}` — legacy format
**canWrite.** Body: `{ date, crew: [{name, hours}], notes }`  
Merges into existing day entry by name, or appends new entry.

### `DELETE /api/hours?jobId={jobId}`
**canWrite.** Body: `{ id }`. Removes entry by ID.

---

### `GET /api/photos?jobId={jobId}`
Returns full index `{ [dwellingId]: [Photo] }`, or `[Photo]` if `?dwelling=` specified.

### `POST /api/photos?jobId={jobId}`
**canWrite.** Body: `{ dwelling, dataUrl, stage?, group?, caption?, uploadedBy? }`  
Decodes base64 dataUrl, uploads image bytes to blob, updates index.

### `DELETE /api/photos?jobId={jobId}`
**canWrite.** Body: `{ dwelling, photoId }`. Removes from index only (does not delete blob).

---

### `GET /api/tags?jobId={jobId}`
Returns `{ tags }`.

### `POST /api/tags?jobId={jobId}`
**canWrite.** Full replacement write of `tags.json`.

### `GET /api/temps?jobId={jobId}`
Returns `{ temps }`.

### `POST /api/temps?jobId={jobId}`
**canWrite.** Full replacement write of `temps.json`.

---

### `GET /api/job-types?action=list`
**Admin only.** Returns `{ jobTypes }`.

### `POST /api/job-types?action=create`
**Admin only.** Body: `{ name }`. Returns `{ jobType }`.

### `POST /api/job-types?action=update`
**Admin only.** Body: `{ id, name }`.

### `POST /api/job-types?action=delete`
**Admin only.** Body: `{ id }`. 409 if type is in use by any job.

---

### `GET /api/costs`
**Admin only.** Returns `{ jobs: [{id, name, status, hours, cost}], totals: {hours, cost} }`  
Labour cost = total hours × tradie's `hourlyRate`. Lookups by username (case-insensitive).

---

## Frontend Pages

### `/login` → `login.html`
- Sign-in form (username + password/PIN)
- Auto-redirects to `/jobs` if already authenticated
- On submit: POST `/api/auth?action=login`, redirect to `/jobs`

### `/jobs` → `jobs.html`
- Lists all visible jobs as cards
- Admin and leadingHand see a "Job Setup" / "Admin panel" button
- Sign out clears session

### `/jobs/:id` → `index.html`
The main app. Loaded with `?job={jobId}` query param set by Vercel rewrites (or the HTML reads from `location.pathname`).

**Tabs:**
- **Dashboard** — overall completion %, KPI stats (complete/in-progress/snagged/not-started counts), dwelling cards with progress bars, snag corner badges, "Log today's hours" button (non-clients)
- **[Area Group tabs]** — one tab per area group (e.g. "Stage 1"), showing dwelling cards. Clicking a card opens dwelling detail.
- **Snags** — raise and resolve snags. Badge on nav tab shows open count.
- **Test & Tag** — log test & tag certificates
- **Temps** — temp board tracker
- **Hours** — full hours log table

**Dwelling detail (opened from any dwelling card):**
- Back button returns to group tab
- Sub-tabs: Tasks | ITP Photos | Notes
- Tasks tab shows rough-in and fit-off checklists with three-state selectors
- ITP Photos tab shows photo grid with stage/group/caption upload form
- Notes tab has a free-text textarea

**"Log today's hours" modal:**
- Bottom sheet on mobile, centred dialog on desktop
- Pre-filled with current user at 8h
- Minutes as select (0/15/30/45)
- "+ Add crew member" button to add additional rows (pulls from `/api/users?action=listTradies`)
- On save: POST new-format hours. 409 conflict shows inline Replace/Cancel per row.

### `/admin` → `admin.html`
**Tabs visible to admin:** Jobs | Job Setup | Users | Costs | Settings | Job Types  
**Tabs visible to leadingHand:** Job Setup only

- **Jobs tab** — create job form, list of existing jobs with edit dialog (area groups editor, status, type, client)
- **Job Setup tab** — sidebar lists jobs; selecting one shows: area groups editor, rough-in checklist editor, fit-off checklist editor, Crew section (add/remove crew members), Client access section (create client account)
- **Users tab** — create user form (role selector shows rate+jobs fields for tradie/leadingHand), user table with edit dialog
- **Costs tab** — labour cost rollup table
- **Settings tab** — change own password
- **Job Types tab** — CRUD job type labels

---

## CSS Architecture (`theme.css` + page-local `<style>`)

### Theme tokens (CSS variables)
```css
--bg: #f1f5f9          /* page background */
--card: #ffffff        /* card/surface */
--header: #0d1f35      /* navy header */
--header-ink: #ffffff
--ink: #0f172a         /* primary text */
--muted: #475569       /* secondary text */
--border: #e2e8f0
--accent: #ffcc00      /* yellow CTA */
--accent-ink: #0f172a
--danger: #dc2626
--radius: 12px
--fs-xxs:11px  --fs-xs:12px  --fs-sm:13px
--fs-base:14px  --fs-lg:17px  --fs-xl:22px
```

### Shared components in `theme.css`
- `.app-header` — sticky dark navy header, 60px tall
- `.card` — white surface with border + radius
- `.btn` — base button (40px min-height). Modifiers: `.primary` (yellow), `.danger` (red), `.sec` (transparent), `.ghost` (white text on dark bg)
- `input`, `select`, `textarea` — full-width, accent focus ring
- `label` — 13px muted, 6px margin-bottom
- `.badge` — pill with variants: `.active` (green), `.complete` (grey), `.archived` (amber)

### Utility classes (added in last session)
- `.field` — 14px bottom margin; wraps label + input
- `.form-actions` — flex row, 18px top margin; for button groups at bottom of forms
- `.msg` / `.msg.err` / `.msg.ok` — typed status messages (13px, coloured text)
- `.page-wrap` — 18px padding, 760px max-width, centred
- `.section-hdr` — labelled divider with line after (`::after`)
- `.btn.ghost` — transparent bg, rgba white border, white text

### `index.html` local variables (aliases + semantic colours)
```css
--navy: var(--header)    /* alias */
--text: var(--ink)       /* alias */
--r: var(--radius)       /* alias */
--rs: 8px                /* small radius */
--blue: #2563eb
--green / --green-bg / --green-bd
--amber / --amber-bg / --amber-bd
--red / --red-bg / --red-bd
```

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | HMAC key for session cookies (min 16 chars) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token |
| `NEXT_PUBLIC_BUHLOS_URL` | BuhlOS dashboard URL (default `https://buhlos.com`) |
| `NEXT_PUBLIC_PHIL_URL` | Phil URL (default `https://phil.buhlos.com`) |
| `NEXT_PUBLIC_API_URL` | API base URL (default `https://api.buhlos.com`) |
| `NEXT_PUBLIC_DOCS_URL` | Optional docs URL (default `https://docs.buhlos.com`) |
| `BUHLOS_COOKIE_DOMAIN` | Optional shared cookie domain, e.g. `.buhlos.com`, for cross-subdomain SSO |
| `ADMIN_ALERT_EMAIL` | Inbox for access-request + password-reset alerts (default `office@buhlos.com`) |
| `NOREPLY_EMAIL` | From-address for system emails (default `noreply@buhlos.com`) |
| `ALLOWED_ORIGINS` | Comma-separated extra origins allowed to call the API with credentials |

---

## Key Design Decisions

1. **No database** — all state in Vercel Blob (JSON files). Simple, zero-ops, cheap. Concurrency risk is accepted (last write wins).

2. **No framework** — vanilla JS in HTML files. No build step, no bundler. Vercel deploys immediately.

3. **Full-document writes** — `data.js`, `tags.js`, `temps.js` accept a full JSON replacement body. The client holds the full document in memory, mutates it, and POSTs the whole thing. The `hours.js` endpoint is the exception — it has structured POST + DELETE.

4. **Three-state task values** — `not_started` | `in_progress` | `complete`. Previously booleans; migrated via script. Validated server-side on every write.

5. **Session stored in cookie, not server** — HMAC-signed JWT-style. No session store needed. Role is embedded but `getCurrentUser()` always re-reads `users.json` for fresh permissions.

6. **Photos as base64 dataUrl** — client reads file as base64, POSTs JSON. Server decodes and puts bytes into blob. Simple but limits photo size to ~4MB (Vercel function body limit).

7. **`canWrite` vs `canManageJob`** — two separate permission tiers. `canWrite` = field work (tasks, snags, hours, photos). `canManageJob` = job configuration (area groups, checklists, crew, client). Leading hands have canWrite + canManageJob; tradies have only canWrite.
