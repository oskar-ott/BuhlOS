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

  it("undoing a count puts back the estimate flag and last-count stamp it replaced; undoing an estimated add clears the estimate", async () => {
    const { item } = await makeItem({ name: "Part-used roll", baseUnit: "metre" }, 50_000, worker, { estimated: true });
    expect(item).toMatchObject({ estimated: true, lastCountedAt: null });
    const count = await store.recordCount(sql, tenantA, { itemId: item.id, countedMilli: 42_000, expectedVersion: item.version, reason: "measured it", actor: office, idempotencyKey: key("e"), requestHash: hash("e-count") });
    expect(count.item).toMatchObject({ estimated: false, lastCountedByName: "Olive Office" });
    const undone = await store.reverseMovement(sql, tenantA, { movementId: count.movement.id, actor: office, reason: "wrong roll", idempotencyKey: key("e"), requestHash: hash("e-undo") }, () => null);
    expect(undone.item).toMatchObject({ balanceMilli: 50_000, estimated: true, lastCountedAt: null, lastCountedByName: null });

    const { item: gpo } = await makeItem({ name: "Estimated add" }, 10_000);
    const est = await store.recordMovement(sql, tenantA, { itemId: gpo.id, kind: "add", quantityMilli: 5000, estimated: true, actor: worker, idempotencyKey: key("e"), requestHash: hash("e-add") });
    expect(est.item.estimated).toBe(true);
    const back = await store.reverseMovement(sql, tenantA, { movementId: est.movement.id, actor: worker, idempotencyKey: key("e"), requestHash: hash("e-undo2") }, () => null);
    expect(back.item).toMatchObject({ balanceMilli: 10_000, estimated: false });
    expect(back.item.lastCountedAt).toBe(gpo.lastCountedAt); // the opening count still stands
  });

  it("stamps each movement with the clock when it lands, so one item's history sorts the way it happened", async () => {
    const { item } = await makeItem({ name: "Same transaction" }, 10_000);
    await sql.begin(async (tx) => {
      for (const i of [1, 2, 3]) {
        await tx`insert into public.workshop_stock_movements (tenant_id, item_id, kind, quantity_milli, actor_legacy_id, idempotency_key, request_hash)
                 values (${tenantA}, ${item.id}, 'take', -1000, 'u_field', ${key(`ts${i}`)}, ${hash(`ts${i}`)})`;
      }
    });
    // compared in Postgres (microseconds): within ONE transaction, now() would tie them
    const rows = await sql`
      select bool_and(created_at > prev) as increasing, count(*)::int as c from (
        select created_at, lag(created_at) over (order by item_version_after) as prev
        from public.workshop_stock_movements where tenant_id = ${tenantA} and item_id = ${item.id}) t
      where prev is not null`;
    expect(rows[0]).toEqual({ increasing: true, c: 3 });
    const hist = await store.listMovements(sql, tenantA, item.id);
    expect(hist.map((m: { itemVersionAfter: number }) => m.itemVersionAfter)).toEqual([4, 3, 2, 1]);
  });

  it("a used key is answered first: a retry replays the saved movement even after the item was archived", async () => {
    const { item } = await makeItem({ name: "Archived after the take" }, 5000);
    const k = key("rp");
    const first = await store.recordMovement(sql, tenantA, { itemId: item.id, kind: "take", quantityMilli: 1000, actor: worker, idempotencyKey: k, requestHash: hash("rp-1") });
    await store.setArchived(sql, tenantA, item.id, true, office);
    const replay = await store.replayOperation(sql, tenantA, k, hash("rp-1"));
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(replay.movement.id).toBe(first.movement.id);
    expect(await store.replayOperation(sql, tenantA, k, hash("rp-other"))).toEqual({ error: "idempotency_conflict" });
    expect(await store.replayOperation(sql, tenantA, key("rp-new"), hash("rp-1"))).toBeNull();
  });

  it("two creates racing with one key make ONE item: the second replays it instead of reporting a duplicate", async () => {
    const idf = codes.identifierFor("manufacturer_code", `RACE-${n}`, { brand: "Acme" });
    const k = key("cr-race");
    const input = {
      item: { name: "Double-tapped create", brand: "Acme", manufacturerCode: idf.value, baseUnit: "each" },
      identifiers: [idf], openingMilli: 3000, actor: worker, idempotencyKey: k, requestHash: hash("cr-race"),
    };
    const [a, b] = await Promise.all([store.createItemWithOpening(connect(), tenantA, input), store.createItemWithOpening(connect(), tenantA, input)]);
    expect(a.ok && b.ok).toBe(true);
    expect([a.replayed === true, b.replayed === true].filter(Boolean)).toHaveLength(1);
    expect(a.item.id).toBe(b.item.id);
    const rows = await sql`select count(*)::int as c from public.workshop_stock_items where tenant_id = ${tenantA} and name = ${"Double-tapped create"}`;
    expect(rows[0]!.c).toBe(1);
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
    const due = await store.photosDueForDeletion(sql, tenantA, 10);
    expect(due.map((p: { id: string }) => p.id)).toEqual([otherId]); // the claimed one is never a candidate
    expect(due[0]).toMatchObject({ marked: false, thumbUrl: null });
  });

  it("an expired photo can't be claimed, and one marked for deletion stays unclaimed — a claim and a cleanup never both win", async () => {
    const photo = (sha: string, actor = worker) => store.insertPhoto(sql, tenantA, { blobUrl: `https://blob.invalid/${sha}`, blobPathname: sha, contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: sha.repeat(64).slice(0, 64), actor, thumb: { url: `https://blob.invalid/${sha}-t`, pathname: `${sha}-t`, byteSize: 50 } });
    const late = await photo("c");
    await sql`update public.workshop_stock_photos set expires_at = now() - interval '1 minute' where id = ${late}`;
    const tooLate = await makeItem({ name: "Expired photo" }, 0, worker, { photoId: late });
    expect(tooLate.item.photoId).toBeNull();
    expect(tooLate.photoAttached).toBe(false);
    // the cleanup marks first; from then on a claim can't take it, even one racing in
    expect(await store.markPhotoDeleted(sql, tenantA, late)).toBe(true);
    expect(await store.markPhotoDeleted(sql, tenantA, late)).toBe(false); // already marked
    const due = await store.photosDueForDeletion(sql, tenantA, 10);
    expect(due.find((p: { id: string }) => p.id === late)).toMatchObject({ marked: true, thumbUrl: "https://blob.invalid/c-t" }); // blob not gone yet: retried
    await store.markBlobDeleted(sql, tenantA, late);
    expect((await store.photosDueForDeletion(sql, tenantA, 10)).find((p: { id: string }) => p.id === late)).toBeUndefined();
    // a claimed photo is never marked, however late the cleanup runs
    const kept = await photo("d");
    const owner = await makeItem({ name: "Kept photo" }, 0, worker, { photoId: kept });
    expect(owner.item.photoId).toBe(kept);
    expect(await store.markPhotoDeleted(sql, tenantA, kept)).toBe(false);
    // the list-size copy is served when asked for, the photo otherwise
    expect(await store.getPhotoForServing(sql, tenantA, kept, { viewerId: worker.id, office: false, size: "thumb" })).toMatchObject({ blobUrl: "https://blob.invalid/d-t", thumb: true });
    expect(await store.getPhotoForServing(sql, tenantA, kept, { viewerId: worker.id, office: false })).toMatchObject({ blobUrl: "https://blob.invalid/d", thumb: false });
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
    // Restoring brings the item back; the barcode stays with the item that took it.
    const restore = await store.setArchived(sql, tenantA, item.id, false, office);
    expect(restore.ok).toBe(true);
    expect(restore.item.archivedAt).toBeNull();
    expect(restore.item.identifiers).toEqual([]);
    expect(restore.codesNotRestored).toEqual([{ kind: "barcode", value: "9300704010017", heldBy: "Replacement" }]);
    expect((await store.getItem(sql, tenantA, replacement.item.id)).identifiers.map((i: { value: string }) => i.value)).toEqual(["9300704010017"]);
    await expect(sql`delete from public.workshop_stock_items where id = ${item.id}`).rejects.toThrow(/never deleted/);
  });

  it("restore brings back only the codes the archive retired — never one the office removed or replaced before", async () => {
    const a = codes.identifierFor("manufacturer_code", "KEEP-1", { brand: "Acme" });
    const b = codes.identifierFor("barcode", "9300704010024");
    const { item } = await makeItem({ name: "Round trip", brand: "Acme", manufacturerCode: "KEEP-1" }, 0, worker, { identifiers: [a, b] });
    const barcodeRow = item.identifiers.find((i: { kind: string }) => i.kind === "barcode");
    expect((await store.retireIdentifier(sql, tenantA, barcodeRow.id, office)).ok).toBe(true); // removed on purpose
    await store.setArchived(sql, tenantA, item.id, true, office);
    const back = await store.setArchived(sql, tenantA, item.id, false, office);
    expect(back.codesNotRestored).toEqual([]);
    expect(back.item.identifiers.map((i: { value: string }) => i.value)).toEqual(["KEEP-1"]); // the removed barcode stays removed
    expect(back.item.manufacturerCode).toBe("KEEP-1");
    // a second archive / restore cycle behaves the same
    await store.setArchived(sql, tenantA, item.id, true, office);
    expect((await store.setArchived(sql, tenantA, item.id, false, office)).item.identifiers.map((i: { value: string }) => i.value)).toEqual(["KEEP-1"]);
  });

  it("restoring an item whose maker's code was taken meanwhile empties its code field and clears its online check", async () => {
    const idf = codes.identifierFor("manufacturer_code", "TAKEN-9", { brand: "Acme" });
    const { item } = await makeItem({ name: "Old listing", brand: "Acme", manufacturerCode: "TAKEN-9" }, 0, worker, { identifiers: [idf], verificationStatus: "manufacturer_code_matched", verification: { sourceUrl: "https://example.invalid/p" } });
    expect(item.verificationStatus).toBe("manufacturer_code_matched");
    await store.setArchived(sql, tenantA, item.id, true, office);
    await makeItem({ name: "New listing", brand: "Acme", manufacturerCode: "TAKEN-9" }, 0, worker, { identifiers: [idf] });
    const back = await store.setArchived(sql, tenantA, item.id, false, office);
    expect(back.codesNotRestored).toEqual([{ kind: "manufacturer_code", value: "TAKEN-9", heldBy: "New listing" }]);
    expect(back.item).toMatchObject({ manufacturerCode: null, verificationStatus: "unverified", verification: null });
    const events = await store.itemEvents(sql, tenantA, item.id);
    expect(events[0]).toMatchObject({ event: "restored", detail: { codesNotRestored: [{ value: "TAKEN-9" }] } });
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

  it("a changed maker's code or brand clears the online check that was for the old one; other edits keep it", async () => {
    const idf = codes.identifierFor("manufacturer_code", "VER-1", { brand: "Acme" });
    const { item } = await makeItem({ name: "Verified", brand: "Acme", manufacturerCode: "VER-1" }, 0, worker, { identifiers: [idf], verificationStatus: "manufacturer_code_matched", verification: { sourceUrl: "https://example.invalid/v" } });
    const located = await store.updateItem(sql, tenantA, item.id, { patch: { location: "Bin 9" }, expectedRevision: item.metaRevision, actor: office });
    expect(located.item.verificationStatus).toBe("manufacturer_code_matched");
    const rebranded = codes.identifierFor("manufacturer_code", "VER-1", { brand: "Other Co" });
    const moved = await store.updateItem(sql, tenantA, item.id, { patch: { brand: "Other Co" }, expectedRevision: located.item.metaRevision, actor: office, identifierChanges: { retire: [idf], add: [rebranded] } });
    expect(moved.item).toMatchObject({ verificationStatus: "unverified", verification: null });
    expect(moved.changes.verification).toEqual({ from: "manufacturer_code_matched", to: "unverified" });
  });

  it("only catalogue edits move meta_revision: a photo, an online check or an archive never invalidates an open edit form; archived items can't be edited", async () => {
    const { item } = await makeItem({ name: "Edit form open" }, 0);
    const photoId = await store.insertPhoto(sql, tenantA, { blobUrl: "https://blob.invalid/e", blobPathname: "e", contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: "e".repeat(64), actor: office });
    expect((await store.replaceItemPhoto(sql, tenantA, item.id, photoId, office)).ok).toBe(true);
    expect((await store.recordVerification(sql, tenantA, item.id, { status: "unverified", verification: null, actor: office })).ok).toBe(true);
    const still = await store.getItem(sql, tenantA, item.id);
    expect(still.metaRevision).toBe(item.metaRevision);
    const saved = await store.updateItem(sql, tenantA, item.id, { patch: { name: "Edited after photo" }, expectedRevision: item.metaRevision, actor: office });
    expect(saved.item.name).toBe("Edited after photo");
    await store.setArchived(sql, tenantA, item.id, true, office);
    expect(await store.updateItem(sql, tenantA, item.id, { patch: { name: "While archived" }, expectedRevision: saved.item.metaRevision, actor: office })).toEqual({ error: "item_archived" });
    expect((await store.addIdentifier(sql, tenantA, item.id, codes.identifierFor("barcode", "9300704010031"), office)).error).toBe("item_archived");
    expect(await store.recordVerification(sql, tenantA, item.id, { status: "unverified", verification: null, actor: office })).toEqual({ error: "item_archived" });
    const otherPhoto = await store.insertPhoto(sql, tenantA, { blobUrl: "https://blob.invalid/f", blobPathname: "f", contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: "f".repeat(64), actor: office });
    expect(await store.replaceItemPhoto(sql, tenantA, item.id, otherPhoto, office)).toEqual({ error: "item_archived" });
  });

  it("a photo of where it lives: claimed with the item, shown on every read, replaceable and removable — and before the migration nothing breaks", async () => {
    const col = await sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workshop_stock_items' and column_name = 'location_photo_id'`;
    const migrated = col.length > 0;
    expect(await store.hasLocationPhoto(sql)).toBe(migrated);
    const pending = (tag: string, actor = worker) => store.insertPhoto(sql, tenantA, { blobUrl: `https://blob.invalid/loc-${tag}`, blobPathname: `loc-${tag}`, contentType: "image/jpeg", byteSize: 100, width: 800, height: 600, sha256: createHash("sha256").update(`loc-${tag}-${marker}`).digest("hex"), actor });
    const shelfShot = await pending("a");
    const created = await makeItem({ name: "Anchors behind the door", location: "Top of the rack" }, 1000, worker, { locationPhotoId: migrated ? shelfShot : null });
    // every read carries the field — null until the column exists
    expect(created.item).toHaveProperty("locationPhotoId");
    const listed = (await store.listItems(sql, tenantA, {})).find((i: { id: string }) => i.id === created.item.id);
    if (!migrated) {
      expect(created.item.locationPhotoId).toBeNull();
      expect(listed.locationPhotoId).toBeNull();
      expect(await store.replaceItemPhoto(sql, tenantA, created.item.id, shelfShot, office, "location")).toEqual({ error: "location_photo_unavailable" });
      // the product photo path is untouched
      expect((await store.replaceItemPhoto(sql, tenantA, created.item.id, shelfShot, office)).ok).toBe(true);
      return;
    }
    expect(created.locationPhotoAttached).toBe(true);
    expect(created.item.locationPhotoId).toBe(shelfShot);
    expect(listed.locationPhotoId).toBe(shelfShot);
    const claimed = await sql`select purpose, expires_at from public.workshop_stock_photos where tenant_id = ${tenantA} and id = ${shelfShot}`;
    expect(claimed[0]).toMatchObject({ purpose: "item", expires_at: null }); // the clean-up never touches it
    // someone else's pending photo can't be claimed by the crew
    const notMine = await pending("b", office);
    const other = await makeItem({ name: "Not my photo" }, 0, worker, { locationPhotoId: notMine });
    expect(other.locationPhotoAttached).toBe(false);
    expect(other.item.locationPhotoId).toBeNull();
    // replace: the old one retires and expires; the edit revision doesn't move
    const newer = await pending("c", office);
    expect((await store.replaceItemPhoto(sql, tenantA, created.item.id, newer, office, "location")).ok).toBe(true);
    const after = await store.getItem(sql, tenantA, created.item.id);
    expect(after.locationPhotoId).toBe(newer);
    expect(after.photoId).toBeNull(); // the product photo is a separate slot
    expect(after.metaRevision).toBe(created.item.metaRevision);
    const retired = await sql`select purpose, expires_at from public.workshop_stock_photos where tenant_id = ${tenantA} and id = ${shelfShot}`;
    expect(retired[0]!.purpose).toBe("retired");
    expect(retired[0]!.expires_at).toBeTruthy();
    // remove
    expect((await store.replaceItemPhoto(sql, tenantA, created.item.id, null, office, "location")).ok).toBe(true);
    expect((await store.getItem(sql, tenantA, created.item.id)).locationPhotoId).toBeNull();
    const events = await store.itemEvents(sql, tenantA, created.item.id);
    expect(events.filter((e: { event: string; detail: { slot?: string } }) => e.event === "photo_changed" && e.detail.slot === "location")).toHaveLength(2);
    // a product photo can't be removed by passing null
    expect(await store.replaceItemPhoto(sql, tenantA, created.item.id, null, office)).toEqual({ error: "photo_not_available" });
  });

  it("the item's code fields follow its codes: removing the main code moves to the next one (or empties) and clears the check; a first code fills the field", async () => {
    const main = codes.identifierFor("manufacturer_code", "MAIN-1", { brand: "Acme" });
    const { item } = await makeItem({ name: "Two codes", brand: "Acme", manufacturerCode: "MAIN-1" }, 0, worker, { identifiers: [main], verificationStatus: "possible_match", verification: { sourceUrl: "https://example.invalid/m" } });
    const alt = await store.addIdentifier(sql, tenantA, item.id, codes.identifierFor("manufacturer_code", "ALT-2", { brand: "Acme" }), office);
    expect(alt.ok).toBe(true);
    const mainRow = (await store.getItem(sql, tenantA, item.id)).identifiers.find((i: { value: string }) => i.value === "MAIN-1");
    await store.retireIdentifier(sql, tenantA, mainRow.id, office);
    const after = await store.getItem(sql, tenantA, item.id);
    expect(after).toMatchObject({ manufacturerCode: "ALT-2", verificationStatus: "unverified" });
    expect(after.metaRevision).toBe(item.metaRevision + 1);
    const altRow = after.identifiers.find((i: { value: string }) => i.value === "ALT-2");
    await store.retireIdentifier(sql, tenantA, altRow.id, office);
    expect((await store.getItem(sql, tenantA, item.id)).manufacturerCode).toBeNull();
    // a code-less item gets its first codes into its fields
    const { item: bare } = await makeItem({ name: "No codes yet", brand: "Acme" }, 0);
    await store.addIdentifier(sql, tenantA, bare.id, codes.identifierFor("manufacturer_code", "FIRST-3", { brand: "Acme" }), office);
    await store.addIdentifier(sql, tenantA, bare.id, { ...codes.identifierFor("supplier_sku", "SKU-77", { supplier: "Rexel" }), supplierName: "Rexel" }, office);
    expect(await store.getItem(sql, tenantA, bare.id)).toMatchObject({ manufacturerCode: "FIRST-3", supplierSku: "SKU-77", supplierName: "Rexel" });
  });

  it("enforces the daily cost ceiling and caches lookups", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consumeUsage(sql, tenantA, "lookup", 3));
    expect(results.map((r: { allowed: boolean }) => r.allowed)).toEqual([true, true, true, false]);
    const white = codes.lookupKey({ brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "White" });
    const black = codes.lookupKey({ brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "Black" });
    await store.putCachedLookup(sql, tenantA, white, "manufacturer_code_matched", { status: "manufacturer_code_matched", candidate: { sourceUrl: "https://www.clipsal.com/x" } }, 30);
    const hit = await store.getCachedLookup(sql, tenantA, white);
    expect(hit).toMatchObject({ status: "manufacturer_code_matched", cached: true });
    expect(await store.getCachedLookup(sql, tenantA, black)).toBeNull(); // a check for the white one isn't one for the black one
    expect(await store.getCachedLookup(sql, tenantB, white)).toBeNull();
  });
});
