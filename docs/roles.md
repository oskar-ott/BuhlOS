# Role checks — never compare strings (#156)

Roles come in **tiers**, and the tiers grow: `admin` is really
admin/boss/owner/manager/office/pm/estimator; the field tier is
tradie/electrician/apprentice/labourer; leading hand has four spellings.
Every literal comparison (`user.role === 'admin'`) is a latent bug the day a
tier gains a member — that's exactly how #114 (electricians invisible to
missing-hours) and #123 (office/boss saw blank hours boards) happened.

**Rule: always use the predicates.**

| Predicate | Meaning |
|---|---|
| `isAdminRole(role)` | the office/admin tier |
| `isLeadingHandRole(role)` | leading hand, any spelling |
| `isFieldRole(role)` | tradie / electrician / apprentice / labourer |
| `isStaffRole(role)` | admin tier OR leading hand |
| `isClientRole(role)` | the client role (single role, predicate for consistency) |
| `isHoursTrackedWorker(user)` | *expected to log hours*: field tier + LHs, live accounts |

JS (`api/`): `require('./_lib/auth')`. TS (`src/`): `src/lib/auth/roles.ts`.

**Enforcement** — two guards, because `next lint` deliberately ignores `api/`:

- `src/`: ESLint `no-restricted-syntax` selectors fail lint on any
  `x.role === '<literal>'` comparison.
- `api/`: `npm run check:role-literals` (in CI) scans every endpoint.
  A genuinely intentional literal needs a reason on or above the line:
  `// role-literal-ok: <why>` — there are six today (job create/delete are
  deliberately literal-admin; credential-format policy; the `accounts` and
  `office` carve-outs in the activity feed; `apprenticeYear`).
