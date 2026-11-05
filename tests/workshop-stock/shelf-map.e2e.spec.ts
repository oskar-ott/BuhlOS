import { expect, test, type Page } from "@playwright/test";

/**
 * The shelf map and the bin picker, end to end against the LOCAL harness
 * (docs/workshop-stock.md → "Testing"): real pages, real handler, real local
 * Postgres. Skipped unless WORKSHOP_STOCK_E2E_API points at the harness.
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
test.describe.configure({ mode: "serial" });

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
  await expect(page.getByRole("region", { name: `Rack ${name.toUpperCase()}` })).toBeVisible();
}

test.beforeAll(async () => {
  await harness("/__harness/reset", {});
});

test.describe("the office", () => {
  test.use({ viewport: { width: 1440, height: 1100 } });

  test("logging fills the bin from a rule; the rest is suggested or picked; the map shows it all", async ({ page }) => {
    await open(page, "office");
    await page.goto("/stock/locations");
    await addRack(page, "1");
    await addRack(page, "3");
    await page.getByRole("button", { name: /Rack 3 Shelf B, Bin 4/ }).click();
    await page.getByTestId("stock-matrix-words").fill("iconic switches");
    await page.getByTestId("stock-matrix-words-add").click();
    await expect(page.getByRole("button", { name: /Rack 3 Shelf B, Bin 4: iconic switches/ })).toBeVisible();

    await page.goto("/stock");
    // A rule fills it in, and follows the name as it's typed.
    await page.getByTestId("stock-admin-add").click();
    await page.getByTestId("stock-new-name").fill("Iconic switch 1 gang");
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 3 Shelf B, Bin 4");
    await page.getByTestId("stock-new-name").fill("Junction box");
    await expect(page.getByTestId("stock-new-location")).toHaveValue("");
    await page.getByTestId("stock-new-name").fill("Iconic switch 1 gang");
    await page.getByTestId("stock-new-save").click();
    await expect.poll(() => locationOf(/Iconic switch 1 gang/), { timeout: 20_000 }).toBe("Rack 3 Shelf B, Bin 4");
    await page.goto("/stock");

    // No rule: a suggestion, one tap. It doesn't fill the field by itself.
    await page.getByTestId("stock-admin-add").click();
    await page.getByTestId("stock-new-name").fill("Junction box");
    await expect(page.getByTestId("stock-new-location")).toHaveValue("");
    await expect(page.getByTestId("stock-new-location-suggestion")).toContainText("Rack 1 Shelf A, Bin 1");
    await page.getByTestId("stock-new-location-suggestion").click();
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 1 Shelf A, Bin 1");
    // Rack, shelf, bin by tapping changes it; a rack alone doesn't.
    await page.getByTestId("stock-bin-picker-rack").filter({ hasText: "Rack 3" }).click();
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 1 Shelf A, Bin 1");
    await page.getByTestId("stock-bin-picker-shelf").filter({ hasText: "Shelf C" }).click();
    await page.getByTestId("stock-bin-picker-bin").filter({ hasText: "Bin 2" }).click();
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 3 Shelf C, Bin 2");
    await page.screenshot({ path: `${SHOTS}/shelf-map-add-form.png` });
    await page.getByTestId("stock-new-save").click();
    await expect.poll(() => locationOf(/Junction box/), { timeout: 20_000 }).toBe("Rack 3 Shelf C, Bin 2");
    await page.goto("/stock");

    // Typing still works, and a typed location is never overwritten.
    await page.getByTestId("stock-admin-add").click();
    await page.getByTestId("stock-new-location").fill("Under the bench");
    await page.getByTestId("stock-new-name").fill("Iconic switches, old box");
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Under the bench");
    await page.getByTestId("stock-new-save").click();
    await expect.poll(() => locationOf(/old box/), { timeout: 20_000 }).toBe("Under the bench");

    await page.goto("/stock/locations");
    await expect(page.getByRole("button", { name: /Rack 3 Shelf B, Bin 4: iconic switches; holds Iconic switch 1 gang/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Rack 3 Shelf C, Bin 2: nothing set; holds Junction box/ })).toBeVisible();
    await expect(page.getByTestId("stock-matrix-used")).toHaveText("2 in use");
    await expect(page.getByTestId("stock-matrix-issue-count")).toHaveText("1 needs a place");
    await page.screenshot({ path: `${SHOTS}/shelf-map.png`, fullPage: true });

    // Nothing moved until the tap; then the rule's bin takes it.
    const issue = page.getByTestId("stock-matrix-issue");
    await expect(issue).toContainText("“Under the bench” isn't a bin on the map");
    await expect(issue).toContainText("Rack 3 Shelf B, Bin 4");
    expect(await locationOf(/old box/)).toBe("Under the bench");
    await issue.getByTestId("stock-matrix-issue-put").click();
    await expect(page.getByTestId("stock-matrix-issue")).toHaveCount(0);
    expect(await locationOf(/old box/)).toBe("Rack 3 Shelf B, Bin 4");

    // Open a bin, see what's in it, move one thing to another bin.
    await page.getByRole("button", { name: /Rack 3 Shelf C, Bin 2/ }).click();
    await expect(page.getByTestId("stock-matrix-bin-stock")).toContainText("Junction box");
    await page.getByTestId("stock-matrix-bin-move").click();
    await expect(page.getByTestId("stock-matrix-moving")).toContainText("Junction box");
    await page.getByRole("button", { name: /Rack 1 Shelf D, Bin 6/ }).click();
    await expect(page.getByRole("button", { name: /Rack 1 Shelf D, Bin 6: nothing set; holds Junction box/ })).toBeVisible();
    expect(await locationOf(/Junction box/)).toBe("Rack 1 Shelf D, Bin 6");

    // Survives a reload, from the server.
    await page.reload();
    await expect(page.getByRole("button", { name: /Rack 1 Shelf D, Bin 6: nothing set; holds Junction box/ })).toBeVisible();
  });

  test("a label with no rule is told where it would go", async ({ page }) => {
    await open(page, "office");
    await page.goto("/stock/locations");
    await page.getByTestId("stock-matrix-try").fill("Mystery widget");
    await expect(page.getByTestId("stock-matrix-try-result")).toContainText("No rule fits. Suggested:");
    await expect(page.getByTestId("stock-matrix-try-result")).toContainText("First free bin");
  });
});

test.describe("the crew, on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("reads the matrix and picks a bin, but can't change it", async ({ page }) => {
    await open(page, "worker");
    await page.goto("/phil/stock", { timeout: 120_000 });
    await page.getByTestId("stock-add-button").click();
    await page.getByTestId("stock-add-manual").click();
    await page.getByTestId("stock-new-name").fill("Iconic switch 2 gang");
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 3 Shelf B, Bin 4");
    await page.getByTestId("stock-bin-picker-bin").filter({ hasText: "Bin 5" }).click();
    await expect(page.getByTestId("stock-new-location")).toHaveValue("Rack 3 Shelf B, Bin 5");
    await page.getByTestId("stock-new-location").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/shelf-map-phone.png` });
    const refused = await page.evaluate(async () => (await fetch("/api/workshop-stock?action=location-matrix", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, racks: [], rules: [] }) })).status);
    expect(refused).toBe(403);
  });
});
