import { expect, test, type Page } from "@playwright/test";

/**
 * The camera table + location matrix, end to end against the LOCAL harness
 * (docs/workshop-stock.md → "Testing"): real pages, real handler, real local
 * Postgres. The webcam is a canvas drawn by this spec — objects really are found
 * in its frames by the real tracker — and the label reader's answer is a fixture.
 * Real webcams, real lighting and real labels are NOT proven here.
 *
 * Skipped unless WORKSHOP_STOCK_E2E_API points at the harness.
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
if (process.env.WORKSHOP_STOCK_E2E_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.WORKSHOP_STOCK_E2E_CHROMIUM } });
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

type State = {
  items: Array<{ id: string; name: string; balance_milli: number; location: string | null }>;
  movements: Array<{ item_id: string; kind: string; quantity_milli: number; reverses_movement_id: string | null }>;
  calls: { vision: unknown[] };
};

async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}
const state = () => harness<State>("/__harness/state");
const itemNamed = async (re: RegExp) => {
  const s = await state();
  const item = s.items.find((i) => re.test(i.name));
  if (!item) throw new Error(`no item matching ${re}`);
  return { item, movements: s.movements.filter((m) => m.item_id === item.id), all: s };
};

const ICONIC = {
  brand: "Clipsal", manufacturerCode: "3041", supplierSku: null, supplierName: null, description: "Iconic 1 gang switch mechanism",
  colourFinish: null, variantDetails: ["16A"], barcode: null, packQuantity: null, packUnit: null, labelText: ["3041"], position: "only product",
};
const ICONIC_PACK = { ...ICONIC, packQuantity: 10, packUnit: "each", labelText: ["3041", "Pack of 10"] };
const SADDLE = { ...ICONIC, brand: "Clipsal", manufacturerCode: null, description: "Conduit saddle 20mm", variantDetails: ["20mm"], labelText: [] };
const reading = (...products: unknown[]) => ({ raw: { legibility: "clear", note: null, products } });
const unreadable = { raw: { legibility: "unreadable", note: "no label in shot", products: [] } };

/** The webcam: a dark table drawn on a canvas, objects added and lifted by the test. */
async function fakeCamera(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;
    const things = new Map<string, { x: number; y: number; w: number; h: number; colour: string }>();
    let nextBarcode: string | null = null;
    setInterval(() => {
      ctx.fillStyle = "#23272b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const t of things.values()) {
        ctx.fillStyle = t.colour;
        ctx.fillRect(t.x, t.y, t.w, t.h);
      }
    }, 50);
    const w = window as unknown as Record<string, unknown>;
    w.__table = {
      put: (id: string, x: number, y: number, tw = 130, th = 110, colour = "#e8e4d8") => things.set(id, { x, y, w: tw, h: th, colour }),
      lift: (id: string) => things.delete(id),
      barcode: (code: string | null) => { nextBarcode = code; },
    };
    w.BarcodeDetector = class {
      async detect() {
        const code = nextBarcode;
        return code ? [{ rawValue: code }] : [];
      }
    };
    const stream = canvas.captureStream(15);
    navigator.mediaDevices.getUserMedia = async () => stream;
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: "videoinput", deviceId: "fake", label: "Overhead test camera", groupId: "", toJSON() { return {}; } } as MediaDeviceInfo];
  });
}
const put = (page: Page, id: string, x: number, y: number, w?: number, h?: number) => page.evaluate((a) => (window as unknown as { __table: { put: (...p: unknown[]) => void } }).__table.put(a.id, a.x, a.y, a.w, a.h), { id, x, y, w, h });
const lift = (page: Page, id: string) => page.evaluate((a) => (window as unknown as { __table: { lift: (i: string) => void } }).__table.lift(a), id);
const nextBarcode = (page: Page, code: string | null) => page.evaluate((c) => (window as unknown as { __table: { barcode: (c: string | null) => void } }).__table.barcode(c), code);

async function open(page: Page) {
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  await page.context().addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
  });
}
const logged = (page: Page) => page.getByTestId("stock-intake-logged");
const waiting = (page: Page) => page.getByTestId("stock-intake-waiting");
const rows = (page: Page) => page.getByTestId("stock-intake-rows").getByTestId("stock-intake-row");

test.beforeAll(async () => {
  await harness("/__harness/reset", {});
});

test("the matrix: a rack, a bin, what goes in it", async ({ page }) => {
  await open(page);
  await page.goto("/stock");
  await page.getByTestId("stock-open-matrix").click();
  await expect(page).toHaveURL(/\/stock\/locations$/);
  await page.getByTestId("stock-matrix-rack-name").fill("c");
  await page.getByTestId("stock-matrix-rack-add").click();
  await expect(page.getByTestId("stock-matrix-rack")).toContainText("Rack C");
  await page.getByRole("button", { name: /Rack C Shelf 2, Bin 4/ }).click();
  await page.getByTestId("stock-matrix-words").fill("iconic switches");
  await page.getByTestId("stock-matrix-words-add").click();
  await expect(page.getByRole("button", { name: /Rack C Shelf 2, Bin 4: iconic switches/ })).toBeVisible();
  await page.getByRole("button", { name: /Rack C Shelf 1, Bin 1/ }).click();
  await page.getByTestId("stock-matrix-words").fill("saddle");
  await page.getByTestId("stock-matrix-words-add").click();
  await page.getByTestId("stock-matrix-try").fill("Clipsal Iconic 1 gang switch");
  await expect(page.getByTestId("stock-matrix-try-result")).toContainText("Rack C Shelf 2, Bin 4");
  await page.screenshot({ path: `${SHOTS}/camera-table-matrix.png` });
  await page.reload();
  await expect(page.getByRole("button", { name: /Rack C Shelf 2, Bin 4: iconic switches/ })).toBeVisible();
});

test("the table: red until logged, green after, each object counted once", async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  await fakeCamera(page);
  await open(page);
  await page.goto("/stock/intake");
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-camera", "live");
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/camera-table-start.png` });
  await page.getByTestId("stock-intake-start").click();
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-running", "true");

  // A new product: stays red, with the location from the matrix, one tap to add.
  await harness("/__harness/vision", { queue: [reading(ICONIC)] });
  await put(page, "a", 150, 200);
  const card = page.getByTestId("stock-intake-card");
  await expect(card).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("Rack C Shelf 2, Bin 4");
  await expect(waiting(page)).toHaveText("1");
  await expect(logged(page)).toHaveText("0");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/camera-table-red-new.png` });
  await page.getByTestId("stock-intake-new-save").click();
  await expect(logged(page)).toHaveText("1");
  await expect(waiting(page)).toHaveText("0");
  let found = await itemNamed(/Iconic/);
  expect(found.item.balance_milli).toBe(1000);
  expect(found.item.location).toBe("Rack C Shelf 2, Bin 4");

  // It stays on the table a good while: still one.
  await page.waitForTimeout(1500);
  await expect(logged(page)).toHaveText("1");

  // The next one with that code logs itself.
  await harness("/__harness/vision", { queue: [reading(ICONIC)] });
  await put(page, "b", 450, 200);
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  await expect(waiting(page)).toHaveText("0");
  found = await itemNamed(/Iconic/);
  expect(found.item.balance_milli).toBe(2000);
  await expect(page.getByTestId("stock-intake-goes-to")).toContainText("Rack C Shelf 2, Bin 4");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/camera-table-green.png` });

  // A hand reaching in from the edge, over an object already logged: nothing new.
  const before = (await state()).calls.vision.length;
  await page.evaluate(() => (window as unknown as { __table: { put: (...p: unknown[]) => void } }).__table.put("arm", 0, 210, 330, 90, "#b98a6a"));
  await page.waitForTimeout(2500);
  await lift(page, "arm");
  await page.waitForTimeout(1200);
  await expect(logged(page)).toHaveText("2");
  expect((await state()).calls.vision.length).toBe(before);

  // A printed pack: +10, said so, and the amount can be changed.
  await harness("/__harness/vision", { queue: [reading(ICONIC_PACK)] });
  await put(page, "pack", 800, 200, 180, 140);
  await expect(logged(page)).toHaveText("3", { timeout: 15_000 });
  await expect(rows(page).first().getByTestId("stock-intake-row-amount")).toHaveText("+10 each");
  await expect(rows(page).first()).toContainText("Pack size from the label");
  found = await itemNamed(/Iconic/);
  expect(found.item.balance_milli).toBe(12000);

  await rows(page).first().getByTestId("stock-intake-row-edit").click();
  await rows(page).first().getByTestId("stock-intake-row-edit-input").fill("8");
  await rows(page).first().getByTestId("stock-intake-row-edit-save").click();
  await expect(rows(page).first().getByTestId("stock-intake-row-amount")).toHaveText("+8 each");
  found = await itemNamed(/Iconic/);
  expect(found.item.balance_milli).toBe(10000);
  expect(found.movements.filter((m) => m.kind === "reversal")).toHaveLength(1);

  // Undo takes it back off the record.
  await rows(page).first().getByTestId("stock-intake-row-undo").click();
  await expect(rows(page).first()).toHaveAttribute("data-status", "undone");
  await expect(logged(page)).toHaveText("2");
  found = await itemNamed(/Iconic/);
  expect(found.item.balance_milli).toBe(2000);

  // Lifted off and the next one placed in the same spot: a new object.
  await lift(page, "a");
  await page.waitForTimeout(2000);
  await harness("/__harness/vision", { queue: [reading(ICONIC)] });
  await put(page, "a2", 150, 200);
  await expect(logged(page)).toHaveText("3", { timeout: 15_000 });

  // "All the same": the rest log with no read at all.
  const reads = (await state()).calls.vision.length;
  await rows(page).first().getByTestId("stock-intake-row-lock").click();
  await expect(page.getByTestId("stock-intake-lock")).toContainText("Iconic");
  await put(page, "c", 150, 450);
  await expect(logged(page)).toHaveText("4", { timeout: 10_000 });
  expect((await state()).calls.vision.length).toBe(reads);
  await page.getByTestId("stock-intake-lock").getByRole("button", { name: "Stop" }).click();

  // Words alone never log: a similar item stays red until someone picks.
  await harness("/__harness/vision", { queue: [reading({ ...ICONIC, manufacturerCode: null, description: "Iconic switch mechanism" })] });
  await put(page, "d", 450, 450);
  await expect(card).toHaveAttribute("data-status", "pick", { timeout: 15_000 });
  await expect(logged(page)).toHaveText("4");
  await page.getByTestId("stock-intake-choice").first().click();
  await expect(logged(page)).toHaveText("5");

  // A logged item with no location can be given one from its row.
  await harness("/__harness/vision", { queue: [reading({ ...ICONIC, manufacturerCode: "NOBIN-1", brand: "HPM", description: "Junction box" })] });
  await put(page, "n", 800, 450, 110, 90);
  await expect(card).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("");
  await page.getByTestId("stock-intake-new-save").click();
  await expect(logged(page)).toHaveText("6");
  await rows(page).first().getByTestId("stock-intake-row-set-location").click();
  await rows(page).first().getByTestId("stock-intake-row-location-input").fill("Rack C Shelf 4, Bin 1");
  await rows(page).first().getByTestId("stock-intake-row-location-save").click();
  await expect(rows(page).first().getByTestId("stock-intake-row-location")).toContainText("Rack C Shelf 4, Bin 1");
  expect((await itemNamed(/Junction box/)).item.location).toBe("Rack C Shelf 4, Bin 1");
  await rows(page).first().getByTestId("stock-intake-row-undo").click();
  await expect(logged(page)).toHaveText("5");
  await lift(page, "n");
  await page.waitForTimeout(2000);

  // A label it can't read: says so, read again, or ignore it.
  await harness("/__harness/vision", { queue: [unreadable] });
  await put(page, "e", 800, 450);
  await expect(card).toHaveAttribute("data-status", "problem", { timeout: 15_000 });
  await harness("/__harness/vision", { queue: [reading(SADDLE)] });
  await page.getByTestId("stock-intake-retry").click();
  await expect(card).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("Rack C Shelf 1, Bin 1");
  await page.getByTestId("stock-intake-ignore").click();
  await expect(waiting(page)).toHaveText("0");
  await expect(logged(page)).toHaveText("5");

  // A barcode logs with no read, once the item has it. Teach it by picking.
  await lift(page, "e");
  await nextBarcode(page, "9300000000019");
  await harness("/__harness/vision", { queue: [reading({ ...ICONIC, manufacturerCode: null, description: "Iconic switch mechanism" })] });
  await put(page, "f", 1050, 450, 120, 100);
  await expect(card).toHaveAttribute("data-status", "pick", { timeout: 15_000 });
  await page.getByTestId("stock-intake-choice").first().click();
  await expect(logged(page)).toHaveText("6");
  const readsBefore = (await state()).calls.vision.length;
  await lift(page, "f");
  await page.waitForTimeout(2000);
  await put(page, "g", 1050, 450, 120, 100);
  await expect(logged(page)).toHaveText("7", { timeout: 10_000 });
  expect((await state()).calls.vision.length).toBe(readsBefore);
  await nextBarcode(page, null);

  const final = await itemNamed(/Iconic/);
  expect(final.item.balance_milli).toBe(7000);
  await page.screenshot({ path: `${SHOTS}/camera-table-session.png` });

  // The keyboard works with hands on the table, even with a button still focused.
  await page.getByTestId("stock-intake-sound").click();
  await page.keyboard.press("m");
  await expect(page.getByTestId("stock-intake-sound")).toHaveAttribute("aria-pressed", "true");
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Space");
  await expect(page.getByTestId("stock-intake-resume")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-running", "true");
  await page.keyboard.press("u");
  await expect(logged(page)).toHaveText("6");
  expect((await itemNamed(/Iconic/)).item.balance_milli).toBe(6000);
  await page.keyboard.press("f");
  await expect(page.getByTestId("stock-intake-full")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/camera-table-full.png` });
  await page.keyboard.press("f");
  await expect(page.getByTestId("stock-intake-full")).toHaveAttribute("aria-pressed", "false");

  // A phone still fits, with nothing running off the side.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/camera-table-phone.png` });
  expect(problems).toEqual([]);
});

test("an item with no location takes the matrix's; one that has one keeps it", async ({ page }) => {
  test.setTimeout(60_000);
  await harness("/__harness/reset", {});
  await open(page);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  const headers = { cookie: `${s.name}=${s.value}`, "content-type": "application/json" };
  const saved = await fetch(`${API}/api/workshop-stock?action=location-matrix`, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, racks: [{ id: "c", name: "C", shelves: 4, bins: 6 }], rules: [{ id: "r1", words: "iconic switch", rackId: "c", shelf: 2, bin: 4 }] }) });
  expect(saved.status).toBe(200);
  const conflict = await fetch(`${API}/api/workshop-stock?action=location-matrix`, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, racks: [], rules: [] }) });
  expect(conflict.status).toBe(409);
  const outOfRange = await fetch(`${API}/api/workshop-stock?action=location-matrix`, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 1, racks: [{ id: "c", name: "C", shelves: 1, bins: 1 }], rules: [{ id: "r1", words: "x", rackId: "c", shelf: 2, bin: 1 }] }) });
  expect(outOfRange.status).toBe(400);
  for (const [name, code, location] of [["Iconic switch A", "3041", null], ["Iconic switch B", "3042", "Top drawer"]] as const) {
    const r = await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { ...headers, "idempotency-key": `camera-seed-${code}` }, body: JSON.stringify({ name, brand: "Clipsal", manufacturerCode: code, baseUnit: "each", location, openingQuantity: "1" }) });
    expect(r.status).toBe(201);
  }
  await fakeCamera(page);
  await page.goto("/stock/intake");
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-camera", "live");
  await page.waitForTimeout(400);
  await page.getByTestId("stock-intake-start").click();
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-running", "true");

  await harness("/__harness/vision", { queue: [reading(ICONIC)] });
  await put(page, "a", 150, 200);
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  await expect(rows(page).first().getByTestId("stock-intake-row-location")).toContainText("Rack C Shelf 2, Bin 4");
  expect((await itemNamed(/switch A/)).item.location).toBe("Rack C Shelf 2, Bin 4");

  await harness("/__harness/vision", { queue: [reading({ ...ICONIC, manufacturerCode: "3042" })] });
  await put(page, "b", 450, 200);
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  expect((await itemNamed(/switch B/)).item.location).toBe("Top drawer");
});
