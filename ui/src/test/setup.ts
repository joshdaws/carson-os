// Vitest test setup — runs once per test file before the suite begins.
//
// jest-dom/vitest auto-extends vitest's expect with DOM matchers (toBeInTheDocument,
// toHaveAttribute, toBeDisabled, toHaveClass, etc.) so component assertions
// stay readable.
//
// Radix primitives (Tooltip, Dialog) reach for ResizeObserver and matchMedia,
// neither of which happy-dom ships. Stub both here so we never have to repeat
// the dance per test file. matchMedia returns "no match" by default, which is
// what most callers want for unit tests.

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
