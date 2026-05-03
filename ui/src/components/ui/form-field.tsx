/**
 * FormField — accessible form input wrapper (v0.5.3 / issue #51).
 *
 * Pre-v0.5.3 forms wired their own labels (`<label>` siblings without
 * `htmlFor`), skipped `name` and `autocomplete`, and signaled error/required
 * state through copy alone. That weakens browser autofill, screen reader
 * traversal, and validation recovery.
 *
 * Contract:
 *   - Auto-generates a stable id via React.useId so labels link via
 *     `htmlFor` without callers having to thread an id manually
 *   - `name` is exposed for browser autofill + form submission
 *   - `autoComplete` defaults to a sensible policy per kind (or "off"
 *     for sensitive controls)
 *   - Required/optional rendered visibly AND via `aria-required`
 *   - Error text renders in a region with `role="alert"` so AT announces it
 *   - First-error focus helper (`focusFirstError`) for caller form submit
 *     handlers — pass it your refs and it scrolls the first invalid field
 *     into view + focuses it
 *
 * The component is unopinionated about the input itself: pass any
 * `<input>`-shaped element via `children`, or use the FormFieldInput /
 * FormFieldTextarea / FormFieldSelect convenience wrappers when you don't
 * need custom rendering.
 */

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export interface FormFieldProps {
  /** Visible label text. */
  label: string;
  /** Optional helper text below the input (rendered when no error). */
  helper?: string;
  /** Error message — rendered in red, replaces helper, announces via role=alert. */
  error?: string;
  /** Required field — adds asterisk + aria-required. */
  required?: boolean;
  /** Override the auto-generated id (rare — only for legacy callers). */
  id?: string;
  /** Style passthrough for the wrapper div. */
  className?: string;
  /** The input/textarea/select element. Will receive id, name, aria-* via React.cloneElement. */
  children: React.ReactElement<Record<string, unknown>>;
  /** name attribute for browser autofill + form submission. */
  name?: string;
  /** autocomplete policy. Defaults vary by call site; sensitive secrets pass "off" or "new-password". */
  autoComplete?: string;
}

export function FormField({
  label,
  helper,
  error,
  required,
  id: idOverride,
  className,
  children,
  name,
  autoComplete,
}: FormFieldProps) {
  const generatedId = React.useId();
  const id = idOverride ?? generatedId;
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;

  const childProps = children.props as Record<string, unknown>;
  const child = React.cloneElement(children, {
    id,
    name: name ?? (childProps.name as string | undefined),
    autoComplete:
      autoComplete ?? (childProps.autoComplete as string | undefined),
    "aria-required": required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby":
      [
        error ? errorId : null,
        !error && helper ? helperId : null,
        childProps["aria-describedby"] as string | undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <LabelPrimitive.Root
        htmlFor={id}
        className="text-xs font-medium text-carson-text-body"
      >
        {label}
        {required && (
          <span aria-hidden="true" className="ml-1 text-carson-error">
            *
          </span>
        )}
      </LabelPrimitive.Root>
      {child}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-xs text-carson-error"
        >
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-xs text-carson-text-meta">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Move keyboard focus to the first form field with a non-empty error.
 * Pass your refs map after running validation. Useful in onSubmit handlers
 * for long forms where the first invalid field would otherwise scroll
 * off-screen.
 */
export function focusFirstError(
  refs: Record<string, HTMLElement | null>,
  errors: Record<string, string | undefined>,
): void {
  for (const [key, msg] of Object.entries(errors)) {
    if (msg && refs[key]) {
      refs[key]?.focus();
      refs[key]?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }
}

/**
 * useDirtyGuard — warn before discarding unsaved input.
 *
 * Returns a tuple [isDirty, markDirty, markClean, guardClose]:
 *   - markDirty()  → call when an input changes
 *   - markClean()  → call after successful save / explicit discard
 *   - guardClose(close) → wrap your modal/drawer onClose. Pops a
 *     `confirm()` (browser-native, lightweight) when dirty; otherwise
 *     calls close() directly.
 *
 * For modals where ConfirmDialog feels heavier than a one-shot prompt,
 * this stays cheap — `confirm()` is perfectly fine for "discard your
 * changes?". The fancy ConfirmDialog is for destructive operations.
 */
export function useDirtyGuard() {
  const [isDirty, setIsDirty] = React.useState(false);
  const markDirty = React.useCallback(() => setIsDirty(true), []);
  const markClean = React.useCallback(() => setIsDirty(false), []);
  const guardClose = React.useCallback(
    (close: () => void, message = "Discard your changes?") => {
      if (!isDirty) {
        close();
        return;
      }
      if (window.confirm(message)) {
        setIsDirty(false);
        close();
      }
    },
    [isDirty],
  );
  return { isDirty, markDirty, markClean, guardClose };
}
