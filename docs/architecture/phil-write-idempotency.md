# Phil write idempotency — replay-safe field writes (#497)

> **Status:** the shared mechanism ships and is wired into the evidence-create
> path (the one the offline capture queue #143 most needs). The other Phil write
> endpoints are listed below as straightforward follow-on adoptions. Foundation
> for [#143](https://github.com/oskar-ott/BuhlOS/issues/143).

## The problem

Phil field writes are `readBlob → mutate → writeBlob` against a per-job document.
A retry — a queued offline write replayed on reconnect, or a client retry after a
timeout where the response was lost — would **append a second record** (a
duplicate photo, snag, or evidence item). The offline capture queue cannot ship
safely until a retry of the same logical write is a no-op.

## The mechanism (`api/_lib/idempotency.js`)

A client sends an **idempotency key** — HTTP header `Idempotency-Key`, or a body
field `idempotencyKey`. The server records processed keys **on the same document
the write already touches**, so a retry returns the original result and writes
nothing new. No new store, no extra round-trip.

- `idempotencyKeyFrom(req)` → the key, or `null` (no key ⇒ today's behaviour,
  every write applies).
- `findIdempotent(doc, key)` → the result recorded for a seen key, else `null`.
- `recordIdempotent(doc, key, result, max=50)` → appends `{ key, result, at }` to
  a **bounded ring** `doc.__idempotency` (oldest trimmed past `max`), mutating
  `doc` so the key is persisted in the same write.

The stored `result` is the exact first response payload, so a replay is
byte-identical to the original.

## Wired: evidence create (`api/evidence.js`)

`createEvidence` reads the per-job `data.json` up front, checks the key **before
any side effect**, and on a hit returns `{ evidenceItem, idempotentReplay: true }`
with no second append and no duplicate audit/push. On a miss it appends the item
and `recordIdempotent`s the key in the same write. Covered by
`src/domains/evidence/evidence-create-idempotency-api.test.ts` (same key → one
item; different keys → distinct; no key → unchanged) and the unit tests in
`src/domains/platform/idempotency.test.ts`.

## Adopt next (same three-line pattern)

Each appends to `jobs/<jobId>/data.json` and should read → `findIdempotent` →
return-or-apply → `recordIdempotent` → write:

- `api/snag-quick-raise.js` — snag create (offline-queueable).
- `api/snags.js` — snag create + transition.
- `api/task-toggle.js` — already naturally idempotent for state-setting
  (re-applying the same state is a `changed:false` no-op), so a key is optional
  here; add it only if the offline queue needs a stable replay receipt.
- `api/observations.js` convert-to-snag — the two-write flow; write the
  observation pointer **last** and dedupe on the observation id (closes the
  documented orphan-snag race).

## Concurrency (separate, already available)

Idempotency makes **retries** safe. Concurrent **distinct** writes to the same
document are protected separately by the revision guard already in
`api/_lib/blob-guards.js` (`__rev` stamping + `expectedRev` → `StaleWriteError`),
which endpoints can opt into by passing `expectedRev` to `writeBlob`. The two are
complementary: idempotency dedupes the same logical write; the revision guard
stops a stale write clobbering a newer one.
