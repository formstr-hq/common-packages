import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { describeError } from "./errors";

type ToastKind = "info" | "error" | "success";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  notify(text: string, kind?: ToastKind): void;
  fail(error: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((text: string, kind: ToastKind = "info") => {
    const id = (nextId += 1);
    setToasts((current) => [...current, { id, kind, text }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      console.error(error);
      notify(describeError(error), "error");
    },
    [notify],
  );

  const api = useMemo<ToastApi>(() => ({ notify, fail }), [notify, fail]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
