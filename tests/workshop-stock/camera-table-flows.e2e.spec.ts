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
/** The browser's speech recogniser, with `say` standing in for the microphone. */
async function fakeSpeech(page: Page, opts: { refuse?: string } = {}) {
  await page.addInitScript((refuse) => {
    class Fake {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        const w = window as unknown as { speechStarts: number; speech: Fake | null };
        w.speechStarts = (w.speechStarts ?? 0) + 1;
        w.speech = this;
        if (refuse) setTimeout(() => { this.onerror?.({ error: refuse }); this.onend?.(); }, 10);
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: Fake, webkitSpeechRecognition: Fake });
  }, opts.refuse ?? "");
}
const hear = (page: Page, text: string, isFinal = true) =>
  page.evaluate(([t, final]) => {
    const s = (window as unknown as { speech: { onresult: (e: unknown) => void } }).speech;
    s.onresult({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: t } }] });
  }, [text, isFinal] as const);

test("talking: the words fill the card, nothing saves until Enter", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSpeech(page);
  await fakeCamera(page);
  await open(page);
  await start(page);

  await page.getByTestId("stock-intake-talk").click();
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stock-intake-heard-hint")).toContainText("Put one down");

  // With nothing open, a name has nowhere to go and the screen says so.
  await hear(page, "iconic switch");
  await expect(page.getByTestId("stock-intake-heard-result")).toHaveText("Nothing is waiting for that. Put one down first.");

  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  const name = page.getByTestId("stock-intake-new-name");
  const amount = page.getByTestId("stock-intake-new-amount");

  // Words on their way show up, and change nothing yet.
  const before = await name.inputValue();
  await hear(page, "clips all", false);
  await expect(page.getByTestId("stock-intake-heard")).toContainText("clips all");
  await expect(name).toHaveValue(before);

  // Misheard, scratched, said again over a pause.
  await hear(page, "clips all iconic forty rack 9 shelf C bin 2");
  await expect(name).toHaveValue("Clips all iconic");
  await expect(amount).toHaveValue("40");
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("Rack 9 Shelf C, Bin 2");
  await hear(page, "scratch that");
  await expect(name).toHaveValue(before);
  await expect(amount).toHaveValue("1");
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("");
  await hear(page, "Clipsal Iconic");
  await hear(page, "single switch");
  await hear(page, "fifteen");
  await expect(name).toHaveValue("Clipsal Iconic single switch");
  await expect(amount).toHaveValue("15");
  await page.waitForTimeout(600);
  expect((await state()).items).toHaveLength(0);

  // Enter is what puts it on the record, even straight after pressing Talk with the mouse.
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  expect(await balance(/Clipsal Iconic single switch/)).toBe(15_000);
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "true");

  // A number straight after it logs opens that amount, and only Enter changes it.
  await hear(page, "twenty");
  await expect(page.getByTestId("stock-intake-row-edit-input")).toHaveValue("20");
  await page.waitForTimeout(400);
  expect(await balance(/Clipsal Iconic single switch/)).toBe(15_000);
  await page.keyboard.press("Enter");
  await expect.poll(() => balance(/Clipsal Iconic single switch/), { timeout: 15_000 }).toBe(20_000);

  // A recogniser stops by itself after a silence: still listening, on a new one.
  const started = await page.evaluate(() => (window as unknown as { speechStarts: number }).speechStarts);
  await page.waitForTimeout(1100);
  await page.evaluate(() => (window as unknown as { speech: { onend: () => void } }).speech.onend());
  await expect.poll(() => page.evaluate(() => (window as unknown as { speechStarts: number }).speechStarts)).toBe(started + 1);
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("stock-intake-talk").click();
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("stock-intake-heard")).toHaveCount(0);
});

test("talking: the amount card takes a number, the cursor in Goes to takes the words as they are", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSpeech(page);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await page.getByTestId("stock-intake-talk").click();

  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-location").click();
  await hear(page, "cable bay forty");
  await expect(page.getByTestId("stock-intake-new-location")).toHaveValue("cable bay forty");
  await expect(page.getByTestId("stock-intake-new-amount")).toHaveValue("1");
  await page.getByTestId("stock-intake-ignore").click();
  await expect(card(page)).toHaveCount(0);

  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": "flows-seed-talk" }, body: JSON.stringify({ name: "Cable tie 200mm", brand: "HPM", manufacturerCode: "CT200", baseUnit: "each", location: "Bin 1", openingQuantity: "1" }) });
  await page.reload();
  await start(page);
  await page.getByTestId("stock-intake-talk").click();
  const pack = product({ brand: "HPM", manufacturerCode: "CT200", description: "Cable tie 200mm", packQuantity: 500, packUnit: "each", labelText: ["CT200", "Pack of 500"] });
  await harness("/__harness/vision", { queue: [reading(pack)] });
  await put(page, "b", 450, 150);
  await expect(page.getByTestId("stock-intake-amount-ask")).toContainText("500", { timeout: 15_000 });
  await hear(page, "cable ties");
  await expect(page.getByTestId("stock-intake-heard-result")).toHaveText("Say how many.");
  await expect(page.getByTestId("stock-intake-amount")).toHaveValue("500");
  await hear(page, "two hundred and fifty");
  await expect(page.getByTestId("stock-intake-amount")).toHaveValue("250");
  await page.screenshot({ path: `${SHOTS}/flows-talk.png` });
  expect(await balance(/Cable tie/)).toBe(1000);
  await page.keyboard.press("Enter");
  await expect.poll(() => balance(/Cable tie/), { timeout: 15_000 }).toBe(251_000);
});

test("talking: hands free, saying add it saves the card, undo takes it back, a number changes the last one", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSpeech(page);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await page.getByTestId("stock-intake-talk").click();

  await harness("/__harness/vision", { queue: [reading(product({})), reading(product({ manufacturerCode: "9999", labelText: ["9999"], description: "Blank plate" }))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-heard-hint")).toContainText("add it");
  await page.screenshot({ path: `${SHOTS}/flows-talk-hint.png` });

  // In one breath, no keyboard.
  await hear(page, "Clipsal Iconic switch forty rack 9 shelf C bin 2 add it");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  expect(await balance(/Clipsal Iconic switch/)).toBe(40_000);
  await expect(page.getByTestId("stock-intake-goes-to")).toHaveText("Rack 9 Shelf C, Bin 2");

  // A number on its own opens the amount; "log it" lands it.
  await hear(page, "fifty");
  await expect(page.getByTestId("stock-intake-row-edit-input")).toHaveValue("50");
  expect(await balance(/Clipsal Iconic switch/)).toBe(40_000);
  await hear(page, "log it");
  await expect.poll(() => balance(/Clipsal Iconic switch/), { timeout: 15_000 }).toBe(50_000);
  await expect(page.getByTestId("stock-intake-row-edit-input")).toHaveCount(0);
  // Both in one go.
  await hear(page, "sixty log it");
  await expect.poll(() => balance(/Clipsal Iconic switch/), { timeout: 15_000 }).toBe(60_000);

  await hear(page, "undo that");
  await expect.poll(() => balance(/Clipsal Iconic switch/), { timeout: 15_000 }).toBe(0);
  await expect(page.getByTestId("stock-intake-row").first()).toHaveAttribute("data-status", "undone");

  // "Add it" with no name says so on the card and saves nothing; "not stock" clears it.
  await put(page, "b", 450, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-name").fill("");
  await page.getByTestId("stock-intake-new-name").blur();
  await hear(page, "add it");
  await expect(card(page)).toContainText("Give it a name.");
  await expect(logged(page)).toHaveText("0");
  await hear(page, "not stock");
  await expect(card(page)).toHaveCount(0);

  await hear(page, "stop listening");
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "false");
});

test("talking: what's said during the label read lands on the card when it opens", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSpeech(page);
  await fakeCamera(page);
  await open(page);
  // The reader's few seconds, which the fixtures otherwise don't have.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/workshop-stock\?action=read/, async (route) => { await held; await route.fallback(); });
  await start(page);
  await page.getByTestId("stock-intake-talk").click();

  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(page.getByTestId("stock-intake-working")).toHaveText("1", { timeout: 15_000 });
  await expect(card(page)).toHaveCount(0);
  await hear(page, "Clipsal Iconic");
  await expect(page.getByTestId("stock-intake-heard-result")).toContainText("when the label");
  await hear(page, "switch fifteen");
  release();
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue("Clipsal Iconic switch");
  await expect(page.getByTestId("stock-intake-new-amount")).toHaveValue("15");
  await page.waitForTimeout(400);
  expect((await state()).items).toHaveLength(0);
  await hear(page, "done");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  expect(await balance(/Clipsal Iconic switch/)).toBe(15_000);
});

test("talking: a list on the card is picked by its number, and a bare number doesn't pick", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeSpeech(page);
  await fakeCamera(page);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  const seed = (name: string, code: string) => fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": `flows-seed-${code}` }, body: JSON.stringify({ name, brand: "Clipsal", baseUnit: "each", manufacturerCode: code, location: "Bin 1", openingQuantity: "1" }) });
  await seed("Iconic 1 gang switch white", "AA1");
  await seed("Iconic 1 gang switch black", "AA2");
  await seed("Saturn dimmer", "AA3");
  await open(page);
  await start(page);
  await page.getByTestId("stock-intake-talk").click();

  await harness("/__harness/vision", { queue: [reading(product({ manufacturerCode: null, labelText: [], description: "Iconic 1 gang switch" }))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "pick", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-heard-hint")).toContainText("number 1");
  const choices = await page.getByTestId("stock-intake-choice").count();
  expect(choices).toBeGreaterThan(0);

  await hear(page, "two");
  await expect(page.getByTestId("stock-intake-heard-result")).toContainText("number 2");
  await expect(card(page)).toHaveAttribute("data-status", "pick");
  await hear(page, "number nine");
  await expect(page.getByTestId("stock-intake-heard-result")).toContainText("no number 9");

  // Search results carry on the card's numbering.
  await hear(page, "saturn");
  await expect(page.getByTestId("stock-intake-search-result")).toContainText(`${choices + 1}Saturn dimmer`);
  await hear(page, `number ${choices + 1}`);
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  await expect.poll(() => balance(/Saturn dimmer/), { timeout: 15_000 }).toBe(2000);
});

test("talking: a blocked microphone says so and stops", async ({ page }) => {
  await fakeSpeech(page, { refuse: "not-allowed" });
  await fakeCamera(page);
  await open(page);
  await page.getByTestId("stock-intake-talk").click();
  await expect(page.getByTestId("stock-intake-talk-problem")).toContainText("blocked the microphone");
  await expect(page.getByTestId("stock-intake-talk")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => (window as unknown as { speechStarts: number }).speechStarts)).toBe(1);
});

test("talking: no speech recognition in this browser, no button", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined });
    Object.defineProperty(window, "SpeechRecognition", { value: undefined });
  });
  await fakeCamera(page);
  await open(page);
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-camera", "live");
  await expect(page.getByTestId("stock-intake-talk")).toHaveCount(0);
});

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
  await page.keyboard.press("Escape");
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

test("a scan with the cursor in a field saves nothing there, and two new barcodes stay two cards", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled();
  const realScan = async (code: string) => {
    await page.keyboard.type(code);
    await page.keyboard.press("Enter");
  };

  await realScan("9300000000033");
  await page.getByTestId("stock-intake-new-name").fill("First thing");
  await realScan("9300000000040");
  await expect(page.getByTestId("stock-intake-queued")).toHaveCount(1);
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue("First thing");
  await expect(logged(page)).toHaveText("0");

  // A code with letters isn't a stock barcode: refused, whole, and out of the field.
  await realScan("ABC123456");
  await expect(page.getByText("ABC123456 isn't a barcode")).toBeVisible();
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue("First thing");

  // A person's Enter still saves, and the first barcode stayed with the first thing.
  await page.getByTestId("stock-intake-new-name").press("Enter");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  await expect(card(page)).toHaveAttribute("data-status", "new");
  await page.getByTestId("stock-intake-new-name").fill("Second thing");
  await page.getByTestId("stock-intake-new-name").press("Enter");
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });

  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await scan(page, "9300000000033");
  await expect(logged(page)).toHaveText("3", { timeout: 15_000 });
  expect(await balance(/First thing/)).toBe(2000);
  expect(await balance(/Second thing/)).toBe(1000);
});

test("the first-session routine: type how many, Enter; a count replaces, never adds to the 1", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await start(page);

  // A new product with a good read: nothing to click.
  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  // Starts with the 1 already in the box.
  await page.keyboard.type("15", { delay: 90 });
  await expect(page.getByTestId("stock-intake-new-amount")).toHaveValue("15");
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  expect(await balance(/Iconic/)).toBe(15_000);

  // Clicking the box and typing replaces too.
  await harness("/__harness/vision", { queue: [reading(product({ manufacturerCode: "2000", description: "GPO double", labelText: ["2000"] }))] });
  await put(page, "b", 450, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await page.getByTestId("stock-intake-new-amount").click();
  await page.keyboard.type("25");
  await expect(page.getByTestId("stock-intake-new-amount")).toHaveValue("25");
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  expect(await balance(/GPO/)).toBe(25_000);
  await expect(page.getByTestId("stock-intake-new-name")).toHaveCount(0);

  // A known item: a number straight after it logs changes that amount.
  await page.keyboard.type("12", { delay: 90 });
  await expect(page.getByTestId("stock-intake-row-edit-input")).toHaveValue("12");
  await page.keyboard.press("Enter");
  await expect.poll(() => balance(/GPO/), { timeout: 15_000 }).toBe(12_000);

  // The pencil replaces as well.
  await page.getByTestId("stock-intake-row-edit").first().click();
  await page.keyboard.type("30");
  await expect(page.getByTestId("stock-intake-row-edit-input")).toHaveValue("30");
  await page.keyboard.press("Escape");
});

test("a scanned new item: the cursor is ready for its name, and typing never runs a shortcut", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  await fetch(`${API}/api/workshop-stock?action=create`, { method: "POST", headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": "flows-seed-4" }, body: JSON.stringify({ name: "RCBO 20A", brand: "Clipsal", barcode: "9300000000026", baseUnit: "each", location: "Bin 2", openingQuantity: "1" }) });
  await open(page);
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled();
  await expect(page.getByTestId("stock-intake-scanner-tip")).toBeVisible();
  await scan(page, "9300000000026");
  await expect(logged(page)).toHaveText("1");

  await scan(page, "9300000000033");
  await expect(page.getByTestId("stock-intake-new-name")).toBeFocused();
  await expect(page.getByTestId("stock-intake-read-again")).toHaveCount(0);
  // F, U and X would be full screen, undo and ignore.
  await page.keyboard.type("Fuxe", { delay: 90 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("7");
  await page.keyboard.press("Enter");
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  expect(await balance(/Fuxe/)).toBe(7000);
  expect(await balance(/RCBO/)).toBe(2000);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  // A new card with a name read: letters still go to the name.
  await harness("/__harness/vision", { queue: [reading(product({}))] });
  await start(page);
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await expect(page.getByTestId("stock-intake-new-name")).not.toBeFocused();
  await page.keyboard.type("ux", { delay: 90 });
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue(/ux$/);
  await expect(logged(page)).toHaveText("2");
  await expect(waiting(page)).toHaveText("1");
});

test("a reload keeps what's waiting, with what was typed", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled();
  await scan(page, "9300000000033");
  await page.getByTestId("stock-intake-new-name").fill("Typed name");
  await scan(page, "9300000000040");
  await expect(waiting(page)).toHaveText("2");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId("stock-intake-start")).toBeEnabled({ timeout: 20_000 });
  await expect(waiting(page)).toHaveText("2");
  await expect(page.getByTestId("stock-intake-new-name")).toHaveValue("Typed name");

  // Numbers carry on from before the reload, and the barcode went with the card.
  await scan(page, "9300000000057");
  await expect(waiting(page)).toHaveText("3");
  await page.getByTestId("stock-intake-new-name").press("Enter");
  await expect(logged(page)).toHaveText("1", { timeout: 15_000 });
  await scan(page, "9300000000033");
  await expect(logged(page)).toHaveText("2", { timeout: 15_000 });
  expect(await balance(/Typed name/)).toBe(2000);
});

test("scanning what's already waiting on the table doesn't name the next thing placed", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeCamera(page);
  await open(page);
  await start(page);
  await harness("/__harness/vision", { queue: [reading(product({ barcode: "9300000000057" }))] });
  await put(page, "a", 100, 150);
  await expect(card(page)).toHaveAttribute("data-status", "new", { timeout: 15_000 });
  await scan(page, "9300000000057");
  await expect(page.getByText(/already waiting/)).toBeVisible();
  await expect(page.getByTestId("stock-intake-next-scan")).toHaveCount(0);
  await expect(waiting(page)).toHaveText("1");
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

test("?evidence=1 records a clip of what the webcam sends, and saves it to this computer", async ({ page }) => {
  await fakeCamera(page);
  await open(page, "/stock/intake?evidence=1");
  await expect(page.getByTestId("stock-intake-feed")).toHaveAttribute("data-camera", "live");
  const button = page.getByTestId("stock-intake-clip");
  await button.click();
  await expect(button).toHaveText("Stop and save clip");
  await page.waitForTimeout(1500);
  const saved = page.waitForEvent("download");
  await button.click();
  const file = await saved;
  expect(file.suggestedFilename()).toMatch(/^camera-table-clip-.*\.webm$/);
  const { statSync } = await import("node:fs");
  expect(statSync(await file.path()).size).toBeGreaterThan(1000);
  await expect(button).toHaveText("Record clip");
});

test("three things appearing at once with no hand: the picture is jumping, nothing counts", async ({ page }) => {
  await fakeCamera(page);
  await open(page);
  await start(page);
  await page.waitForTimeout(600);
  await Promise.all([
    table(page, "put", "a", 200, 200, 120, 120, "#d8c9a8"),
    table(page, "put", "b", 600, 200, 120, 120, "#d8c9a8"),
    table(page, "put", "c", 1000, 200, 120, 120, "#d8c9a8"),
  ]);
  await expect(page.getByTestId("stock-intake-unsteady")).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(page.getByTestId("stock-intake-unsteady")).toBeHidden();
  await expect(logged(page)).toHaveText("0");
  await expect(waiting(page)).toHaveText("0");
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
