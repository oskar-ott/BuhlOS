import { expect, test, type Page } from "@playwright/test";

/**
 * The camera table through the ways people really work it, against the LOCAL
 * harness (docs/workshop-stock.md → "Testing"): working a pile through one spot, a
 * queue of new items, a pack size worth checking, a hand scanner, a reload, a camera
 * knocked out. The webcam is a canvas with sensor noise drawn in; the label reader's
 * answer is a fixture. Real webcams, real lighting and real labels are NOT proven.
 *
 * Skipped unless WORKSHOP_STOCK_E2E_API points at the harness.
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
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
const balance = async (re: RegExp) => (await state()).items.find((i) => re.test(i.name))?.balance_milli ?? null;

const product = (over: Record<string, unknown>) => ({
  brand: "Clipsal", manufacturerCode: "3041", supplierSku: null, supplierName: null, description: "Iconic 1 gang switch mechanism",
  colourFinish: null, variantDetails: [], barcode: null, packQuantity: null, packUnit: null, labelText: ["3041"], position: "only product", ...over,
});
const reading = (...products: unknown[]) => ({ raw: { legibility: "clear", note: null, products } });
const unreadable = { raw: { legibility: "unreadable", note: "no label in shot", products: [] } };

/** A webcam with grain in the picture, and a track that can be knocked out and says what it can hold. */
async function fakeCamera(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;
    const things = new Map<string, { x: number; y: number; w: number; h: number; colour: string }>();
    const grain = document.createElement("canvas");
    grain.width = 256;
    grain.height = 256;
    const gtx = grain.getContext("2d")!;
    const pixels = gtx.createImageData(256, 256);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      pixels.data[i] = v;
      pixels.data[i + 1] = v;
      pixels.data[i + 2] = v;
      pixels.data[i + 3] = 22;
    }
    gtx.putImageData(pixels, 0, 0);
    let nextBarcode: string | null = null;
    setInterval(() => {
      ctx.fillStyle = "#3a5a4c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const t of things.values()) {
        ctx.fillStyle = t.colour;
        ctx.fillRect(t.x, t.y, t.w, t.h);
        if (t.colour !== "#b98a6a") {
          ctx.fillStyle = "#f4f4ee";
          ctx.fillRect(t.x + 10, t.y + 10, t.w - 20, t.h / 2);
          ctx.fillStyle = "#222";
          ctx.fillRect(t.x + 16, t.y + 18, t.w - 40, 8);
        }
      }
      ctx.globalCompositeOperation = "source-over";
      for (let y = 0; y < 720; y += 256) for (let x = 0; x < 1280; x += 256) ctx.drawImage(grain, Math.floor(Math.random() * 40) - 20 + x, Math.floor(Math.random() * 40) - 20 + y);
    }, 50);
    const w = window as unknown as Record<string, unknown>;
    w.__table = {
      put: (id: string, x: number, y: number, tw = 130, th = 110, colour = "#c9a878") => things.set(id, { x, y, w: tw, h: th, colour }),
      lift: (id: string) => things.delete(id),
      handOver: (id: string) => {
        const t = things.get(id);
        if (t) things.set("hand", { x: t.x + t.w / 2 - 35, y: t.y + t.h / 2, w: 70, h: 720 - t.y - t.h / 2, colour: "#b98a6a" });
      },
      barcode: (code: string | null) => { nextBarcode = code; },
      constraints: [] as unknown[],
      opens: 0,
      knockOut: () => {
        const track = (w.__stream as MediaStream).getVideoTracks()[0]!;
        track.stop();
        track.dispatchEvent(new Event("ended"));
      },
    };
    w.BarcodeDetector = class {
      async detect() {
        const code = nextBarcode;
        return code ? [{ rawValue: code }] : [];
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0]!;
      const table = w.__table as { constraints: unknown[]; opens: number };
      table.opens += 1;
      (track as unknown as { getCapabilities: () => unknown }).getCapabilities = () => ({ exposureMode: ["continuous", "manual"], whiteBalanceMode: ["continuous", "manual"] });
      track.applyConstraints = async (c) => { table.constraints.push(c); };
      w.__stream = stream;
      return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: "videoinput", deviceId: "fake", label: "Overhead test camera", groupId: "", toJSON() { return {}; } } as MediaDeviceInfo];
  });
}
const table = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
  const t = (window as unknown as { __table: Record<string, (...p: unknown[]) => unknown> }).__table;
  return t[f as string]!(...(a as unknown[]));
}, [fn, args] as const);
const put = (page: Page, id: string, x: number, y: number, w?: number, h?: number) => table(page, "put", id, x, y, w, h);
const take = (page: Page, id: string) => table(page, "lift", id);
/** A hand comes over it, takes it, and goes: nothing leaves the table on its own. */
async function lift(page: Page, id: string) {
  await table(page, "handOver", id);
  await page.waitForTimeout(350);
  await take(page, id);
  await page.waitForTimeout(200);
  await take(page, "hand");
}

/** A hand reaching in from the bottom of the picture to a spot: on the table for as long as the caller waits. */
const handTo = (page: Page, x: number, y: number) => table(page, "put", "hand", x, y, 70, 720 - y, "#b98a6a");
const handAway = (page: Page) => take(page, "hand");

async function open(page: Page, path = "/stock/intake") {
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  await page.context().addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
  });
  await page.goto(path);
}
async function start(page: Page) {
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-camera", "live");
  await page.waitForTimeout(400);
  await page.getByTestId("stock-intake-start").click();
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-running", "true");
}
const logged = (page: Page) => page.getByTestId("stock-intake-logged");
const waiting = (page: Page) => page.getByTestId("stock-intake-waiting");
const card = (page: Page) => page.getByTestId("stock-intake-card");
const rows = (page: Page) => page.getByTestId("stock-intake-rows").getByTestId("stock-intake-row");

/** What a scanner does: every key within a few milliseconds of the last, then Enter. */
async function scan(page: Page, code: string) {
  await page.evaluate((c) => {
    for (const key of [...c, "Enter"]) window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }, code);
}

test.beforeEach(async () => {
  await harness("/__harness/reset", {});
});

test("a pile worked through one spot: each one counted, hand in between or not", async ({ page }) => {
  test.setTimeout(120_000);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await expect(page.getByTestId("stock-intake-exposure")).toHaveText("Held");

  await harness("/__harness/vision", { queue: [reading(product({ barcode: "9300000000019" }))] });
  await table(page, "barcode", "9300000000019");
  await put(page, "first", 500, 250);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-save").click();
  await expect(logged(page)).toHaveText("1");
  const reads = (await state()).calls.vision.length;

  for (let n = 2; n <= 6; n++) {
    // The hand comes in, takes the last one, and comes straight back with the next.
    await handTo(page, 530, 300);
    await page.waitForTimeout(350);
    await take(page, n === 2 ? "first" : `box${n - 1}`);
    await page.waitForTimeout(150);
    await handAway(page);
    await page.waitForTimeout(600);
    await handTo(page, 530, 300);
    await put(page, `box${n}`, 500, 250);
    await page.waitForTimeout(250);
    await handAway(page);
    await expect(logged(page)).toHaveText(String(n), { timeout: 8_000 });
  }
  expect(await balance(/Iconic/)).toBe(6000);
  expect((await state()).calls.vision.length).toBe(reads);
  await expect(page.getByTestId("stock-intake-barcodes")).toHaveText("6");
  const ms = Number(await page.getByTestId("stock-intake-feed").getAttribute("data-analysis-ms"));
  console.log(`analysis per frame in the browser: ${ms} ms`);
  expect(ms).toBeLessThan(40);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/flows-pile.png` });
});

test("new items queue oldest first, repeats share a card, the keyboard works it", async ({ page }) => {
  test.setTimeout(120_000);
  await fakeCamera(page);
  await open(page);
  await start(page);

  await harness("/__harness/vision", { queue: [reading(product({})), reading(product({ manufacturerCode: "2000", description: "GPO double", labelText: ["2000"] })), reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-name").fill("Iconic switch mech");
  await put(page, "b", 450, 150);
  await expect(page.getByTestId("stock-intake-queued")).toHaveCount(1, { timeout: 15_000 });
  // What's being typed into stays put.
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue("Iconic switch mech");
  await expect(card(page)).toHaveCount(1);
  await put(page, "c", 800, 150);
  await expect(page.getByTestId("stock-intake-card-repeats")).toHaveText("×2", { timeout: 15_000 });
  await expect(waiting(page)).toHaveText("3");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/flows-queue.png` });

  // Enter adds the open card, and its repeat goes with it.
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("2");
  expect(await balance(/Iconic switch mech/)).toBe(2000);
  await expect(card(page)).toContainText("New to the stock list");
  await page.keyboard.press("x");
  await expect(waiting(page)).toHaveText("0");
});

test("a pick teaches the printed code, so the next one logs itself", async ({ page }) => {
  test.setTimeout(90_000);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  const headers = { cookie: `${s.name}=${s.value}`, "content-type": "application/json" };
  const made = await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { ...headers, "idempotency-key": "flows-seed-1" }, body: JSON.stringify({ name: "Iconic switch mechanism", brand: "Clipsal", baseUnit: "each", location: "Top drawer", openingQuantity: "1" }) });
  expect(made.status).toBe(201);

  await fakeCamera(page);
  await open(page);
  await start(page);
  await harness("/__harness/vision", { queue: [reading(product({ manufacturerCode: "3041L" }))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "pick", { timeout: 15_000 });
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("1");
  await expect(logged(page)).toHaveText("1");
  await harness("/__harness/vision", { queue: [reading(product({ manufacturerCode: "3041L" }))] });
  await put(page, "b", 450, 150);
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  await expect(waiting(page)).toHaveText("0");
  expect(await balance(/Iconic switch mechanism/)).toBe(3000);
});

test("a big pack size is checked once, then trusted", async ({ page }) => {
  test.setTimeout(90_000);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  const headers = { cookie: `${s.name}=${s.value}`, "content-type": "application/json" };
  await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { ...headers, "idempotency-key": "flows-seed-2" }, body: JSON.stringify({ name: "Cable tie 200mm", brand: "HPM", manufacturerCode: "CT200", baseUnit: "each", location: "Bin 1", openingQuantity: "1" }) });

  await fakeCamera(page);
  await open(page);
  await start(page);
  const pack = product({ brand: "HPM", manufacturerCode: "CT200", description: "Cable tie 200mm", packQuantity: 500, packUnit: "each", labelText: ["CT200", "Pack of 500"] });
  await harness("/__harness/vision", { queue: [reading(pack), reading(pack)] });
  await put(page, "a", 100, 150);
  await expect(page.getByTestId("stock-intake-amount-ask")).toContainText("500", { timeout: 15_000 });
  expect(await balance(/Cable tie/)).toBe(1000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/flows-pack-check.png` });
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("1");
  expect(await balance(/Cable tie/)).toBe(501000);
  await put(page, "b", 450, 150);
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  expect(await balance(/Cable tie/)).toBe(1001000);
});

test("a hand scanner: with the camera stopped it counts, with it running it names what's placed next", async ({ page }) => {
  test.setTimeout(90_000);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  const headers = { cookie: `${s.name}=${s.value}`, "content-type": "application/json" };
  await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { ...headers, "idempotency-key": "flows-seed-3" }, body: JSON.stringify({ name: "RCBO 20A", brand: "Clipsal", barcode: "9300000000026", baseUnit: "each", location: "Bin 2", openingQuantity: "1" }) });

  await fakeCamera(page);
  await open(page);
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled();
  await scan(page, "9300000000026");
  await expect(logged(page)).toHaveText("1");
  await scan(page, "9300000000026");
  await expect(logged(page)).toHaveText("2");
  expect(await balance(/RCBO/)).toBe(3000);

  await start(page);
  const reads = (await state()).calls.vision.length;
  await scan(page, "9300000000026");
  await expect(page.getByTestId("stock-intake-next-scan")).toContainText("RCBO 20A");
  await put(page, "a", 100, 150);
  await expect(logged(page)).toHaveText("3", { timeout: 15_000 });
  expect((await state()).calls.vision.length).toBe(reads);
  expect(await balance(/RCBO/)).toBe(4000);
});

test("a label it can't read: taken away, it's marked not logged; a passing failure retries by itself", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await start(page);

  await harness("/__harness/vision", { queue: [unreadable] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "problem", { timeout: 15_000 });
  await lift(page, "a");
  await expect(page.getByTestId("stock-intake-missed")).toHaveText("1", { timeout: 5_000 });
  await expect(waiting(page)).toHaveText("0");

  // The first read dies on the network; nobody has to do anything.
  let aborted = false;
  await page.route(/action=read-photo/, async (route) => {
    if (!aborted) {
      aborted = true;
      await route.abort();
      return;
    }
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
  });
  await harness("/__harness/vision", { queue: [reading(product({ manufacturerCode: "RETRY1" }))] });
  await put(page, "b", 450, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 20_000 });
  expect(aborted).toBe(true);
});

test("the log survives a reload, Undo included", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-save").click();
  await expect(logged(page)).toHaveText("1");
  await page.reload();
  await expect(logged(page)).toHaveText("1");
  await expect(page.getByTestId("stock-intake-rows")).toContainText("Iconic");
  await rows(page).first().getByTestId("stock-intake-row-undo").click();
  await expect(rows(page).first()).toHaveAttribute("data-status", "undone");
  expect(await balance(/Iconic/)).toBe(0);
  await page.getByTestId("stock-intake-clear-log").click();
  await expect(page.getByTestId("stock-intake-rows")).toHaveCount(0);
});

test("the table area: outside it is ignored, and its edge is the picture's edge", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await start(page);
  const feed = page.getByTestId("stock-intake-feed");
  await page.getByTestId("stock-intake-zone").click();
  const video = await feed.locator("video").boundingBox();
  if (!video) throw new Error("no video");
  await page.mouse.move(video.x + video.width * 0.3, video.y + video.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(video.x + video.width * 0.75, video.y + video.height * 0.8, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/flows-zone.png` });

  const reads = (await state()).calls.vision.length;
  await put(page, "outside", 60, 300);
  await page.waitForTimeout(2200);
  expect((await state()).calls.vision.length).toBe(reads);
  await expect(page.getByTestId("stock-intake-on-table")).toHaveText("0");
  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "inside", 620, 300);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
});

test("a camera knocked out: says so, stops counting, comes back paused", async ({ page }) => {
  test.setTimeout(60_000);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await page.evaluate(() => (window as unknown as { __table: { knockOut: () => void } }).__table.knockOut());
  await expect(page.getByTestId("stock-intake-status")).toHaveText(/Camera lost|Starting|Paused/);
  await expect(page.getByTestId("stock-intake-resume")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("stock-intake-resume").click();
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-running", "true");
});
