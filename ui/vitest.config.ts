import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// vitest config for the UI package. Mirrors the dev vite config's @-alias and
// JSX setup so component imports work the same way they do at runtime, and
// uses happy-dom (faster than jsdom, complete enough for radix + RTL).
//
// The four shared primitives in src/components and src/components/ui are
// the priority test targets — pre-merge review caught real bugs in three of
// them (ConfirmDialog armed-reset, mutate-vs-mutateAsync, FormField id
// clobber). Tests here exist mostly to keep those bugs from coming back.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
