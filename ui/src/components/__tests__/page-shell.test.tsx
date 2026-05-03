import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PageShell } from "@/components/page-shell";

// PageShell pins three things that the v0.5.3 audit fixed:
//   1. The 56px mobile inset so the fixed hamburger doesn't overlap content
//   2. The breakpoint that drops that inset must match the hamburger's
//      breakpoint (md), not lg — codex P3 caught this regression
//   3. overflow-x-hidden so a stray fixed-width child can't push horizontal
//      scroll on the document
// Header tests cover the responsive flex stack→row transition that lets
// title/action pairs work at 390px without collisions.

describe("PageShell", () => {
  it("applies pt-14 mobile inset and md:pt-0 reset (codex P3 regression)", () => {
    const { container } = render(
      <PageShell>
        <div>content</div>
      </PageShell>,
    );
    const shell = container.firstChild as HTMLElement;
    expect(shell).toHaveClass("pt-14");
    expect(shell).toHaveClass("md:pt-0");
    // Anti-regression: the broken version had lg:pt-0, which left the inset
    // applied at 768-1023px even though the hamburger is hidden by then.
    expect(shell).not.toHaveClass("lg:pt-0");
  });

  it("locks horizontal overflow so fixed-width children can't trigger page scroll", () => {
    const { container } = render(
      <PageShell>
        <div>content</div>
      </PageShell>,
    );
    expect(container.firstChild).toHaveClass("overflow-x-hidden");
  });

  it("defaults to max-w-3xl and accepts max-width overrides", () => {
    const { container, rerender } = render(
      <PageShell>
        <div>x</div>
      </PageShell>,
    );
    expect(container.firstChild).toHaveClass("max-w-3xl");

    rerender(
      <PageShell maxWidth="5xl">
        <div>x</div>
      </PageShell>,
    );
    expect(container.firstChild).toHaveClass("max-w-5xl");

    rerender(
      <PageShell maxWidth="full">
        <div>x</div>
      </PageShell>,
    );
    expect(container.firstChild).toHaveClass("max-w-none");
  });

  it("merges a passthrough className without dropping the base classes", () => {
    const { container } = render(
      <PageShell className="custom-extra">
        <div>x</div>
      </PageShell>,
    );
    const shell = container.firstChild as HTMLElement;
    expect(shell).toHaveClass("custom-extra");
    expect(shell).toHaveClass("pt-14");
    expect(shell).toHaveClass("overflow-x-hidden");
  });

  it("renders children inside the shell wrapper", () => {
    const { getByText } = render(
      <PageShell>
        <p>hello</p>
      </PageShell>,
    );
    expect(getByText("hello")).toBeInTheDocument();
  });
});

describe("PageShell.Header", () => {
  it("stacks vertically on mobile and goes flex-row on sm+", () => {
    const { container } = render(
      <PageShell.Header>
        <h1>Title</h1>
        <button>Action</button>
      </PageShell.Header>,
    );
    const header = container.firstChild as HTMLElement;
    // Mobile: column stack. sm+: row.
    expect(header).toHaveClass("flex-col");
    expect(header).toHaveClass("sm:flex-row");
    expect(header.tagName).toBe("HEADER");
  });

  it("merges a custom className while keeping the responsive base classes", () => {
    const { container } = render(
      <PageShell.Header className="bonus">
        <h1>x</h1>
      </PageShell.Header>,
    );
    const header = container.firstChild as HTMLElement;
    expect(header).toHaveClass("bonus");
    expect(header).toHaveClass("flex-col");
    expect(header).toHaveClass("sm:flex-row");
  });
});
