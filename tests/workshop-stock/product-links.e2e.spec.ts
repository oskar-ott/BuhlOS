import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Workshop Stock — product links (owner pull 2026-11-15: "a link to the product
 * page in an online wholesaler and if available the product spec on the
 * manufacturer's page"). Against the LOCAL harness like the other stock specs
 * (docs/workshop-stock.md → "Testing"): the real handler and a local Postgres
 * with 20261115100000 applied; the web search and the two pages behind 2025WE
 * (clipsal.com, rexel.com.au) are the harness's FIXTURES.
 *
 *   • a worker accepts the online check on a new item → both links are saved
 *     from the pages the check itself found
 *   • the phone's item sheet and the office drawer show them, opening a new tab
 *   • the office replaces the wholesaler link; re-recording the check never
 *     overwrites it
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
test.describe.configure({ mode: "serial" });
if (process.env.WORKSHOP_STOCK_E2E_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.WORKSHOP_STOCK_E2E_CHROMIUM } });

const { defaultBrowserType: _phoneBrowser, ...PHONE } = devices["Pixel 7"];
const DESKTOP = { viewport: { width: 1366, height: 900 } };
const MAKER = "https://www.clipsal.com/products/2025we";
const WHOLESALER = "https://www.rexel.com.au/p/CLI2025WE";
const OURS = "https://www.middys.com.au/clipsal-2025we";

async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}

async function api(who: "worker" | "office", method: string, query: string, body?: unknown) {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  const r = await fetch(`${API}/api/workshop-stock?${query}`, {
    method,
    headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": `e2e-links-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

async function signIn(context: BrowserContext, who: "worker" | "office") {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  await context.addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}

/** The page's /api/workshop-stock calls go to the harness (next dev serves no api/*.js). */
async function wire(page: Page) {
  const problems: string[] = [];
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    try {
      await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
    } catch (e) {
      if (!page.isClosed()) throw e;
    }
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (/\/api\/workshop-stock/.test(r.url()) && r.status() >= 400) problems.push(`api ${r.status()}: ${r.request().method()} ${new URL(r.url()).search}`);
  });
  return problems;
}

let itemId = "";

test.describe("product links", () => {
  test("an accepted online check saves the wholesaler page and the maker's page", async () => {
    await harness("/__harness/reset", {});
    const check = await api("worker", "POST", "action=lookup", { brand: "Clipsal", manufacturerCode: "2025WE" });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ status: expect.stringMatching(/manufacturer_code_matched|possible_match/) });
    const made = await api("worker", "POST", "action=create", {
      name: "Clipsal double power point", brand: "Clipsal", manufacturerCode: "2025WE", baseUnit: "each", location: "Shelf A2", openingQuantity: "6",
      lookupCheck: check.body.check,
    });
    expect(made.status).toBe(201);
    const item = made.body.item as { id: string; productUrl: string | null; specUrl: string | null };
    expect(item.specUrl).toBe(MAKER);
    expect(item.productUrl).toBe(WHOLESALER);
    itemId = item.id;
  });

  test.describe("on the phone", () => {
    test.use(PHONE);
    test("the item sheet shows both links, each opening a new tab", async ({ page, context }) => {
      test.setTimeout(180_000);
      await signIn(context, "worker");
      const problems = await wire(page);
      await page.goto("/phil/stock", { timeout: 120_000 });
      await expect(page.getByTestId("stock-take-button")).toBeEnabled({ timeout: 60_000 });
      await page.getByTestId("stock-row").filter({ hasText: "Clipsal double power point" }).first().click();
      const links = page.getByTestId("stock-product-links");
      await expect(links).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("stock-link-product")).toHaveAttribute("href", WHOLESALER);
      await expect(page.getByTestId("stock-link-product")).toContainText("rexel.com.au");
      await expect(page.getByTestId("stock-link-spec")).toHaveAttribute("href", MAKER);
      await expect(page.getByTestId("stock-link-spec")).toHaveAttribute("target", "_blank");
      const box = await page.getByTestId("stock-link-spec").boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `${SHOTS}/links-phone-item-sheet.png`, fullPage: true });
      expect(problems).toEqual([]);
    });
  });

  test.describe("in the office", () => {
    test.use(DESKTOP);
    test("the drawer shows them; the office replaces the wholesaler link and a re-recorded check keeps it", async ({ page, context }) => {
      test.setTimeout(180_000);
      await signIn(context, "office");
      const problems = await wire(page);
      await page.goto("/stock", { timeout: 120_000 });
      await page.getByTestId("stock-admin-card").filter({ hasText: "Clipsal double power point" }).first().click();
      const drawer = page.getByTestId("stock-drawer");
      await expect(drawer).toBeVisible({ timeout: 30_000 });
      await expect(drawer.getByTestId("stock-link-product")).toHaveAttribute("href", WHOLESALER);
      await expect(drawer.getByTestId("stock-link-spec")).toHaveAttribute("href", MAKER);
      await page.screenshot({ path: `${SHOTS}/links-office-drawer.png` });

      await page.getByTestId("stock-catalogue-toggle").click();
      await expect(page.getByTestId("stock-edit-links")).toBeVisible();
      await expect(page.getByTestId("stock-edit-productUrl")).toHaveValue(WHOLESALER);
      // not a web page → refused, said plainly
      await page.getByTestId("stock-edit-productUrl").fill("javascript:alert(1)");
      await page.getByTestId("stock-edit-save").click();
      await expect(page.getByTestId("stock-edit-form")).toContainText("doesn't look like a web link");
      // pasted without https:// → tidied and saved
      await page.getByTestId("stock-edit-productUrl").fill(OURS.replace("https://", ""));
      await page.getByTestId("stock-edit-save").click();
      await expect(page.getByTestId("stock-edit-form")).toContainText("Saved.", { timeout: 20_000 });
      await expect(drawer.getByTestId("stock-link-product")).toHaveAttribute("href", OURS);
      await page.getByTestId("stock-edit-links").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/links-office-edit.png` });

      // recording the check again never replaces a link the office set
      const r = await api("office", "POST", "action=verify", { itemId });
      expect(r.status).toBe(200);
      expect(r.body.item).toMatchObject({ productUrl: OURS, specUrl: MAKER });
      // one 400 on purpose (the javascript: link)
      expect(problems.filter((p) => !/api 400: PUT/.test(p))).toEqual([]);
    });
  });
});
