/**
 * Lightweight toast notification system.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success("Saved");
 *   toast.error("Something failed");
 */

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Check, X, AlertTriangle } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

// ── Context ────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ── Toast Item ─────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const styles: Record<ToastType, { bg: string; border: string; icon: string }> = {
    success: { bg: "#f0f7f0", border: "#4a7c59", icon: "#4a7c59" },
    error: { bg: "#fdf0f0", border: "#c62828", icon: "#c62828" },
    info: { bg: "#faf8f4", border: "#8b6f4e", icon: "#8b6f4e" },
  };

  const s = styles[toast.type];
  const Icon = toast.type === "success" ? Check : toast.type === "error" ? AlertTriangle : AlertTriangle;

  return (
    <div
      className="flex items-center gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-sm animate-in slide-in-from-right-5 fade-in duration-200"
      style={{ background: s.bg, borderColor: s.border, color: "#1a1f2e" }}
    >
      <Icon className="h-4 w-4 shrink-0" style={{ color: s.icon }} />
      <span className="flex-1">{toast.message}</span>
      <button onClick={onDismiss} className="shrink-0 opacity-50 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Provider ───────────────────────────────────────────────────────

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((message: string, type: ToastType) => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value: ToastContextValue = {
    success: useCallback((msg: string) => add(msg, "success"), [add]),
    error: useCallback((msg: string) => add(msg, "error"), [add]),
    info: useCallback((msg: string) => add(msg, "info"), [add]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast container -- fixed bottom-right */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
