# Sogo Terminal Upgrade Spec

For Codex. Raises the in-app terminal toward iTerm2 / Warp-class smoothness and
polish. The terminal hosts the Claude Code TUI — see "Non-goals" before
reaching for Warp-style features that do not apply.

## Current State

`src/components/TerminalPane.tsx`:

- xterm.js `@xterm/xterm` 5.5, addons loaded: `@xterm/addon-fit`,
  `@xterm/addon-web-links` only.
- No renderer addon → xterm's default **DOM renderer** (the slowest path).
- `new Terminal({ fontSize, lineHeight: 1.35, cursorBlink: true,
  convertEol: false, scrollback: 20_000, theme })`.
- `@xterm/addon-ligatures` is in `package.json` but **not loaded** (it crashed
  React-on-mount previously in WKWebView).

PTY transport:

- `src-tauri/src/pty.rs`: a reader thread reads 8 KiB chunks, base64-encodes
  each chunk, and emits a **global** `pty://data` event `{ session_id, data }`.
- `TerminalPane.tsx` `listen("pty://data", …)` filters by session id,
  base64-decodes, then both `terminal.write(bytes)` and re-decodes the bytes
  via `TextDecoder` to feed status inference.

Cost: every terminal pane receives every session's events and filters; each
chunk pays a base64 encode + JSON event + base64 decode round trip.

## Goal

Close the felt gap to iTerm2/Warp: smooth scrolling, low-latency fast output,
correct glyph rendering, scrollback search, inline images. Do this within the
xterm.js-in-WKWebView architecture — a native-GPU terminal is out of scope
(see "Ceiling").

## Tier 1 — GPU renderer (largest single win)

Add `@xterm/addon-webgl` and load it on each `Terminal`:

```ts
import { WebglAddon } from "@xterm/addon-webgl";
// after terminal.open(container):
const webgl = new WebglAddon();
webgl.onContextLoss(() => webgl.dispose()); // WKWebView can drop the context
terminal.loadAddon(webgl);
```

- Load **after** `terminal.open()`, not before.
- Handle `onContextLoss` — WKWebView can lose the WebGL context on
  backgrounding; dispose and optionally re-create.
- Re-test `@xterm/addon-ligatures` together with WebGL. WebGL renders ligatures
  via the texture atlas; if it still crashes or misrenders, leave ligatures
  disabled — the renderer is the priority, ligatures are cosmetic.
- Verify the existing `palette.terminal` theme and `fontSize`/`lineHeight`
  live-update paths still apply with the WebGL renderer attached.

## Tier 2 — PTY transport

Replace the global base64 `pty://data` event with a Tauri v2
`tauri::ipc::Channel` per session:

- The `spawn_session` command (or equivalent) takes a `Channel<…>` argument;
  the reader thread sends chunks on that channel instead of `app.emit`.
- Send bytes directly (Channel supports binary / `tauri::ipc::Response`) to
  drop the base64 encode/decode entirely.
- Per-session channel removes the global broadcast + session-id filtering —
  each pane only receives its own output.
- Keep the status-inference path: still derive text for `onData`, but decode
  once.

If the Channel migration is large, an intermediate win is to keep the event
but send raw bytes (Tauri can serialize `Vec<u8>`) and drop base64.

## Tier 3 — polish addons + display

Drop-in addons:

- `@xterm/addon-search` — scrollback search (UI: a find bar over the pane).
- `@xterm/addon-unicode11` — correct wide-glyph / emoji widths; activate via
  `terminal.unicode.activeVersion = "11"`.
- `@xterm/addon-clipboard` — OSC 52 clipboard.
- `@xterm/addon-image` — sixel / iTerm inline images.

Display tuning:

- `lineHeight: 1.35` is loose; iTerm/Warp sit ~1.0–1.2. Try `1.2` for density.
- Consider `minimumContrastRatio` and a ligature-capable mono font.

## Non-goals

- **Warp-style command blocks / AI input bar.** Sogo's terminal hosts the
  Claude Code full-screen TUI, not a sequence of shell commands — there are no
  discrete command blocks to decompose. Do not build block UI.
- Input ergonomics (Shift+Enter, file drop, image paste) are already done in
  the terminal input bridge — not part of this spec.

## Ceiling (context, not a task)

xterm.js in WKWebView with the WebGL renderer reaches roughly 90% of native
terminal feel. Matching Warp/Alacritty input latency would require a native
GPU renderer (`alacritty_terminal` or WezTerm `termwiz`/`wezterm-term` on a
`wgpu` surface, or a native shell around SwiftTerm) — none embed in Tauri's
webview, so that is a separate strategic decision, not this spec.

## Suggested Order

1. Tier 1 (WebGL) — ship and feel the difference first.
2. Tier 3 addons — search and unicode11 are the most noticeable.
3. Tier 2 transport — do this if fast output still stutters after Tier 1.

## Acceptance Check

- Fast output (e.g. `cat` a large file, rapid Claude streaming) scrolls
  smoothly with no visible tearing or lag.
- WebGL context loss (background/foreground the app) does not blank or crash
  the terminal.
- Scrollback search finds and highlights matches across the 20k buffer.
- Wide glyphs and emoji occupy correct cell widths; no cursor drift.
- Multi-tab: each pane only processes its own PTY output.
- Theme, font size, and fit-on-resize still work with the new renderer.

## Scope

Terminal rendering and transport only. Do not change PTY/session lifecycle
semantics, the file editor, eject mode, or panel content.
