# Workshop Stock (`workshop_stock`)

> **Status (2026-10-09): built, dark, not operational.** The five states are
> defined in [feature-flags.md](feature-flags.md) ("What a flag proves").
>
> - **Built:** the slice below, behind `workshop_stock` (launch-gate, default
>   off, global target).
> - **Registry default:** off. While off, nothing of it exists for anyone:
>   `/phil/stock` and `/stock` 404, every `/api/workshop-stock` path 404s right
>   after the session check, the office nav item and the More-screen card are
>   not rendered.
> - **Effectively enabled:** read it at `/owner` — not provable from the repo.
> - **Externally configured:** **no.** The migration
>   `20261009100000_workshop_stock.sql` has been applied only to a local test
>   database. Photo reading and the online check reuse the existing
>   `ANTHROPIC_API_KEY`; web search must also be enabled for the organisation in
>   the Claude Console, and Vercel must be able to reach the allowlisted sites —
>   neither is verified. See [Activation](#activation-operator-steps--none-performed-by-the-pr).
> - **Operationally proven:** no. The photo reader, the web search and the page
>   fetch were exercised only against fixtures (the build sandbox has no product
>   API key and no egress to the supplier sites). Everything else — ledger,
>   locking, idempotency, undo, matching, verification logic, both surfaces — was
>   exercised end to end against real Postgres in a browser
>   ([Testing](#testing)).
>
> **Pull:** owner pull, 2026-10-09. **Hypothesis:** if workers can identify
> stock from a photo and confirm a quantity with minimal effort, they will keep
> the workshop stock list useful enough to check before buying more materials.
> Not part of the ratified lean core
> ([product/02-lean-reset.md](product/02-lean-reset.md)); it earns its place, or
> not, through the loop in [product/03-lean-startup-loop.md](product/03-lean-startup-loop.md).

## What it does

Electrical materials and consumables kept in the workshop — GPOs, switches,
breakers, conduit, cable, fittings, fixings: what we have, how many are
recorded, and where they live.

**Workers (phone, `/phil/stock`)**

- Search the list by name, code, barcode or shelf; each row shows the photo,
  the recorded quantity with its unit, and the shelf/bin.
- **Take stock** — photograph the item; when its barcode or code identifies one
  of our items, confirm the quantity and save. Several products in the photo →
  "which one?". Not recognised → search the list, take a closer photo, or add
  it as new stock (explicitly).
- **Add stock** — photograph the item or its box: if it is already in the
  workshop, add to it; if not, one short form pre-filled from the label,
  checked against a public listing, then quantity + location → save. "Save and
  add another" goes straight back to the camera (setting up the workshop).
- **Return unused stock** — find the item, confirm the quantity.
- Note a job on a movement if they like (optional, informational — **never a
  job cost**).
- Undo their own movement for 30 minutes.

**Office (`/stock`, desktop and phone)**

- The full list with filters (None recorded · Estimates · Code not confirmed ·
  Archived), last movement and last count per item.
- Per item: **correct the count** (with a stale-count guard), the full movement
  history with **Undo** (any movement, a reason required), catalogue edits
  (compare-and-set), codes / barcodes / pack sizes, the online code check, the
  photo, archive / restore.
- Add items the same way the crew does.

**Not gear.** Gear (tools and equipment) has custody, serials, test-and-tag and
"who has it". Workshop stock has none of that: an item is a quantity on a shelf
and stock leaving is a quantity movement, not a loan. The two share nothing but
a nav group; the Gear workflow is untouched.

## Flows

### Add stock: photo → read → find/verify → confirm quantity + location → save

1. The phone downscales the photo (1600 px, JPEG) and sends it once.
2. The server validates it, stores it as a **pending** photo, and reads the
   label (photo reading below). Reading never writes stock.
3. The reading is matched against the catalogue ([Identification](#identification)).
   An exact match → **Matched in workshop**: add to that item (no duplicate).
   Weaker evidence → "Is it one of these?" with "None of these — it's new".
4. A new item opens one form. Fields read from the photo are labelled **read
   from photo**; when the label showed a manufacturer code, the online check
   runs once by itself and its result shows as evidence with its source link.
   "Use these details" fills empty fields from the listing (labelled **from
   the listing**). Before saving, the form says the code status the item will
   be saved with.
5. Name, unit, location and the quantity going on the shelf (or a number of
   full packs × the pack size) → **Save**. The item, its codes, its photo and
   its opening movement are created in **one transaction** — or nothing is.
   A code another live item already carries is refused with "Add to "X"
   instead".

### Take stock: photo → identify → confirm → deduct

The photo is read for identification only and **not stored**. Only an exact
catalogue match goes straight to the confirmation; the confirmation shows the
item, brand · code · colour · rating, supplier SKU, the shelf, the recorded
quantity and what matched (e.g. "Matched in workshop · barcode
9300704010017"). Nothing changes until **Confirm take**. A take larger than
what is recorded is refused on the phone and by the database, with the
recorded quantity said plainly ("Only 2 each recorded. If there's more on the
shelf, ask the office to correct the count.").

### Return, count, undo

- **Return** adds back what wasn't used (a separate movement kind from add).
- **Count** (office): "Start a count" pins the ledger version; if anything moved
  while counting, the save is refused and the movements since are listed — the
  counter confirms ("My count is right — save it") or counts again. A count
  records the counted quantity and the difference, and is the item's new
  "last counted".
- **Undo** writes a compensating reversal; nothing is edited or deleted
  ([Permissions and the undo policy](#permissions-and-the-undo-policy)).

### No signal, lost answers

A save is only "saved" when the server says so. Every write carries one
**operation key** for its whole life (retries reuse it), and the phone keeps the
pending save in local storage, stamped with the worker's id. If the answer is
lost (no signal, 5xx, the phone killed the app), the form locks with **Try
again** (same key — the server replays the first result, never a second
movement) and **Check if it saved** (asks the server about that key). Reopening
the screen later does the check by itself and says "Your last save went
through" — or offers to save it now / discard it. A pending save is only ever
read back for the person who made it, expires after a day, and is cleared on
Phil sign-out. Offline, nothing is queued silently; the screen says it didn't
save.

## Identification

`api/_lib/workshop-stock/match.js` — pure, over the live catalogue:

| Evidence | Strength | Notes |
| --- | --- | --- |
| Barcode (GTIN, check digit valid) | 100 | compared as GTIN-14 |
| Manufacturer code, same brand | 90 | 60 when the photo's brand clashes |
| Supplier SKU, same supplier | 85 | 50 when the supplier clashes |
| Code differs only by punctuation | 55 / 50 | "check it" |
| A code matches a different kind | 45 | "check which one" |
| Description words | ≤ 40 | never exact; a colour conflict lowers it |

**Exact** (straight to confirmation) only when exactly one item has clean
evidence of strength ≥ 85 and nothing else competes; otherwise up to five
candidates for the worker to pick from, each with its conflicts named ("colour
differs"). Codes keep their punctuation and leading zeroes for display; the
exact key uppercases and removes spaces. Several products in one reading → the
worker picks the product first. One item per transaction, always.

## Photo reading

`api/_lib/workshop-stock/vision.js` — the same provider and call shape as the
supplier-invoice reader (`invoices/vision-extract.js`): Anthropic Messages API
with a strict JSON schema (structured output), the invoice reader's model
(`INVOICE_VISION_MODEL`) unless `STOCK_VISION_MODEL` is set, 30 s timeout, no
retries.

- **Reads only what is printed.** Per product: brand, manufacturer code,
  supplier SKU and supplier, description, colour/finish, size/rating details,
  barcode digits, pack quantity + unit **only when printed**, the label lines,
  and where it sits in the frame. Missing stays null. There is no count field —
  the model is told not to count items.
- **Untrusted.** Text in the photo is data, never instructions (said in the
  prompt; and nothing it returns is acted on without the worker's
  confirmation). The output is re-validated: codes must fit a strict alphabet,
  barcodes need a valid check digit, pack sizes must be explicit, at most four
  products. A refusal, a truncated or malformed answer, or an outage is a
  status ("Photo reading isn't working right now"), never a 500, and the flow
  continues by search or by hand.

## Online code check

Search the catalogue first (above); only a NEW item's code is checked online.
The pipeline, each piece replaceable:

1. **Search** (`search.js`) — Anthropic's server-side web search tool
   (`web_search_20250305`, `STOCK_LOOKUP_SEARCH_TOOL` to change it) on the
   existing `ANTHROPIC_API_KEY`: no new vendor, no scraping a search engine.
   `allowed_domains` = the allowlist, at most 2 searches, Australian location.
   The query contains only the validated code and brand. We keep only the
   search-result URLs/titles and verbatim cited snippets — **the model's prose
   is ignored**.
2. **Allowlist** (`sources.js`) — manufacturers: clipsal.com, se.com,
   hpm.com.au, legrand.com.au, nhp.com.au, hager.com.au, abb.com, olex.com.au,
   pierlite.com, sal.net.au; wholesalers: rexel.com.au, jrt.com.au, lh.com.au,
   ebranch.online, middys.com.au, haymans.com.au, cnw.com.au,
   idealelectrical.com.au, sparkydirect.com.au. `STOCK_LOOKUP_DOMAINS`
   replaces it. The brand's own sites are searched/opened first.
3. **Fetch** (`safe-fetch.js`) — our own request, SSRF-safe: https only, port
   443, no credentials or IP hosts, allowlisted host; every DNS answer checked
   at connect time against private/reserved ranges (incl. IPv4-mapped/NAT64);
   redirects re-validated (max 3); HTML only; 1.5 MB cap counted after
   decompression; 8 s wall clock. At most 3 pages in a 20 s budget.
4. **Extract + verify** (`page-extract.js`, `verify.js`) — deterministic code,
   no model: the page's JSON-LD Product (name, brand, sku/mpn/gtin, colour),
   title and h1. Statuses:

| Status | When |
| --- | --- |
| **Manufacturer code matched** | the exact code is the page's own code (structured data or title/h1 — a wholesaler's bare `sku` field doesn't count), the brand is confirmed (the maker's own domain, the page's brand, or the brand in the title), no colour/rating conflict, and the code isn't too generic to mean anything |
| **Possible match** | some of that, not all — every missing part is listed as a reason |
| No listing found / Couldn't check online / Online check not set up | said plainly; the item can still be saved |

A worker accepting a listing saves the item as **Manufacturer code matched** or
**Possible match** — the server takes the status from **its own cached check**,
never from the phone. Anything else saves as **Saved without external
verification**. A match is evidence that a public listing uses this code, **not
a certification** or a check that it suits the job (said on the card).
Listings are cached per brand + code (matched 30 days, possible 7, none 3); the
office can re-check and record the result on an item.

## Information kept apart

- **From the photo** — the reading is stored with the photo row (`reading`),
  and the item's `provenance` records which fields came from it.
- **From a listing** — the item's `verification` holds the source URL, title,
  domain, status, reasons and when it was checked; fields filled from it are
  marked `lookup` in `provenance`.
- **Confirmed by a person** — every saved field is what the worker confirmed;
  typed fields are marked `typed`. The listing's name/photo never overwrite what
  a person typed.

## Quantities, units, packs, estimates

- Units: each, metre (to 0.1 m), length, bag, box, roll, pack. Quantities are
  exact integers in thousandths (bigint) — parsed from decimal strings, never
  floating point; a quantity that doesn't fit the unit's precision is refused.
- Packs are an **explicit conversion**: "2 boxes × 10 each = 20 each", shown
  before saving and stored on the movement. A printed pack size is offered,
  never applied silently; a pack size can be remembered as the item's default,
  and a pack barcode can carry its own size.
- **Estimated** — a part-used roll or a rough count is saved as an estimate
  and shown as "≈ 40 m (estimate)" until a real count.
- The unit **locks** once real stock has moved (the database refuses the
  change); archive and re-add instead.
- Zero is "None recorded" — the list is a record, not a promise of what's on
  the shelf.

## Integrity

- **One transaction per write** with the item row locked (`FOR UPDATE`): the
  movement insert and the cached balance change in the same statement (BEFORE
  INSERT trigger) — they cannot drift, and a direct balance update raises.
- **Append-only ledger** (update/delete raise); server-stamped time; actor
  from the session.
- **No negative stock** — refused in the database; the refusal carries the real
  recorded balance.
- **Idempotency keys** unique per company; the request hash beside each key
  makes a reused key with a different payload a refusal, and an identical retry
  a replay. Concurrent duplicates are resolved by the unique index (proven with
  10 parallel connections).
- **Stale-count guard** — a count is pinned to the version counting started
  from.
- **Undo** — one reversal per movement (partial unique index); a reversal can't
  be reversed; it can't take stock below zero; and a movement a later count has
  absorbed can't be undone at all (the count already corrected it — undo the
  count first, or count again). Checked by the API, under the item lock, and
  by the ledger trigger.
- **Tenant scope** from the server; composite `(tenant_id, id)` foreign keys.

## Permissions and the undo policy

`api/_lib/workshop-stock/policy.js` — role tiers only, server-side:

| | Field tier & leading hands | Office (admin tier) |
| --- | --- | --- |
| See the list, history of an item | ✓ | ✓ (+ archived, catalogue history) |
| Take / add / return, create an item via Add stock | ✓ | ✓ |
| Photo reading, online check | ✓ | ✓ (+ re-check, record on an item) |
| Undo | own opening/add/take/return, within **30 minutes** | any movement, any time, **reason required** |
| Count, edit, codes/packs, photo, archive/restore | — | ✓ |

Clients and unknown roles get 403; signed-out 401. The actor, role and company
always come from the session; bodies are validated (Zod). Office actions,
counts, undos and item creation are journalled (`workshop_stock.*` audit verbs).

## Photos: validation, storage, retention

- **On the phone:** orientation applied, downscaled to 1600 px, re-encoded as
  JPEG (which also drops EXIF metadata such as location); a dark photo gets a
  non-blocking hint.
- **On the server:** at most 3 MiB; the type is sniffed from the bytes (JPEG,
  PNG, WebP — never trusted from the client), the dimensions are read from the
  header (64–10,000 px).
- **Storage:** Vercel Blob under `workshop-stock/<company>/photos/` with a
  random suffix; the URL never leaves the server — photos are served only
  through the authenticated `?action=photo` proxy (`nosniff`, private cache).
- **Retention:** take photos are not stored. An add photo is **pending** for a
  day — claimed by the item it becomes, otherwise deleted. A replaced item photo
  is retired and deleted a day later. Clean-up runs opportunistically on the
  next photo upload; nothing else is kept.

## Limits and cost

| Control | Value |
| --- | --- |
| Photo reads per person | 30 per 10 minutes (per warm instance) |
| Online checks per person | 20 per hour (per warm instance) |
| Daily ceiling per company | `STOCK_DAILY_PHOTO_READS` (300), `STOCK_DAILY_LOOKUPS` (60) — durable, in Postgres |
| Per check | ≤ 2 searches, ≤ 3 pages, 20 s page budget; cached per brand + code |
| Function duration | 60 s (`vercel.json`) |

Costs are Anthropic API usage on the existing key: tokens for each photo read
and check, plus the web search tool's per-search price. Measured cost is not
known until real use — watch the usage counters (`workshop_stock_usage`).

## Configuration

| Env | Purpose |
| --- | --- |
| `FLAG_WORKSHOP_STOCK` | optional env pin for the flag (normally flipped at `/owner`) |
| `ANTHROPIC_API_KEY` | existing key (receipts/invoices) — photo reading + search |
| `STOCK_VISION_MODEL`, `STOCK_LOOKUP_MODEL` | override the model for photo reading / the search turn (default: the invoice reader's model) |
| `STOCK_LOOKUP_SEARCH_TOOL` | the web search tool version |
| `STOCK_LOOKUP_DOMAINS` | replace the source allowlist, e.g. `clipsal.com=manufacturer:clipsal,rexel.com.au=supplier` (see `sources.js`) |
| `STOCK_PHOTO_READ_DISABLED=1` / `STOCK_LOOKUP_DISABLED=1` | turn photo reading / online checks off; the flows fall back to search and by hand |
| `STOCK_DAILY_PHOTO_READS`, `STOCK_DAILY_LOOKUPS` | daily ceilings |
| `BLOB_READ_WRITE_TOKEN` | existing Blob store (photos) |

## Data

Migration `supabase/migrations/20261009100000_workshop_stock.sql` (additive):
`workshop_stock_items`, `_identifiers`, `_movements`, `_item_events`, `_photos`,
`_lookup_cache`, `_usage`. RLS on, no policies (service-role only — the house
pattern; see [architecture/supabase-rls-access-matrix.md](architecture/supabase-rls-access-matrix.md)).
The integrity rules above live in its triggers and indexes. The down path is in
the file's header (drops, in order — only for abandoning the feature, after an
export).

## Surfaces and navigation

- Phone: one card in the More screen's reference group (`/v2/phil`), shown
  only while the flag is on — **no tab, no My Day tile** (P10). Level one of
  `/phil/stock` is one decision: Take stock or Add stock; Return and per-item
  actions are one tap down. Quantities are labelled as recorded (P7); copy is
  site language (P11); undo sits apart from the primary action and archive sits
  apart from everything (P12); the phone's back gesture closes an open sheet
  instead of leaving the page (P8).
- Office: "Workshop stock" in the People & gear nav group, flag-gated.
- Routes: [route-ownership.md](route-ownership.md) §4/§8/§9.

## Activation (operator steps — none performed by the PR)

1. Merge the PR (squashed, `main` only).
2. Apply `20261009100000_workshop_stock.sql` to the **dev** project, then to
   **production** as an operator release step (Supabase migration process —
   never from an agent session). Confirm the seven tables exist with RLS on.
3. Confirm `ANTHROPIC_API_KEY` is set in Production and that **web search is
   enabled for the organisation** in the Claude Console; leave the stock env
   vars unset to take the defaults.
4. On a preview with the migration applied: flip the flag for the preview
   only, photograph two or three real products, take one, undo it, return
   one, and count one from the office. Check the source links the online
   check shows and that nothing from the preview remains (archive the test
   items).
5. Flip `workshop_stock` on at `/owner` (audited). Record the effective state
   in [runbooks/production-flag-verification.md](runbooks/production-flag-verification.md).
6. Set up the workshop with real stock as a deliberate job (Add stock → Save
   and add another).

## Rollback

- **Flag off** at `/owner` → every surface and API path 404s at once; the data
  stays (nothing is deleted when the flag goes off) and comes back as it was.
- Photo reading or online checks misbehaving alone →
  `STOCK_PHOTO_READ_DISABLED=1` / `STOCK_LOOKUP_DISABLED=1`.
- A wrong movement → Undo; a wrong balance → Correct the count. No job cost is
  ever written, so jobs need no repair.
- Removing the tables is a separate, deliberate decision (export first; the
  down path is in the migration header).
- [runbooks/rollback-and-incident.md](runbooks/rollback-and-incident.md) has the row.

## Testing

| Layer | What | Run |
| --- | --- | --- |
| Unit | quantities, codes, barcodes, matching, variants, extraction, verification, SSRF guards, client decisions, pending-save scoping | `npx vitest run src/domains/workshop-stock src/components/stock` |
| API | the real handler with mocked store/AI: auth, flag 404, office-only, actor from session, idempotency keys, uploads, statuses | (same; `workshop-stock-api.test.ts`) |
| Postgres | the store + triggers against a real local Postgres: atomic ledger, no negatives, concurrent takes (10 connections), idempotent replays/conflicts, stale counts, one-time undo, counted-since, atomic create, tenants, archive, unit lock, cost ceiling | `WORKSHOP_STOCK_PG_TEST=1 SUPABASE_ENV=local SUPABASE_PROJECT_REF=localstack SUPABASE_DB_URL=postgres://…@localhost:5432/<db> npx vitest run src/domains/workshop-stock/workshop-stock-store.pg.test.ts` (migrations applied to `<db>`) |
| Browser E2E | phone (Pixel 7) + desktop, real pages + real handler + real local Postgres; the photo reader's model answer, the search response and the listing pages are **fixtures** (`scripts/qa/workshop-stock-e2e/harness.js`) | below |

Browser E2E, locally (never against a hosted database — the harness refuses a
non-localhost URL):

```bash
# 1. a local Postgres with every migration applied and a 'buhl' tenant row
# 2. the harness: the real /api/workshop-stock on :3101
WORKSHOP_STOCK_E2E_DB_URL=postgres://…@localhost:5432/<db> SESSION_SECRET=<16+ chars> \
  node scripts/qa/workshop-stock-e2e/harness.js
# 3. the app, flag on, same secret
SESSION_SECRET=<same> FLAG_WORKSHOP_STOCK=1 npx next dev -p 3000
# 4. the spec (optionally WORKSHOP_STOCK_E2E_CHROMIUM=<path> for a preinstalled browser)
WORKSHOP_STOCK_E2E_API=http://localhost:3101 npx playwright test tests/workshop-stock --project=desktop-chrome
```

The spec covers: More → Workshop stock; add by photo with the online check and
packs; photograph again and take; Undo; take from the list; return; a lost
answer recovered by Try again (one movement) and by reopening (reconciled);
several products → which one; unknown product → add as new; reader and check
both down → by hand; the office list, filters, history, the stale-count path,
an audited undo, the counted-since refusal; the worker seeing the office's
count; the office list at phone width. It fails on any page error, console
error or failed request that isn't named as environment noise in the spec.

## Deliberately out of scope

Tool custody, vans and transfers, reservations, purchase orders and
reordering, supplier integrations, valuation, invoice-to-stock posting, job
costing, mandatory job selection, analytics, a general assistant.

## Known limitations

- Live provider behaviour is unproven: real label photos, real search results
  and real supplier pages may read or verify worse than the fixtures. Expect to
  tune the allowlist and verification rules from the first real checks.
- Per-person rate limits are per warm serverless instance (the daily ceilings
  are durable).
- Offline means "not saved, said plainly": there is no background queue that
  sends later — the pending save is reconciled when the worker comes back.
- Photos are validated and re-encoded on the phone; a client that bypasses the
  app could store a photo with its original metadata (the server sniffs type
  and size only).
