# 00 · Rebuild non-negotiables

The rules that apply to every line of code written in the rebuild. Product rules first (so we don't lose sight of what we're building), engineering rules second (so we don't build it badly again).

---

## Product rules

### Naming

1. **BuhlOS** is the name of the operating system / backbone — the company's internal operating layer.
2. **BuhlOS Admin** is the desktop control interface for boss, admin staff, project managers, estimators, office users.
3. **Phil** is the *internal* name of the field / mobile worker interface for tradesmen, apprentices, and workers on site. **Single-brand decision (2026-07-22):** this version presents as **one brand — BuhlOS — on every user-visible surface**, field included. "Phil" is reserved as a possible future field-app brand for other businesses and must not appear in user-visible copy (emails, screens, PWA manifest, notifications). Code identifiers, routes (`/phil/*`) and internal docs keep the phil name — field URLs are sacred (installed PWAs / bookmarks). The canonical brand constant is `src/naming/brand.ts` (CJS mirror `api/_lib/brand.js`); `src/naming/deprecated-naming.test.ts` enforces the user-visible ban.
4. **"Switchboard" and "Site Office" are deprecated.** They do not appear anywhere user-facing — not in URLs, page titles, buttons, body copy, marketing, manifest, localStorage keys, or anywhere else a non-engineer could see them.
5. The word "Switchboard" may appear when it refers to the electrical equipment (e.g. "Switchboard fit-off" as a task name). It must not appear as a product label.
6. The phrase "Site Office" never appears, period.
7. Per [[project_buhlos_phil_naming]] and [[project_phil_logo_v3]], the canonical names and logos are fixed.

### Surfaces

1. **Phil contains only field action surfaces.** What a worker does in the field, captures from the field, requests from the field. No reports. No long lists of approvals. No org admin.
2. **BuhlOS Admin contains planning, review, approval, reporting, and control.** No field-capture surfaces (you don't tag photos with a desktop keyboard).
3. **Leading hands are a hybrid.** They get Phil + a small admin surface for their crew. They do not get the full BuhlOS Admin.
4. **Clients get a read-only client portal**, scoped to their job only.
5. **A user belongs to one surface at a time** — the post-login redirect picks. A user can manually switch (admin-with-Phil-access) but the canonical landing is per role.

### Data integrity

1. **Every captured record links to job / stage / task / worker** where applicable. A photo is on a task, on an area, on a stage, on a job, captured by a worker, at a time. A snag is on an area, on a job. A timesheet is for a job, for a stage, for a worker.
2. **Every approval creates an audit log.** Hours approval, ITP signoff, snag resolution, plan acknowledgement — all write an immutable `AuditLog` event with the who/when/what/why.
3. **Every mutation validates its input** server-side, regardless of client validation. Zod schemas at the API boundary.
4. **No silent deletion** of existing feature concepts. If a feature is being retired, it is replaced with an `UNDER CONSTRUCTION` placeholder for one release, then removed.

### Feature gating

1. **Every incomplete feature must show UNDER CONSTRUCTION.** Visible, unambiguous, non-clickable.
2. **No half-broken UI shipped live.** Per [[feedback_hide_unfinished_features]] — half-broken UI must be hidden or labelled, never shipped live. This is non-negotiable.
3. **No mock-only UI pretending to be functional.** If data isn't real, the screen says so. A `DEMO MODE` banner appears across the whole shell when fixtures are loaded.
4. **`live` and `v1` markers** stay as the visible state taxonomy, applied honestly.

### Operational loops

1. **The first end-to-end loop is hours** (per [[project_buhlos_phil_hours_pipeline]]). Other loops follow this template:
   - Worker captures → admin sees → admin approves/rejects → record attaches to job entity → audit log records action → reporting updates.
2. **No feature ships without its loop closed.** Materials request without delivery confirmation is not a Materials feature. ITP completion without independent review is not an ITP feature.

---

## Engineering rules

### Language and tooling

1. **TypeScript only for new code.** No untyped JavaScript files in `src/`.
2. **Strict mode on.** `tsconfig.json` has `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`.
3. **`any` is forbidden** outside of carefully-marked type-shim files (`src/types/legacy/*` — none required at start).
4. **Zod for all runtime validation** at API boundaries, form parsing, and any place untrusted data crosses a trust boundary.
5. **No build step in `public/`.** Files in `public/` are static assets only (favicons, manifest, images). No app code.

### Application architecture

1. **No static HTML files as primary app surfaces.** All app code is React components rendered by Next.js. The existing `public/*.html` files stay reachable at `/legacy/*` during cutover but are never the canonical surface.
2. **No business logic inside page components.** Pages compose; domains contain logic. `src/app/(admin)/hours/page.tsx` calls into `src/domains/timesheets/` for everything it does.
3. **Shared domain logic belongs in `src/domains/<domain>/`** — never scattered across components or page files.
4. **All new data structures should be backend-ready, not random UI-only objects.** Every type that touches the API has its schema in `src/domains/<domain>/schema.ts`. Types are derived from schemas, not the other way around.
5. **One canonical source per concept.** No two files define `landingFor()`. No two components both call themselves "the JobHeader". No two CSS files both define `--accent`.

### Task-led architecture

1. **Tasks are first-class job objects.** A job is the operating context; the task instance is the operational spine. Areas, stages, systems, workers, dependencies, blockers, proof, QA, materials, RFIs and drawings are **facets of a task**. Every list (by area, stage, system, worker, blocked, QA, proof) is a **view — a projection over task instances**. Views stay views. See [task-led-job-architecture.md](task-led-job-architecture.md) and [task-led-jobs-adr.md](task-led-jobs-adr.md).
2. **Areas/stages are not the final task owner.** The `Job → Area → Stage → Task` hierarchy is **current storage and a place-first view**, not the long-term owner. New task-facet work keys off **canonical task identity** (the canonical task index + `src/domains/jobs/task-ref.ts`), not raw area arrays.
3. **The `jobId + areaId + stage + taskId` model is a compatibility bridge** over the older area/stage storage — load-bearing today (write paths, Phil display, job-control `TaskRef`, proof keying), but not the final architecture. The long-term target is a stable `taskInstanceId` (which exists **nowhere** in the code yet — it is a target, not a type).
4. **Do not deepen area-owned task arrays** (`dwellings[areaId][stage].tasks[taskId]`) as the *owner* of a task unless the change **explicitly documents itself as a temporary compatibility bridge**. Adding new facets onto the area-owned shape without that label entrenches the wrong architecture.
5. **Live area ids are unique within a job** — the invariant that lets a `(areaId, stage, taskId)` tuple resolve exactly one instance. Enforced server-side on every write path (`findDuplicateLiveAreaId`).
6. **Proof is area/package-granular by default** — per-task authoring is now opt-in (#539/#542): a requirement scoped to a task carries a `taskRef`; one with no `taskRef` stays package-level (byte-identical). The per-task submit→review *engine* is keyed to the task instance (#544/#546), but the **admin approve/reject surface is NOT built** and `taskInstanceId` is still a target term, not a type. Do not claim an admin proof-approval surface as existing. See [proof-review-model.md](proof-review-model.md).

### API and persistence

1. **Every feature must have schema, UI, mutation/API path, and test path** before it leaves draft.
2. **Every role-sensitive screen must enforce permissions** at three layers: middleware (route), page (UI gates), and API (server-side check). Server-side is authoritative.
3. **Every mutation must validate input** — Zod parse with server-side rejection. No client-only validation.
4. **No full-document writes for collections that grow.** Tasks/snags/notes/etc. get patch endpoints. The existing full-doc writes on `/api/data` are tolerated during transition but new code does not add more. The sanctioned end-state transition is the Supabase Postgres strangler ([supabase-storage-migration-adr.md](supabase-storage-migration-adr.md)).
5. **No mock-only endpoints.** If `src/app/api/<x>/route.ts` exists, it does real work or returns 501.

### UI

1. **No static HTML primary surfaces.** (Repeated for emphasis — this is the most common temptation when "just hack it in for now".)
2. **No `alert()`, no `confirm()`, no `prompt()`** in product code. Use proper UI components.
3. **No `document.body.innerHTML = '...'` page replacement.** Use React.
4. **No `window.location.href = '/...'`** for in-app navigation. Use `<Link>` / `useRouter()`. Hard navigation only for external links and explicit logout.
5. **No inline `<style>`** in component files. Tailwind utilities + design tokens only.
6. **No emojis** in product UI unless the design explicitly calls for them. Emojis in code comments are also banned.

### Deployment

1. **No random production deploys.** `main` is production. Direct `vercel deploy --prod` is removed from `package.json` and forbidden from local CLIs.
2. **No `GUARD_OVERRIDE` escape hatches.** Emergency reverts use `vercel promote <previous-deploy>` exclusively.
3. **Every PR gets a preview URL** and that's where it's verified. Production is touched only via merge.

### Naming hygiene

1. **No user-facing "Switchboard" or "Site Office"** (as product names). Equipment-name uses of "switchboard" are fine.
2. **No localStorage keys with deprecated names.** New code never writes `buhl-site-office-*`. Migration runs once on app boot and clears stale keys.
3. **No file or folder named `site-office`** anywhere in `src/` or `public/`.
4. **No code comments saying "site office"** (in active code). Historical regression docs may reference the prior naming for context.

### Performance and bundle hygiene

1. **No file >100KB** in `src/` without a clear reason. The current repo has ten files over 100KB; the rebuild keeps none.
2. **No 'one big component' files.** Pages compose multiple components, each in its own file.
3. **No global window state** — use React state, context, or a state library at the layer that owns the state.

### Testing

1. **Every domain has a test file.** `src/domains/timesheets/timesheets.test.ts` from the day timesheets exists.
2. **Every route has a render smoke test** (Playwright or `@testing-library`).
3. **Every API route has an integration test** covering at least the happy path and an unauthorized-call path.
4. **The hours loop has an end-to-end test** that walks through Phil → admin → approval. This is the reference loop and must always pass.

### Audit and observability

1. **Every mutation writes to `AuditLog`** with `{ actor, action, target, timestamp, before?, after? }`.
2. **Every permission denial writes to `AuditLog`** with `{ actor, attempted_action, target, reason, timestamp }`.
3. **Every error in production gets a unique error ID** shown to the user (so they can quote it) and recorded server-side.

### Backwards compatibility

1. **Old session cookies remain valid.** Don't change `SESSION_SECRET` or cookie format.
2. **Old Blob keys remain readable.** New writes may use new keys (with migration), but old keys are not silently abandoned.
3. **Old roles remain understood.** A user with `role: 'leadingHand'` in `users.json` continues to work without an admin manually updating records.

---

## Forbidden patterns (cheat sheet)

Things to refuse even if asked. Each refusal points at the rule that bans it.

| Pattern                                                         | Banned by rule                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| Adding a new static `.html` file to `public/`                   | "No static HTML files as primary app surfaces."             |
| Writing untyped JS in `src/`                                    | "TypeScript only for new code."                             |
| Using `any` in a new file                                       | "`any` is forbidden..."                                      |
| Skipping Zod validation on an API route                         | "Every mutation must validate input."                       |
| Adding a `BUHLOS_MOCK`-style invisible mock fallback             | "No mock-only UI pretending to be functional."              |
| Adding "site office" or "switchboard" as a product label         | "Deprecated names ban."                                     |
| `vercel deploy --prod` from a local branch                      | "No random production deploys."                             |
| `alert()` / `confirm()` in product code                         | "UI rule."                                                  |
| Adding a feature without an UNDER CONSTRUCTION fallback when broken | "Every incomplete feature must show UNDER CONSTRUCTION." |
| Full-document write to grow-collections in new code             | "No full-document writes..."                                |
| `window.location.href = ...` for in-app nav                     | "Use `<Link>` / `useRouter()`."                              |
| Inline `<style>` block in a component                           | "No inline `<style>` in component files."                   |
| 100KB+ single-component file                                    | "No file >100KB without a clear reason."                    |
| Adding a `/buhlos/*` mirror route                               | Discarded in salvage map.                                   |
| Naming a file or folder `site-office`                            | Forbidden name.                                              |
| Deepening area-owned task arrays without labelling it a bridge   | "Task-led architecture" rule 4.                             |
| Claiming a `taskInstanceId` type or an admin proof-approval surface as built (per-task proof authoring IS built, #539/#542; the office approve/reject UI is not) | "Task-led architecture" rules 3/6. |

---

## Cross-references

- Surface taxonomy: [01-target-rebuild-structure.md](01-target-rebuild-structure.md)
- Operational loop templates: [../product/00-core-operational-loops.md](../product/00-core-operational-loops.md)
- MVP scope: [../product/01-mvp-rebuild-scope.md](../product/01-mvp-rebuild-scope.md)
- Deploy enforcement: [../rebuild-audit/06-deployment-audit.md](../rebuild-audit/06-deployment-audit.md)
