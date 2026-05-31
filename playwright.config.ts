import { defineConfig, devices } from "@playwright/test";

/**
 * Preview-friendly Playwright configuration.
 *
 * PLAYWRIGHT_BASE_URL points at a Vercel preview in the manual smoke
 * workflow. Local runs default to next dev. Authenticated specs skip with a
 * clear reason when the matching credentials are absent.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const usesLocalServer = /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(baseURL);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    navigationTimeout: 20_000,
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /playwright\/smoke\/phil\.spec\.ts/,
    },
    {
      name: "mobile-phil",
      use: { ...devices["Pixel 7"] },
      testMatch: /playwright\/smoke\/phil\.spec\.ts/,
    },
  ],
  webServer: usesLocalServer
    ? {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
