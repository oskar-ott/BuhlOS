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
        // Partner brand (Xero) — the "send to Xero" affordance only.
        "brand-xero": "var(--brand-xero)",
        "brand-xero-hover": "var(--brand-xero-hover)",
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
          // Badge tint quads (Phil sharpened §1): pale pill bg/border, dark
          // label text, solid dot — e.g. `bg-state-info-subtle-bg`,
          // `border-state-info-subtle-border`, `text-state-info-subtle-text`,
          // `bg-state-info-dot`. Defined in src/styles/tokens.css.
          "neutral-dot": "var(--state-neutral-dot)",
          "neutral-subtle-bg": "var(--state-neutral-subtle-bg)",
          "neutral-subtle-border": "var(--state-neutral-subtle-border)",
          "neutral-subtle-text": "var(--state-neutral-subtle-text)",
          "info-dot": "var(--state-info-dot)",
          "info-subtle-bg": "var(--state-info-subtle-bg)",
          "info-subtle-border": "var(--state-info-subtle-border)",
          "info-subtle-text": "var(--state-info-subtle-text)",
          "warning-dot": "var(--state-warning-dot)",
          "warning-subtle-bg": "var(--state-warning-subtle-bg)",
          "warning-subtle-border": "var(--state-warning-subtle-border)",
          "warning-subtle-text": "var(--state-warning-subtle-text)",
          "danger-dot": "var(--state-danger-dot)",
          "danger-subtle-bg": "var(--state-danger-subtle-bg)",
          "danger-subtle-border": "var(--state-danger-subtle-border)",
          "danger-subtle-text": "var(--state-danger-subtle-text)",
          "success-dot": "var(--state-success-dot)",
          "success-subtle-bg": "var(--state-success-subtle-bg)",
          "success-subtle-border": "var(--state-success-subtle-border)",
          "success-subtle-text": "var(--state-success-subtle-text)",
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
