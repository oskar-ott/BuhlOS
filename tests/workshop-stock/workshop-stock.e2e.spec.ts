import { deflateSync } from "node:zlib";
import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Workshop Stock — browser end-to-end against the LOCAL harness
 * (docs/workshop-stock.md → "Testing"). The real pages run under `next dev`; the
 * real /api/workshop-stock handler runs in scripts/qa/workshop-stock-e2e/harness.js
 * against a local Postgres. The photo reader's model response, the web-search
 * response and the pages behind it are FIXTURES — this proves the product flow,
 * the ledger and the verification code, not the live providers.
 *
 * Skipped unless WORKSHOP_STOCK_E2E_API points at the harness. Synthetic people,
 * jobs and items only.
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
test.describe.configure({ mode: "serial" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
// A sandbox whose preinstalled Chromium doesn't match the pinned Playwright build can point at it.
if (process.env.WORKSHOP_STOCK_E2E_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.WORKSHOP_STOCK_E2E_CHROMIUM } });

const { defaultBrowserType: _phoneBrowser, ...PHONE } = devices["Pixel 7"];
const DESKTOP = { viewport: { width: 1366, height: 900 } };

// ── harness plumbing ─────────────────────────────────────────────────────────

type Movement = { id: string; item_id: string; kind: string; quantity_milli: number; balance_after_milli: number; counted_milli: number | null; reverses_movement_id: string | null; actor_name: string; idempotency_key: string; job_label: string | null; reason: string | null };
type HarnessState = {
  items: Array<{ id: string; name: string; base_unit: string; balance_milli: number; version: number; estimated: boolean; location: string | null; photo_id: string | null; verification_status: string; archived_at: string | null }>;
  movements: Movement[];
  photos: Array<{ id: string; purpose: string; byte_size: number; has_thumb: boolean; deleted: boolean; blob_deleted: boolean; blobStored: boolean; thumbStored: boolean | null }>;
  calls: { vision: Array<{ model: string; imageBytes: number }>; search: Array<{ prompt: string; allowedDomains: string[]; maxUses: number }> };
  pageFetches: Array<{ url: string; found: boolean }>;
  visionQueued: number;
  audit: Array<{ action: string; actor: string | null; targetId: string | null }>;
};

async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}
const state = () => harness<HarnessState>("/__harness/state");
const itemNamed = async (re: RegExp) => {
  const s = await state();
  const item = s.items.find((i) => re.test(i.name));
  if (!item) throw new Error(`no item matching ${re}`);
  return { item, movements: s.movements.filter((m) => m.item_id === item.id), all: s };
};

async function signIn(context: BrowserContext, who: "worker" | "worker2" | "office") {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  await context.addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}

/** Someone else using the API at the same time (another phone, the office). */
async function api(who: "worker" | "worker2" | "office", method: string, query: string, body?: unknown) {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  const r = await fetch(`${API}/api/workshop-stock?${query}`, {
    method,
    headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> & { item?: { id: string; metaRevision: number } } };
}

/** A model answer for the photo reader: what the label shows, nothing invented. */
type RawProduct = Record<string, unknown>;
const GPO: RawProduct = {
  brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: null, supplierName: null, description: "Double power point",
  colourFinish: "White", variantDetails: ["10A", "250V"], barcode: "9300704010017", packQuantity: 10, packUnit: "pcs",
  labelText: ["2025WE", "10 PCS"], position: "only product",
};
const SWITCH: RawProduct = {
  brand: "HPM", manufacturerCode: "E-TEST-30", supplierSku: null, supplierName: null, description: "Single switch",
  colourFinish: "White", variantDetails: ["10A"], barcode: null, packQuantity: null, packUnit: null, labelText: ["E-TEST-30"], position: "right",
};
const reading = (...products: RawProduct[]) => ({ raw: { legibility: "clear", note: null, products } });
/** The name the photo suggested — kept when the listing is accepted (the listing only fills blanks). */
const GPO_NAME = "Clipsal Double power point — White 10A 250V";
const GPO_RE = /Clipsal Double power point/;
const queue = (...entries: unknown[]) => harness("/__harness/vision", { queue: entries });

// A real image file (PNG), so the phone's resize + the server's sniffing run for real.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function productPhoto(tint: number): { name: string; mimeType: string; buffer: Buffer } {
  const w = 480;
  const h = 360;
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row + 1 + x * 3;
      const label = x > 120 && x < 360 && y > 120 && y < 240;
      raw[o] = label ? 250 : 190 + tint;
      raw[o + 1] = label ? 250 : 200;
      raw[o + 2] = label ? 245 : 185;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
  return { name: `product-${tint}.png`, mimeType: "image/png", buffer };
}

/**
 * Send the page's /api/workshop-stock calls to the harness. `dropNext` lets a
 * test cut the line AFTER the server has the request — the save commits, the
 * phone never hears back (the uncertain-save case).
 */
/** The fixture listing's image URL (on the allowlisted maker site — unreachable from a sandbox). */
const EXTERNAL_IMAGE = /^https:\/\/www\.clipsal\.com\/img\//;
type Match = ((u: URL, method: string) => boolean) | null;
type Wire = {
  /** the server gets it (and saves); the phone never hears back */
  dropNext: Match;
  /** the line drops before the server gets it (nothing saved) */
  dropBeforeNext: Match;
  /** a canned answer instead of the server's (e.g. 503 store_unavailable) */
  answerNext: { match: Match; status: number; body: unknown } | null;
  problems: string[];
  ignored: string[];
};
async function wire(page: Page): Promise<Wire> {
  const w: Wire = { dropNext: null, dropBeforeNext: null, answerNext: null, problems: [], ignored: [] };
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    try {
      if (w.dropBeforeNext && w.dropBeforeNext(u, req.method())) {
        w.dropBeforeNext = null;
        w.ignored.push(`dropped on purpose before the server: ${req.method()} ${u.search}`);
        await route.abort("connectionreset");
        return;
      }
      if (w.answerNext && w.answerNext.match && w.answerNext.match(u, req.method())) {
        const a = w.answerNext;
        w.answerNext = null;
        w.ignored.push(`answered on purpose: ${req.method()} ${u.search} → ${a.status}`);
        await route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) });
        return;
      }
      const response = await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 });
      if (w.dropNext && w.dropNext(u, req.method())) {
        w.dropNext = null;
        w.ignored.push(`dropped on purpose: ${req.method()} ${u.search} (server answered ${response.status()})`);
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({ response });
    } catch (e) {
      // The test finished while a request (e.g. a thumbnail) was still in flight.
      if (!page.isClosed()) throw e;
    }
  });
  page.on("pageerror", (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const where = m.location().url || "";
    // next dev serves no Vercel functions: the shell's other /api/* calls 404 here.
    if (/\/api\//.test(where) && !/\/api\/workshop-stock/.test(where)) { w.ignored.push(`shell call outside this feature: ${where}`); return; }
    // Pre-existing on main: a cold `next dev` compile of /v2/phil fails server rendering
    // (webpack dev runtime) and the client renders it; not seen in a production build.
    if (/status of 500/.test(m.text()) && /\/v2\/phil$/.test(where)) { w.ignored.push("pre-existing: /v2/phil 500 on a cold next dev compile"); return; }
    // No Blob store locally: server components fall back and next dev forwards their warning.
    if (/readBlob degraded/.test(m.text())) { w.ignored.push("server: readBlob degraded (no Blob token locally)"); return; }
    // The listing's product photo is loaded from the source site; this sandbox has no egress to it.
    if (EXTERNAL_IMAGE.test(where)) { w.ignored.push(`listing image blocked by the sandbox: ${where}`); return; }
    if (/ERR_CONNECTION_RESET|net::ERR_FAILED/.test(m.text()) && w.ignored.some((i) => i.startsWith("dropped on purpose"))) { w.ignored.push(`console after the deliberate drop: ${m.text()}`); return; }
    w.problems.push(`console: ${m.text()} @ ${where}`);
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (EXTERNAL_IMAGE.test(u)) return;
    if (/\/api\/workshop-stock/.test(u) && w.ignored.some((i) => i.startsWith("dropped on purpose"))) return;
    if (/\/_next\/webpack-hmr|\/__nextjs/.test(u)) return;
    // The App Router cancels a superseded RSC fetch (e.g. when a sheet's history entry unwinds).
    if (/[?&]_rsc=/.test(u) && r.failure()?.errorText === "net::ERR_ABORTED") { w.ignored.push(`router cancelled an RSC fetch: ${new URL(u).pathname}`); return; }
    w.problems.push(`requestfailed: ${r.method()} ${u} ${r.failure()?.errorText ?? ""}`);
  });
  page.on("response", (r) => {
    if (/\/api\/workshop-stock/.test(r.url()) && r.status() >= 400) w.problems.push(`api ${r.status()}: ${r.request().method()} ${new URL(r.url()).search}`);
  });
  return w;
}

function clean(w: Wire, allowed: RegExp[] = []) {
  if (w.ignored.length) console.log(`  (environment noise ignored: ${[...new Set(w.ignored)].join(" | ")})`);
  expect(w.problems.filter((p) => !allowed.some((a) => a.test(p)))).toEqual([]);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const photoInput = (page: Page) => page.getByTestId("stock-photo-camera").locator("input[type=file]");

async function openStockFromMore(page: Page) {
  await page.goto("/v2/phil", { timeout: 120_000 });
  const link = page.getByTestId("more-stock-link");
  await expect(link).toBeVisible({ timeout: 60_000 });
  await link.click();
  await expect(page).toHaveURL(/\/phil\/stock$/, { timeout: 60_000 });
  await expect(page.getByTestId("phil-workshop-stock")).toBeVisible({ timeout: 60_000 });
}

async function openStock(page: Page) {
  await page.goto("/phil/stock", { timeout: 120_000 });
  await expect(page.getByTestId("stock-take-button")).toBeEnabled({ timeout: 60_000 });
}

async function pickFromList(page: Page, name: RegExp) {
  await page.getByTestId("stock-picker-search").fill("2025");
  await page.getByTestId("stock-picker-row").filter({ hasText: name }).first().click();
}

// ── the worker, on a phone ───────────────────────────────────────────────────

test.describe("worker on a phone", () => {
  test.use(PHONE);

  test("adds a new item by photo: read → online check → packs → shelf → saved", async ({ page, context }) => {
    test.setTimeout(240_000);
    await harness("/__harness/reset", {});
    await signIn(context, "worker");
    const w = await wire(page);

    await openStockFromMore(page);
    await expect(page.getByText("Nothing recorded yet")).toBeVisible({ timeout: 30_000 });
    await shot(page, "phone-01-empty");

    await queue(reading(GPO));
    await page.getByTestId("stock-add-button").click();
    await expect(page.getByTestId("stock-add-flow")).toBeVisible();
    await photoInput(page).setInputFiles(productPhoto(1));

    // Not in the workshop yet → the new-item form, pre-filled from the label.
    const form = page.getByTestId("stock-new-item");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stock-new-brand")).toHaveValue("Clipsal");
    await expect(page.getByTestId("stock-new-code")).toHaveValue("2025WE");
    await expect(form.getByText("read from photo").first()).toBeVisible();

    // The online check ran on its own for the code it read.
    await expect(page.getByTestId("stock-lookup-status")).toHaveText("Manufacturer code matched", { timeout: 30_000 });
    await expect(page.getByTestId("stock-lookup-source")).toContainText("clipsal.com");
    await expect(page.getByTestId("stock-lookup-card")).toContainText("not a certification");
    await page.getByTestId("stock-lookup-accept").click();
    // The listing only fills blanks: the name the crew would search for stays.
    await expect(page.getByTestId("stock-new-name")).toHaveValue(GPO_NAME);
    await expect(page.getByTestId("stock-new-code-status")).toHaveAttribute("data-status", "manufacturer_code_matched");
    // Change what the check was for and it stops counting — change it back and it counts again.
    await page.getByTestId("stock-new-brand").fill("HPM");
    await expect(page.getByTestId("stock-new-code-status")).toHaveAttribute("data-status", "stale");
    await expect(page.getByTestId("stock-new-check")).toHaveText("Check it again with these details");
    await page.getByTestId("stock-new-brand").fill("Clipsal");
    await expect(page.getByTestId("stock-new-code-status")).toHaveAttribute("data-status", "manufacturer_code_matched");

    // The printed pack size is OFFERED, never applied silently.
    await page.getByTestId("stock-new-pack-suggest").click();
    await expect(page.getByTestId("stock-new-pack-size")).toHaveValue("10");
    await page.getByTestId("stock-new-packs-plus").click();
    await expect(page.getByTestId("stock-new-pack-total")).toHaveText("= 20 each going on the shelf");
    await page.getByTestId("stock-new-location").fill("Shelf A2");
    await expect(page.getByTestId("stock-new-code-status")).toHaveText("Code status: Manufacturer code matched (the listing you accepted)");
    await shot(page, "phone-02-new-item-form");
    await page.getByTestId("stock-new-save").click();

    // Saved → back on the list, with what was recorded and an Undo.
    await expect(page.getByTestId("stock-add-flow")).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId("stock-last-write")).toContainText("20 each recorded now");
    const row = page.getByTestId("stock-list").getByTestId("stock-row").first();
    await expect(row).toContainText(GPO_NAME);
    await expect(row).toContainText("Shelf A2");
    await expect(row).toContainText("20");
    // the list loads the small copy of the photo, not the full label shot
    await expect(row.locator("img")).toHaveAttribute("src", /action=photo&id=[^&]+&size=thumb$/);
    await shot(page, "phone-03-list-after-add");
    // Found by the trade name a worker types, whatever it was saved as.
    await page.getByTestId("stock-search").fill("gpo");
    await expect(page.getByTestId("stock-list").getByTestId("stock-row")).toHaveCount(1);
    await page.getByTestId("stock-search").fill("socket outlet");
    await expect(page.getByTestId("stock-list").getByTestId("stock-row")).toHaveCount(1);
    await page.getByTestId("stock-search").fill("");

    const { item, movements, all } = await itemNamed(GPO_RE);
    expect(item.balance_milli).toBe(20_000);
    expect(item.base_unit).toBe("each");
    expect(item.verification_status).toBe("manufacturer_code_matched");
    expect(item.photo_id).not.toBeNull();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: "opening", quantity_milli: 20_000, actor_name: "Sam Tester" });
    expect(all.photos.find((p) => p.id === item.photo_id)).toMatchObject({ purpose: "item", has_thumb: true, blobStored: true, thumbStored: true });
    // Recognition + verification really went through the production code path.
    expect(all.calls.vision).toHaveLength(1);
    expect(all.calls.search).toHaveLength(1);
    expect(all.calls.search[0]!.prompt).toContain('"2025WE" by Clipsal');
    expect(all.calls.search[0]!.allowedDomains).toContain("clipsal.com");
    expect(all.pageFetches.map((p) => p.url)).toContain("https://www.clipsal.com/products/2025we");
    clean(w);
  });

  test("photographs it again and takes several; undoes the take; takes again from the list", async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    await queue(reading(GPO));
    await page.getByTestId("stock-take-button").click();
    await photoInput(page).setInputFiles(productPhoto(2));

    // The barcode/code identifies OUR item → straight to the explicit confirmation.
    const confirm = page.getByTestId("stock-move-confirm");
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stock-move-item")).toHaveText(GPO_NAME);
    await expect(confirm).toContainText(/Matched in workshop · (barcode 9300704010017|code 2025WE)/);
    await expect(page.getByTestId("stock-move-recorded")).toHaveText("Recorded stock: 20 each");
    await expect(page.getByTestId("stock-move-packs")).not.toBeChecked(); // a unit barcode starts in units
    await page.getByTestId("stock-move-qty-input").fill("3");
    await shot(page, "phone-04-take-confirm");
    await page.getByTestId("stock-move-submit").click();

    await expect(page.getByTestId("stock-move-done")).toContainText("Taken: 3 each");
    await expect(page.getByTestId("stock-move-balance")).toContainText("17 each recorded now");
    await shot(page, "phone-05-take-done");

    // Undo straight away.
    await page.getByTestId("stock-move-undo").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Undone");
    await expect(page.getByTestId("stock-move-balance")).toContainText("20 each recorded now");

    // Take again, found by searching the list this time.
    await page.getByTestId("stock-move-another").click();
    await page.getByTestId("stock-take-search").click();
    await pickFromList(page, GPO_RE);
    await page.getByTestId("stock-move-qty-input").fill("5");
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-balance")).toContainText("15 each recorded now");
    await page.getByTestId("stock-move-close").click();
    await expect(page.getByTestId("stock-last-write")).toContainText("15 each recorded now");

    const { item, movements } = await itemNamed(GPO_RE);
    expect(item.balance_milli).toBe(15_000);
    expect(movements.map((m) => [m.kind, m.quantity_milli])).toEqual([["opening", 20_000], ["take", -3_000], ["reversal", 3_000], ["take", -5_000]]);
    const reversal = movements.find((m) => m.kind === "reversal");
    expect(reversal?.reverses_movement_id).toBe(movements[1]!.id);
    clean(w);
  });

  test("returns unused stock", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    await page.getByTestId("stock-return-button").click();
    await expect(page.getByTestId("stock-return-flow")).toBeVisible();
    await pickFromList(page, GPO_RE);
    await expect(page.getByTestId("stock-move-submit")).toHaveText("Return to stock");
    await page.getByTestId("stock-move-qty-input").fill("2");
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Returned: 2 each");
    await expect(page.getByTestId("stock-move-balance")).toContainText("17 each recorded now");

    const { item } = await itemNamed(GPO_RE);
    expect(item.balance_milli).toBe(17_000);
    clean(w);
  });

  test("a take whose answer is lost: Try again re-sends the same key — one movement, no double deduction", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await pickFromList(page, GPO_RE);
    await page.getByTestId("stock-move-qty-input").fill("4");
    w.dropNext = (u, method) => method === "POST" && u.searchParams.get("action") === "move";
    await page.getByTestId("stock-move-submit").click();

    await expect(page.getByTestId("stock-move-error")).toContainText("Not sure it saved — no signal");
    await expect(page.getByTestId("stock-move-qty-input")).toBeDisabled(); // locked until settled
    await shot(page, "phone-06-uncertain-save");
    const during = await itemNamed(GPO_RE);
    expect(during.item.balance_milli).toBe(13_000); // the server DID save it

    await page.getByTestId("stock-move-retry").click();
    await expect(page.getByTestId("stock-move-balance")).toContainText("13 each recorded now (already saved earlier)");

    const after = await itemNamed(GPO_RE);
    expect(after.item.balance_milli).toBe(13_000);
    expect(after.movements.filter((m) => m.kind === "take" && m.quantity_milli === -4_000)).toHaveLength(1);
    clean(w);
  });

  test("a take whose answer is lost, then the app is reopened: it checks and says it went through", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await pickFromList(page, GPO_RE);
    w.dropNext = (u, method) => method === "POST" && u.searchParams.get("action") === "move";
    await page.getByTestId("stock-move-submit").click(); // 1 each
    await expect(page.getByTestId("stock-move-error")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("stock-reconcile-saved")).toContainText("Your save went through", { timeout: 30_000 });
    await expect(page.getByTestId("stock-reconcile-saved")).toContainText("12 each recorded now");
    await shot(page, "phone-07-reconciled");

    const { item, movements } = await itemNamed(GPO_RE);
    expect(item.balance_milli).toBe(12_000);
    expect(movements.filter((m) => m.kind === "take" && m.quantity_milli === -1_000)).toHaveLength(1);
    clean(w);
  });

  test("several products in one photo → asks which one; an unknown product → add it as new", async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    await queue(reading({ ...GPO, position: "left" }, SWITCH));
    await page.getByTestId("stock-take-button").click();
    await photoInput(page).setInputFiles(productPhoto(3));
    const products = page.getByTestId("stock-outcome-products");
    await expect(products).toBeVisible({ timeout: 30_000 });
    await expect(products.getByTestId("stock-outcome-product")).toHaveCount(2);
    await shot(page, "phone-08-which-product");
    await products.getByTestId("stock-outcome-product").first().click();
    await expect(page.getByTestId("stock-move-item")).toHaveText(GPO_NAME);
    // Nothing was written by reading or picking.
    expect((await itemNamed(GPO_RE)).item.balance_milli).toBe(12_000);

    // Back to the camera; the next photo is something the workshop doesn't have.
    await page.getByTestId("stock-take-flow").getByRole("button", { name: "Back", exact: true }).click();
    await queue(reading(SWITCH));
    await photoInput(page).setInputFiles(productPhoto(4));
    await expect(page.getByTestId("stock-outcome-none")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("stock-outcome-add-new").click();

    await expect(page.getByTestId("stock-new-code")).toHaveValue("E-TEST-30");
    await expect(page.getByTestId("stock-lookup-status")).toHaveText("No listing found", { timeout: 30_000 });
    await page.getByTestId("stock-new-qty-input").fill("6");
    await page.getByTestId("stock-new-location").fill("Bin 7");
    await expect(page.getByTestId("stock-new-code-status")).toHaveText("Code status: Saved without external verification");
    await page.getByTestId("stock-new-save").click();
    await expect(page.getByTestId("stock-last-write")).toContainText("6 each recorded now", { timeout: 20_000 });

    const { item } = await itemNamed(/HPM Single switch/);
    expect(item.balance_milli).toBe(6_000);
    expect(item.verification_status).toBe("unverified");
    clean(w);
  });

  test("manual fallback: the photo reader and the online check are both down — the item still saves by hand", async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await harness("/__harness/config", { searchFail: 503 });
    try {
      await openStock(page);
      await queue({ fail: 529 });
      await page.getByTestId("stock-add-button").click();
      await photoInput(page).setInputFiles(productPhoto(5));
      await expect(page.getByTestId("stock-outcome-status")).toHaveAttribute("data-status", "unavailable", { timeout: 30_000 });
      await expect(page.getByTestId("stock-outcome-status")).toContainText("Photo reading isn't working right now");
      await shot(page, "phone-09-reader-down");
      await page.getByTestId("stock-outcome-manual").click();

      await page.getByTestId("stock-new-name").fill("TEST conduit 20mm grey");
      await page.getByTestId("stock-new-code").fill("PVC20-TEST");
      await page.getByTestId("stock-new-check").click();
      await expect(page.getByTestId("stock-lookup-status")).toHaveText("Couldn't check online", { timeout: 30_000 });
      // a container unit says what it means before anyone relies on it
      await page.getByTestId("stock-new-unit-box").click();
      await expect(page.getByTestId("stock-new-unit-hint")).toContainText("stock can only go out a full box at a time");
      await page.getByTestId("stock-new-unit-length").click();
      await expect(page.getByTestId("stock-new-unit-hint")).toHaveCount(0);
      await page.getByTestId("stock-new-qty-input").fill("12");
      await page.getByTestId("stock-new-location").fill("Rack C");
      await expect(page.getByTestId("stock-new-code-status")).toHaveText("Code status: Saved without external verification");
      await shot(page, "phone-10-manual-form");
      await page.getByTestId("stock-new-save").click();
      await expect(page.getByTestId("stock-last-write")).toContainText("TEST conduit 20mm grey", { timeout: 20_000 });

      const { item } = await itemNamed(/TEST conduit 20mm grey/);
      expect(item.balance_milli).toBe(12_000);
      expect(item.base_unit).toBe("length");
      expect(item.verification_status).toBe("unverified");
      // The photo couldn't be read, but it was kept for the item.
      expect(item.photo_id).not.toBeNull();
    } finally {
      await harness("/__harness/config", { searchFail: null });
    }
    clean(w);
  });
});

// ── the office, on a desktop ─────────────────────────────────────────────────

test.describe("office on a desktop", () => {
  test.use(DESKTOP);

  test("sees the list and history; corrects a count through the stale-count guard; undoes a take with a reason", async ({ page, context }) => {
    test.setTimeout(240_000);
    await signIn(context, "office");
    const w = await wire(page);

    await page.goto("/stock", { timeout: 120_000 });
    const table = page.getByTestId("stock-admin-table");
    await expect(table).toBeVisible({ timeout: 60_000 });
    await expect(table.getByTestId("stock-admin-row")).toHaveCount(3);
    const gpoRow = table.getByTestId("stock-admin-row").filter({ hasText: "Clipsal Double power point" });
    await expect(gpoRow).toContainText("12 each");
    await expect(gpoRow).toContainText("Shelf A2");
    await page.getByRole("tab", { name: /Code not confirmed/ }).click();
    await expect(table.getByTestId("stock-admin-row")).toHaveCount(2);
    await page.getByRole("tab", { name: /^All/ }).click();
    await shot(page, "desktop-01-office-list");

    await gpoRow.click();
    const drawer = page.getByTestId("stock-drawer");
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stock-drawer-balance")).toHaveText("12 each");
    const history = page.getByTestId("stock-history");
    await expect(history).toContainText("Sam Tester");
    await expect(history).toContainText("Undone by Sam Tester");

    // Audited undo: the office undoes Sam's 5-each take, with a reason.
    const fiveRow = history.locator("li").filter({ hasText: "Taken 5 each" });
    await fiveRow.getByTestId("stock-history-undo").click();
    await page.getByTestId("stock-history-undo-reason").fill("Wrong item scanned");
    await page.getByTestId("stock-history-undo-confirm").click();
    await expect(page.getByTestId("stock-drawer-balance")).toHaveText("17 each", { timeout: 20_000 });
    await expect(history).toContainText("Undone by Olive Tester");
    await expect(history).toContainText("Wrong item scanned");

    // Count: start counting, someone takes one meanwhile, the save is refused and explained.
    await page.getByTestId("stock-count-begin").click();
    await page.getByTestId("stock-count-qty").fill("15");
    await page.getByTestId("stock-count-reason").fill("Monthly shelf count");
    const { item } = await itemNamed(GPO_RE);
    const jo = await harness<{ name: string; value: string }>("/__harness/session?as=worker2");
    const meanwhile = await fetch(`${API}/api/workshop-stock?action=move`, {
      method: "POST",
      headers: { cookie: `${jo.name}=${jo.value}`, "content-type": "application/json", "idempotency-key": `e2e-meanwhile-${Date.now()}` },
      body: JSON.stringify({ itemId: item.id, kind: "take", quantity: "1" }),
    });
    expect(meanwhile.status).toBe(201);
    await page.getByTestId("stock-count-save").click();
    const stale = page.getByTestId("stock-count-stale");
    await expect(stale).toContainText("Stock changed while you were counting");
    await expect(stale).toContainText("Jo Tester");
    await shot(page, "desktop-02-stale-count");
    await page.getByTestId("stock-count-confirm-stale").click();
    await expect(page.getByTestId("stock-drawer-balance")).toHaveText("15 each", { timeout: 20_000 });
    await expect(history).toContainText("Counted 15 each");

    // The count absorbed everything before it: no Undo on those rows, and the API refuses too.
    await expect(history.locator("li").filter({ hasText: "Returned 2 each" }).getByTestId("stock-history-undo")).toHaveCount(0);
    const before = await itemNamed(GPO_RE);
    const josTake = before.movements.find((m) => m.actor_name === "Jo Tester");
    const olive = await harness<{ name: string; value: string }>("/__harness/session?as=office");
    const late = await fetch(`${API}/api/workshop-stock?action=undo`, {
      method: "POST",
      headers: { cookie: `${olive.name}=${olive.value}`, "content-type": "application/json", "idempotency-key": `e2e-late-undo-${Date.now()}` },
      body: JSON.stringify({ movementId: josTake?.id, reason: "testing the rule" }),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "undo_counted_since" });
    await shot(page, "desktop-03-drawer-history");

    const after = await itemNamed(GPO_RE);
    expect(after.item.balance_milli).toBe(15_000);
    const count = after.movements.find((m) => m.kind === "count");
    expect(count).toMatchObject({ counted_milli: 15_000, quantity_milli: -1_000, actor_name: "Olive Tester", reason: "Monthly shelf count" });
    const actions = after.all.audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["workshop_stock.count_corrected", "workshop_stock.movement_undone"]));
    // the crew's creates live in the item's own history, not the shared audit journal
    expect(actions).not.toContain("workshop_stock.item_created");
    await expect(drawer).toContainText("Added to the catalogue · Sam Tester");
    // The stale count's 409 is the guard doing its job (the browser logs any non-2xx).
    clean(w, [/^api 409: POST \?action=count$/, /status of 409 \(Conflict\) @ .*action=count$/]);
  });
});

test.describe("worker on a phone, after the office", () => {
  test.use(PHONE);

  test("sees the corrected balance and the item's recent movements", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);

    const row = page.getByTestId("stock-list").getByTestId("stock-row").filter({ hasText: "Clipsal Double power point" });
    await expect(row).toContainText("15");
    await row.click();
    await expect(page.getByTestId("stock-sheet-balance")).toContainText("15 each");
    await expect(page.getByTestId("stock-sheet-movements")).toContainText("Counted 15 each");
    await shot(page, "phone-11-item-sheet");
    clean(w);
  });

  test("office list stays usable at phone width", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "office");
    const w = await wire(page);
    await page.goto("/stock", { timeout: 120_000 });
    await expect(page.getByTestId("stock-admin").getByTestId("stock-row").first()).toBeVisible({ timeout: 60_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "phone-12-office-list");
    clean(w);
  });
});

// ── regressions from the review (a fresh workshop of fictional items) ─────────

test.describe("phone: what the review found", () => {
  test.use(PHONE);
  let gpoId = "";

  test.beforeAll(async () => {
    await harness("/__harness/reset", {});
    const r = await api("office", "POST", "action=create", { name: "TEST double GPO", brand: "Clipsal", manufacturerCode: "TEST-2025", baseUnit: "each", location: "Shelf T1", openingQuantity: "40" });
    expect(r.status).toBe(201);
    gpoId = r.body.item!.id;
  });

  test("the confirm screen re-reads the item: what was recorded a minute ago doesn't decide a take now", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    await expect(page.getByTestId("stock-list")).toContainText("40");
    // another phone takes most of it while this list is on screen
    expect((await api("worker2", "POST", "action=move", { itemId: gpoId, kind: "take", quantity: "38" })).status).toBe(201);

    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    await expect(page.getByTestId("stock-move-recorded")).toHaveText("Recorded stock: 2 each");
    await page.getByTestId("stock-move-qty-input").fill("5");
    await expect(page.getByTestId("stock-move-short")).toContainText("Only 2 each recorded");
    await expect(page.getByTestId("stock-move-submit")).toBeDisabled();
    await page.getByTestId("stock-move-qty-input").fill("2");
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-balance")).toContainText("TEST double GPO — none recorded now");
    const after = await state();
    expect(after.items.find((i) => i.id === gpoId)?.balance_milli).toBe(0);
    clean(w);
  });

  test("a pack the office resized meanwhile is refused, shown at its new size, and saved at that size", async ({ page, context }) => {
    test.setTimeout(150_000);
    const current = await api("office", "GET", `action=item&id=${gpoId}`);
    const boxed = await api("office", "PUT", `action=item&id=${gpoId}`, { expectedRevision: current.body.item!.metaRevision, defaultPack: { unit: "box", size: "10" } });
    expect(boxed.status).toBe(200);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    await page.getByTestId("stock-list").getByTestId("stock-row").filter({ hasText: "TEST double GPO" }).click();
    await page.getByTestId("stock-sheet-add").click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    await expect(page.getByTestId("stock-move-confirm")).toContainText("Count in boxes (1 box = 10 each)");
    await page.getByTestId("stock-move-packs").check();

    // the office re-sizes the box while the worker is on this screen
    const again = await api("office", "GET", `action=item&id=${gpoId}`);
    expect((await api("office", "PUT", `action=item&id=${gpoId}`, { expectedRevision: again.body.item!.metaRevision, defaultPack: { unit: "box", size: "12" } })).status).toBe(200);
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("The office changed the box size to 12 — nothing was saved");
    await expect(page.getByTestId("stock-move-confirm")).toContainText("Count in boxes (1 box = 12 each)");
    expect((await itemNamed(/TEST double GPO/)).movements.filter((m) => m.kind === "add")).toHaveLength(0);

    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Added: 12 each (1 box)");
    const { item, movements } = await itemNamed(/TEST double GPO/);
    expect(item.balance_milli).toBe(12_000);
    expect(movements.filter((m) => m.kind === "add").map((m) => m.quantity_milli)).toEqual([12_000]);
    clean(w, [/^api 409: POST \?action=move$/, /status of 409 \(Conflict\) @ .*action=move$/]);
  });

  test("a save that never reached the server: 'Check if it saved' says not yet and keeps the key; Try again saves it once", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    const before = await itemNamed(/TEST double GPO/);
    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    w.dropBeforeNext = (u, method) => method === "POST" && u.searchParams.get("action") === "move";
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("Not sure it saved");

    await page.getByTestId("stock-move-check").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("It hasn't saved (yet)");
    await expect(page.getByTestId("stock-move-qty-input")).toBeDisabled(); // still locked: Try again can't double up
    expect((await itemNamed(/TEST double GPO/)).movements).toHaveLength(before.movements.length); // nothing landed

    await page.getByTestId("stock-move-retry").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Taken: 1 each");
    const after = await itemNamed(/TEST double GPO/);
    expect(after.movements).toHaveLength(before.movements.length + 1);
    expect(after.movements[after.movements.length - 1]).toMatchObject({ kind: "take", quantity_milli: -1000, actor_name: "Sam Tester" });
    expect(after.item.balance_milli).toBe(before.item.balance_milli - 1000);
    clean(w);
  });

  test("two saves left unanswered are both remembered: one went through, the other is sent again — once each", async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    const before = (await itemNamed(/TEST double GPO/)).item.balance_milli;

    // 1. a take the server saved, but the phone never heard back
    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    w.dropNext = (u, method) => method === "POST" && u.searchParams.get("action") === "move";
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("Not sure it saved");
    await page.getByTestId("stock-take-flow-close").click();
    // the sheet closed: the page asks about it and says it went through
    await expect(page.getByTestId("stock-reconcile-saved")).toContainText("Your save went through", { timeout: 20_000 });

    // 2. a return that never reached the server
    await page.getByTestId("stock-return-button").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    await page.getByTestId("stock-move-qty-input").fill("3");
    w.dropBeforeNext = (u, method) => method === "POST" && u.searchParams.get("action") === "move";
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("Not sure it saved");

    // the phone is closed and opened again: the unanswered return is still there
    await page.reload();
    const pending = page.getByTestId("stock-reconcile-pending");
    await expect(pending).toHaveCount(1, { timeout: 30_000 });
    // too recent to call lost (it could still be on its way) — offered as "try again"
    await expect(pending).toHaveAttribute("data-status", "unknown");
    await expect(pending).toContainText("return of 3 each");
    await shot(page, "phone-13-two-pending");
    await pending.getByTestId("stock-reconcile-retry").click();
    await expect(page.getByTestId("stock-reconcile-pending")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("stock-last-write")).toContainText("Returned 3 each");

    const { item, movements } = await itemNamed(/TEST double GPO/);
    expect(item.balance_milli).toBe(before - 1000 + 3000);
    expect(movements.filter((m) => m.kind === "return")).toHaveLength(1);
    clean(w);
  });

  test("'Workshop stock can't save right now' means nothing was saved: the form unlocks and nothing is left pending", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    const before = await itemNamed(/TEST double GPO/);
    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    w.answerNext = { match: (u, method) => method === "POST" && u.searchParams.get("action") === "move", status: 503, body: { error: "store_unavailable" } };
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-error")).toContainText("nothing was saved");
    await expect(page.getByTestId("stock-move-qty-input")).toBeEnabled();
    await expect(page.getByTestId("stock-move-retry")).toHaveCount(0);
    await page.getByTestId("stock-take-flow-close").click();
    await page.reload();
    await expect(page.getByTestId("stock-take-button")).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId("stock-reconcile-pending")).toHaveCount(0);
    expect((await itemNamed(/TEST double GPO/)).movements).toHaveLength(before.movements.length);
    clean(w, [/^api 503: POST \?action=move$/, /status of 503 \(Service Unavailable\) @ .*action=move$/]);
  });

  test("the office undoes from the phone screens: asked for a reason, not refused", async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(context, "office");
    const w = await wire(page);
    await openStock(page);
    await page.getByTestId("stock-take-button").click();
    await page.getByTestId("stock-take-search").click();
    await page.getByTestId("stock-picker-search").fill("TEST double");
    await page.getByTestId("stock-picker-row").first().click();
    await expect(page.getByTestId("stock-move-confirm")).toHaveAttribute("data-fresh", "1", { timeout: 20_000 });
    await page.getByTestId("stock-move-submit").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Taken: 1 each");
    await page.getByTestId("stock-move-undo").click();
    await page.getByTestId("stock-move-undo-reason").fill("picked the wrong box");
    await page.getByTestId("stock-move-undo-confirm").click();
    await expect(page.getByTestId("stock-move-done")).toContainText("Undone");
    const { movements } = await itemNamed(/TEST double GPO/);
    const reversal = movements[movements.length - 1]!;
    expect(reversal).toMatchObject({ kind: "reversal", reason: "picked the wrong box", actor_name: "Olive Tester" });
    clean(w);
  });

  test("an abandoned add-stock photo is cleaned up after it expires — marked first, then its blobs go", async ({ page, context }) => {
    test.setTimeout(150_000);
    await signIn(context, "worker");
    const w = await wire(page);
    await openStock(page);
    await queue(reading({ ...SWITCH, manufacturerCode: "E-ABANDON-1", position: "only product" }));
    await page.getByTestId("stock-add-button").click();
    await photoInput(page).setInputFiles(productPhoto(6));
    await expect(page.getByTestId("stock-new-item")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("stock-add-flow-close").click(); // walked away without saving
    const kept = (await state()).photos.filter((p) => p.purpose === "pending");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ has_thumb: true, blobStored: true, thumbStored: true });

    expect((await harness<{ expired: number }>("/__harness/expire-photos", {})).expired).toBe(1);
    // the next photo read does the cleanup alongside its own work
    await queue(reading(SWITCH));
    await page.getByTestId("stock-take-button").click();
    await photoInput(page).setInputFiles(productPhoto(7));
    await expect(page.getByTestId("stock-outcome-none").or(page.getByTestId("stock-move-confirm"))).toBeVisible({ timeout: 30_000 });
    const gone = (await state()).photos.find((p) => p.id === kept[0]!.id);
    expect(gone).toMatchObject({ deleted: true, blob_deleted: true, blobStored: false, thumbStored: false });
    clean(w);
  });
});

test.describe("office: what the review found", () => {
  test.use(DESKTOP);

  test("restoring an item whose code another item took meanwhile says so — the new item keeps it", async ({ page, context }) => {
    test.setTimeout(150_000);
    const old = await api("office", "POST", "action=create", { name: "TEST old switch", brand: "HPM", manufacturerCode: "TEST-OLD-1", barcode: "9300704010024", baseUnit: "each", location: "Shelf T2", openingQuantity: "4" });
    expect(old.status).toBe(201);
    expect((await api("office", "POST", "action=archive", { itemId: old.body.item!.id })).status).toBe(200);
    expect((await api("worker", "POST", "action=create", { name: "TEST new switch", barcode: "9300704010024", baseUnit: "each", location: "Shelf T3", openingQuantity: "2" })).status).toBe(201);

    await signIn(context, "office");
    const w = await wire(page);
    await page.goto("/stock", { timeout: 120_000 });
    await expect(page.getByTestId("stock-admin-table")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("tab", { name: /Archived/ }).click();
    await page.getByTestId("stock-admin-row").filter({ hasText: "TEST old switch" }).click();
    await expect(page.getByTestId("stock-drawer-archived-note")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("stock-edit-form")).toHaveCount(0); // read-only while archived
    await page.getByTestId("stock-restore").click();
    await expect(page.getByTestId("stock-restore-note")).toContainText("Restored without 9300704010024 (now on “TEST new switch”)", { timeout: 20_000 });
    await expect(page.getByTestId("stock-edit-form")).toBeVisible();
    await shot(page, "desktop-04-restore-note");
    clean(w);
  });

  test("typing in Details survives a photo change; another office edit is flagged, never silently overwritten", async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, "office");
    const w = await wire(page);
    await page.goto("/stock", { timeout: 120_000 });
    await page.getByTestId("stock-admin-row").filter({ hasText: "TEST double GPO" }).click();
    await expect(page.getByTestId("stock-drawer")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("stock-edit-location").fill("Shelf T9");

    // a photo change reloads the drawer: the half-typed edit is still there
    await page.getByTestId("stock-drawer-photo-camera").locator("input[type=file]").setInputFiles(productPhoto(8));
    await expect(page.getByTestId("stock-drawer")).toContainText("Photo changed.", { timeout: 30_000 });
    await expect(page.getByTestId("stock-edit-location")).toHaveValue("Shelf T9");
    await expect(page.getByTestId("stock-edit-stale")).toHaveCount(0);

    // someone else edits the name; the next reload shows it's stale instead of wiping the form
    const { item } = await itemNamed(/TEST double GPO/);
    const cur = await api("office", "GET", `action=item&id=${item.id}`);
    expect((await api("office", "PUT", `action=item&id=${item.id}`, { expectedRevision: cur.body.item!.metaRevision, name: "TEST double GPO (renamed)" })).status).toBe(200);
    await page.getByTestId("stock-drawer-photo-camera").locator("input[type=file]").setInputFiles(productPhoto(9));
    await expect(page.getByTestId("stock-edit-stale")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stock-edit-location")).toHaveValue("Shelf T9");
    await shot(page, "desktop-05-edit-stale");
    await page.getByTestId("stock-edit-reload").click();
    await expect(page.getByTestId("stock-edit-name")).toHaveValue("TEST double GPO (renamed)");
    await page.getByTestId("stock-edit-location").fill("Shelf T9");
    await page.getByTestId("stock-edit-save").click();
    await expect(page.getByTestId("stock-edit-form")).toContainText("Saved.");
    const after = await itemNamed(/TEST double GPO/);
    expect(after.item).toMatchObject({ name: "TEST double GPO (renamed)", location: "Shelf T9" });
    clean(w);
  });
});
