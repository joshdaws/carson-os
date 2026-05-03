/**
 * PageShell — mobile-aware page container (v0.5.3 / issues #43, #50).
 *
 * Pre-v0.5.3 every page rendered inside Layout's main with `p-6 lg:p-8 max-w-3xl`
 * (or similar) and didn't reserve space for the fixed mobile menu button at
 * the top-left. Result: at 390px wide, hamburger overlapped page titles, the
 * `Register project` button competed with copy, and Staff Detail had horizontal
 * scroll because controls hard-coded desktop widths.
 *
 * Contract:
 *   - Mobile (<sm): top inset of 56px so the fixed hamburger doesn't cover
 *     the title; horizontal padding 16px; no horizontal overflow
 *   - Tablet/desktop (sm+): standard 24-32px padding, max-w-3xl by default
 *   - Headers: a `<PageShell.Header>` slot stacks vertically on mobile
 *     (title above actions) and goes flex-row on sm+
 *   - Page-wide max width is overridable via `maxWidth` prop for wider
 *     dashboards (e.g., Tools at "5xl")
 *
 * Application strategy: each routed page wraps its top-level content in
 * <PageShell>. Layout.tsx's main is a transparent flex container; PageShell
 * does the spacing. This keeps the contract co-located with each page so
 * future page authors can't accidentally break the mobile shell.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

const MAX_WIDTHS: Record<string, string> = {
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  full: "max-w-none",
};

export interface PageShellProps {
  children: React.ReactNode;
  /** Tailwind max-width key. Default `3xl`. */
  maxWidth?: keyof typeof MAX_WIDTHS;
  /** Style passthrough for the outer wrapper. */
  className?: string;
}

export function PageShell({
  children,
  maxWidth = "3xl",
  className,
}: PageShellProps) {
  return (
    <div
      className={cn(
        // Top inset on mobile so the fixed hamburger button (44x44 in the
        // top-left corner) doesn't overlap page content. lg+ doesn't show
        // the hamburger so we drop the inset.
        "pt-14 lg:pt-0",
        // Horizontal padding scales up at sm. Max-width caps the content
        // so it doesn't stretch on ultrawide displays.
        "px-4 sm:px-6 lg:px-8",
        // Bottom padding for breathing room. mb-* on the last child of
        // PageShell.Content used to be ad-hoc per page; this wrapper
        // gives every page a consistent end-of-content gutter.
        "pb-8",
        // Lock the horizontal axis so mis-sized children can't introduce
        // page-level horizontal scroll. Issue #43 root cause.
        "overflow-x-hidden",
        MAX_WIDTHS[maxWidth],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PageShellHeaderProps {
  children: React.ReactNode;
  /** Style passthrough for the header wrapper. */
  className?: string;
}

/**
 * Stacks vertically on mobile (so the title isn't competing with action
 * buttons) and goes flex-row on sm+. Use for page headers with both a
 * title block and a primary action.
 */
export function PageShellHeader({
  children,
  className,
}: PageShellHeaderProps) {
  return (
    <header
      className={cn(
        "mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      {children}
    </header>
  );
}

PageShell.Header = PageShellHeader;
