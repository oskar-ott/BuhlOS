# A job's client (who the job is for)

**Pull:** owner, 2026-10-03 — "be able to choose, when setting up a job, what
builder it is for" → "have it as client".

## What it is
`job.clientName` — who the job is for, usually the builder (e.g. *Hutchinson
Builders*). Optional free text, max 120 characters. Older jobs simply don't
have one; nothing shows for them.

Not to be confused with two existing fields:
- `clientUserId` — links a client-portal login to the job.
- `clientReference` — the client's PO / contract number (admin-only, in
  *Client & contract*).

## Where it's set
- **New job** (`/v2/jobs/new`) — the *Client* field under the job name.
- **Builder → Basics** (`/v2/jobs/<id>/builder?tab=basics`) — the same field,
  beside Reference. Blank clears it.

Both use `ClientNameInput`: type, or pick from the clients **already used on
other jobs** (most-used first). There is no clients register to maintain — a
new name typed once becomes a suggestion from then on. Leaving the field snaps
a same-client spelling onto the existing one (`hutchinson builders` →
`Hutchinson Builders`), so a client never splits into two. Pure logic:
`src/domains/jobs/client-names.ts`. Suggestions come from the light admin
read `GET /api/jobs?summary=1`; if it fails the field still works as plain text.

## Where it shows
- The job page hero, under the job name (building icon).
- The jobs list search matches it — typing *hutchinson* lists every Hutchinson job.
- The job cost report PDF (Money card → *Download job report*), which already
  printed `Client: …` when the field was set (`api/_lib/job-report-pdf.js`).

## Storage and access
- Saved through the shared basics validator (`api/_lib/job-fields.js`
  `BASIC_TEXT`), so create, edit and duplicate all carry it. Admin and leading
  hand can edit it (like the site address); the field-crew name-only edit
  can't.
- Blob `jobs.json` is authoritative. It is not a Postgres-migrated field, so
  the PG overlay, the jobs summary and the admin-extras read all carry it
  through unchanged — no migration.
- Not redacted: a client's name is site language, not a money figure.
- Edits are journalled under the existing "Updated job basics" audit entry.

Not in this slice (pull, don't push): showing it to the crew on the field
app, filtering the list by client, a clients register with contacts.
