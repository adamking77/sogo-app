import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  AlertTriangle,
  Check,
  ChevronsRight,
  Eye,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownLivePreview } from "@/lib/markdownLivePreview";
import { isTauriRuntime } from "@/lib/runtime";
import { type EditorMode, useEditorStore } from "@/stores/editorStore";
import { useThemeStore } from "@/stores/themeStore";
import { useVaultStore } from "@/stores/vaultStore";
import { toastError } from "@/stores/toastStore";

interface FileEditorPaneProps {
  sessionId: string;
  cwd: string;
  layout: "overlay" | "ejected";
  onDragMouseDown: (event: ReactMouseEvent) => void;
  onBeginResize: (event: ReactMouseEvent) => void;
  onResetWidth: () => void;
  onToggleLayout: () => void;
  onHide: () => void;
}

export function FileEditorPane({
  sessionId,
  cwd,
  layout,
  onDragMouseDown,
  onBeginResize,
  onResetWidth,
  onToggleLayout,
  onHide,
}: FileEditorPaneProps) {
  const session = useEditorStore((state) => state.sessions[sessionId]);
  const {
    save,
    close,
    revert,
    setMode,
    setBuffer,
    setFocusWithin,
    setClosePrompt,
    clearError,
    openFile,
  } = useEditorStore();


  const handleWikiLink = useCallback(async (target: string) => {
    let files = useVaultStore.getState().localFiles;
    if (!files || files.length === 0) {
      await useVaultStore.getState().refresh();
      files = useVaultStore.getState().localFiles;
    }
    const resolved = resolveWikiTarget(target, files ?? []);
    if (!resolved) {
      toastError(`No GenZen OS document named "${target}"`);
      return;
    }
    await openFile(sessionId, resolved, { source: "vault" });
  }, [openFile, sessionId]);

  const activePath = session?.activePath;
  const dirty = !!session && session.buffer !== session.loadedContent;
  const isMarkdown = !!activePath && /\.(md|mdx|markdown)$/i.test(activePath);
  const mode = session?.mode ?? "preview";
  const displayPath = activePath ? pathRelativeTo(activePath, cwd) : "";

  if (!session || !activePath) return null;

  const requestClose = () => {
    if (close(sessionId)) {
      window.dispatchEvent(new Event("sogo:focus-terminal"));
    }
  };

  return (
    <aside
      className="file-editor-pane sogo-background-bg relative flex h-full w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[22px] border border-cc-border shadow-[-30px_18px_72px_-30px_rgba(0,0,0,0.6),-2px_0_8px_-3px_rgba(0,0,0,0.35)]"
      onFocusCapture={() => setFocusWithin(sessionId, true)}
      onBlurCapture={(event) => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
          setFocusWithin(sessionId, false);
        }
      }}
    >
      <div
        className="group/resize absolute inset-y-0 left-0 z-30 w-3 cursor-col-resize"
        onMouseDown={(event) => {
          event.stopPropagation();
          onBeginResize(event);
        }}
        onDoubleClick={onResetWidth}
        title="Resize editor"
        aria-label="Resize editor"
      >
        <div className="mx-auto h-full w-[3px] rounded-full bg-cc-accent/0 transition-colors duration-150 group-hover/resize:bg-cc-accent/35" />
      </div>
      <div
        className="h-3 w-full shrink-0 cursor-grab"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      />
      <div
        className="flex h-10 shrink-0 items-center justify-between px-3 text-xs text-cc-muted"
        data-tauri-drag-region
        onMouseDown={onDragMouseDown}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-cc-foreground">{basename(activePath)}</span>
          {dirty ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" title="Unsaved changes" />
          ) : null}
          {displayPath && displayPath !== basename(activePath) ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-cc-muted/60">{displayPath}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {isMarkdown ? (
            <ModeToggle mode={mode} onModeChange={(nextMode) => setMode(sessionId, nextMode)} />
          ) : null}
          <IconButton
            label={layout === "ejected" ? "Return terminal overlay" : "Eject terminal left"}
            active={layout === "ejected"}
            onClick={onToggleLayout}
          >
            {layout === "ejected" ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
          </IconButton>
          <IconButton label="Hide editor (keeps the file open)" onClick={onHide}>
            <ChevronsRight size={13} />
          </IconButton>
          <IconButton
            label="Revert"
            disabled={!dirty || session.saving}
            onClick={() => revert(sessionId)}
          >
            <RotateCcw size={13} />
          </IconButton>
          <IconButton
            label="Save"
            active={dirty}
            disabled={!dirty || session.saving}
            onClick={() => void save(sessionId)}
          >
            {session.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          </IconButton>
          <IconButton label="Close file" onClick={requestClose}>
            <X size={13} />
          </IconButton>
        </div>
      </div>
      {session.closePrompt ? (
        <InlineNotice
          tone="warning"
          message="Discard unsaved changes?"
          primaryLabel="Discard"
          onPrimary={() => close(sessionId, { force: true })}
          onDismiss={() => setClosePrompt(sessionId, false)}
        />
      ) : null}

      {session.error ? (
        <InlineNotice
          tone={session.conflict ? "warning" : "error"}
          message={session.error}
          primaryLabel={session.conflict ? "Reload" : "Dismiss"}
          onPrimary={() => {
            if (session.conflict) {
              void openFile(sessionId, activePath);
            } else {
              clearError(sessionId);
            }
          }}
          onDismiss={() => clearError(sessionId)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {session.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-cc-muted">
            <Loader2 size={14} className="animate-spin" />
            Loading
          </div>
        ) : isMarkdown && mode === "preview" ? (
          <MarkdownPreview contents={session.buffer} onWikiLink={(target) => void handleWikiLink(target)} />
        ) : (
          <CodeMirrorEditor
            path={activePath}
            value={session.buffer}
            onChange={(contents) => setBuffer(sessionId, contents)}
          />
        )}
      </div>
    </aside>
  );
}

function ModeToggle({
  mode,
  onModeChange,
}: {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}) {
  return (
    <div className="mr-1 flex h-6 items-center gap-0.5">
      <button
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 ${
          mode === "preview"
            ? "bg-cc-surface-strong text-cc-foreground"
            : "text-cc-muted hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
        }`}
        onClick={() => onModeChange("preview")}
        title="Preview"
      >
        <Eye size={12} />
      </button>
      <button
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 ${
          mode === "edit"
            ? "bg-cc-surface-strong text-cc-foreground"
            : "text-cc-muted hover:bg-cc-surface-strong/60 hover:text-cc-foreground"
        }`}
        onClick={() => onModeChange("edit")}
        title="Edit"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`flex h-6 w-6 items-center justify-center rounded text-cc-muted transition-colors duration-150 hover:bg-cc-surface-strong hover:text-cc-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-cc-muted ${
        active ? "text-cc-accent" : ""
      }`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}

function InlineNotice({
  tone,
  message,
  primaryLabel,
  onPrimary,
  onDismiss,
}: {
  tone: "warning" | "error";
  message: string;
  primaryLabel: string;
  onPrimary: () => void;
  onDismiss: () => void;
}) {
  const toneClass = tone === "warning"
    ? "border-amber-400/20 bg-amber-400/10 text-amber-100"
    : "border-red-400/20 bg-red-400/10 text-red-100";

  return (
    <div className={`flex min-h-10 shrink-0 items-center gap-2 border-b px-3 text-xs ${toneClass}`}>
      <AlertTriangle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <button
        className="flex h-6 items-center gap-1 rounded-md border border-current/20 px-2 text-[11px] hover:bg-current/10"
        onClick={onPrimary}
      >
        <Check size={11} />
        {primaryLabel}
      </button>
      <button
        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-current/10"
        onClick={onDismiss}
        title="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * Obsidian-style resolution: exact vault-relative path first, then unique
 * basename match, case-insensitive, .md implied.
 */
function resolveWikiTarget(target: string, files: string[]): string | null {
  const clean = target.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase();
  if (!clean) return null;

  const exact = files.find(
    (file) => file.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase() === clean,
  );
  if (exact) return exact;

  return (
    files.find((file) => {
      const base = (file.split("/").pop() ?? file)
        .replace(/\.(md|mdx|markdown)$/i, "")
        .toLowerCase();
      return base === clean;
    }) ?? null
  );
}

const WIKI_LINK_PROTOCOL = "sogo-wiki:";
const WIKI_LINK_PATTERN = /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g;

/**
 * Remark plugin turning Obsidian-style [[target]] / [[target|alias]] text
 * into links with a sogo-wiki: URL. Operates on mdast text nodes only, so
 * code blocks and inline code stay untouched.
 */
function remarkWikiLinks() {
  interface MdastNode {
    type: string;
    value?: string;
    url?: string;
    children?: MdastNode[];
  }

  const transform = (node: MdastNode) => {
    if (!node.children) return;

    const nextChildren: MdastNode[] = [];
    let changed = false;

    for (const child of node.children) {
      if (child.type !== "text" || !child.value || node.type === "link") {
        transform(child);
        nextChildren.push(child);
        continue;
      }

      let lastIndex = 0;
      let match: RegExpExecArray | null;
      WIKI_LINK_PATTERN.lastIndex = 0;
      const pieces: MdastNode[] = [];

      while ((match = WIKI_LINK_PATTERN.exec(child.value)) !== null) {
        if (match.index > lastIndex) {
          pieces.push({ type: "text", value: child.value.slice(lastIndex, match.index) });
        }
        const target = match[1].trim();
        const alias = match[2]?.trim();
        pieces.push({
          type: "link",
          url: `${WIKI_LINK_PROTOCOL}${encodeURIComponent(target)}`,
          children: [{ type: "text", value: alias || target }],
        });
        lastIndex = match.index + match[0].length;
      }

      if (pieces.length === 0) {
        nextChildren.push(child);
        continue;
      }

      if (lastIndex < child.value.length) {
        pieces.push({ type: "text", value: child.value.slice(lastIndex) });
      }
      nextChildren.push(...pieces);
      changed = true;
    }

    if (changed) node.children = nextChildren;
  };

  return (tree: unknown) => transform(tree as MdastNode);
}

function MarkdownPreview({
  contents,
  onWikiLink,
}: {
  contents: string;
  onWikiLink: (target: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    ...markdownComponents,
    a: ({ href, children }) => (
      <a
        className="text-cc-accent underline decoration-cc-accent/40 underline-offset-2 transition-colors hover:decoration-cc-accent"
        href={href}
        onClick={(event) => {
          if (!href) return;
          if (href.startsWith(WIKI_LINK_PROTOCOL)) {
            event.preventDefault();
            onWikiLink(decodeURIComponent(href.slice(WIKI_LINK_PROTOCOL.length)));
            return;
          }
          if (/^https?:/i.test(href)) {
            // Never navigate the webview away from the app; hand the URL to
            // the default browser instead.
            event.preventDefault();
            if (!isTauriRuntime()) return;
            void import("@tauri-apps/api/core").then(({ invoke }) =>
              invoke("open_path_in_default_app", { path: href }).catch(() => undefined),
            );
          }
        }}
      >
        {children}
      </a>
    ),
  }), [onWikiLink]);

  return (
    <div className="h-full overflow-y-auto px-12 py-14">
      <div className="markdown-preview mx-auto max-w-[64ch]">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks]} components={components}>
          {contents}
        </ReactMarkdown>
      </div>
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-6 mt-0 text-[28px] font-normal leading-[1.15] tracking-[-0.02em] text-cc-foreground">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-10 text-[17px] font-normal leading-snug tracking-tight text-cc-foreground">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-7 text-[14px] font-normal leading-snug tracking-tight text-cc-foreground">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="my-4 text-[14px] leading-[1.75] text-cc-muted">{children}</p>
  ),
  a: ({ href, children }) => (
    <a className="text-cc-accent underline decoration-cc-accent/40 underline-offset-2 transition-colors hover:decoration-cc-accent" href={href}>
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-4 list-disc space-y-1.5 pl-5 text-[14px] leading-[1.7] text-cc-muted marker:text-cc-muted/40">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-1.5 pl-5 text-[14px] leading-[1.7] text-cc-muted marker:text-cc-muted/40">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="relative my-7 pl-6 text-[14px] leading-[1.75] text-cc-foreground/85">
      <span aria-hidden className="absolute -left-1 -top-3 select-none font-serif text-[44px] leading-none text-cc-accent/40">
        &ldquo;
      </span>
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    if (!className) {
      return (
        <code className="rounded bg-cc-surface-strong/70 px-1.5 py-0.5 font-mono text-[0.88em] text-cc-foreground" {...props}>
          {children}
        </code>
      );
    }

    return (
      <code className={`font-mono text-[12.5px] leading-[1.6] text-cc-foreground ${className ?? ""}`} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-5 overflow-x-auto rounded-md bg-cc-surface p-4">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px] text-cc-muted">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-cc-border/60">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-cc-border/30">{children}</tbody>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-[12px] font-normal uppercase tracking-wide text-cc-muted/80">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-8 border-cc-border/40" />,
};

const EDITOR_FONT_SIZE: Record<"small" | "medium" | "large", number> = {
  small: 12,
  medium: 13.5,
  large: 15,
};

function CodeMirrorEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const fontSize = useThemeStore((state) => state.fontSize);
  const fontPx = EDITOR_FONT_SIZE[fontSize];
  const extensions = useMemo(() => editorExtensions(path, fontPx), [path, fontPx]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;

    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={containerRef} className="h-full min-h-0" />;
}

const sogoHighlightStyle = HighlightStyle.define([
  // Markdown markers (#, *, -, 1., backticks, etc.) → accent
  { tag: t.processingInstruction, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.contentSeparator, color: "rgba(var(--cc-accent-rgb) / 0.7)" },
  { tag: t.heading, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.list, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.quote, color: "rgb(var(--cc-muted-rgb))", fontStyle: "italic" },
  { tag: t.link, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.url, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, color: "rgb(var(--cc-foreground-rgb))" },
  // Code (TS/JS/JSON/etc) — accent for syntactic anchors, foreground for content
  { tag: t.keyword, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.controlKeyword, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.moduleKeyword, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.operatorKeyword, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.atom, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.bool, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.null, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.typeName, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.className, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.string, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.number, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.variableName, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.propertyName, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.function(t.variableName), color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.comment, color: "rgba(var(--cc-muted-rgb) / 0.7)", fontStyle: "italic" },
  { tag: t.lineComment, color: "rgba(var(--cc-muted-rgb) / 0.7)", fontStyle: "italic" },
  { tag: t.blockComment, color: "rgba(var(--cc-muted-rgb) / 0.7)", fontStyle: "italic" },
  { tag: t.punctuation, color: "rgba(var(--cc-muted-rgb) / 0.8)" },
  { tag: t.bracket, color: "rgba(var(--cc-muted-rgb) / 0.8)" },
  { tag: t.operator, color: "rgba(var(--cc-muted-rgb) / 0.9)" },
  { tag: t.meta, color: "rgba(var(--cc-muted-rgb) / 0.7)" },
  { tag: t.attributeName, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.attributeValue, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.tagName, color: "rgb(var(--cc-accent-rgb))" },
  { tag: t.regexp, color: "rgb(var(--cc-foreground-rgb))" },
  { tag: t.escape, color: "rgb(var(--cc-accent-rgb))" },
]);

function editorExtensions(path: string, fontPx: number): Extension[] {
  const language = languageForPath(path);
  const isMarkdownFile = /\.(md|mdx|markdown)$/i.test(path);

  return [
    ...(isMarkdownFile ? [] : [lineNumbers()]),
    history(),
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    syntaxHighlighting(sogoHighlightStyle, { fallback: true }),
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    buildEditorTheme(fontPx),
    ...(language ? [language] : []),
    ...(isMarkdownFile ? [markdownLivePreview()] : []),
  ];
}

function languageForPath(path: string): Extension | null {
  const lower = path.toLowerCase();
  if (/\.(md|mdx|markdown)$/.test(lower)) return markdown();
  if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(lower)) return javascript({ jsx: true, typescript: lower.endsWith(".ts") || lower.endsWith(".tsx") });
  if (lower.endsWith(".json")) return json();
  if (/\.(css|scss|sass)$/.test(lower)) return css();
  if (/\.(html|htm|xml|svg)$/.test(lower)) return html();
  return null;
}

function buildEditorTheme(fontPx: number) {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "rgb(var(--cc-foreground-rgb))",
      fontSize: `${fontPx}px`,
      caretColor: "rgb(var(--cc-foreground-rgb))",
    },
    ".cm-scroller": {
      fontFamily: 'var(--cc-font-mono), "SF Mono", Menlo, Monaco, Consolas, monospace',
      lineHeight: "1.6",
      fontVariantLigatures: "contextual",
    },
    ".cm-content": {
      padding: "20px 0",
      caretColor: "rgb(var(--cc-foreground-rgb))",
      fontWeight: "normal",
    },
    ".cm-content *": {
      fontWeight: "normal !important",
    },
    ".cm-line": {
      padding: "0 20px",
      overflowWrap: "anywhere",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "rgb(var(--cc-foreground-rgb))",
      borderLeftWidth: "1.5px",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "rgb(var(--cc-foreground-rgb))",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      borderRight: "none",
      color: "rgba(var(--cc-muted-rgb) / 0.3)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(var(--cc-surface-strong-rgb) / 0.28)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(var(--cc-accent-rgb) / 0.22)",
    },
    "&.cm-focused": {
      outline: "none",
    },
  });
}

function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function pathRelativeTo(path: string, cwd: string) {
  if (cwd && path.startsWith(cwd)) {
    return path.slice(cwd.length).replace(/^\//, "") || basename(path);
  }

  return path;
}
