import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type ResizeEdge =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

export type FileEditorLayout = "overlay" | "ejected";

export const TERMINAL_ONLY_WINDOW_MIN_WIDTH = 440;
export const TERMINAL_MIN_WIDTH_SOLO = 420;
export const TERMINAL_MIN_WIDTH_WITH_EDITOR = 300;
export const TERMINAL_EJECTED_MIN_WIDTH = 320;
export const TERMINAL_EJECTED_MAX_WIDTH = 980;
export const TERMINAL_EJECTED_DEFAULT_WIDTH = 520;
export const FILE_EDITOR_MIN_WIDTH = 520;
export const FILE_EDITOR_MAX_WIDTH = 1080;
export const FILE_EDITOR_DEFAULT_WIDTH = 760;
export const PANE_GAP = 8;
export const RIGHT_SIDEBAR_WIDTH = 336;
/** Floating bottom control rail row (its own flex row + gap). */
export const CONTROL_RAIL_HEIGHT = 38;
export const CONTROL_RAIL_TOTAL = CONTROL_RAIL_HEIGHT + PANE_GAP;
export const PANEL_WINDOW_MIN_WIDTH = TERMINAL_ONLY_WINDOW_MIN_WIDTH + RIGHT_SIDEBAR_WIDTH + PANE_GAP;
export const EDITOR_WINDOW_MIN_WIDTH = 840;
export const EDITOR_PANEL_WINDOW_MIN_WIDTH =
  TERMINAL_MIN_WIDTH_WITH_EDITOR + FILE_EDITOR_MIN_WIDTH + RIGHT_SIDEBAR_WIDTH + PANE_GAP * 2;
export const WINDOW_MIN_HEIGHT = 540;

export function getWindowMinWidth(
  editorVisible: boolean,
  panelOpen: boolean,
  fileEditorLayout: FileEditorLayout,
) {
  const base = (() => {
    if (editorVisible && fileEditorLayout === "ejected") {
      const panelWidth = panelOpen ? RIGHT_SIDEBAR_WIDTH : 0;
      const gapCount = panelOpen ? 2 : 1;
      return TERMINAL_EJECTED_MIN_WIDTH + FILE_EDITOR_MIN_WIDTH + panelWidth + PANE_GAP * gapCount;
    }
    if (editorVisible && panelOpen) return EDITOR_PANEL_WINDOW_MIN_WIDTH;
    if (editorVisible) return EDITOR_WINDOW_MIN_WIDTH;
    if (panelOpen) return PANEL_WINDOW_MIN_WIDTH;
    return TERMINAL_ONLY_WINDOW_MIN_WIDTH;
  })();

  return base;
}

export function readStoredNumber(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getAvailableEjectedPaneWidthForWindow(windowWidth: number, toolPanelOpen: boolean) {
  const toolPanelWidth = toolPanelOpen ? RIGHT_SIDEBAR_WIDTH : 0;
  const gapCount = toolPanelOpen ? 2 : 1;
  return windowWidth - toolPanelWidth - PANE_GAP * gapCount;
}

// In ejected mode the terminal column has a fixed width and the file-view
// column is flex-1. Clamp the terminal so the flex file-view keeps at least
// FILE_EDITOR_MIN_WIDTH.
export function clampEjectedTerminalWidth(width: number, toolPanelOpen: boolean) {
  return clampEjectedTerminalWidthForWindow(width, toolPanelOpen, window.innerWidth);
}

export function clampEjectedTerminalWidthForWindow(
  width: number,
  toolPanelOpen: boolean,
  windowWidth: number,
) {
  const maxAvailable = getAvailableEjectedPaneWidthForWindow(windowWidth, toolPanelOpen) - FILE_EDITOR_MIN_WIDTH;
  const effectiveMin = Math.min(TERMINAL_EJECTED_MIN_WIDTH, Math.max(220, maxAvailable));
  const effectiveMax = Math.max(effectiveMin, Math.min(TERMINAL_EJECTED_MAX_WIDTH, maxAvailable));
  return Math.round(clampNumber(width, effectiveMin, effectiveMax));
}

export function clampFileEditorWidth(
  width: number,
  toolPanelOpen: boolean,
  fileEditorLayout: FileEditorLayout,
  terminalWidth = TERMINAL_MIN_WIDTH_WITH_EDITOR,
) {
  const toolPanelWidth = toolPanelOpen ? RIGHT_SIDEBAR_WIDTH : 0;
  const gapCount = toolPanelOpen ? 2 : 1;
  const requiredTerminalWidth = fileEditorLayout === "ejected" ? terminalWidth : TERMINAL_MIN_WIDTH_WITH_EDITOR;
  const maxAvailable = window.innerWidth - requiredTerminalWidth - toolPanelWidth - PANE_GAP * gapCount;
  const effectiveMin = Math.min(FILE_EDITOR_MIN_WIDTH, Math.max(220, maxAvailable));
  const effectiveMax = Math.max(effectiveMin, Math.min(FILE_EDITOR_MAX_WIDTH, maxAvailable));
  return Math.round(Math.min(Math.max(width, effectiveMin), effectiveMax));
}

export function beginHorizontalPaneResize(
  event: ReactMouseEvent,
  startWidth: number,
  onResize: (width: number) => void,
  options: { invert?: boolean } = {},
) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (moveEvent: MouseEvent) => {
    const delta = options.invert ? startX - moveEvent.clientX : moveEvent.clientX - startX;
    onResize(startWidth + delta);
  };

  const onUp = () => {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

export function useDragHandler(tauriRuntime: boolean) {
  return useCallback(
    (event: ReactMouseEvent) => {
      if (!tauriRuntime || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, a, select")) return;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        void getCurrentWindow().startDragging();
      });
    },
    [tauriRuntime],
  );
}

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readWindowFrame() {
  const { currentMonitor, getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  const [size, scaleFactor, position, monitor] = await Promise.all([
    appWindow.innerSize(),
    appWindow.scaleFactor(),
    appWindow.outerPosition(),
    currentMonitor(),
  ]);

  const workArea: WorkArea = {
    x: monitor?.workArea?.position?.x ? monitor.workArea.position.x / scaleFactor : 0,
    y: monitor?.workArea?.position?.y ? monitor.workArea.position.y / scaleFactor : 0,
    width: monitor?.workArea?.size?.width
      ? monitor.workArea.size.width / scaleFactor
      : window.screen.availWidth,
    height: monitor?.workArea?.size?.height
      ? monitor.workArea.size.height / scaleFactor
      : window.screen.availHeight,
  };

  return {
    appWindow,
    width: size.width / scaleFactor,
    height: size.height / scaleFactor,
    x: position.x / scaleFactor,
    y: position.y / scaleFactor,
    workArea,
  };
}

/** Grow the window by deltaW logical pixels, staying inside the work area. */
export async function growWindowBy(tauriRuntime: boolean, deltaW: number) {
  if (!tauriRuntime || deltaW <= 0) return;
  try {
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
    const frame = await readWindowFrame();
    const maxW = frame.workArea.width - 24;
    const nextW = Math.min(frame.width + deltaW, maxW);
    if (nextW - frame.width >= 8) {
      await frame.appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(frame.height)));
    }

    const maxX = frame.workArea.x + frame.workArea.width - nextW - 12;
    if (frame.x > maxX) {
      await frame.appWindow.setPosition(
        new LogicalPosition(Math.round(Math.max(frame.workArea.x + 12, maxX)), Math.round(frame.y)),
      );
    }
  } catch {
    // ignore
  }
}

/** Resize the window by deltaW (positive or negative), clamped to minWidth and the work area. */
export async function adjustWindowWidth(tauriRuntime: boolean, deltaW: number, minWidth: number) {
  if (!tauriRuntime || deltaW === 0) return;
  try {
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
    const frame = await readWindowFrame();
    const maxW = frame.workArea.width - 24;
    const nextW = Math.min(Math.max(frame.width + deltaW, minWidth), maxW);
    if (Math.abs(nextW - frame.width) >= 8) {
      await frame.appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(frame.height)));
    }

    const maxX = frame.workArea.x + frame.workArea.width - nextW - 12;
    if (frame.x > maxX) {
      await frame.appWindow.setPosition(
        new LogicalPosition(Math.round(Math.max(frame.workArea.x + 12, maxX)), Math.round(frame.y)),
      );
    }
  } catch {
    // ignore
  }
}

interface StoredBounds {
  width: number;
  height: number;
  x: number;
  y: number;
}

let zoomRestoreBounds: StoredBounds | null = null;

/**
 * Manual zoom toggle. The window is created with resizable:false (custom
 * resize handles), which disables the native macOS zoom, so we implement it:
 * first call fills the work area (minus a margin), second call restores.
 */
export async function toggleManualZoom(tauriRuntime: boolean) {
  if (!tauriRuntime) return;
  try {
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
    const frame = await readWindowFrame();

    if (zoomRestoreBounds) {
      const bounds = zoomRestoreBounds;
      zoomRestoreBounds = null;
      await Promise.all([
        frame.appWindow.setSize(new LogicalSize(Math.round(bounds.width), Math.round(bounds.height))),
        frame.appWindow.setPosition(new LogicalPosition(Math.round(bounds.x), Math.round(bounds.y))),
      ]);
    } else {
      zoomRestoreBounds = { width: frame.width, height: frame.height, x: frame.x, y: frame.y };
      const margin = 12;
      await Promise.all([
        frame.appWindow.setSize(new LogicalSize(
          Math.round(frame.workArea.width - margin * 2),
          Math.round(frame.workArea.height - margin * 2),
        )),
        frame.appWindow.setPosition(new LogicalPosition(
          Math.round(frame.workArea.x + margin),
          Math.round(frame.workArea.y + margin),
        )),
      ]);
    }
    window.dispatchEvent(new Event("sogo:window-resize-end"));
  } catch {
    // ignore
  }
}

export const RESIZE_CURSOR: Record<ResizeEdge, string> = {
  North: "cursor-n-resize",
  NorthEast: "cursor-ne-resize",
  East: "cursor-e-resize",
  SouthEast: "cursor-se-resize",
  South: "cursor-s-resize",
  SouthWest: "cursor-sw-resize",
  West: "cursor-w-resize",
  NorthWest: "cursor-nw-resize",
};

export function useWindowResizeHandler(tauriRuntime: boolean, edge: ResizeEdge, minWidth: number) {
  return useCallback(
    async (event: ReactMouseEvent) => {
      if (!tauriRuntime) return;
      event.preventDefault();
      event.stopPropagation();

      const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
      const frame = await readWindowFrame();
      const { appWindow, workArea } = frame;

      const movesX = edge.includes("West");
      const movesY = edge.includes("North");

      const startW = frame.width;
      const startH = frame.height;
      const startWX = frame.x;
      const startWY = frame.y;
      const startX = event.screenX;
      const startY = event.screenY;
      const maxWidthFromLeft = Math.max(minWidth, workArea.x + workArea.width - startWX - 12);
      const maxWidthFromRight = Math.max(minWidth, startWX + startW - workArea.x - 12);
      const maxHeightFromTop = Math.max(WINDOW_MIN_HEIGHT, workArea.y + workArea.height - startWY - 12);
      const maxHeightFromBottom = Math.max(WINDOW_MIN_HEIGHT, startWY + startH - workArea.y - 12);

      let frameId: number | null = null;
      let nextW = startW;
      let nextH = startH;
      let nextX = startWX;
      let nextY = startWY;

      const onMove = (e: MouseEvent) => {
        const dx = e.screenX - startX;
        const dy = e.screenY - startY;

        if (edge.includes("East")) nextW = clampNumber(startW + dx, minWidth, maxWidthFromLeft);
        if (edge.includes("West")) {
          nextW = clampNumber(startW - dx, minWidth, maxWidthFromRight);
          nextX = startWX + startW - nextW;
        }
        if (edge.includes("South")) nextH = clampNumber(startH + dy, WINDOW_MIN_HEIGHT, maxHeightFromTop);
        if (edge.includes("North")) {
          nextH = clampNumber(startH - dy, WINDOW_MIN_HEIGHT, maxHeightFromBottom);
          nextY = startWY + startH - nextH;
        }

        if (!frameId) {
          frameId = requestAnimationFrame(() => {
            const ops: Promise<void>[] = [
              appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(nextH))),
            ];
            if (movesX || movesY) {
              ops.push(appWindow.setPosition(new LogicalPosition(Math.round(nextX), Math.round(nextY))));
            }
            void Promise.all(ops);
            frameId = null;
          });
        }
      };

      const onUp = () => {
        if (frameId) cancelAnimationFrame(frameId);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.dispatchEvent(new Event("sogo:window-resize-end"));
      };

      window.dispatchEvent(new Event("sogo:window-resize-start"));
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [tauriRuntime, edge, minWidth],
  );
}

export function useEjectedTerminalWestResizeHandler(
  tauriRuntime: boolean,
  minWidth: number,
  terminalWidth: number,
  panelOpen: boolean,
  setTerminalWidth: (updater: number) => void,
) {
  return useCallback(
    async (event: ReactMouseEvent) => {
      if (!tauriRuntime) return;
      event.preventDefault();
      event.stopPropagation();

      const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
      const frame = await readWindowFrame();
      const { appWindow, workArea } = frame;

      const startW = frame.width;
      const startH = frame.height;
      const startWX = frame.x;
      const startWY = frame.y;
      const startX = event.screenX;
      const maxWidthFromRight = Math.max(minWidth, startWX + startW - workArea.x - 12);

      let frameId: number | null = null;
      let nextW = startW;
      let nextX = startWX;
      let nextTerminalWidth = terminalWidth;

      const onMove = (e: MouseEvent) => {
        const dx = e.screenX - startX;
        const rawW = clampNumber(startW - dx, minWidth, maxWidthFromRight);
        const rawTerminalWidth = terminalWidth + rawW - startW;
        nextTerminalWidth = clampEjectedTerminalWidthForWindow(rawTerminalWidth, panelOpen, rawW);
        nextW = clampNumber(startW + nextTerminalWidth - terminalWidth, minWidth, maxWidthFromRight);
        nextX = startWX + startW - nextW;

        if (!frameId) {
          frameId = requestAnimationFrame(() => {
            setTerminalWidth(nextTerminalWidth);
            void Promise.all([
              appWindow.setSize(new LogicalSize(Math.round(nextW), Math.round(startH))),
              appWindow.setPosition(new LogicalPosition(Math.round(nextX), Math.round(startWY))),
            ]);
            frameId = null;
          });
        }
      };

      const onUp = () => {
        if (frameId) cancelAnimationFrame(frameId);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.dispatchEvent(new Event("sogo:window-resize-end"));
      };

      window.dispatchEvent(new Event("sogo:window-resize-start"));
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [tauriRuntime, minWidth, terminalWidth, panelOpen, setTerminalWidth],
  );
}

export function ResizeHandle({
  tauriRuntime,
  edge,
  minWidth,
}: {
  tauriRuntime: boolean;
  edge: ResizeEdge;
  minWidth: number;
}) {
  const handleMouseDown = useWindowResizeHandler(tauriRuntime, edge, minWidth);

  const cursor = RESIZE_CURSOR[edge];

  // Corners
  if (edge === "NorthWest") return <div className={`absolute left-0 top-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "NorthEast") return <div className={`absolute right-0 top-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "SouthWest") return <div className={`absolute bottom-0 left-0 z-20 h-4 w-4 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "SouthEast") {
    return (
      <div className={`group absolute bottom-2 right-2 z-20 p-2 ${cursor}`} onMouseDown={handleMouseDown}>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-cc-muted opacity-20 transition-opacity duration-200 group-hover:opacity-70">
          <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" />
          <circle cx="5" cy="8.5" r="1.1" fill="currentColor" />
          <circle cx="8.5" cy="5" r="1.1" fill="currentColor" />
        </svg>
      </div>
    );
  }

  // Edges
  if (edge === "North") return <div className={`absolute inset-x-4 top-0 z-30 h-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "South") return <div className={`absolute inset-x-4 bottom-0 z-30 h-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "East") return <div className={`absolute inset-y-4 right-0 z-30 w-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;
  if (edge === "West") return <div className={`absolute inset-y-4 left-0 z-30 w-1.5 ${cursor}`} onMouseDown={handleMouseDown} />;

  return null;
}
