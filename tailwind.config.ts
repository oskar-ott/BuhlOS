import type { Config } from "tailwindcss";

/**
 * Brand tokens are defined in src/styles/tokens.css as CSS custom properties
 * and exposed to Tailwind here so utilities like `bg-brand-navy`,
 * `text-accent-yellow`, `border-accent-ink` work everywhere.
 *
 * Density tokens map to a single CSS variable each so a top-level density
 * theme switch can rewrite spacing globally without touching component code.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/domains/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "accent-yellow": "var(--accent-yellow)",
        "brand-navy": "var(--brand-navy)",
        "accent-ink": "var(--accent-ink)",
        surface: {
          DEFAULT: "var(--surface)",
          subtle: "var(--surface-subtle)",
          raised: "var(--surface-raised)",
        },
        text: {
          DEFAULT: "var(--text)",
          muted: "var(--text-muted)",
          inverse: "var(--text-inverse)",
        },
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        state: {
          danger: "var(--state-danger)",
          success: "var(--state-success)",
          warning: "var(--state-warning)",
          info: "var(--state-info)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-inter-tight)", "var(--font-inter)", "sans-serif"],
      },
      spacing: {
        density: "var(--density-unit)",
      },
      borderRadius: {
        card: "12px",
        pill: "999px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.05)",
        raised: "0 4px 14px rgba(15, 23, 42, 0.10)",
      },
    },
  },
  plugins: [],
};

export default config;
