import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  IconButton,
  IconButtonTooltipProvider,
} from "@/components/ui/icon-button";
import { X } from "lucide-react";

// IconButton's whole reason to exist is the WCAG 2.5.5 hit area + accessible
// name contract. These tests pin the contract so future "let's go smaller" PRs
// fail before they merge.
//
// All tests render inside IconButtonTooltipProvider because radix Tooltip
// requires its provider to mount — this matches App.tsx, where the provider
// wraps the whole route tree.

function renderWithProvider(ui: React.ReactElement) {
  return render(<IconButtonTooltipProvider>{ui}</IconButtonTooltipProvider>);
}

describe("IconButton", () => {
  it("renders the aria-label on the underlying <button>", () => {
    renderWithProvider(
      <IconButton aria-label="Close menu">
        <X />
      </IconButton>,
    );
    expect(
      screen.getByRole("button", { name: "Close menu" }),
    ).toBeInTheDocument();
  });

  it("applies the 44x44 hit-area classes regardless of size variant (WCAG 2.5.5)", () => {
    const { rerender } = renderWithProvider(
      <IconButton aria-label="x" size="sm">
        <X />
      </IconButton>,
    );
    let btn = screen.getByRole("button", { name: "x" });
    expect(btn).toHaveClass("min-h-[44px]");
    expect(btn).toHaveClass("min-w-[44px]");

    rerender(
      <IconButtonTooltipProvider>
        <IconButton aria-label="x" size="lg">
          <X />
        </IconButton>
      </IconButtonTooltipProvider>,
    );
    btn = screen.getByRole("button", { name: "x" });
    expect(btn).toHaveClass("min-h-[44px]");
    expect(btn).toHaveClass("min-w-[44px]");
  });

  it("primary variant carries the navy + on-navy classes (Layout.tsx mobile menu uses this for AA contrast)", () => {
    renderWithProvider(
      <IconButton aria-label="Open menu" variant="primary">
        <X />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Open menu" });
    expect(btn).toHaveClass("bg-carson-navy");
    expect(btn).toHaveClass("text-carson-text-on-navy");
  });

  it("ghost variant keeps the muted-text class on cream surfaces", () => {
    renderWithProvider(
      <IconButton aria-label="x" variant="ghost">
        <X />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "x" })).toHaveClass(
      "text-carson-text-muted",
    );
  });

  it("destructive variant carries the error color", () => {
    renderWithProvider(
      <IconButton aria-label="del" variant="destructive">
        <X />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "del" })).toHaveClass(
      "text-carson-error",
    );
  });

  it("forwards onClick to the underlying button", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProvider(
      <IconButton aria-label="x" onClick={onClick}>
        <X />
      </IconButton>,
    );
    await user.click(screen.getByRole("button", { name: "x" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("respects the disabled prop", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProvider(
      <IconButton aria-label="x" disabled onClick={onClick}>
        <X />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "x" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("type defaults to 'button' so it never accidentally submits a parent form", () => {
    renderWithProvider(
      <form>
        <IconButton aria-label="x">
          <X />
        </IconButton>
      </form>,
    );
    expect(screen.getByRole("button", { name: "x" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  it("noTooltip skips the radix Tooltip wrapper", () => {
    // When noTooltip is true the component bypasses the Tooltip entirely.
    // We don't need a provider at all for this case.
    const { container } = render(
      <IconButton aria-label="x" noTooltip>
        <X />
      </IconButton>,
    );
    // Only the button is rendered — no radix-tooltip-trigger wrapper.
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("works inside IconButtonTooltipProvider without crashing", () => {
    // Smoke check: the provider mounts radix Tooltip's provider once at the
    // app root. App.tsx wires it. This is the rendering path used in prod.
    render(
      <IconButtonTooltipProvider>
        <IconButton aria-label="Edit">
          <X />
        </IconButton>
      </IconButtonTooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
