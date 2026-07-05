import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Sticky toasts stay until dismissed; others auto-dismiss. */
  sticky?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
const AUTO_DISMISS_MS: Record<ToastTone, number> = {
  info: 4000,
  success: 1600,
  error: 7000,
};

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextToastId++;
    set((state) => ({
      // Keep at most 3 stacked; drop the oldest non-sticky first.
      toasts: [...state.toasts.slice(-2), { ...toast, id }],
    }));
    if (!toast.sticky) {
      window.setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((candidate) => candidate.id !== id) }));
      }, AUTO_DISMISS_MS[toast.tone]);
    }
    return id;
  },
  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((candidate) => candidate.id !== id) }));
  },
}));

export function toastError(message: string) {
  useToastStore.getState().push({ tone: "error", message, sticky: true });
}

export function toastSuccess(message: string) {
  useToastStore.getState().push({ tone: "success", message });
}

export function toastInfo(message: string) {
  useToastStore.getState().push({ tone: "info", message });
}
