/**
 * IconButton — accessible icon-only button (v0.5.3 / issue #45).
 *
 * Pre-v0.5.3 the codebase used `<button>` with a 28-36px hit area and no
 * accessible name on icon-only controls (member edit, schedule pause/edit/
 * delete, password reveal, mobile menu). That fails WCAG 2.5.5 (44x44 touch
 * target) and leaves screen-readers and keyboard users guessing.
 *
 * Contract:
 *   - 44x44 minimum hit area (sm = 36 visible + 4px each side via padding;
 *     md = 40 visible + 2px; lg = 44 visible)
 *   - `aria-label` is REQUIRED — TypeScript enforces this so a refactor that
 *     drops the label fails the build, not at runtime
 *   - Visible focus ring (focus-visible:ring-2)
 *   - Optional tooltip via `tooltip` prop, rendered on hover/focus
 *   - Variants: ghost (default — minimal chrome), outline, destructive
 *
 * Default size is `lg` so the 44px target lands without callers thinking
 * about it. `sm` exists for compact contexts (table rows, form helpers)
 * but the hit area is still 44x44 — only the visible chrome shrinks.
 */

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const iconButtonVariants = cva(
  // Base: 44x44 hit area via min-w/min-h, focus-visible ring, transition
  "relative inline-flex items-center justify-center rounded-md transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 " +
    "disabled:pointer-events-none disabled:opacity-50 " +
    "min-h-[44px] min-w-[44px]",
  {
    variants: {
      variant: {
        ghost:
          "text-carson-text-muted hover:bg-carson-cream hover:text-carson-text-body",
        outline:
          "border border-carson-border bg-carson-ivory text-carson-text-body hover:bg-carson-cream",
        destructive:
          "text-carson-error hover:bg-carson-error/10 hover:text-carson-error",
        primary:
          "bg-carson-navy text-carson-text-on-navy hover:bg-carson-navy/90",
      },
      size: {
        // Visible chrome size. Hit area stays 44x44 via base min-h/min-w.
        sm: "[&>svg]:h-3.5 [&>svg]:w-3.5",
        md: "[&>svg]:h-4 [&>svg]:w-4",
        lg: "[&>svg]:h-5 [&>svg]:w-5",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "md",
    },
  },
);

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">,
    VariantProps<typeof iconButtonVariants> {
  /** REQUIRED. Screen-reader name + tooltip text. */
  "aria-label": string;
  /** Optional explicit tooltip override; defaults to aria-label. */
  tooltip?: string;
  /** Hide the tooltip even though aria-label is set. */
  noTooltip?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      className,
      variant,
      size,
      tooltip,
      noTooltip,
      type = "button",
      "aria-label": ariaLabel,
      children,
      ...props
    },
    ref,
  ) {
    const button = (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </button>
    );

    if (noTooltip) return button;
    const tooltipText = tooltip ?? ariaLabel;
    return (
      <TooltipPrimitive.Root delayDuration={400}>
        <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 rounded-md bg-carson-navy px-2 py-1 text-xs text-carson-text-on-navy shadow-md"
          >
            {tooltipText}
            <TooltipPrimitive.Arrow className="fill-carson-navy" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    );
  },
);

/**
 * App-level provider for radix Tooltip. Mount once near the app root so
 * IconButton tooltips don't each spin up their own provider. Defaults to
 * skipDelay so quickly mousing across multiple icon buttons doesn't
 * re-trigger the open delay every time.
 */
export const IconButtonTooltipProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={200}>
    {children}
  </TooltipPrimitive.Provider>
);
