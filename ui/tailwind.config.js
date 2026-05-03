import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    resolve(__dirname, "index.html"),
    resolve(__dirname, "src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      fontFamily: {
        // The butler earns a serif (DESIGN.md). Instrument Serif loads from
        // Google Fonts in index.html. v0.5.4 still hardcoded
        // `style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}`
        // at ~26 product-chrome sites — system Georgia fell through and the
        // brand never reached the dashboard. v0.5.5 routes every product
        // heading through `font-serif` so the loaded webfont actually lands.
        serif: ["'Instrument Serif'", "Georgia", "'Times New Roman'", "serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // CarsonOS palette + semantic text tokens (v0.5.3 — issue #46).
        // Use these via Tailwind classes rather than inline hex literals
        // so a future palette tweak lands in one place.
        carson: {
          navy:    "var(--carson-navy)",
          cream:   "var(--carson-cream)",
          ivory:   "var(--carson-ivory)",
          border:  "var(--carson-border)",
          text: {
            primary:         "var(--carson-text-primary)",
            body:            "var(--carson-text-body)",
            muted:           "var(--carson-text-muted)",
            meta:            "var(--carson-text-meta)",
            "on-navy":       "var(--carson-text-on-navy)",
            "on-navy-muted": "var(--carson-text-on-navy-muted)",
          },
          success: "var(--carson-success)",
          warning: "var(--carson-warning)",
          error:   "var(--carson-error)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
