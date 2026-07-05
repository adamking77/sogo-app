# Debug Report — 2026-07-05: "App closes / won't reopen" + "Resume unclickable"

## STATUS: NOT RESOLVED FOR ADAM — HANDED OFF TO CODEX

After a full day of Claude-driven fixes, Adam reports both issues still occur in
his real usage: closing a tab closes the app and it won't reopen, and the Resume
Session button is not clickable. Claude's synthetic-input verification (below)
passed, but that verification has NOT been reproduced by Adam's hands-on testing.
Treat everything below as leads and data, not as settled conclusions. Codex owns
this debugging from here.

Handoff state:
- All fixes described below are committed and pushed to `main`.
- `/Applications/Sogo Desktop.app` was replaced 2026-07-05 19:17 with the latest
  build; stale DMG mounts ejected. If the bugs still reproduce after that
  replacement, the deployed-binary theory is wrong and something in Adam's real
  interaction path differs from the synthetic repro — start by watching him
  reproduce it, or capture stderr by launching
  `"/Applications/Sogo Desktop.app/Contents/MacOS/sogo-desktop"` from a terminal.
- Repro harness that exists already: launch the release binary from CLI with
  stderr redirected; drive with `osascript` keystrokes (accessibility granted);
  synthetic clicks via a CGEvent Swift helper; `[sogo timing]` spawn lines in
  stderr are the ground truth for whether Resume actually spawned.
- Open questions for Codex: which exact binary/instance was Adam running when it
  failed; does his "close a tab" gesture differ from the tested ones (tab X,
  pill-rail X, ⌘W); does his machine state (multiple displays, stage manager,
  other apps owning shortcuts) change event routing.

Everything below is the work already done — root-cause analysis, fixes applied,
and the verification that passed synthetically.

## Bug: Resume button unclickable

**Symptom.** The stopped-session overlay's "Resume session" button ignored clicks
entirely — no hover response, no spawn.

**Root cause (proven).** xterm.js renders a `.xterm-link-layer` canvas with a
positive `z-index`. The overlay (`absolute inset-0`, no z-index → `z-auto`) painted
visually above it but stacked *below* it, so the invisible link-layer canvas
swallowed every pointer event. Instrumented `pointerdown` at the button's center
logged `atPoint=CANVAS.xterm-link-layer`; after the fix the same click logs
`atPoint=BUTTON` and `spawn_session` fires.

**Fix.** `z-30` on the stopped/error overlay in `src/components/TerminalPane.tsx`.

**Related fix (earlier same day, also required for Resume to work).** The Claude
project-dir encoding must convert *every* non-alphanumeric character to `-` (not
just `/`), and a session ID with an aux dir (`<id>/`) but no transcript
(`<id>.jsonl`) is burned — passing it to `--session-id` makes Claude exit
instantly. `resolve_claude_session()` in `src-tauri/src/pty.rs` handles both
(resume on transcript; fresh UUID on burned ID). Unit-tested.

## Bug: closing a tab closes the app, which then won't reopen

**Root causes (proven, two independent layers).**

1. Tauri v2's default macOS menu (`Menu::default()`) includes `close_window`
   with the ⌘W accelerator. When the webview doesn't consume ⌘W — exactly the
   stopped-tab state where focus isn't in xterm — the native menu item
   **destroys** the window. A destroyed window + prevented exit = windowless
   zombie process; `RunEvent::Reopen` finds no `"main"` window, so Dock clicks
   do nothing ("won't reopen").
2. `PredefinedMenuItem::quit` sends NSApp `terminate:`, which tao cannot
   intercept (it only implements `applicationWillTerminate`). Reproduced ⌘Q
   killing the app instantly with a live session, bypassing the quit confirm.

**Fixes (`src-tauri/src/lib.rs`).**
- Custom app menu: no close-window item at all; Edit submenu keeps the
  predefined clipboard items (required for ⌘C/⌘V in the webview); custom
  "Quit Sogo" ⌘Q item routed through `on_menu_event` → `request_quit`
  (instant exit when idle, in-app confirm when sessions are running).
- `on_window_event`: `CloseRequested` → `prevent_close()` + `hide()`. No close
  request from any source can destroy the window; red traffic light hides.
- `RunEvent::Reopen` shows/focuses the window (Dock click restores).
- `RunEvent::ExitRequested` (code `None`) with active sessions → prevented +
  frontend confirm; `confirm_quit` command flips a flag and exits for real.

**Known limitation.** The Dock icon's right-click "Quit" is a system-owned
`terminate:` and cannot be intercepted — it force-quits without the confirm.
Sessions remain resumable afterward, so the blast radius is small.

## Verification evidence (release build)

- ⌘W on a stopped tab: window and app survive; tab behavior unchanged.
- Red light: window hides, process alive; Dock/`open -a`/⌥Space restores it.
- ⌘Q with live Claude session: exit prevented, "Quit Sogo?" dialog in AX tree;
  pressing Quit exits cleanly and reaps claude children.
- Resume click on a burned session ID: fresh Claude ID minted
  (`spawn_session … claude_id=<new uuid> resumed=false`), claude alive >5s.

## Deployment note

`/Applications/Sogo Desktop.app` had the pre-fix build during Adam's retest —
"reloaded the app" relaunched the old binary, which is why the bugs appeared to
persist. Replaced 2026-07-05 19:17 with the fixed build; stale mounted DMG
volumes ejected. Always reinstall from
`src-tauri/target/release/bundle/dmg/` after backend changes.
