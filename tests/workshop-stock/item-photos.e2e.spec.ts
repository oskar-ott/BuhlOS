import { deflateSync } from "node:zlib";
import { devices, expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Workshop Stock — more photos of an item (owner pull 2026-11-16: "i want to be
 * able to add multiple photos of items"). Against the LOCAL harness like the
 * other stock specs (docs/workshop-stock.md → "Testing"): the real handler and a
 * local Postgres with 20261116100000 applied; photos are kept in the harness's
 * memory instead of Vercel Blob.
 *
 *   • on the phone, a worker picks three photos at once for an item with none:
 *     the first becomes the main photo, all three show, and swipe through full screen
 *   • in the office, the drawer shows them; the office makes another the main
 *     one and takes one off (asked first)
 */
const API = process.env.WORKSHOP_STOCK_E2E_API ?? "";
const SHOTS = process.env.WORKSHOP_STOCK_E2E_SHOTS ?? "test-results/workshop-stock";

test.skip(!API, "needs the local Workshop Stock harness (docs/workshop-stock.md → Testing)");
test.describe.configure({ mode: "serial" });
if (process.env.WORKSHOP_STOCK_E2E_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.WORKSHOP_STOCK_E2E_CHROMIUM } });

const { defaultBrowserType: _phoneBrowser, ...PHONE } = devices["Pixel 7"];
const DESKTOP = { viewport: { width: 1366, height: 900 } };
const NAME = "Clipsal weatherproof double GPO";

// ── a real image file (PNG), so the phone's resize + the server's sniffing run for real ──
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
function photo(name: string, [r, g, b]: [number, number, number]) {
  const w = 480;
  const h = 360;
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row + 1 + x * 3;
      const label = x > 120 && x < 360 && y > 120 && y < 240;
      raw[o] = label ? 250 : r;
      raw[o + 1] = label ? 250 : g;
      raw[o + 2] = label ? 245 : b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
  return { name: `${name}.png`, mimeType: "image/png", buffer };
}

// ── harness plumbing ─────────────────────────────────────────────────────────
async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
}
async function api(who: "worker" | "office", method: string, query: string, body?: unknown) {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  const r = await fetch(`${API}/api/workshop-stock?${query}`, {
    method,
    headers: { cookie: `${s.name}=${s.value}`, "content-type": "application/json", "idempotency-key": `e2e-photos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
async function signIn(context: BrowserContext, who: "worker" | "office") {
  const s = await harness<{ name: string; value: string }>(`/__harness/session?as=${who}`);
  await context.addCookies([{ name: s.name, value: s.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}
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
  // `next dev` only: its issue badge (the local "readBlob degraded" warning — no Blob store here)
  // sits bottom-left over the viewer's buttons; production has no such overlay.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none !important}";
      document.head.appendChild(s);
    });
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (/\/api\/workshop-stock/.test(r.url()) && r.status() >= 400) problems.push(`api ${r.status()}: ${r.request().method()} ${new URL(r.url()).search}`);
  });
  return problems;
}
const itemNow = async (id: string) => ((await api("office", "GET", `action=item&id=${id}`)).body.item as { photoId: string | null; photos: Array<{ id: string }> });

let itemId = "";

test.describe("more photos of an item", () => {
  test("setup: an item with no photo", async () => {
    await harness("/__harness/reset", {});
    const made = await api("worker", "POST", "action=create", { name: NAME, brand: "Clipsal", baseUnit: "each", location: "Shelf C1", openingQuantity: "3" });
    expect(made.status).toBe(201);
    itemId = (made.body.item as { id: string }).id;
  });

  test.describe("on the phone", () => {
    test.use(PHONE);
    test("a worker picks three photos at once: the first is the main one, all three show and swipe full screen", async ({ page, context }) => {
      test.setTimeout(180_000);
      await signIn(context, "worker");
      const problems = await wire(page);
      await page.goto("/phil/stock", { timeout: 120_000 });
      await expect(page.getByTestId("stock-take-button")).toBeEnabled({ timeout: 60_000 });
      await page.getByTestId("stock-row").filter({ hasText: NAME }).first().click();
      await expect(page.getByTestId("stock-item-photo-add")).toContainText("Add a photo", { timeout: 30_000 });

      await page.getByTestId("stock-item-photo-input").setInputFiles([photo("front", [200, 60, 60]), photo("back", [60, 160, 80]), photo("terminals", [60, 90, 200])]);
      await expect(page.getByTestId("stock-item-photo")).toHaveCount(3, { timeout: 60_000 });
      await expect(page.getByTestId("stock-item-photo-add")).toContainText("Add photos");
      const after = await itemNow(itemId);
      expect(after.photoId).not.toBeNull();
      expect(after.photos).toHaveLength(2);
      await page.screenshot({ path: `${SHOTS}/photos-phone-item-sheet.png` });

      await page.getByTestId("stock-item-photo").nth(1).click();
      const viewer = page.getByTestId("stock-item-photo-viewer");
      await expect(viewer).toBeVisible();
      await expect(page.getByTestId("stock-item-photo-count")).toHaveText("Photo 2 of 3");
      await page.getByTestId("stock-item-photo-next").click();
      await expect(page.getByTestId("stock-item-photo-count")).toHaveText("Photo 3 of 3");
      // the crew don't get remove / make-main
      await expect(page.getByTestId("stock-item-photo-remove")).toHaveCount(0);
      await expect(page.getByTestId("stock-item-photo-main")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/photos-phone-viewer.png` });
      await viewer.getByRole("button", { name: "Close" }).click();
      await expect(viewer).toHaveCount(0);
      expect(problems).toEqual([]);
    });
  });

  test.describe("in the office", () => {
    test.use(DESKTOP);
    test("the office makes another photo the main one and takes one off, asked first", async ({ page, context }) => {
      test.setTimeout(180_000);
      const before = await itemNow(itemId);
      const [second, third] = before.photos.map((p) => p.id);
      await signIn(context, "office");
      const problems = await wire(page);
      await page.goto("/stock", { timeout: 120_000 });
      await page.getByTestId("stock-admin-card").filter({ hasText: NAME }).first().click();
      const drawer = page.getByTestId("stock-drawer");
      await expect(drawer.getByTestId("stock-item-photo")).toHaveCount(3, { timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/photos-office-drawer.png` });

      // the third photo becomes the main one
      await drawer.getByTestId("stock-item-photo").nth(2).click();
      await expect(page.getByTestId("stock-item-photo-count")).toHaveText("Photo 3 of 3");
      await page.screenshot({ path: `${SHOTS}/photos-office-viewer.png` });
      await page.getByTestId("stock-item-photo-main").click();
      await expect(page.getByTestId("stock-item-photo-count")).toHaveText("Photo 1 of 3 · main", { timeout: 20_000 });
      expect((await itemNow(itemId)).photoId).toBe(third);

      // take the second one off: asked first, then gone
      await page.getByTestId("stock-item-photo-next").click();
      await page.getByTestId("stock-item-photo-remove").click();
      await expect(page.getByTestId("stock-item-photo-viewer")).toContainText("Remove this photo?");
      await page.getByTestId("stock-item-photo-remove-confirm").click();
      await expect(page.getByTestId("stock-item-photo-count")).toHaveText(/of 2/, { timeout: 20_000 });
      // main is the third, then the second and the first: the second (photo 2) went
      const now = await itemNow(itemId);
      expect(now.photoId).toBe(third);
      expect(now.photos.map((p) => p.id)).toEqual([before.photoId]);
      expect(now.photos.map((p) => p.id)).not.toContain(second);
      await page.getByTestId("stock-item-photo-viewer").getByRole("button", { name: "Close" }).click();
      await expect(drawer.getByTestId("stock-item-photo")).toHaveCount(2);
      expect(problems).toEqual([]);
    });
  });
});
