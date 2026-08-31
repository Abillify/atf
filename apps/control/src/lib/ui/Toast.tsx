"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, {
  createContext,
  useCallback,
  useContext,
  useId,
  useReducer,
  useEffect,
  useRef,
} from "react";

export type ToastVariant = "default" | "success" | "warning" | "destructive";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Duration in ms — 0 means persist until dismissed */
  duration?: number;
}

type ToastAction =
  | { type: "ADD"; toast: ToastItem }
  | { type: "REMOVE"; id: string };

function toastReducer(state: ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case "ADD":
      return [...state, action.toast];
    case "REMOVE":
      return state.filter((t) => t.id !== action.id);
    default:
      return state;
  }
}

interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const counter = useRef(0);

  const addToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = `toast-${++counter.current}`;
    dispatch({ type: "ADD", toast: { duration: 5000, ...toast, id } });
  }, []);

  const removeToast = useCallback((id: string) => {
    dispatch({ type: "REMOVE", id });
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastViewport toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): Omit<ToastContextValue, "toasts"> {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return { addToast: ctx.addToast, removeToast: ctx.removeToast };
}

const variantClasses: Record<ToastVariant, string> = {
  default: "bg-popover border-border text-popover-foreground",
  success: "bg-emerald-950 border-emerald-700 text-emerald-100",
  warning: "bg-amber-950 border-amber-600 text-amber-100",
  destructive: "bg-destructive border-destructive text-destructive-foreground",
};

interface ToastEntryProps {
  toast: ToastItem;
  removeToast: (id: string) => void;
}

function ToastEntry({
  toast,
  removeToast,
}: ToastEntryProps): React.JSX.Element {
  const {
    id,
    title,
    description,
    variant = "default",
    duration = 5000,
  } = toast;

  useEffect(() => {
    if (duration === 0) return;
    const timer = setTimeout(() => removeToast(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, removeToast]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={[
        "pointer-events-auto relative flex w-full min-w-[280px] max-w-sm flex-col gap-1 rounded-lg border p-4 shadow-lg",
        variantClasses[variant],
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <button
          aria-label="Dismiss notification"
          onClick={() => removeToast(id)}
          className={[
            "flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-70 transition-opacity",
            "hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {description && <p className="text-xs opacity-90">{description}</p>}
    </div>
  );
}

interface ToastViewportProps {
  toasts: ToastItem[];
  removeToast: (id: string) => void;
}

function ToastViewport({
  toasts,
  removeToast,
}: ToastViewportProps): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2 sm:bottom-6 sm:right-6"
    >
      {toasts.map((t) => (
        <ToastEntry key={t.id} toast={t} removeToast={removeToast} />
      ))}
    </div>
  );
}
