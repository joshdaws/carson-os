/**
 * ConfirmDialog — accessible destructive-action confirmation (v0.5.3 / issue #49).
 *
 * Pre-v0.5.3 destructive controls were a mix of `window.confirm()`, ad-hoc
 * inline two-step buttons, and immediate state changes from icon-only
 * buttons. That made accidents likely (Projects' icon-only X for disable),
 * inconsistent (native `confirm` styling vs custom inline), and unsafe
 * (Schedules' delete fired straight from a 28px icon).
 *
 * Contract:
 *   - Modal dialog via radix Dialog (focus trap, ESC to close, click-outside)
 *   - `tone="destructive"` paints the confirm button red
 *   - Description renders structured content (not just a string) so callers
 *     can show "Delete schedule 'morning briefing'?" with the schedule name
 *     bolded
 *   - Confirm and cancel labels are explicit verbs (no "OK"/"Cancel" defaults
 *     for destructive actions — caller passes "Delete" / "Disable" / etc.)
 *   - Disables the confirm button briefly after open to prevent accidental
 *     enter-key from a quick click sequence
 *
 * Use this for: delete, disable, revoke, archive, force-stop. NOT for:
 * "discard unsaved changes?" — that's `useDirtyGuard` from form-field.tsx,
 * which is intentionally lighter weight.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short imperative title — "Delete this schedule?" */
  title: string;
  /** Body content. String becomes a paragraph; ReactNode renders as-is. */
  description: React.ReactNode;
  /** Imperative verb on the confirm button — "Delete", "Disable", "Revoke". */
  confirmLabel: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** "destructive" paints confirm red. "default" is neutral. */
  tone?: "destructive" | "default";
  /** Called when user confirms. Async-aware: dialog stays open + confirm
   *  shows pending state until the promise resolves. */
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "destructive",
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);
  // Disable confirm for 250ms after open to prevent enter-key carry-over
  // from a quick double-tap on the trigger.
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setArmed(false);
      const t = window.setTimeout(() => setArmed(true), 250);
      return () => window.clearTimeout(t);
    } else {
      setPending(false);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (!armed || pending) return;
    try {
      setPending(true);
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-carson-border bg-carson-ivory p-5 shadow-lg",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex gap-3">
            {tone === "destructive" && (
              <div className="flex-shrink-0">
                <AlertTriangle
                  aria-hidden="true"
                  className="h-5 w-5 text-carson-error"
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold text-carson-text-primary">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <div className="mt-2 text-sm text-carson-text-body">
                  {description}
                </div>
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={pending}
              className="min-h-[44px] rounded-md border border-carson-border bg-carson-ivory px-4 text-sm font-medium text-carson-text-body transition-colors hover:bg-carson-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!armed || pending}
              className={cn(
                "min-h-[44px] rounded-md px-4 text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                tone === "destructive"
                  ? "bg-carson-error hover:bg-carson-error/90"
                  : "bg-carson-navy hover:bg-carson-navy/90",
              )}
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Small hook to wire a ConfirmDialog without component-level state churn.
 * Returns [props, ask] where ask(action) opens the dialog and runs `action`
 * on confirm.
 *
 * Usage:
 *   const [confirmProps, askConfirm] = useConfirmDialog();
 *   ...
 *   <ConfirmDialog {...confirmProps} title="..." description="..." confirmLabel="..." />
 *   ...
 *   <button onClick={() => askConfirm(() => deleteSchedule(id))}>Delete</button>
 */
export function useConfirmDialog() {
  const [open, setOpen] = React.useState(false);
  const actionRef = React.useRef<(() => void | Promise<void>) | null>(null);
  const ask = React.useCallback((action: () => void | Promise<void>) => {
    actionRef.current = action;
    setOpen(true);
  }, []);
  const onConfirm = React.useCallback(async () => {
    if (actionRef.current) await actionRef.current();
  }, []);
  return [{ open, onOpenChange: setOpen, onConfirm }, ask] as const;
}
