# Job numbers issued by BuhlOS

**What this is:** BuhlOS gives a new job its job number (`IV` + 4 digits)
itself, instead of the number being typed in from ServiceM8 or made up on the
phone.

**Status: built, dark** behind `job_code_auto`
([#1152](https://github.com/oskar-ott/BuhlOS/issues/1152)). Proven against a
local database only. Never used on a real job. The migration is applied to dev
and production (2026-11-22); the tables are empty.

**Part of** the job-invoicing plan
([product/job-invoicing-xero-plan.md](product/job-invoicing-xero-plan.md),
part F), but independent of the invoice parts: it needs none of them switched
on.

## The pull and the hypothesis

Owner pull, 2026-11-22: creating job numbers is one of the last things
ServiceM8 does for the business.

*We believe the office and the crew will start the next real job in BuhlOS
without opening ServiceM8 for a number. We'll know it's true if a real job is
created with a BuhlOS number, that number is quoted at a wholesaler, and the
supplier invoice comes back matched to the job.*

## Owner decisions

| Question | Decision |
| --- | --- |
| Where numbers start | **IV4000** (2026-11-22, replacing the earlier "7000 range" in the plan) |
| Format | unchanged: `IV` + 4 digits, so supplier-invoice matching needs no change |

## What happens

- **A job created with no number typed gets the next one**: IV4000, IV4001,
  and so on. This is the same on the office New job form and on the phone's
  "+ New job".
- **Two people can never be given the same number**, even at the same instant.
- **A typed number still works** (for example a ServiceM8 number) and is still
  checked for clashes.
- **A number is never made up.** If BuhlOS can't issue one, the job is not
  created and the person is told so. Typing a number still works in that case.
- **A number is never reused and never changed.** An older job that has no
  number can be given one, once, by the office.

### Office: New job (`/v2/jobs/new`)

The IV number field is optional and says "Leave blank and BuhlOS gives the job
the next number." After a create with the field left blank, the form stops on
the issued number, shown large, before going on to the Builder: it is the
number that gets read out at the wholesaler counter, and it did not exist
until then. A typed number goes straight to the Builder as before.

### Office: an older job with no number (`/v2/jobs/[jobId]`)

Where the job's number shows at the top of the job page: "No job number yet.
**Give this job a number**". It asks once ("A job number can't be changed
afterwards") and then shows the number in its usual place.

### Phone: "+ New job" (`/phil/jobs`, needs `phil_sharpened`)

The second side of the Job code toggle is **BuhlOS number** (it was "Custom
number"). It no longer asks the worker to make a number up: the digits field
and "Next free" are gone, the row reads "next number, given when you create",
and a name is all Create needs. The job opens with its number where a job's
code already shows.

The **ServiceMate** side is unchanged: a number can still be typed.

Governed by the Phil constitution
([phil-constitution.md](phil-constitution.md)):

- **P6** (every tap pays for itself): the worker no longer types or picks a
  number on that side.
- **P7** (truth over theatre): no number is shown before it exists. If none
  can be issued the worker is told and nothing is created.
- **P10** (fixed cognitive budget): no new slot. The line sits where the
  digits field was (one input and one button fewer), and the number appears
  where the code already shows.
- **P11** (site language): "BuhlOS gives this job the next free number.
  You'll see it on the job as soon as it's made — that's the one to give the
  wholesaler."

With the flag off the sheet is exactly as it was, including the phone's own
"next free 7000 number". That client-side guess is what this replaces: it is
worked out from one worker's job list, so two workers can be handed the same
number.

Which side the toggle opens on is unchanged (ServiceMate). Making the BuhlOS
side the default is a one-line change once the crew has used it.

## How a number is issued

`api/_lib/job-codes.js`, Postgres
(`supabase/migrations/20261124100000_job_codes.sql`). Postgres, because
`jobs.json` has no compare-and-swap and can be read stale.

- `job_code_counters`: one row, the next number to try. It is locked while a
  number is issued, so requests queue.
- `job_code_claims`: one row per number given out, or typed in while the flag
  is on. `UNIQUE (tenant_id, code)` is the rule that makes a duplicate
  impossible.

The issuer takes the lowest number from IV4000 up that is neither on a job nor
claimed, so numbers already in use are skipped. That includes the 7000-series
numbers the phone has made up until now. It stops at IV9999, the end of the
4-digit format, with a plain message. At a few hundred jobs a year that is
many years away; going past it means a longer number format, which also
touches supplier-invoice matching.

Order matters in `createJob` (`api/_lib/job-create.js`): the number is issued
**last**, after every other check, so a refused create never uses a number up.
A retried phone create is recognised as the worker's own job before a number
is issued, so a retry never takes a second number.

If the job then can't be saved, an issued number stays used (it is skipped,
never handed out again) and a typed number is given back.

This departs from the plan in one detail: the plan seeded the counter from the
highest existing 7000-series number. Starting at IV4000 and skipping what is in
use does the same job without a single mistyped high number pushing every
later number up.

## API

| Call | Does |
| --- | --- |
| `POST /api/jobs` with no `code` | flag on: issues the next number. `503` with a plain sentence when none can be issued; nothing is created |
| `POST /api/jobs` with a `code` | as before, plus the number is claimed. `409` when another job has claimed it. If Postgres can't be reached the create still goes ahead on the existing `jobs.json` clash check |
| `PUT /api/jobs` `{ id, issueCode: true }` | office tier, flag on: gives a job with no number the next one. `409` when it already has a number; `400` if anything else is sent with it; `404` while the flag is off |

A job's number cannot be set or changed through an ordinary `PUT`.

With the flag off none of this runs and Postgres is never touched: a create
with no code has no code, and the phone still requires one.

## Turning it on

1. **Done 2026-11-22.** `20261124100000_job_codes.sql` is applied to the dev
   Supabase project and to production (owner-approved each time), and checked
   against the file character for character.
2. In the Owner Console, set **BuhlOS job numbers** to owner preview, then
   Live. It is a global flag: once Live it applies to everyone who creates a
   job.
3. The phone side lives on the "+ New job" sheet, which only exists while `phil_sharpened` is on.

On a database without step 1, a create with no number fails with "Couldn't get the next job
number just now, so nothing was created" and typing a number still works.

Preview deployments cannot reach Postgres, and a preview may share the
production Blob store, so this must not be exercised by creating jobs on a
Vercel preview. The flag-off phone sheet can be looked at on a preview; the
flag-on path has been walked locally (real handler, real local Postgres) and
needs its first real use on production behind owner preview.

## Testing

| What | Where |
| --- | --- |
| The range, what counts as a number, the words a person sees, every database failure becoming one typed error | `src/domains/jobs/job-codes.test.ts` |
| The real SQL: order, skipping, twenty requests at the same instant, typed claims, the end of the range (local Postgres, skipped in CI) | `src/domains/jobs/job-codes.pg.test.ts` |
| Office create, phone create, retries, "no number, no job", giving an older job its number — through the real handler | `src/domains/jobs/job-code-auto-api.test.ts` |
| The phone sheet on and off | `src/components/phil/PhilNewJobSheet.render.test.tsx`, `philNewJobForm.test.ts` |
| The office form and the job page | `src/components/admin/NewJobForm.render.test.tsx`, `JobHealthBand.render.test.tsx` |

```
JOB_CODES_PG_TEST=1 SUPABASE_ENV=local SUPABASE_PROJECT_REF=localstack \
SUPABASE_DB_URL=postgres://…@localhost:<port>/<db> \
  npx vitest run src/domains/jobs/job-codes.pg.test.ts
```
