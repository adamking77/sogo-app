# File Viewer / Markdown Editor — Corrected Implementation Spec

Spec for adding in-app file viewing and optional text editing to Sogo Desktop.

This is not a network API or separate service. The "file API" referenced here means the small Tauri invoke command layer required for the React UI to safely read and write local workspace files.

---

## Purpose

Allow the user to open text files from the active Sogo session workspace without leaving the app. Markdown files should be readable as rendered documents and optionally editable as text. Code files can use the same editor surface with syntax highlighting.

The terminal remains the primary interaction surface. The file viewer/editor exists so the user can inspect and make small edits to the same workspace Claude Code is operating in.

---

## Recommended V1 Scope

Build this in two layers so the first useful version stays small:

1. **Viewer V1**
   - Open text files from the existing Files panel.
   - Render markdown with GFM support.
   - Show non-markdown text/code in a read-only editor/viewer with syntax highlighting where available.
   - Reject binary files and oversized files.

2. **Editor V1.1**
   - Enable editing for text files.
   - Track dirty state.
   - Save back to disk with `Cmd+S` while the editor has focus.
   - Warn before closing/switching away from unsaved edits.
   - Check file `mtime` before save to avoid silently overwriting external changes.

This avoids tying the initial viewer work to every editing edge case.

---

## Current Repo Reality

Important corrections against the earlier plan:

- `list_directory(path)` currently does **not** enforce workspace scoping. It accepts an arbitrary path and only checks that it is a directory.
- The frontend session store persists `cwd`, but the backend should not treat frontend-provided paths as trusted authority for read/write scope.
- The Rust PTY registry currently stores PTY handles, not a durable session workspace root. The file commands need a backend-owned way to resolve `sessionId -> workspace root`.
- The current `Cmd+W` handler closes the active session globally. Editor shortcuts must be focus-aware so editor close/save actions do not conflict with terminal/session commands.

---

## Backend Implementation

Add a backend-owned workspace root lookup before adding file read/write commands.

### Session Roots

When `spawn_session` starts, store the canonical session `cwd` alongside the session ID. This can be added to `PtySession`, or maintained in a separate registry such as:

```rust
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    roots: Mutex<HashMap<String, PathBuf>>,
}
```

Scratch sessions already have a deterministic cwd from `default_session_cwd`; folder sessions pass a selected directory to `spawn_session`. In both cases, canonicalize server-side before storing.

### Path Resolution

Every filesystem command must resolve paths server-side:

1. Look up the canonical workspace root for `session_id`.
2. Join/resolve the requested path.
3. Canonicalize the target for reads/stats.
4. For writes to existing files, canonicalize the existing target.
5. For writes to new files, canonicalize the parent directory and then join the filename.
6. Reject if the canonical target or parent does not stay under the canonical workspace root.

Do not rely on client-side path normalization. This protects against `..` traversal and symlink escapes.

### Commands

Viewer-only V1 needs:

```rust
#[tauri::command]
fn read_text_file(session_id: String, path: String) -> Result<FileContent, FileCommandError>;
```

Editor V1.1 adds:

```rust
#[tauri::command]
fn write_text_file(
    session_id: String,
    path: String,
    contents: String,
    expected_mtime_ms: Option<u128>,
) -> Result<FileMeta, FileCommandError>;

#[tauri::command]
fn stat_file(session_id: String, path: String) -> Result<FileMeta, FileCommandError>;
```

`expected_mtime_ms` is important. The previous draft mentioned mtime conflict detection but omitted it from the write signature.

### Response Types

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    path: String,
    contents: String,
    meta: FileMeta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    path: String,
    size: u64,
    mtime_ms: Option<u128>,
    is_text: bool,
}
```

Use structured error kinds instead of raw strings where practical:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCommandError {
    kind: String, // "outsideWorkspace", "notFound", "tooLarge", "binary", "conflict", etc.
    message: String,
}
```

### Safety Rules

- Maximum read size: 10 MB unless there is a reason to lower it.
- Binary detection: reject files with null bytes in the first 8 KB.
- Text decoding: require valid UTF-8 for V1. If invalid, return a typed error instead of lossy rendering.
- Writes should be atomic enough for normal use: write to a temporary file in the same directory, then rename over the target.
- Never add broad `fs:*` permissions. Custom Tauri commands do not require enabling the filesystem plugin.

### Directory Listing Follow-Up

The existing `list_directory(path)` should be updated to the same trust model:

```rust
fn list_directory(session_id: String, path: Option<String>) -> Result<Vec<FileEntry>, FileCommandError>
```

If `path` is absent, list the session root. If present, resolve it through the same scoped path helper used by file reads. This prevents the file browser from becoming a general filesystem browser.

---

## Frontend Implementation

### Types

Extend `src/types.ts` with `FileContent`, `FileMeta`, and a richer `FileEntry` if needed:

```ts
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileMeta {
  path: string;
  size: number;
  mtimeMs?: number;
  isText: boolean;
}

export interface FileContent {
  path: string;
  contents: string;
  meta: FileMeta;
}
```

### Editor Store

Add `src/stores/editorStore.ts`. Prefer per-session state from the start:

```ts
interface EditorSessionState {
  activePath: string | null;
  loadedContent: string;
  buffer: string;
  loadedMtimeMs?: number;
  mode: "preview" | "edit";
  loading: boolean;
  saving: boolean;
  error: string | null;
}
```

Actions:

- `openFile(sessionId, path)`
- `setBuffer(sessionId, contents)`
- `setMode(sessionId, mode)`
- `save(sessionId)`
- `close(sessionId, options?: { force?: boolean })`
- `revert(sessionId)`

Dirty state should be derived from `buffer !== loadedContent`, not manually maintained.

### Files Panel Wiring

Update `FilesPanel` so it receives `sessionId` plus `cwd`:

```tsx
<FilesPanel
  sessionId={activeTab.id}
  cwd={activeTab.cwd}
  folderChosen={activeTab.folderChosen}
  onOpenFile={(path) => openFile(activeTab.id, path)}
/>
```

Directory rows expand as they do today. File rows open the editor/viewer.

### Editor Surface

The cleanest V1 placement is a split inside the main session area:

- Terminal remains mounted so the PTY session is not interrupted.
- Editor appears as a sibling pane when a file is open.
- The split can be fixed-width first, then made resizable later.

Avoid putting the editor inside the existing right-side `PanelWindow`; that panel is only 21rem wide and is better suited to navigation/tools than editing.

### Keyboard Handling

The app already has global `Cmd+N`, `Cmd+W`, and `Cmd+1-9` handling in `App.tsx`.

Editor shortcuts must only run when focus is inside the editor/viewer:

- `Cmd+S`: save active editor buffer.
- `Cmd+W`: close active file with dirty guard.
- `Cmd+E` or `Cmd+P`: toggle edit/preview if both modes exist.

When terminal focus is active, terminal/session shortcuts should keep their current behavior.

---

## Library Choices

Recommended:

- Markdown rendering: `react-markdown` + `remark-gfm`.
- Editor: CodeMirror 6.
- Preview code highlighting: use CodeMirror highlighting or a lightweight highlighter. Avoid Shiki for V1 unless visual fidelity becomes a priority.

Avoid Monaco for this app unless requirements grow into a full IDE-like editor. It is much heavier than needed for one-file viewing and small edits.

Minimum dependency set for the recommended path:

```bash
pnpm add react-markdown remark-gfm @codemirror/view @codemirror/state @codemirror/language @codemirror/lang-markdown @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-rust @codemirror/commands
```

TOML support may require a third-party CodeMirror language package or can fall back to plain text in V1.

---

## Theme Integration

Use the existing palette in `src/stores/themeStore.ts`.

- Build a CodeMirror theme extension from the active `Palette`.
- Use CSS variables for markdown preview colors.
- Do not import an off-the-shelf dark theme that ignores Sogo's palette.
- Recompute the CodeMirror theme when `paletteName` changes.

---

## Tests

Backend unit tests should cover:

- Reading a normal text file under the workspace.
- Rejecting `../outside.md`.
- Rejecting symlink escape outside the workspace.
- Rejecting oversized files.
- Rejecting binary files.
- Returning mtime from read/stat.
- Rejecting save when `expected_mtime_ms` does not match current disk mtime.
- Allowing save when mtime matches.

Frontend checks should cover:

- File click invokes `openFile`.
- Dirty state appears after editing.
- Close/switch guard blocks silent discard.
- `Cmd+S` only saves when editor focus is active.
- Markdown preview renders headings, lists, code blocks, links, and tables.

---

## Out Of Scope For First Pass

- Multi-file editor tabs.
- File watcher/live external change notifications.
- Autosave.
- Image/PDF rendering.
- Find and replace.
- Vim/Emacs keybindings.
- LSP, completions, linting, diagnostics.
- Git diff view.
- Collaborative editing.

---

## Implementation Order

1. Add backend session-root tracking and scoped path helper.
2. Update `list_directory` to use session-scoped paths.
3. Add `read_text_file` with size/binary/UTF-8 checks.
4. Add a viewer store and file-open wiring from `FilesPanel`.
5. Add the editor/viewer pane with markdown preview.
6. Add CodeMirror read-only view for non-markdown text/code.
7. Add write support, dirty guard, `Cmd+S`, and mtime conflict detection.
8. Add backend tests before widening behavior.

