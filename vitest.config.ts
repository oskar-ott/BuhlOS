import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [
      "node_modules/**",
      ".next/**",
      "tests/**", // Playwright lives in tests/
      "public/**",
      "api/**",
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      exclude: ["node_modules/**", ".next/**", "tests/**", "public/**", "api/**"],
    },
  },
});
