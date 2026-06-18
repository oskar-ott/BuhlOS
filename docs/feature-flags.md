# Feature flags (#155)

Merge unfinished work **dark**, stage it to the admin tier first, switch off
a misbehaving feature without a revert deploy. Backs the standing rule:
half-broken UI is hidden or labelled, never shipped live.

## The registry

One source of truth: [api/_lib/feature-flags.js](../api/_lib/feature-flags.js)
(+ `.d.ts` for typed `src/` consumption — add new keys to **both**, same PR).
Every flag declares a description, `default: false` (always), a target, and
an **expiry date** — flags are temporary by default, and
`npm run check:flag-expiry` (CI) fails the build once a flag outlives its
date: delete it (and the dead branch it guarded) or consciously extend it.

| Flag | Target | Expires | What it gates |
|---|---|---|---|
| `supabase_dual_write` | global | 2026-09-30 | Mirror blob writes into Supabase per migrated domain (#152) |
| `admin_flags_readout` | admin-tier | 2026-09-30 | The active-flags readout card on /command-centre |
| `supabase_read_health` | global | 2026-12-31 | `GET /api/supabase-health` — the read-only Supabase connectivity proving slice (#533) |

## Flipping a flag

Resolution order — first hit wins:

1. **Env var** `FLAG_<SNAKE_UPPER>` (`FLAG_SUPABASE_DUAL_WRITE=1`) — set in
   Vercel env, takes effect on the next deploy. Beats everything, both
   directions (an env `0` force-disables a blob-enabled flag).
2. **Runtime override** — the `flags.json` blob:
   `{ "flags": { "supabase_dual_write": true } }`. No deploy needed; rides
   the 5s `readBlob` TTL cache so it costs nothing on hot paths. (It's in the
   backup manifest like every canonical store.)
3. **Registry default** — always `false`. Dark by default.

**Targeting applies on top:** an `admin-tier` flag is only ever on for
admin-tier viewers (tier-aware `isAdminRole` — the role-literal guard applies
here like everywhere). `global` ignores the viewer.

## Using a flag

```js
// api/*.js (CJS)
const { isFlagEnabled } = require('./_lib/feature-flags');
if (await isFlagEnabled('supabase_dual_write')) { /* dark path */ }
```

```ts
// src/ server components / route handlers
import { isFlagEnabled, flagsForViewer } from "../../../../api/_lib/feature-flags.js";
const show = await isFlagEnabled("admin_flags_readout", session);
```

Client components never read flags directly — a server component resolves
`flagsForViewer(session)` and passes the booleans down. Never serialize the
raw `flags.json` blob to a client.

Unknown flag names **throw** at runtime and fail typecheck (`FlagKey` union)
— a typo can't silently resolve to off.

## Conventions

- Name by feature, snake_case, no `enable_`/`new_` prefixes.
- Default off, expiry ≤ ~90 days out. The expiry guard is the cleanup nag.
- A flag guards ONE coherent feature; if you need two flags for one feature,
  the feature is two features.
- Pilot: `admin_flags_readout` is the worked example — the readout it gates
  is itself dark by default and admin-tier-targeted in the same build.
