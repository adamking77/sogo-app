# Sogo Desktop V1 Concept Alignment

Source of truth: `/Users/adamking/projects/claude-client/SPEC.md`.

## Product Concept

Sogo Desktop is a personal macOS Claude Code desktop client. It replaces the defunct CLUI Electron fork with a Tauri app that combines:

- Lanes/Claudy-style embedded terminal sessions.
- CLUI-inspired custom chrome, tab strip, palette system, and compact tool UI.
- A live read-only Supabase vault observer.

It is not a dashboard, database app, generic terminal launcher, VS Code extension, agent control plane, or Sogo database migration product.

## V1 User Model

The user opens Sogo, chooses a project folder, and gets an interactive Claude Code terminal tab scoped to that folder.

Each tab is one persistent Claude Code process. The user types directly into the terminal. Claude Code itself handles slash commands, approvals, permissions, prompts, and terminal UI. Sogo owns the window, tabs, session lifecycle, colors, status indicators, and auxiliary read-only panels.

## Required Layout

1. Custom floating Tauri window.
2. Custom title/chrome area.
3. Top tab strip for Claude sessions.
4. Main content is the xterm.js terminal workspace.
5. Right sidebar is the Supabase vault observer, collapsible to an icon/tab.
6. Skills/MCP browser is read-only and secondary, either in a settings popover or right-panel subview.
7. Theme/font controls live in settings/status area, not as a dominant app surface.

The empty state must still preserve this frame. It should invite opening a folder inside the terminal workspace, not replace the product with a dashboard-like launcher.

## Required Behavior

### Window

- Tauri v2.
- `decorations: false`.
- `transparent: true`.
- Floating behavior with normal focus and dock presence.
- Option+Space toggles show/hide.
- Collapsible tab strip, right sidebar, and any bottom/input/status area should use React state plus matching `Window.setSize()` behavior.
- User decision after first test: do not pin by default. A pin toggle is acceptable.

### Tabs and Sessions

- New tab opens native folder picker.
- Launch interactive `claude` in selected folder via Rust `portable-pty`.
- Tab label is folder name.
- Process remains alive for tab lifetime.
- Interrupt sends Ctrl+C without killing process.
- Close tab writes `/exit`, waits 2s, then kills if needed.
- Store Claude session ID when discoverable.
- Relaunch restores tabs with `claude --resume <session-id>` in the same directory.
- Status indicator per tab: `idle`, `busy`, `awaiting-input`, `stopped`, `error`.

### Terminal

- xterm.js renders raw PTY bytes.
- No stream parsing or fake Claude UI.
- No `claude -p`.
- No separate input bar for V1; user confirmed xterm owns input.
- xterm theme follows selected palette.
- Font size: small, medium, large.

### Vault

- Read-only Supabase panel.
- Table: `documents`.
- Path column: `source_path`.
- Label: `title`.
- Tree derived from `source_path`.
- Realtime subscription refreshes as documents change.
- Selecting a document shows title and path only.
- No write path and no content renderer in V1.

### Skills and MCP

- Read `~/.claude/skills`.
- Parse `SKILL.md` name and description where possible.
- Read `~/.claude/settings.json` MCP server names.
- Read-only in V1.

## Current Implementation Drift

- The app has been drifting toward a generic launcher/dashboard. That is wrong.
- The first screen became too prominent and displaced the terminal-first layout. It must become a lightweight empty state inside the terminal workspace.
- The right panel must feel like an observer/sidebar attached to the terminal client, not a primary app destination.
- The implementation should borrow CLUI surface patterns more directly: compact tab pills, status dots, settings popover/status bar, muted palette rhythm.
- The only large custom backend area should be PTY-to-xterm event bridge and session lifecycle.

## Next Build Pass

1. Rebuild the shell around the required frame: chrome, tab strip, terminal workspace, right observer panel, bottom/status/settings control.
2. Strip any dashboard-like first-run composition. Keep a compact empty terminal state with `New session`.
3. Align tab strip and settings/status controls with CLUI safe references.
4. Make the right sidebar default-open at app width and collapsible to an icon rail.
5. Validate actual session flow with a real folder: new tab, Claude starts, input works, Ctrl+C works, close writes `/exit`, relaunch resumes.
6. Validate vault panel against available Supabase config or explicitly show missing config without blocking the terminal client.
7. Validate skills/MCP read-only browser.

## Acceptance Check

V1 is not acceptable until the app can be described visually as:

> A compact floating Claude Code terminal client with session tabs, a live vault observer, and CLUI-like controls.

If it looks like a generic app dashboard, it is off concept.
