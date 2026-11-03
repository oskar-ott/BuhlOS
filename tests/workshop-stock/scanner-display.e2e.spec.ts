import { expect, test, type Page } from "@playwright/test";

/**
 * The scanner display (/stock/scan), end to end against the LOCAL harness
 * (docs/workshop-stock.md → "Testing"): real page, real handler, real local
 * Postgres. The USB scanner is the keyboard, typing a code a few ms a key and
 * pressing Enter, the way a real one does. A real scanner is NOT proven here.
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
};

async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}
const itemNamed = async (re: RegExp) => {
  const s = await harness<State>("/__harness/state");
  const item = s.items.find((i) => re.test(i.name));
  if (!item) throw new Error(`no item matching ${re}`);
  return { item, movements: s.movements.filter((m) => m.item_id === item.id) };
};

async function open(page: Page) {
  const s = await harness<{ name: string; value: string }>("/__harness/session?as=office");
  await page.context().addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
  });
}

/** What a USB scanner does: the code's keys a few ms apart, then Enter. */
async function scan(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press("Enter");
}

const GPO_BARCODE = "4006381333931";
const logged = (page: Page) => page.getByTestId("stock-scan-logged");
const waiting = (page: Page) => page.getByTestId("stock-scan-waiting");

test.beforeAll(async () => {
  await harness("/__harness/reset", {});
});

test("the scanner display: a new code, then the same code logs by itself", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  await open(page);
  await page.goto("/stock");
  await page.getByTestId("stock-open-scan").click();
  await expect(page).toHaveURL(/\/stock\/scan$/);
  await expect(page.getByTestId("stock-scan-status")).toHaveAttribute("data-listening", "ready");
  await expect(page.getByTestId("stock-scan-howto")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/scanner-ready.png` });

  // Not on the list yet: one card, the barcode kept.
  await scan(page, GPO_BARCODE);
  const card = page.getByTestId("stock-intake-card");
  await expect(card).toHaveAttribute("data-status", "new");
  await expect(card.getByTestId("stock-intake-card-barcode")).toContainText(GPO_BARCODE);
  await expect(card.getByTestId("stock-intake-read-again")).toHaveCount(0);
  await expect(page.getByTestId("stock-scan-last")).toHaveAttribute("data-status", "new");
  await expect(waiting(page)).toHaveText("1");

  // Typing in the card's field: the status says a scan would go there.
  await card.getByTestId("stock-intake-new-name").fill("Scanner test GPO");
  await expect(page.getByTestId("stock-scan-status")).toHaveAttribute("data-listening", "field");
  await card.getByTestId("stock-intake-new-location").fill("Rack A Shelf 1, Bin 2");
  await card.getByTestId("stock-intake-new-save").click();
  await expect(logged(page)).toHaveText("1");
  await expect(waiting(page)).toHaveText("0");
  await expect(page.getByTestId("stock-scan-goes-to")).toHaveText("Rack A Shelf 1, Bin 2");

  // Click off the field: ready again, and the same barcode now logs by itself.
  await page.getByTestId("stock-scan-readout").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("stock-scan-status")).toHaveAttribute("data-listening", "ready");
  await scan(page, GPO_BARCODE);
  await expect(logged(page)).toHaveText("2");
  await expect(page.getByTestId("stock-scan-last")).toHaveAttribute("data-status", "logged");
  await expect(page.getByTestId("stock-scan-last-name")).toHaveText("Scanner test GPO");
  await expect(page.getByTestId("stock-scan-last-amount")).toHaveText("+1");
  await expect(page.getByTestId("stock-scan-by-item")).toContainText("+2");
  await page.screenshot({ path: `${SHOTS}/scanner-logged.png` });
  let { item, movements } = await itemNamed(/Scanner test GPO/);
  expect(item.balance_milli).toBe(2000);
  expect(movements.map((m) => m.kind).sort()).toEqual(["add", "opening"]);

  // U takes back the last one only; a scan with a U in it never does.
  await page.keyboard.press("u");
  await expect(page.getByTestId("stock-scan-rows").getByTestId("stock-intake-row").first()).toHaveAttribute("data-status", "undone");
  ({ item } = await itemNamed(/Scanner test GPO/));
  expect(item.balance_milli).toBe(1000);

  // A code that isn't a product barcode asks for a search.
  await scan(page, "BUHL-TOOL-0042");
  await expect(page.getByTestId("stock-intake-card")).toHaveAttribute("data-status", "problem");
  await expect(page.getByTestId("stock-intake-card")).toContainText("isn't a product barcode");
  await expect(page.getByTestId("stock-intake-retry")).toHaveCount(0);
  await page.getByTestId("stock-intake-ignore").click();
  ({ item } = await itemNamed(/Scanner test GPO/));
  expect(item.balance_milli).toBe(1000);

  // Won't scan? Typing the digits does the same.
  await page.getByTestId("stock-scan-manual").fill(GPO_BARCODE);
  await expect(page.getByTestId("stock-scan-status")).toHaveAttribute("data-listening", "ready");
  await page.getByTestId("stock-scan-manual").press("Enter");
  await expect(logged(page)).toHaveText("2");
  ({ item, movements } = await itemNamed(/Scanner test GPO/));
  expect(item.balance_milli).toBe(2000);
  // the new item's opening one, the scan Undo took back (and its reversal), the typed one
  expect(movements.map((m) => m.kind).sort()).toEqual(["add", "add", "opening", "reversal"]);

  expect(problems).toEqual([]);
});
