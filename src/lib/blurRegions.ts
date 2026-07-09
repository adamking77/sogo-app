import { useCallback, useRef } from "react";

import { isTauriRuntime } from "@/lib/runtime";
import { useThemeStore } from "@/stores/themeStore";

/**
 * Registry of DOM elements that should show the native desktop blur
 * (NSVisualEffectView behind the webview, masked to these rounded rects).
 * Regions are re-reported on element resize, window resize, entrance
 * animation end, and background-opacity changes.
 */

export type BlurRadius = number | "pill";

type Entry = { el: HTMLElement; radius: BlurRadius };

/** At or above this opacity the app reads as solid; skip the native blur. */
const OPAQUE_THRESHOLD = 0.995;

const entries = new Set<Entry>();
let resizeObserver: ResizeObserver | null = null;
let frame = 0;
let wired = false;
let lastPayload = "";

function ensureWired() {
  if (wired) return;
  wired = true;
  window.addEventListener("resize", scheduleBlurReport);

  let lastOpacity = useThemeStore.getState().backgroundOpacity;
  useThemeStore.subscribe((state) => {
    if (state.backgroundOpacity === lastOpacity) return;
    lastOpacity = state.backgroundOpacity;
    scheduleBlurReport();
  });
}

export function scheduleBlurReport() {
  if (!isTauriRuntime()) return;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    void report();
  });
}

async function report() {
  const enabled = useThemeStore.getState().backgroundOpacity < OPAQUE_THRESHOLD;
  const regions = enabled
    ? [...entries]
        .filter(({ el }) => el.isConnected)
        .map(({ el, radius }) => {
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            radius: radius === "pill" ? rect.height / 2 : radius,
          };
        })
        .filter((region) => region.width > 0 && region.height > 0)
    : [];

  // ResizeObserver fires every frame during drags; only cross the IPC
  // boundary when the payload actually changed.
  const payload = JSON.stringify({ regions, enabled });
  if (payload === lastPayload) return;
  lastPayload = payload;

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_blur_regions", { regions, enabled }).catch(() => undefined);
}

function register(el: HTMLElement, radius: BlurRadius) {
  ensureWired();
  const entry: Entry = { el, radius };
  entries.add(entry);
  resizeObserver ??= new ResizeObserver(scheduleBlurReport);
  resizeObserver.observe(el);
  // Entrance animations translate the element; re-report its settled rect.
  el.addEventListener("animationend", scheduleBlurReport);
  scheduleBlurReport();

  return () => {
    entries.delete(entry);
    resizeObserver?.unobserve(el);
    el.removeEventListener("animationend", scheduleBlurReport);
    scheduleBlurReport();
  };
}

/** Callback ref marking an element as a desktop-blur region. */
export function useBlurRegion(radius: BlurRadius) {
  const cleanupRef = useRef<(() => void) | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = el ? register(el, radius) : null;
    },
    [radius],
  );
}
