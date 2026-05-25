import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  // tsconfig.json sets jsx="preserve" so Next.js owns the production
  // transform. For vitest's node test runner there is no downstream — we
  // need esbuild to emit a usable runtime. "automatic" matches React 19's
  // production behaviour (no React import required in source files).
  esbuild: {
    jsx: "automatic",
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
