# Sogo Eject-Mode Resize Spec

Spec for Codex. Fixes the column-resize behavior when the file editor is
ejected to a separate left-docked terminal column. **Eject mode only** — the
non-ejected (overlay) and terminal-only layouts already resize correctly and
must not change.

## Context

"Eject mode" = `ejectedEditorActive` in `src/App.tsx`
(`editorVisible && fileEditorLayout === "ejected"`).

Layout in eject mode is a flex row, `gap-2`, left to right:

```
[ terminal column ] [ file view column ] [ sidebar (optional, fixed width) ]
```

- Terminal column = the main shell `<div>`. In eject mode: `shrink-0`,
  `flex: 0 0 auto`, `width = renderedTerminalPaneWidth`.
- File view column = the `<FileEditorPane>` wrapper `<div>`. In eject mode:
  `shrink-0`, `width = renderedFileEditorWidth`.
- Sidebar = `<PanelWindow>`, fixed `RIGHT_SIDEBAR_WIDTH`, not resizable.

## Reported Bugs (eject mode only)

| # | Edge | Current behavior | Wanted |
|---|------|------------------|--------|
| 1 | Terminal column — left edge | Resizes the whole app window; sidebar gets clipped on its right | Resize the terminal column |
| 2 | Terminal column — right edge | Does nothing | Resize the terminal column |
| 3 | File view — left edge | Resizes the file view from its *right* side | Resize the file view from its *left* side |
| 4 | File view — right edge | Does nothing | Resize the file view |

## Diagnosis

1. **Terminal left edge.** The eight `<ResizeHandle>` window-resize handles
   (N/NE/E/SE/S/SW/W/NW) are all children of the terminal shell. In eject mode
   the terminal shell is only column 1, so the `West` handle sits on the app's
   left edge and runs a Tauri window resize. Window shrinks from the left →
   total content exceeds window width → the rightmost element (sidebar) clips.

2. **Terminal right edge does nothing.** The terminal-pane handle
   (`absolute inset-y-4 right-0 z-40 w-3`, `beginTerminalPaneResize`) exists,
   but `clampEjectedTerminalWidth` pins the width when the window is not wide
   enough for the terminal *plus* the fixed `fileEditorWidth`. With
   `fileEditorWidth` fixed at e.g. 760, a sub-~1100px window leaves
   `effectiveMin === effectiveMax`, so the drag clamps to a constant and the
   column never moves.

3. **File view left edge resizes the wrong side.** The handle inside
   `FileEditorPane` (`absolute inset-y-0 left-0 z-30 w-3`,
   `beginFileEditorResize`, `{ invert: true }`) only changes the column's
   `width`. The file view wrapper is a fixed-width flex child placed *after*
   the terminal, so its left edge is pinned by flex and a width change always
   moves the **right** edge. Dragging the left handle visibly moves the right
   edge.

4. **File view right edge does nothing.** There is no resize handle on the
   file view's right edge in eject mode — all window handles live inside the
   terminal shell, and `FileEditorPane` only carries a left handle.

## Target Behavior

In eject mode, the terminal column and the file view column each resize
independently by dragging their own left and right edges. The sidebar is never
clipped. Window top/bottom edges and the four corners still resize the app
window.

Because the terminal column's left edge and the file view's right edge
coincide with the app window frame, dragging those edges does move the window
frame — but the **adjacent column absorbs the delta**, so nothing else shifts
or clips and it reads as resizing that column.

## Recommended Implementation

The two columns are flex-docked; only their shared divider and the file view's
outer edge can move freely. Make that explicit:

### 1. File view column becomes `flex-1` in eject mode

Instead of a fixed `renderedFileEditorWidth`, let the file view fill the space
between the terminal column and the sidebar (`flex: 1 1 auto`, `min-width` =
`FILE_EDITOR_MIN_WIDTH`). The terminal column stays fixed-width
(`terminalPaneWidth`). This removes the bug-#2 clamp deadlock — the file view
yields space instead of being a fixed competitor.

### 2. Divider handle (terminal right edge / file view left edge)

One handle on the boundary between the two columns. Dragging it sets
`terminalPaneWidth`; the `flex-1` file view absorbs the inverse automatically.

- Satisfies #2: terminal right edge resizes the terminal.
- Satisfies #3: the file view's left edge moves with the divider.

Keep the existing `beginTerminalPaneResize` for this; drop the separate
`FileEditorPane` left handle's width-only behavior (it is now the divider).

### 3. File view right-edge handle

Add a resize handle on the file view's right edge. It performs a Tauri `East`
window resize. Because the file view is `flex-1`, growing the window from the
right grows the file view; the terminal and sidebar keep their widths.

- Satisfies #4.

### 4. Terminal left-edge handle (coupled)

Add a resize handle on the terminal column's left edge. It performs a Tauri
`West` window resize **and** adds the same delta to `terminalPaneWidth`, so the
terminal column tracks the moving window edge. The `flex-1` file view width is
unchanged; the sidebar stays flush right and never clips.

- Satisfies #1.

### 5. Window handles in eject mode

The long `West` and `East` window-resize edges are now owned by the column
handles above. Keep `North`, `South`, and the four corners for window resize.
Position the window handles so they track the true window rectangle in eject
mode (the terminal shell is no longer full width — parent them to the outer
container, or otherwise anchor them to the window frame).

Non-eject layouts keep all eight window handles exactly as today.

## Open Decision

Bugs #1 and #4 inherently move the app window frame, because those column edges
*are* the window frame. The recommended model accepts that and makes the
adjacent column absorb the change (no clipping). If the intent is that the
window frame must never move when dragging a column edge, the alternative is:
columns only trade space within a fixed window, and the window resizes solely
via corners + top/bottom. Confirm with Adam before building if unsure.

## Acceptance Check

Eject mode:

- Terminal column resizes by dragging its left edge; sidebar never clips.
- Terminal column resizes by dragging its right edge, at any window width.
- File view resizes by dragging its left edge (left edge moves).
- File view resizes by dragging its right edge.
- Each column keeps its minimum width; the other column yields space.
- Window still resizes via corners and top/bottom edges.
- Double-click on a column edge still resets that column to its default width.

Non-eject (overlay) and terminal-only layouts: resize behavior unchanged.

## Scope

UI layout/resize pass only. Do not change PTY behavior, session lifecycle,
file editor features, or panel content.
