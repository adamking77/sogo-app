import { X } from "lucide-react";

import { useToastStore, type ToastTone } from "@/stores/toastStore";

const DOT_CLASS: Record<ToastTone, string> = {
  info: "bg-sky-400",
  success: "bg-emerald-400",
  error: "bg-red-400",
};

/** Single toast anchor: bottom-center of the main card, above the pill bar. */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-14 z-40 flex flex-col items-center gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="sogo-pop pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full border border-cc-border bg-cc-surface/95 py-1.5 pl-3.5 pr-1.5 text-xs shadow-xl"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[toast.tone]}`} />
          <span className="min-w-0 flex-1 truncate text-cc-foreground" title={toast.message}>
            {toast.message}
          </span>
          {toast.actionLabel && toast.onAction ? (
            <button
              className="shrink-0 rounded-full bg-cc-surface-strong px-2.5 py-1 text-[11px] text-cc-foreground transition-colors hover:bg-cc-surface-strong/70"
              onClick={() => {
                toast.onAction?.();
                dismiss(toast.id);
              }}
            >
              {toast.actionLabel}
            </button>
          ) : null}
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-cc-muted transition-colors hover:text-cc-foreground"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
