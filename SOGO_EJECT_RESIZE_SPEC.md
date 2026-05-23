# Sogo Eject-Mode Resize — Remaining Work

For Codex. Most of the eject-mode column resizing is done (commit `b7ed9fb`).
One behavior remains. **Eject mode only** — overlay and terminal-only layouts
must not change.

## What "eject mode" is

`ejectedEditorActive` in `src/App.tsx` (`editorVisible && fileEditorLayout ===
"ejected"`). Flex row, `gap-2`, left to right:

```
[ terminal column ] [ file view column ] [ sidebar (optional, fixed) ]
```

- Terminal column = main shell `<div>`: fixed width `renderedTerminalPaneWidth`,
  `flex: 0 0 auto`.
- File view column = `<FileEditorPane>` wrapper: `flex-1`, `min-width
  FILE_EDITOR_MIN_WIDTH`.
- Sidebar = `<PanelWindow>`, fixed `RIGHT_SIDEBAR_WIDTH`.

## Already implemented (commit b7ed9fb)

- Terminal column fixed-width, file view `flex-1`. All four column edges
  resize the terminal/file-view split via `terminalPaneWidth`; the flex file
  view absorbs the inverse. Nothing clips, the window frame does not move.
- Handlers in `App.tsx`: `beginTerminalDividerResize` (divider edges),
  `beginTerminalEdgeResize` (outer edges, inverted). `clampEjectedTerminalWidth`
  reserves `FILE_EDITOR_MIN_WIDTH` for the flex file view.
- Column-resize handles: terminal-left + terminal-right inside the terminal
  shell; file-view-left inside `FileEditorPane`; file-view-right in the file
  view wrapper. All `absolute inset-y-4 w-3 z-40`.
- Window-resize handles moved to the outer shell. In eject mode the `West` and
  `East` edge handles are dropped (the long left/right edges belong to the
  column handles); window width still resizes from the four corners.

## Behavior status

| # | Edge | Status |
|---|------|--------|
| 1 | Terminal — left edge | Resizes the column, but from the **right** side. Wrong — the grabbed (left) edge should move. |
| 2 | Terminal — right edge | Correct (divider). |
| 3 | File view — left edge | Correct (divider). |
| 4 | File view — right edge | Resizes the column, but from the **left** side. Wrong — the grabbed (right) edge should move. |

## Remaining task: outer edges follow the cursor

The two divider edges (#2, #3) are correct. The two outer edges (#1, #4) are
not: the terminal's left edge is welded to the app window's left edge, and the
file view's right edge is welded to the window's right edge. A docked column
can only move its free (divider) edge, so dragging a welded edge currently
resizes the column from the opposite side.

To make the grabbed outer edge follow the cursor, that edge must drag the
**window frame** with it, and the adjacent column must absorb the change so
nothing else shifts or clips:

- **Terminal left edge** (`beginTerminalEdgeResize` on the terminal-left
  handle): perform a Tauri `West` window resize. As the window's left edge
  moves by delta D, grow/shrink `terminalPaneWidth` by D so the terminal column
  tracks the moving frame. File view (`flex-1`) and sidebar keep their widths;
  the terminal's left edge follows the cursor.

- **File view right edge** (`beginTerminalEdgeResize` on the file-view-right
  handle): perform a Tauri `East` window resize. The `flex-1` file view absorbs
  the width change automatically; the terminal and sidebar are unchanged. The
  file view's right edge follows the cursor.

Reference the existing `ResizeHandle` component in `App.tsx` for the Tauri
window-resize drag math (`setSize` / `setPosition`, monitor work-area clamps,
`requestAnimationFrame` batching). The outer-edge handlers need the same window
math plus the column-width coupling above.

Note: this means dragging those two edges resizes the app window. That is
intended and confirmed — it is the only way for a window-welded edge to follow
the cursor. The corners and top/bottom edges continue to resize the window.

## Acceptance Check

Eject mode:

- Terminal left edge drag → terminal's left edge follows the cursor; terminal
  resizes; sidebar never clips.
- Terminal right edge drag → divider moves (already correct).
- File view left edge drag → divider moves (already correct).
- File view right edge drag → file view's right edge follows the cursor; file
  view resizes; terminal and sidebar unchanged.
- Each column keeps its minimum width.

Overlay and terminal-only layouts: resize behavior unchanged.

## Scope

UI layout/resize only. Do not change PTY behavior, session lifecycle, file
editor features, or panel content.
