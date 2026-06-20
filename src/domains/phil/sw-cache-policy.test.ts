import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { overflowCount, shouldCachePhilPage } from "./sw-cache-policy";

const ORIGIN = "https://buhlos.com";

function decision(over: Partial<Parameters<typeof shouldCachePhilPage>[0]> = {}) {
  return shouldCachePhilPage({
    requestPath: "/phil/my-day",
    responseUrl: `${ORIGIN}/phil/my-day`,
    origin: ORIGIN,
    ok: true,
    redirected: false,
    ...over,
  });
}

describe("shouldCachePhilPage (#575 P1b)", () => {
  it("caches a successful, non-redirected, same-origin, same-path Phil page", () => {
    expect(decision()).toBe(true);
    expect(
      shouldCachePhilPage({
        requestPath: "/phil/jobs/job-123",
        responseUrl: `${ORIGIN}/phil/jobs/job-123`,
        origin: ORIGIN,
        ok: true,
        redirected: false,
      }),
    ).toBe(true);
  });

  it("REFUSES an auth redirect to /v2/login (the core leak)", () => {
    // Both signals are present on a followed middleware redirect; either alone
    // must block caching the login page under /phil/my-day.
    expect(
      shouldCachePhilPage({
        requestPath: "/phil/my-day",
        responseUrl: `${ORIGIN}/v2/login?next=/phil/my-day`,
        origin: ORIGIN,
        ok: true,
        redirected: true,
      }),
    ).toBe(false);
    // Belt-and-suspenders: even if some proxy left `redirected` false, the
    // final pathname differs, so it's still refused.
    expect(decision({ responseUrl: `${ORIGIN}/v2/login`, redirected: false })).toBe(false);
  });

  it("refuses a redirect that lands on the SAME path (redirected flag alone blocks it)", () => {
    expect(decision({ redirected: true })).toBe(false);
  });

  it("refuses a non-2xx response", () => {
    expect(decision({ ok: false })).toBe(false);
  });

  it("refuses a cross-origin final URL", () => {
    expect(decision({ responseUrl: "https://evil.example/phil/my-day" })).toBe(false);
  });

  it("refuses an unparseable response URL", () => {
    expect(decision({ responseUrl: "not a url" })).toBe(false);
  });
});

describe("overflowCount (#575 P2 FIFO bound)", () => {
  it("returns 0 when within bounds", () => {
    expect(overflowCount(40, 40)).toBe(0);
    expect(overflowCount(10, 40)).toBe(0);
  });

  it("returns how many oldest entries to evict past max", () => {
    expect(overflowCount(41, 40)).toBe(1);
    expect(overflowCount(125, 120)).toBe(5);
  });

  it("treats a non-positive max as evict-all", () => {
    expect(overflowCount(3, 0)).toBe(3);
  });
});

/**
 * Drift + regression guard: public/sw.js transcribes the policy above (a plain
 * SW script can't import this module). Assert the load-bearing tokens are still
 * present so a future edit can't silently drop a #575 fix. check-sw-cache-version
 * separately enforces that any sw.js edit bumps SW_VERSION.
 */
describe("public/sw.js carries the #575 guards", () => {
  const sw = readFileSync(
    fileURLToPath(new URL("../../../public/sw.js", import.meta.url)),
    "utf8",
  );

  it("gates Phil page caching on the redirect/same-path predicate (P1b)", () => {
    expect(sw).toContain("function shouldCachePhilPage");
    expect(sw).toContain("response.redirected");
    expect(sw).toContain("finalUrl.pathname === requestUrl.pathname");
    expect(sw).toContain("if (isPhil && shouldCachePhilPage(url, response))");
  });

  it("bounds BOTH runtime caches (P2)", () => {
    expect(sw).toContain("PAGE_CACHE_MAX");
    expect(sw).toContain("ASSET_CACHE_MAX");
    expect(sw).toContain("trimCache(ASSET_CACHE, ASSET_CACHE_MAX)");
  });

  it("keeps the SW_VERSION bumped past the pre-fix v11", () => {
    const ver = (sw.match(/const SW_VERSION = '([^']+)'/) || [])[1];
    expect(ver).toBeTruthy();
    expect(ver).not.toBe("buhl-sw-v11");
  });

  it("preserves the push + notificationclick handlers", () => {
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("showNotification");
  });
});
