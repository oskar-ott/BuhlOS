import { expect, test } from "@playwright/test";
import path from "node:path";
import { loginAsAdmin } from "../helpers/auth";
import { adminCredentials } from "../helpers/testData";

/**
 * Supplier-invoice capture (invoice_capture) — preview smoke.
 *
 *   always:            /invoices is a protected admin route (login redirect).
 *   admin creds:       with the flag OFF for this viewer there is NO trace —
 *                      no nav item, /invoices 404s, the hub shows no card.
 *   SMOKE_INVOICE_CAPTURE=1 (preview with the flag ON for the smoke admin):
 *                      upload a FAKE tax invoice → review → confirm → the job
 *                      figure shows it exactly once → a re-upload is a
 *                      duplicate → exclude it (keeps the preview data tidy).
 *
 * The fixture PDF is generated on the fly (pdf-lib) from fake text — no real
 * supplier data. The job it targets must exist on the preview with code
 * SMOKE_INVOICE_IV (default IV9999).
 */
const FLAG_ON = process.env.SMOKE_INVOICE_CAPTURE === "1";
const IV = process.env.SMOKE_INVOICE_IV ?? "IV9999";

test("unauthenticated users are redirected from /invoices", async ({ page }) => {
  await page.goto("/invoices");
  await expect(page).toHaveURL(/\/v2\/login\?next=%2Finvoices/);
});

test.describe("invoice capture — no trace while disabled", () => {
  test.skip(!adminCredentials() || FLAG_ON, "Needs admin creds and the flag OFF for the smoke admin.");
  test("no nav item, 404 on the route, no hub card, API 404", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole("navigation", { name: "BuhlOS admin" }).getByRole("link", { name: "Invoices" })).toHaveCount(0);
    const res = await page.goto("/invoices");
    expect(res?.status()).toBe(404);
    const api = await page.request.get("/api/invoices");
    expect(api.status()).toBe(404);
    await page.goto("/v2/jobs");
    await expect(page.getByTestId("buhlos-admin-shell")).toBeVisible();
    expect(await page.getByText("Supplier invoices").count()).toBe(0);
  });
});

test.describe("invoice capture — upload → confirm → duplicate", () => {
  test.skip(!adminCredentials() || !FLAG_ON, "Set SMOKE_INVOICE_CAPTURE=1 on a preview where the flag is on for the smoke admin.");

  test("the full office story", async ({ page }) => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const pg = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const stamp = String(Date.now()).slice(-6);
    const lines: Array<[string, number, number]> = [
      ["SMOKE Supplies Pty Ltd", 40, 800], ["TAX INVOICE", 40, 780],
      ["Tax Invoice No:", 40, 760], [`SMK-${stamp}`, 200, 760],
      ["Invoice Date:", 40, 740], ["03/09/2026", 200, 740],
      ["Job Number:", 40, 720], [IV, 200, 720],
      ["Sub Total", 300, 300], ["123.00", 480, 300],
      ["GST", 300, 280], ["12.30", 480, 280],
      ["Total (inc GST)", 300, 260], ["135.30", 480, 260],
    ];
    for (const [t, x, y] of lines) pg.drawText(t, { x, y, size: 11, font });
    const bytes = Buffer.from(await doc.save());

    await loginAsAdmin(page);
    await page.goto("/invoices");
    await expect(page.getByTestId("invoice-inbox")).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("invoice-upload-button").click();
    await (await chooser).setFiles({ name: `SMOKE_TEST_${stamp}.pdf`, mimeType: "application/pdf", buffer: bytes });
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await expect(page.getByTestId("invoice-status")).toContainText("Matched", { timeout: 20_000 });
    await expect(page.getByTestId("invoice-field-number")).toHaveValue(`SMK-${stamp}`);
    await expect(page.getByTestId("invoice-field-iv")).toHaveValue(IV);
    await expect(page.getByTestId("invoice-field-subtotal")).toHaveValue("123.00");
    await expect(page.getByTestId("invoice-match-reason")).toContainText("Exact match");
    const jobHref = await page.getByTestId("invoice-matched-job").getByRole("link").getAttribute("href");

    await page.getByTestId("invoice-confirm").click();
    await expect(page.getByTestId("invoice-status")).toContainText("Confirmed");
    await expect(page.getByTestId("invoice-allocation")).toContainText("$123.00");
    await expect(page.getByTestId("invoice-confirm")).toHaveCount(0);

    // the hub shows the figure exactly once
    await page.goto(jobHref!);
    await expect(page.getByTestId("job-supplier-invoices-card")).toBeVisible();
    await expect(page.getByTestId("supplier-invoices-total")).toContainText("$");

    // same PDF again → duplicate
    await page.goto("/invoices");
    const chooser2 = page.waitForEvent("filechooser");
    await page.getByTestId("invoice-upload-button").click();
    await (await chooser2).setFiles({ name: `SMOKE_TEST_${stamp}_again.pdf`, mimeType: "application/pdf", buffer: bytes });
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await expect(page.getByTestId("invoice-status")).toContainText("Duplicate", { timeout: 20_000 });

    // tidy: exclude the smoke invoice so the preview figure does not accumulate
    await page.goto(new URL(page.url()).pathname.replace(/\/[0-9a-f-]{36}$/, ""));
    await page.getByTestId("invoice-search").fill(`SMK-${stamp}`);
    await page.getByRole("link", { name: "SMOKE Supplies Pty Ltd" }).first().click();
    await page.getByTestId("invoice-exclude").click();
    await page.getByTestId("invoice-exclude-confirm").click();
    await expect(page.getByTestId("invoice-status")).toContainText("Excluded");
    void path;
  });
});
