import { describe, it, expect, vi } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import {
  FormField,
  focusFirstError,
  useDirtyGuard,
} from "@/components/ui/form-field";

// FormField is shipping in v0.5.3 but the per-page migration is deferred to
// v0.5.4. These tests pin the primitive's contract so the migration doesn't
// have to debug surprises that already had review-time fixes (codex adv #4 in
// particular — id preservation).

describe("FormField", () => {
  it("auto-generates an id and wires <label htmlFor> to the input", () => {
    render(
      <FormField label="Name">
        <input data-testid="x" />
      </FormField>,
    );
    const input = screen.getByTestId("x");
    const id = input.getAttribute("id");
    expect(id).toBeTruthy();

    // label htmlFor matches.
    const label = screen.getByText("Name");
    expect(label).toHaveAttribute("for", id!);
  });

  it("preserves the child input's existing id when no override is passed (codex adv #4)", () => {
    render(
      <FormField label="Name">
        <input data-testid="x" id="legacy-id" />
      </FormField>,
    );
    const input = screen.getByTestId("x");
    expect(input).toHaveAttribute("id", "legacy-id");

    // Label's htmlFor matches the legacy id, not a useId-generated one.
    expect(screen.getByText("Name")).toHaveAttribute("for", "legacy-id");
  });

  it("explicit FormField id wins over the child's id", () => {
    render(
      <FormField label="Name" id="wrapper-wins">
        <input data-testid="x" id="ignored" />
      </FormField>,
    );
    expect(screen.getByTestId("x")).toHaveAttribute("id", "wrapper-wins");
  });

  it("renders the asterisk + aria-required when required", () => {
    render(
      <FormField label="Name" required>
        <input data-testid="x" />
      </FormField>,
    );
    expect(screen.getByText("*")).toBeInTheDocument();
    expect(screen.getByTestId("x")).toHaveAttribute("aria-required", "true");
  });

  it("error sets aria-invalid + role=alert and replaces helper text", () => {
    render(
      <FormField label="Name" helper="hidden when there's an error" error="Required field">
        <input data-testid="x" />
      </FormField>,
    );
    const input = screen.getByTestId("x");
    expect(input).toHaveAttribute("aria-invalid", "true");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Required field");
    // Helper text is suppressed in the error state.
    expect(
      screen.queryByText("hidden when there's an error"),
    ).not.toBeInTheDocument();

    // aria-describedby points at the error region.
    expect(input.getAttribute("aria-describedby")).toContain(
      alert.getAttribute("id")!,
    );
  });

  it("helper text shows when there is no error, with aria-describedby", () => {
    render(
      <FormField label="Name" helper="Visible only without an error">
        <input data-testid="x" />
      </FormField>,
    );
    expect(
      screen.getByText("Visible only without an error"),
    ).toBeInTheDocument();
    const id = screen.getByTestId("x").getAttribute("aria-describedby");
    expect(id).toBeTruthy();
  });

  it("forwards name + autoComplete to the child input", () => {
    render(
      <FormField label="Email" name="email" autoComplete="email">
        <input data-testid="x" type="email" />
      </FormField>,
    );
    const input = screen.getByTestId("x");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
  });

  it("prefers child's own name + autoComplete when wrapper props are unset", () => {
    render(
      <FormField label="Email">
        <input data-testid="x" name="child-name" autoComplete="username" />
      </FormField>,
    );
    const input = screen.getByTestId("x");
    expect(input).toHaveAttribute("name", "child-name");
    expect(input).toHaveAttribute("autocomplete", "username");
  });
});

describe("focusFirstError", () => {
  it("focuses + scrolls the first ref whose error is non-empty, in object insertion order", () => {
    const a = document.createElement("input");
    const b = document.createElement("input");
    const c = document.createElement("input");
    document.body.append(a, b, c);
    a.focus = vi.fn();
    b.focus = vi.fn();
    c.focus = vi.fn();
    a.scrollIntoView = vi.fn();
    b.scrollIntoView = vi.fn();
    c.scrollIntoView = vi.fn();

    focusFirstError(
      { a, b, c },
      { a: undefined, b: "must fill", c: "also broken" },
    );

    expect(a.focus).not.toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(b.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(c.focus).not.toHaveBeenCalled();
  });

  it("does nothing when no errors are set", () => {
    const a = document.createElement("input");
    a.focus = vi.fn();
    focusFirstError({ a }, { a: undefined });
    expect(a.focus).not.toHaveBeenCalled();
  });
});

describe("useDirtyGuard", () => {
  it("guardClose calls close() immediately when not dirty", () => {
    const close = vi.fn();
    const { result } = renderHook(() => useDirtyGuard());
    act(() => {
      result.current.guardClose(close);
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("guardClose with dirty + confirmed=true calls close() and clears dirty", () => {
    const close = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { result } = renderHook(() => useDirtyGuard());
      act(() => {
        result.current.markDirty();
      });
      expect(result.current.isDirty).toBe(true);

      act(() => {
        result.current.guardClose(close);
      });

      expect(confirmSpy).toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(result.current.isDirty).toBe(false);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("guardClose with dirty + confirmed=false does NOT close", () => {
    const close = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { result } = renderHook(() => useDirtyGuard());
      act(() => {
        result.current.markDirty();
      });
      act(() => {
        result.current.guardClose(close);
      });
      expect(close).not.toHaveBeenCalled();
      expect(result.current.isDirty).toBe(true);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("markClean drops the dirty flag without prompting", () => {
    const { result } = renderHook(() => useDirtyGuard());
    act(() => {
      result.current.markDirty();
    });
    act(() => {
      result.current.markClean();
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("guardClose accepts a custom prompt message", () => {
    const close = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { result } = renderHook(() => useDirtyGuard());
      act(() => {
        result.current.markDirty();
      });
      act(() => {
        result.current.guardClose(close, "Lose your work?");
      });
      expect(confirmSpy).toHaveBeenCalledWith("Lose your work?");
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
