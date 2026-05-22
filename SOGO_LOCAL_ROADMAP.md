# Sogo Local Roadmap Notes

These notes capture later-stage product directions for Sogo. They are exploratory, not current build scope.

## Current App Shape

Sogo is currently best understood as a compact local desktop shell for agentic coding CLIs:

- Tauri desktop app.
- xterm.js terminal connected to a Rust PTY bridge.
- One local agent process per tab.
- Workspace-scoped file browsing and editing.
- Right-side panels for files, vault, skills, and related context.
- Supabase-backed vault observer in the current concept.

The strongest architectural foundation is the PTY bridge. It means Sogo can host real interactive CLIs without reimplementing their terminal UI, permission prompts, slash commands, or approval flows.

## 1. Support Multiple Local Agent CLIs

This is feasible and probably the most natural next evolution.

Today the app is Claude-specific in several places:

- Binary resolution assumes `claude`.
- Resume logic assumes Claude Code `--resume`.
- Session discovery reads Claude's local project files.
- Skills and MCP inventory reads `~/.claude`.
- UI labels and empty states refer to Claude Code.
- Status inference is tuned around Claude terminal output.

The generic part is already in place:

- Spawn a local executable.
- Attach it to a PTY.
- Stream bytes into xterm.js.
- Send user input back to the process.
- Resize the PTY.
- Interrupt with Ctrl+C.
- Close or kill the process.

The missing piece is a provider abstraction.

Recommended shape:

```ts
type CliProvider = {
  id: "claude" | "codex" | "kimi" | "gemini" | "custom";
  label: string;
  binaryName: string;
  binaryEnvVar?: string;
  defaultArgs?: string[];
  resumeArgs?: (sessionId: string) => string[];
  shutdownCommand?: string;
  configRoots?: string[];
  inventoryKind?: "claude" | "codex" | "generic" | "none";
  sessionDiscovery?: "claude-jsonl" | "provider-config" | "none";
};
```

Expected work:

- Add provider selection to new session creation.
- Store provider ID on each tab.
- Pass provider config into `spawn_session`.
- Replace Claude-only binary resolution with provider binary resolution.
- Make resume optional and provider-specific.
- Rename Claude-specific app types to agent/provider-neutral names.
- Add provider-specific inventory readers for skills, MCP, rules, hooks, or config.
- Make status parsing configurable per provider.

Important product decision:

Sogo should not claim to support "any CLI" equally. Better framing:

> Sogo supports local agent providers, with first-class adapters for the CLIs we care about.

That gives room for Claude, Codex, Kimi, Gemini, and custom shells while still allowing quality provider-specific behavior.

## 2. VS Code Extension Reuse

Directly modifying VS Code extensions for Sogo is technically possible only in narrow cases and is probably not a good core strategy.

VS Code extensions expect:

- VS Code's extension host.
- The `vscode` API.
- `package.json` contribution points.
- Activation events.
- Commands, settings, secrets, webviews, workspace APIs, terminal APIs, and file APIs.
- Marketplace packaging and extension licensing constraints.

Practical options:

### Preferred: Use The CLI Or SDK

For tools like Claude Code or Codex, Sogo should integrate the local CLI directly. This keeps Sogo simple and avoids recreating VS Code.

### Sometimes Useful: Reuse Open Source Internals

If an extension is open source and cleanly separates its core logic from VS Code bindings, Sogo could reuse selected pieces. This depends on license compatibility and code structure.

### Avoid: VS Code Compatibility Layer

Building a compatibility layer for arbitrary VS Code extensions would be a large product in itself. It would require implementing enough of the VS Code runtime to satisfy extensions, and many extensions would still break.

Recommendation:

Do not make VS Code extension compatibility a Sogo pillar. Use extension source code only as reference or selectively reusable code when licensing and architecture make it straightforward.

## 3. Sogo Canvas

Sogo Canvas could be a first-class visual workspace inside the app.

Good fit:

- Architecture maps.
- Agent plans.
- Task graphs.
- File/entity relationship maps.
- UI sketches.
- Research boards.
- Workflow diagrams.

Avoid turning it into:

- A general Figma replacement.
- A decorative whiteboard disconnected from agent work.
- A large separate product bolted onto the side.

The key value is making Canvas agent-aware.

Recommended model:

- Canvas documents are stored as structured JSON.
- Canvas nodes can link to files, database records, tasks, prompts, sessions, or vault documents.
- Local agents can read and update canvas state through tools.
- Users can visually inspect and steer plans that the agent is working on.

Possible storage:

- Local files under a `.sogo/` directory.
- Local SQLite.
- Supabase-backed sync later.

Possible UI placement:

- A top-level mode beside Terminal and Database.
- Or a split workspace surface that can sit beside the terminal.

Canvas should share the same project/workspace context as terminal sessions.

## 4. Sogo Database

Sogo Database should not be a generic database admin tool. It should be Sogo's structured project and memory substrate.

Good fit:

- Projects.
- Sessions.
- Tasks.
- Decisions.
- Documents.
- Entities.
- Notes.
- Agent memories.
- File links.
- Canvas objects.
- Tool outputs.

Recommended model:

- Use local SQLite for offline-first personal data.
- Keep Supabase optional for sync, sharing, or cloud vault use.
- Expose database capabilities to local agent CLIs through a tool/MCP-style interface.
- Make records linkable from terminal sessions, files, and canvas nodes.

Possible tables:

```sql
projects
sessions
messages
tasks
documents
entities
links
canvas_documents
canvas_nodes
canvas_edges
agent_events
```

Important boundary:

Sogo Database should manage Sogo-native structured data. It should not start as a replacement for TablePlus, Supabase Studio, or a general SQL IDE.

## Suggested Sequencing

### Phase 1: Provider Neutrality

Goal: make the app a local agent shell rather than a Claude-only shell.

- Rename Claude-specific types and UI labels.
- Add `providerId` to tabs.
- Introduce provider config.
- Keep Claude as the first provider.
- Add Codex as the second provider once the abstraction is real.

### Phase 2: Local Sogo Data Layer

Goal: create a durable local substrate for Sogo features.

- Add SQLite.
- Store Sogo sessions and project metadata.
- Store user-created notes/tasks/decisions.
- Keep existing file editor and terminal behavior intact.

### Phase 3: Agent-Accessible Tools

Goal: let local CLIs interact with Sogo's own data.

- Expose local Sogo data through MCP or a small local tool server.
- Add tools for reading tasks, writing decisions, creating links, and searching records.
- Keep permission boundaries explicit.

### Phase 4: Sogo Canvas

Goal: add a visual workspace connected to real project state.

- Store canvas documents in the local data layer.
- Link canvas nodes to files, tasks, documents, and sessions.
- Let agents read and update canvas state.

### Phase 5: Sogo Database UI

Goal: provide a focused interface for the Sogo data layer.

- Record browser.
- Saved views.
- Task/document/entity editors.
- Link graph.
- Search across structured records and files.

## Product Principle

The terminal should remain the command center.

Sogo becomes strongest if Terminal, Files, Canvas, and Database all share the same project context and can be used by local agents. If they are separate apps inside one window, the scope gets large without compounding value.

Better framing:

> Sogo is a local agent workspace. The terminal runs the agent, files show the workspace, the database holds structured memory, and canvas visualizes the work.

