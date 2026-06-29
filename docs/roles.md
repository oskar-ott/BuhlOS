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
| `isOwnerRole(role)` | the product/platform owner — a **narrowing within** the admin tier (`owner` ∈ admin tier, so `isAdminRole('owner')` is also true). Gates the Owner Console only; never replaces the admin-tier checks. |

The **Owner Console** (`docs/owner-console.md`, `/owner`) is gated to the owner —
`isOwnerRole(role)` **OR** the `OWNER_EMAILS` email allowlist (the cookie carries
no email, so the email check is authoritative at the API in `api/_lib/auth.js`
via `canAccessOwnerConsole(user)`). A user whose stored role is `owner` also
lands on `/owner` (`landingFor`), not `/command-centre`.

**Env-only owner principal (#760).** The preferred owner identity is *not* a
`users.json` employee — it's a synthetic principal (id `__owner__`, role `owner`)
authenticated against `OWNER_PASSWORD_HASH` (bcrypt, env; fail-closed) and resolved
by `getCurrentUser` without a stored row, so it leaves no trace in the Employees
roster. Role `owner` is therefore **not** in `VALID_ROLES` (no owner employee), and
the owner username + `__owner__` id are reserved (`api/users.js`, the `users.json`
write-guard). See `docs/owner-console.md` → "Owner identity".

JS (`api/`): `require('./_lib/auth')`. TS (`src/`): `src/lib/auth/roles.ts`.

**Enforcement** — two guards, because `next lint` deliberately ignores `api/`:

- `src/`: ESLint `no-restricted-syntax` selectors fail lint on any
  `x.role === '<literal>'` comparison.
- `api/`: `npm run check:role-literals` (in CI) scans every endpoint.
  A genuinely intentional literal needs a reason on or above the line:
  `// role-literal-ok: <why>` — there are six today (job create/delete are
  deliberately literal-admin; credential-format policy; the `accounts` and
  `office` carve-outs in the activity feed; `apprenticeYear`).
