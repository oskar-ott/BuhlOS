import { expect, test, type Page } from "@playwright/test";

/**
 * The recommended layout, end to end against the LOCAL harness (docs/workshop-stock.md
 * → "Testing"): real pages, real handler, real local Postgres. Skipped unless
 * WORKSHOP_STOCK_E2E_API points at the harness.
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1100 } });

type State = { items: Array<{ id: string; name: string; location: string | null }> };

async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}
const locationOf = async (name: RegExp) => (await harness<State>("/__harness/state")).items.find((i) => name.test(i.name))?.location;

async function open(page: Page, who: string) {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  await page.context().addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
  await page.route(/\/api\/workshop-stock(\?|$)/, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${API}${u.pathname}${u.search}`, timeout: 60_000 }) });
  });
}

async function addRack(page: Page, name: string) {
  await page.getByTestId("stock-matrix-rack-name").fill(name);
  await page.getByTestId("stock-matrix-rack-add").click();
  await expect(page.getByRole("region", { name: `Rack ${name.toUpperCase()}`, exact: true })).toBeVisible();
}

async function addItem(page: Page, name: string) {
  await page.goto("/stock");
  await page.getByTestId("stock-admin-add").click();
  await page.getByTestId("stock-new-name").fill(name);
  await page.getByTestId("stock-new-location").fill("Under the bench");
  await page.getByTestId("stock-new-save").click();
  await expect.poll(async () => (await harness<State>("/__harness/state")).items.some((i) => i.name === name), { timeout: 20_000 }).toBe(true);
}

test.beforeAll(async () => {
  await harness("/__harness/reset", {});
});

test("recommends a layout, saves it as rules, moves stock only on a tap, and can be undone", async ({ page }) => {
  await open(page, "office");
  await page.goto("/stock/locations");
  await addRack(page, "a");

  // With no stock yet it still lays out the racks, and says when they're short of bins.
  await page.getByTestId("stock-layout-open").click();
  await expect(page.getByTestId("stock-layout-family")).toHaveCount(8);
  await expect(page.getByTestId("stock-layout-shared")).toBeVisible();
  await page.getByTestId("stock-layout").screenshot({ path: `${SHOTS}/layout-plan-empty-one-rack.png` });
  await addRack(page, "b");
  await addRack(page, "c");
  await expect(page.getByTestId("stock-layout-shared")).toHaveCount(0);
  await page.getByTestId("stock-layout").screenshot({ path: `${SHOTS}/layout-plan-empty-three-racks.png` });
  await page.getByTestId("stock-layout-close").click();
  for (const name of ["Rack C", "Rack B"]) await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(page.getByTestId("stock-matrix-rack")).toHaveCount(1);

  await addItem(page, "Iconic switch 1 gang");
  await addItem(page, "Iconic GPO double");
  await addItem(page, "Cat6 patch lead 1m");
  await addItem(page, "Cat6 data jack");
  await addItem(page, "Mystery widget");

  await page.goto("/stock/locations");
  await page.getByTestId("stock-layout-open").click();

  // Shown on the racks first; nothing saved yet.
  await expect(page.getByTestId("stock-layout-family").first()).toContainText("Switches & GPOs");
  const binOf = (label: string) => page.getByRole("img", { name: new RegExp(`^Rack A Shelf 1, Bin \\d+: ${label}$`) });
  await expect(binOf("Switches")).toHaveAccessibleName("Rack A Shelf 1, Bin 1: Switches");
  await expect(binOf("GPOs")).toHaveAccessibleName("Rack A Shelf 1, Bin 2: GPOs");
  await expect(binOf("Data jacks")).toBeVisible();
  await expect(binOf("Patch leads")).toBeVisible();
  await expect(page.getByTestId("stock-layout-summary")).toContainText("4 items to move");
  await page.getByTestId("stock-layout").screenshot({ path: `${SHOTS}/layout-plan.png` });
  await page.getByTestId("stock-layout-unsorted").locator("summary").click();
  await expect(page.getByTestId("stock-layout-unsorted")).toContainText("Mystery widget");
  await page.getByTestId("stock-layout-moves").locator("summary").click();
  await expect(page.getByTestId("stock-layout-moves")).toContainText("Under the bench");
  expect(await locationOf(/Iconic GPO/)).toBe("Under the bench");

  await page.getByTestId("stock-layout-use").click();
  await expect(page.getByTestId("stock-layout-saved")).toContainText("4 items to move are listed under Needs a place");

  // Saved as ordinary rules on the real grid. Recorded stock hasn't moved.
  await expect(page.getByRole("button", { name: /Rack A Shelf 1, Bin 2: gpo; no stock/ })).toBeVisible();
  expect(await locationOf(/Iconic GPO/)).toBe("Under the bench");

  // One tap under Needs a place takes it there.
  const gpo = page.getByTestId("stock-matrix-issue").filter({ hasText: "Iconic GPO" });
  await expect(gpo).toContainText("Rack A Shelf 1, Bin 2");
  await gpo.getByTestId("stock-matrix-issue-put").click();
  await expect(page.getByRole("button", { name: /Rack A Shelf 1, Bin 2: gpo; holds Iconic GPO double/ })).toBeVisible();
  expect(await locationOf(/Iconic GPO/)).toBe("Rack A Shelf 1, Bin 2");

  // Undo puts the rules back, and leaves what moved where it is.
  await page.getByTestId("stock-layout-undo").click();
  await expect(page.getByRole("button", { name: /Rack A Shelf 1, Bin 2: nothing set; holds Iconic GPO double/ })).toBeVisible();

  // New stock goes by the saved rules.
  await page.getByTestId("stock-layout-open").click();
  await page.getByTestId("stock-layout-use").click();
  await expect(page.getByTestId("stock-layout-saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("stock-matrix")).toBeVisible();
  await page.goto("/stock");
  await page.getByTestId("stock-admin-add").click();
  await page.getByTestId("stock-new-name").fill("Saturn power point");
  await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack A Shelf 1, Bin 2");

  // Asked again, there's nothing new.
  await page.goto("/stock/locations");
  await page.getByTestId("stock-layout-open").click();
  await expect(page.getByTestId("stock-layout-nothing")).toBeVisible();
  await expect(page.getByTestId("stock-layout-use")).toHaveCount(0);
});
