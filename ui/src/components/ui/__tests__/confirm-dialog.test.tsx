import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ConfirmDialog,
  useConfirmDialog,
} from "@/components/ui/confirm-dialog";

// Most of these tests guard regressions caught during the v0.5.3 pre-merge
// review. Names mention the codex finding number so the link back to the
// review log is obvious.
//
// Implementation note: ConfirmDialog uses a 250ms setTimeout to disable its
// confirm button right after open. userEvent v14 also relies on real timers
// for inter-event waits, so mixing fake timers with userEvent.click hangs the
// test. We use real timers throughout and wait the actual 270ms — adds ~2s
// total to the suite, but keeps the tests honest.

const ARMED_DELAY_MS = 270;

function Harness({
  onConfirm,
  initialOpen = false,
}: {
  onConfirm: () => void | Promise<void>;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this thing?"
        description="The description text."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("renders title + description + verb buttons when open", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();
    expect(screen.getByText("The description text.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("disables the confirm button for the first 250ms after open (codex adv #1: armed-reset)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} initialOpen />);
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    // Before the timer fires, confirm is disabled even though open=true
    // from the start.
    expect(confirmBtn).toBeDisabled();
    // Click on a disabled button is a no-op natively.
    await user.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));
    expect(confirmBtn).not.toBeDisabled();
  });

  it("re-arms the guard on every fresh open, not only the first (codex adv #1)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    // First cycle: open, wait past the guard, fire confirm, dialog closes.
    await user.click(screen.getByRole("button", { name: "open" }));
    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // Reopen — armed must be reset to false. The button should be disabled
    // again until the 250ms of the SECOND open elapses.
    await user.click(screen.getByRole("button", { name: "open" }));
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn).toBeDisabled();
    // Click in the guard window is dropped.
    await user.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));
    expect(confirmBtn).not.toBeDisabled();
  });

  it("waits for an async onConfirm to resolve before closing, and surfaces the pending label", async () => {
    const user = userEvent.setup();
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(<Harness onConfirm={onConfirm} initialOpen />);
    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));

    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    await user.click(confirmBtn);

    // Pending state: dialog stays open, button label flips, both buttons disabled.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByText("Delete this thing?")).toBeInTheDocument();

    // Resolve the promise — the dialog closes and pending clears.
    await act(async () => {
      resolveConfirm();
    });
    expect(screen.queryByText("Delete this thing?")).not.toBeInTheDocument();
  });

  it("blocks ESC and click-outside from closing the dialog while pending (codex adv #2)", async () => {
    const user = userEvent.setup();
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(<Harness onConfirm={onConfirm} initialOpen />);
    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));

    await user.click(screen.getByRole("button", { name: "Delete" }));
    // Mid-flight: try to ESC out. Radix routes ESC through onOpenChange(false),
    // which our wrapper drops while pending=true.
    await user.keyboard("{Escape}");
    expect(screen.getByText("Delete this thing?")).toBeInTheDocument();
    expect(screen.getByText("Working…")).toBeInTheDocument();

    await act(async () => {
      resolveConfirm();
    });
    expect(screen.queryByText("Delete this thing?")).not.toBeInTheDocument();
  });

  it("destructive tone uses the error-colored confirm button; default tone uses navy", () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-carson-error",
    );

    rerender(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Disable"
        tone="default"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Disable" })).toHaveClass(
      "bg-carson-navy",
    );
  });
});

describe("useConfirmDialog", () => {
  it("ask(action) opens the dialog and runs the action when confirmed", async () => {
    function Demo({ action }: { action: () => Promise<void> }) {
      const [props, ask] = useConfirmDialog();
      return (
        <>
          <button onClick={() => ask(action)}>trigger</button>
          <ConfirmDialog
            {...props}
            title="ok?"
            description="desc"
            confirmLabel="Yes"
          />
        </>
      );
    }

    const user = userEvent.setup();
    const action = vi.fn(async () => {});
    render(<Demo action={action} />);

    await user.click(screen.getByRole("button", { name: "trigger" }));
    expect(screen.getByText("ok?")).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, ARMED_DELAY_MS));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
