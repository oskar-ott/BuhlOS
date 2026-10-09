import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Workshop Stock — the REAL store + ledger triggers against a real Postgres.
 *
 * Runs only with WORKSHOP_STOCK_PG_TEST=1 and SUPABASE_ENV=local (a throwaway
 * local database with supabase/migrations/20260611142758_phase1_core_schema.sql
 * and 20261009100000_workshop_stock.sql applied — see docs/workshop-stock.md
 * "Testing"). Local only on purpose: the ledger is append-only by trigger, so
 * cleanup needs session_replication_role (superuser), which a shared dev
 * project must not hand out. Skipped in CI.
 *
 * Concurrency is real: each "worker" gets its OWN connection (max:1, the
 * production pool shape), the way separate serverless instances would.
 */
const ENABLED = process.env.WORKSHOP_STOCK_PG_TEST === "1" && process.env.SUPABASE_ENV === "local" && !!process.env.SUPABASE_DB_URL;
const requireFromHere = createRequire(import.meta.url);

type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  end: (o?: { timeout?: number }) => Promise<void>;
  begin: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  (v: unknown): unknown;
};

describe.skipIf(!ENABLED)("workshop stock store — real Postgres", () => {
  const store = requireFromHere("../../../api/_lib/workshop-stock/store.js");
  const codes = requireFromHere("../../../api/_lib/workshop-stock/codes.js");
  const postgres = requireFromHere("postgres");
  const url = process.env.SUPABASE_DB_URL as string;
  const marker = `wst${Date.now().toString(36)}`;
  const pools: Sql[] = [];
  let sql: Sql;
  let tenantA: string;
  let tenantB: string;
  const worker = { id: "u_field", name: "Sam Sparky", role: "electrician" };
  const office = { id: "u_office", name: "Olive Office", role: "office" };
  let n = 0;
  const key = (label: string) => `${marker}-${label}-${++n}`.slice(0, 100);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");

  function connect(): Sql {
    const c = postgres(url, { max: 1, prepare: false, idle_timeout: 5 }) as Sql;
    pools.push(c);
    return c;
  }

  async function makeItem(over: Record<string, unknown> = {}, openingMilli = 0, actor = worker, extra: Record<string, unknown> = {}) {
    const name = String(over.name ?? `Test item ${++n}`);
    const r = await store.createItemWithOpening(sql, tenantA, {
      item: { name, baseUnit: "each", ...over },
      identifiers: [],
      openingMilli,
      actor,
      idempotencyKey: key("create"),
      requestHash: hash(`create-${name}-${n}`),
      ...extra,
    });
    expect(r.ok).toBe(true);
    return r;
  }

  beforeAll(async () => {
    sql = connect();
    const a = await sql`insert into public.tenants (name, slug) values (${"Test A"}, ${marker + "-a"}) returning id`;
    const b = await sql`insert into public.tenants (name, slug) values (${"Test B"}, ${marker + "-b"}) returning id`;
    tenantA = String(a[0]!.id);
    tenantB = String(b[0]!.id);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const t of [tenantA, tenantB]) {
        await tx`delete from public.workshop_stock_movements where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_item_events where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_identifiers where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_items where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_photos where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_lookup_cache where tenant_id = ${t}`;
        await tx`delete from public.workshop_stock_usage where tenant_id = ${t}`;
        await tx`delete from public.tenants where id = ${t}`;
      }
    });
    await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
  });

  it("records opening / add / take / return, and the cached balance always equals the ledger", async () => {
    const created = await makeItem({ name: "Clipsal double GPO" }, 10_000);
    expect(created.item.balanceMilli).toBe(10_000);
    expect(created.movement.kind).toBe("opening");
    expect(created.item.lastCountedAt).toBeTruthy(); // a non-estimated opening is a count
    const id = created.item.id;
    const add = await store.recordMovement(sql, tenantA, { itemId: id, kind: "add", quantityMilli: 5000, actor: worker, idempotencyKey: key("add"), requestHash: hash("add") });
    const take = await store.recordMovement(sql, tenantA, { itemId: id, kind: "take", quantityMilli: 3000, actor: worker, idempotencyKey: key("take"), requestHash: hash("take"), jobId: "job_1", jobLabel: "IV3232 · Birdwood" });
    const ret = await store.recordMovement(sql, tenantA, { itemId: id, kind: "return", quantityMilli: 1000, actor: worker, idempotencyKey: key("ret"), requestHash: hash("ret") });
    expect([add.item.balanceMilli, take.item.balanceMilli, ret.item.balanceMilli]).toEqual([15_000, 12_000, 13_000]);
    expect(take.movement).toMatchObject({ kind: "take", quantityMilli: -3000, balanceAfterMilli: 12_000, jobId: "job_1", jobLabel: "IV3232 · Birdwood", actorId: "u_field" });
    const sum = await sql`select coalesce(sum(quantity_milli),0)::bigint as s from public.workshop_stock_movements where tenant_id = ${tenantA} and item_id = ${id}`;
    expect(Number(sum[0]!.s)).toBe(13_000);
    const hist = await store.listMovements(sql, tenantA, id);
    expect(hist.map((m: { kind: string }) => m.kind)).toEqual(["return", "take", "add", "opening"]);
  });

  it("takes the final unit, then refuses one more with the actual recorded balance", async () => {
    const { item } = await makeItem({ name: "Last one" }, 2000);
    const t1 = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 2000, actor: worker, idempotencyKey: key("t"), requestHash: hash("t1") });
    expect(t1.item.balanceMilli).toBe(0);
    const t2 = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: worker, idempotencyKey: key("t"), requestHash: hash("t2") });
    expect(t2).toMatchObject({ error: "insufficient_stock", balanceMilli: 0, unit: "each" });
    const after = await store.getItem(sql, tenantA, item.id);
    expect(after.balanceMilli).toBe(0);
  });

  it("serialises simultaneous withdrawals from separate connections: never negative, never lost", async () => {
    const { item } = await makeItem({ name: "Contested GPO" }, 5000);
    const conns = Array.from({ length: 10 }, () => connect());
    const results = await Promise.all(conns.map((c, i) =>
      store.recordMovement(c, tenantA, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: { ...worker, id: `u_${i}` }, idempotencyKey: key(`race${i}`), requestHash: hash(`race${i}`) })));
    expect(results.filter((r: { ok?: boolean }) => r.ok).length).toBe(5);
    expect(results.filter((r: { error?: string }) => r.error === "insufficient_stock").length).toBe(5);
    const after = await store.getItem(sql, tenantA, item.id);
    expect(after.balanceMilli).toBe(0);
    const balances = results.filter((r: { ok?: boolean }) => r.ok).map((r: { movement: { balanceAfterMilli: number } }) => r.movement.balanceAfterMilli).sort();
    expect(balances).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("a retried or double-tapped save is ONE movement; a reused key with a different payload is refused", async () => {
    const { item } = await makeItem({ name: "Retry GPO" }, 10_000);
    const k = key("retry");
    const input = { itemId: item.id, kind: "take", quantityMilli: 2000, actor: worker, idempotencyKey: k, requestHash: hash("same-payload") };
    // simultaneous double tap from two connections
    const [a, b] = await Promise.all([store.recordMovement(connect(), tenantA, input), store.recordMovement(connect(), tenantA, input)]);
    expect([a.replayed === true, b.replayed === true].filter(Boolean).length).toBe(1);
    expect(a.movement.id).toBe(b.movement.id);
    // a later retry (response lost)
    const again = await store.recordMovement(sql, tenantA, input);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.movement.id).toBe(a.movement.id);
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(8000);
    const rows = await sql`select count(*)::int as c from public.workshop_stock_movements where tenant_id = ${tenantA} and idempotency_key = ${k}`;
    expect(rows[0]!.c).toBe(1);
    // same key, different quantity
    const clash = await store.recordMovement(sql, tenantA, { ...input, quantityMilli: 5000, requestHash: hash("other-payload") });
    expect(clash).toEqual({ error: "idempotency_conflict" });
    // same key used for a different item (no shared lock) → the unique index still refuses it
    const other = await makeItem({ name: "Other item" }, 1000);
    const cross = await store.recordMovement(sql, tenantA, { ...input, itemId: other.item.id, requestHash: hash("cross") });
    expect(cross).toEqual({ error: "idempotency_conflict" });
    // the operation lookup finds what was saved
    const op = await store.getOperation(sql, tenantA, k);
    expect(op.id).toBe(a.movement.id);
  });

  it("decimal metres stay exact and packs convert explicitly", async () => {
    const cable = await makeItem({ name: "2.5mm TPS", baseUnit: "metre" }, 100_000);
    let bal = cable.item.balanceMilli;
    for (let i = 0; i < 30; i++) {
      const r = await store.recordMovement(sql, tenantA, { itemId: cable.item.id, kind: "take", quantityMilli: 100, actor: worker, idempotencyKey: key("m"), requestHash: hash(`m${i}`) });
      bal = r.item.balanceMilli;
    }
    expect(bal).toBe(97_000); // 100 m − 30 × 0.1 m, no floating drift
    const bad = await store.recordMovement(sql, tenantA, { itemId: cable.item.id, kind: "take", quantityMilli: 50, actor: worker, idempotencyKey: key("m"), requestHash: hash("m-bad") });
    expect(bad).toEqual({ error: "quantity_unit_mismatch" }); // 5 cm is finer than the metre step (DB trigger)
    const gpo = await makeItem({ name: "GPO by the box" }, 0);
    const boxes = await store.recordMovement(sql, tenantA, { itemId: gpo.item.id, kind: "add", quantityMilli: 20_000, pack: { count: 2, unit: "box", sizeMilli: 10_000 }, actor: worker, idempotencyKey: key("box"), requestHash: hash("box") });
    expect(boxes.item.balanceMilli).toBe(20_000);
    expect(boxes.movement.pack).toEqual({ count: 2, unit: "box", sizeMilli: 10_000 });
    const lie = await store.recordMovement(sql, tenantA, { itemId: gpo.item.id, kind: "add", quantityMilli: 25_000, pack: { count: 2, unit: "box", sizeMilli: 10_000 }, actor: worker, idempotencyKey: key("box"), requestHash: hash("box-lie") }).catch((e: Error) => e);
    expect(lie).toBeInstanceOf(Error); // pack maths that doesn't add up never reaches the ledger
  });

  it("a stale physical count is refused with what happened meanwhile; a fresh one sets the balance", async () => {
    const { item } = await makeItem({ name: "Counted switch" }, 10_000);
    const startedAt = (await store.getItem(sql, tenantA, item.id)).version;
    await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 2000, actor: worker, idempotencyKey: key("c"), requestHash: hash("c-take") });
    const stale = await store.recordCount(sql, tenantA, { itemId: item.id, countedMilli: 9000, expectedVersion: startedAt, reason: "shelf count", actor: office, idempotencyKey: key("c"), requestHash: hash("c1") });
    expect(stale.error).toBe("stock_changed");
    expect(stale.since).toHaveLength(1);
    expect(stale.since[0]).toMatchObject({ kind: "take", quantityMilli: -2000, actorName: "Sam Sparky" });
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(8000); // nothing written
    const fresh = await store.recordCount(sql, tenantA, { itemId: item.id, countedMilli: 7000, expectedVersion: stale.currentVersion, reason: "shelf count after review", actor: office, idempotencyKey: key("c"), requestHash: hash("c2") });
    expect(fresh.movement).toMatchObject({ kind: "count", quantityMilli: -1000, countedMilli: 7000, reason: "shelf count after review" });
    expect(fresh.item).toMatchObject({ balanceMilli: 7000, lastCountedByName: "Olive Office" });
    const same = await store.recordCount(sql, tenantA, { itemId: item.id, countedMilli: 7000, expectedVersion: fresh.item.version, reason: "confirmed", actor: office, idempotencyKey: key("c"), requestHash: hash("c3") });
    expect(same.movement.quantityMilli).toBe(0); // a count that confirms is still recorded
  });

  it("an undo is a one-time compensating reversal — concurrent undos produce one", async () => {
    const { item } = await makeItem({ name: "Undo GPO" }, 10_000);
    const take = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 4000, actor: worker, idempotencyKey: key("u"), requestHash: hash("u-take") });
    const allow = () => null;
    const [r1, r2] = await Promise.all([
      store.reverseMovement(connect(), tenantA, { movementId: take.movement.id, actor: worker, idempotencyKey: key("u"), requestHash: hash("u1") }, allow),
      store.reverseMovement(connect(), tenantA, { movementId: take.movement.id, actor: worker, idempotencyKey: key("u"), requestHash: hash("u2") }, allow),
    ]);
    const ok = [r1, r2].filter((r: { ok?: boolean }) => r.ok);
    const dup = [r1, r2].filter((r: { error?: string }) => r.error === "already_undone");
    expect(ok.length).toBe(1);
    expect(dup.length).toBe(1);
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(10_000);
    const orig = await store.getMovement(sql, tenantA, take.movement.id);
    expect(orig.reversedBy).toMatchObject({ actorName: "Sam Sparky" });
    expect(orig.quantityMilli).toBe(-4000); // the original row is untouched
    const undoUndo = await store.reverseMovement(sql, tenantA, { movementId: ok[0].movement.id, actor: office, idempotencyKey: key("u"), requestHash: hash("u3") }, allow);
    expect(undoUndo.error).toBe("cannot_undo_undo");
    await expect(sql`update public.workshop_stock_movements set quantity_milli = 0 where id = ${take.movement.id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from public.workshop_stock_movements where id = ${take.movement.id}`).rejects.toThrow(/append-only/);
  });

  it("refuses to undo an addition whose stock has since been taken", async () => {
    const { item } = await makeItem({ name: "Gone already" }, 0);
    const add = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "add", quantityMilli: 10_000, actor: worker, idempotencyKey: key("n"), requestHash: hash("n-add") });
    await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 8000, actor: worker, idempotencyKey: key("n"), requestHash: hash("n-take") });
    const r = await store.reverseMovement(sql, tenantA, { movementId: add.movement.id, actor: worker, idempotencyKey: key("n"), requestHash: hash("n-undo") }, () => null);
    expect(r).toMatchObject({ error: "undo_would_go_negative", balanceMilli: 2000, originalMilli: 10_000 });
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(2000);
  });

  it("a later count absorbs earlier movements: neither the store nor the trigger will undo them — until that count is itself undone", async () => {
    const { item } = await makeItem({ name: "Counted since" }, 10_000);
    const take = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 3000, actor: worker, idempotencyKey: key("k"), requestHash: hash("k-take") });
    const count = await store.recordCount(sql, tenantA, { itemId: item.id, countedMilli: 9000, expectedVersion: take.item.version, reason: "shelf count", actor: office, idempotencyKey: key("k"), requestHash: hash("k-count") });
    expect(count.item.balanceMilli).toBe(9000);
    expect((await store.getMovement(sql, tenantA, take.movement.id)).countedSince).toBe(true);
    expect((await store.getMovement(sql, tenantA, count.movement.id)).countedSince).toBe(false);

    const refused = await store.reverseMovement(sql, tenantA, { movementId: take.movement.id, actor: office, reason: "wrong item", idempotencyKey: key("k"), requestHash: hash("k-u1") }, () => null);
    expect(refused).toEqual({ error: "undo_counted_since" });
    // Past the app, straight at the ledger: the trigger refuses it too.
    await expect(sql`
      insert into public.workshop_stock_movements (tenant_id, item_id, kind, quantity_milli, reverses_movement_id, actor_legacy_id, actor_name, idempotency_key, request_hash)
      values (${tenantA}, ${item.id}, 'reversal', 3000, ${take.movement.id}, 'u_office', 'Olive Office', ${key("k-raw")}, ${hash("k-raw")})`).rejects.toThrow(/counted since/);
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(9000);

    // The count was the mistake: undo it, and the take is undoable again.
    const undoCount = await store.reverseMovement(sql, tenantA, { movementId: count.movement.id, actor: office, reason: "miscounted", idempotencyKey: key("k"), requestHash: hash("k-u2") }, () => null);
    expect(undoCount.item.balanceMilli).toBe(7000);
    expect((await store.getMovement(sql, tenantA, take.movement.id)).countedSince).toBe(false);
    const undoTake = await store.reverseMovement(sql, tenantA, { movementId: take.movement.id, actor: office, reason: "wrong item", idempotencyKey: key("k"), requestHash: hash("k-u3") }, () => null);
    expect(undoTake.item.balanceMilli).toBe(10_000);
  });

  it("the policy callback runs on the locked state and can refuse", async () => {
    const { item } = await makeItem({ name: "Not yours" }, 5000);
    const take = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: worker, idempotencyKey: key("p"), requestHash: hash("p-take") });
    const r = await store.reverseMovement(sql, tenantA, { movementId: take.movement.id, actor: { id: "u_other", name: "Other", role: "tradie" }, idempotencyKey: key("p"), requestHash: hash("p-undo") }, (m: { actorId: string }) => (m.actorId === "u_other" ? null : "undo_not_yours"));
    expect(r).toEqual({ error: "undo_not_yours" });
  });

  it("creates item + identifiers + opening atomically; a duplicate code creates NOTHING; a retried create returns the first item", async () => {
    const idf = codes.identifierFor("manufacturer_code", "2025WE", { brand: "Clipsal" });
    const k = key("cr");
    const input = {
      item: { name: "Clipsal 2025WE double GPO", brand: "Clipsal", manufacturerCode: "2025WE", baseUnit: "each", location: "Shelf A2" },
      identifiers: [idf], openingMilli: 12_000, actor: worker, idempotencyKey: k, requestHash: hash("cr-1"),
    };
    const first = await store.createItemWithOpening(sql, tenantA, input);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(first.item.identifiers.map((i: { value: string }) => i.value)).toEqual(["2025WE"]);
    const retry = await store.createItemWithOpening(sql, tenantA, input);
    expect(retry).toMatchObject({ ok: true, replayed: true });
    expect(retry.item.id).toBe(first.item.id);
    const before = await sql`select count(*)::int as c from public.workshop_stock_items where tenant_id = ${tenantA}`;
    const dup = await store.createItemWithOpening(sql, tenantA, { ...input, item: { ...input.item, name: "Same code again" }, idempotencyKey: key("cr"), requestHash: hash("cr-2") });
    expect(dup.error).toBe("duplicate_item");
    expect(dup.existing[0]).toMatchObject({ itemId: first.item.id, kind: "manufacturer_code", value: "2025WE" });
    const after = await sql`select count(*)::int as c from public.workshop_stock_items where tenant_id = ${tenantA}`;
    expect(after[0]!.c).toBe(before[0]!.c); // no half-created item
    // same code under a DIFFERENT brand is a different product
    const otherBrand = await store.createItemWithOpening(sql, tenantA, { ...input, item: { ...input.item, brand: "HPM", name: "HPM thing" }, identifiers: [codes.identifierFor("manufacturer_code", "2025WE", { brand: "HPM" })], idempotencyKey: key("cr"), requestHash: hash("cr-3") });
    expect(otherBrand.ok).toBe(true);
    // and a supplier SKU equal to the maker's code is a different KIND of identifier
    const sku = await store.createItemWithOpening(sql, tenantA, { ...input, item: { ...input.item, brand: "Generic", name: "SKU thing" }, identifiers: [codes.identifierFor("supplier_sku", "2025WE", { supplier: "Rexel" })], idempotencyKey: key("cr"), requestHash: hash("cr-4") });
    expect(sku.ok).toBe(true);
  });

  it("claims a pending photo uploaded by the same worker, never someone else's", async () => {
    const ownId = await store.insertPhoto(sql, tenantA, { blobUrl: "https://blob.invalid/a", blobPathname: "a", contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: "a".repeat(64), actor: worker });
    const otherId = await store.insertPhoto(sql, tenantA, { blobUrl: "https://blob.invalid/b", blobPathname: "b", contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: "b".repeat(64), actor: { id: "u_other", name: "Other" } });
    const mine = await makeItem({ name: "With my photo" }, 0, worker, { photoId: ownId });
    expect(mine.item.photoId).toBe(ownId);
    const theirs = await makeItem({ name: "With their photo" }, 0, worker, { photoId: otherId });
    expect(theirs.item.photoId).toBeNull();
    expect(theirs.photoAttached).toBe(false);
    expect(await store.getPhotoForServing(sql, tenantA, otherId, { viewerId: worker.id, office: false })).toBeNull();
    expect(await store.getPhotoForServing(sql, tenantA, ownId, { viewerId: "someone", office: false })).toMatchObject({ id: ownId });
    await sql`update public.workshop_stock_photos set expires_at = now() - interval '1 hour' where id = ${otherId}`;
    const expired = await store.expiredPhotos(sql, tenantA, 10);
    expect(expired.map((p: { id: string }) => p.id)).toEqual([otherId]); // the claimed one is never a candidate
  });

  it("keeps tenants apart: guessed ids from another tenant read and move nothing", async () => {
    const { item } = await makeItem({ name: "Tenant A only" }, 5000);
    expect(await store.getItem(sql, tenantB, item.id)).toBeNull();
    const r = await store.recordMovement(sql, tenantB, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: worker, idempotencyKey: key("x"), requestHash: hash("x") });
    expect(r).toEqual({ error: "item_not_found" });
    expect((await store.listItems(sql, tenantB)).length).toBe(0);
    await expect(sql`insert into public.workshop_stock_movements (tenant_id, item_id, kind, quantity_milli, actor_legacy_id, idempotency_key, request_hash) values (${tenantB}, ${item.id}, 'take', -1000, 'u', ${key("x")}, ${hash("x2")})`).rejects.toThrow();
    expect((await store.getItem(sql, tenantA, item.id)).balanceMilli).toBe(5000);
  });

  it("archives without losing history, frees the codes, and refuses movements while archived", async () => {
    const idf = codes.identifierFor("barcode", "9300704010017");
    expect(idf.error).toBeUndefined();
    const { item } = await makeItem({ name: "To archive" }, 3000, worker, { identifiers: [idf] });
    const arch = await store.setArchived(sql, tenantA, item.id, true, office);
    expect(arch.item.archivedAt).toBeTruthy();
    const mv = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: worker, idempotencyKey: key("ar"), requestHash: hash("ar") });
    expect(mv).toEqual({ error: "item_archived" });
    expect((await store.listMovements(sql, tenantA, item.id)).length).toBe(1);
    const replacement = await makeItem({ name: "Replacement" }, 0, worker, { identifiers: [idf] });
    expect(replacement.ok).toBe(true); // the barcode is free again
    const restore = await store.setArchived(sql, tenantA, item.id, false, office);
    expect(restore).toEqual({ error: "identifier_in_use" });
    await expect(sql`delete from public.workshop_stock_items where id = ${item.id}`).rejects.toThrow(/never deleted/);
  });

  it("catalogue edits are compare-and-set; the unit locks once real stock has moved; codes move with edits", async () => {
    const empty = await makeItem({ name: "Wrong unit" }, 0);
    const fixUnit = await store.updateItem(sql, tenantA, empty.item.id, { patch: { baseUnit: "metre" }, expectedRevision: empty.item.metaRevision, actor: office });
    expect(fixUnit.item.baseUnit).toBe("metre"); // a zero opening means nothing in any unit
    const used = await makeItem({ name: "Used unit" }, 4000);
    const locked = await store.updateItem(sql, tenantA, used.item.id, { patch: { baseUnit: "box" }, expectedRevision: used.item.metaRevision, actor: office });
    expect(locked).toEqual({ error: "unit_locked" });
    const edited = await store.updateItem(sql, tenantA, used.item.id, { patch: { location: "Bin 4" }, expectedRevision: used.item.metaRevision, actor: office });
    expect(edited.item.location).toBe("Bin 4");
    const stale = await store.updateItem(sql, tenantA, used.item.id, { patch: { location: "Bin 5" }, expectedRevision: used.item.metaRevision, actor: office });
    expect(stale.error).toBe("item_changed");
    const oldIdf = codes.identifierFor("manufacturer_code", "OLD-1", { brand: "Acme" });
    const coded = await makeItem({ name: "Coded", brand: "Acme", manufacturerCode: "OLD-1" }, 0, worker, { identifiers: [oldIdf] });
    const newIdf = codes.identifierFor("manufacturer_code", "NEW-2", { brand: "Acme" });
    const recoded = await store.updateItem(sql, tenantA, coded.item.id, { patch: { manufacturerCode: "NEW-2" }, expectedRevision: coded.item.metaRevision, actor: office, identifierChanges: { retire: [oldIdf], add: [newIdf] } });
    expect(recoded.item.manufacturerCode).toBe("NEW-2");
    expect(recoded.item.identifiers.map((i: { value: string }) => i.value)).toEqual(["NEW-2"]);
    const events = await store.itemEvents(sql, tenantA, coded.item.id);
    expect(events[0]).toMatchObject({ event: "updated", detail: { changes: { manufacturerCode: { from: "OLD-1", to: "NEW-2" } } } });
    await expect(sql`update public.workshop_stock_items set balance_milli = 999000 where id = ${coded.item.id}`).rejects.toThrow(/only through the movement ledger/);
  });

  it("enforces the daily cost ceiling and caches lookups", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consumeUsage(sql, tenantA, "lookup", 3));
    expect(results.map((r: { allowed: boolean }) => r.allowed)).toEqual([true, true, true, false]);
    await store.putCachedLookup(sql, tenantA, "clipsal", "2025WE", "manufacturer_code_matched", { status: "manufacturer_code_matched", candidate: { sourceUrl: "https://www.clipsal.com/x" } }, 30);
    const hit = await store.getCachedLookup(sql, tenantA, "clipsal", "2025WE");
    expect(hit).toMatchObject({ status: "manufacturer_code_matched", cached: true });
    expect(await store.getCachedLookup(sql, tenantB, "clipsal", "2025WE")).toBeNull();
  });
});
