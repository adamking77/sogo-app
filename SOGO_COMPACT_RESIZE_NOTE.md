# Sogo Compact Resize Note

This note captures a small usability improvement for later implementation.

## Problem

When Sogo is being used as a plain terminal session without the file editor, vault, docs, or side panels open, the main app window cannot be reduced enough.

Desired behavior:

> A terminal-only Sogo session should resize down to roughly the smallest practical width of the Codex app / compact terminal client window.

The wide minimum is useful when side panels or the file editor are open, but it is too restrictive for a simple agent terminal.

## Current Resize Gates

The current committed app enforces width limits in multiple places.

### Tauri Window Config

`src-tauri/tauri.conf.json`

```json
{
  "width": 920,
  "height": 700,
  "minWidth": 840,
  "minHeight": 540,
  "resizable": false
}
```

Notes:

- `minWidth: 840` prevents the OS/app window from shrinking below 840px.
- `resizable: false` is paired with custom React resize handles, so the app's own resize code also matters.

### React Layout Constants

`src/App.tsx`

```ts
const TERMINAL_MIN_WIDTH_SOLO = 420;
const TERMINAL_MIN_WIDTH_WITH_EDITOR = 300;
const FILE_EDITOR_MIN_WIDTH = 520;
```

These are closer to the desired behavior, especially `TERMINAL_MIN_WIDTH_SOLO = 420`.

### Main Shell Minimum

`src/App.tsx`

```ts
const mainShellMinWidth = editorVisible
  ? TERMINAL_MIN_WIDTH_WITH_EDITOR
  : activePanel
    ? TERMINAL_MIN_WIDTH_SOLO
    : 680;
```

This means a terminal-only window still has an internal layout minimum of 680px.

### Manual Resize Handle Clamp

`src/App.tsx`

```ts
if (edge.includes("East"))  nextW = Math.max(840, startW + dx);
if (edge.includes("West"))  { nextW = Math.max(840, startW - dx); nextX = startWX + dx; }
```

This is probably the strongest blocker after the Tauri config. Even if `minWidth` is reduced, custom resize still clamps to 840px.

## Recommended Behavior

Use dynamic minimum width based on what is visible.

Suggested targets:

- Terminal only: 420-480px.
- Terminal + side panel: 760-840px.
- Terminal + file editor: 840-980px.
- Terminal + file editor + side panel: 1120px or fit-to-screen clamped.

The terminal-only target should be tested manually against:

- Tab strip.
- Session status bar.
- Traffic light controls.
- Pin/settings/sidebar buttons.
- xterm readability.
- Long cwd path truncation.

## Proposed Implementation

### 1. Centralize Minimum Width

Create a single function in `App.tsx`:

```ts
function getWindowMinWidth(options: {
  editorVisible: boolean;
  panelOpen: boolean;
}) {
  if (options.editorVisible && options.panelOpen) return 1120;
  if (options.editorVisible) return 840;
  if (options.panelOpen) return 760;
  return 440;
}
```

Use this for:

- Main shell min width.
- Manual resize handle clamp.
- Window shrink/grow logic when panels open/close.
- Any future `setMinSize` call if added.

### 2. Reduce Tauri `minWidth`

Change `src-tauri/tauri.conf.json`:

```json
"minWidth": 440
```

This should represent the smallest terminal-only state. The React code can still prevent smaller effective layouts when side panels or editor panes are open.

### 3. Replace Hardcoded `840`

In resize handle logic, replace:

```ts
Math.max(840, ...)
```

with the dynamic minimum width:

```ts
Math.max(getWindowMinWidth({ editorVisible, panelOpen: !!activePanel }), ...)
```

The resize handle component may need `minWidth` passed as a prop so it does not need to know app layout state.

### 4. Lower Terminal-Only Shell Minimum

Replace the terminal-only `680` with the same compact target:

```ts
const mainShellMinWidth = getWindowMinWidth({
  editorVisible,
  panelOpen: !!activePanel,
});
```

Or keep the content minimum slightly below the window minimum if the window includes outer gaps.

### 5. Handle Panel Open/Close

When the user opens the side panel from a compact terminal-only window:

- Grow the window if possible.
- If the screen cannot fit the larger target, allow the side panel to overlay or temporarily reduce terminal width.
- Avoid forcing the app into an off-screen position.

Existing panel open/close code already grows and shrinks the window. It should use the same central minimum-width function.

## Acceptance Check

Terminal-only session:

- Can shrink to around 440px wide.
- Terminal remains usable.
- Header controls do not overlap.
- Tab label and cwd truncate cleanly.
- xterm does not collapse or render blank.

With side panel open:

- The app expands or enforces a larger minimum.
- Files/Vault/Skills panel remains usable.
- Terminal still has enough width for basic interaction.

With file editor open:

- Compact terminal-only minimum does not make the editor layout unusable.
- File editor width clamps correctly.
- Resize handles still behave predictably from both left and right edges.

## Scope

This should be a small UI behavior pass, not a redesign.

Do not change:

- PTY behavior.
- Session lifecycle.
- File editor features.
- Provider/CLI architecture.
- Panel content.

