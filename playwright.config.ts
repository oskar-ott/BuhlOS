import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * Default: spin up `next dev` on localhost and run the unauthenticated route
 * guards. The authenticated Phase B flows need the legacy /api/auth login,
 * which only runs on a Vercel deploy — so set PLAYWRIGHT_BASE_URL to a preview
 * URL to exercise them. When an external base URL is supplied we do NOT start
 * the local dev server (it would serve a different origin with no api/*).
 */
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: externalBaseURL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Only manage a local server when testing localhost; against a preview
  // deploy the app is already running.
  webServer: externalBaseURL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
