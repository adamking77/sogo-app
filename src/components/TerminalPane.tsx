import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import { isTauriRuntime } from "@/lib/runtime";
import { toastSuccess } from "@/stores/toastStore";
import type { Palette } from "@/stores/themeStore";
import type { FileMeta, SessionInfo, SogoTab } from "@/types";

interface PtyDataPayload {
  sessionId: string;
  data: string;
}

interface PtyExitPayload {
  sessionId: string;
  code?: number;
}

interface TerminalPaneProps {
  tab: SogoTab;
  active: boolean;
  palette: Palette;
  fontSize: number;
  backgroundOpacity: number;
  onData: (tabId: string, text: string) => void;
  onExit: (tabId: string) => void;
  onError: (tabId: string, error: string) => void;
  onResumeRequested: (tabId: string) => void;
  onSpawnStarted: (tabId: string) => void;
  onSessionId: (tabId: string, claudeSessionId: string) => void;
  onBell: (tabId: string) => void;
  onOpenFile: (path: string) => void;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

type SmartLinkKind = "network" | "path";

interface SmartLinkMatch {
  text: string;
  index: number;
  kind: SmartLinkKind;
}

const SMART_LINK_PATTERNS: Array<{ kind: SmartLinkKind; regex: RegExp }> = [
  {
    kind: "network",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|localhost)(?::\d{2,5})?\b/g,
  },
  {
    kind: "path",
    regex: /(?:~|\.{1,2}|\/)?[\w@.-]+(?:\/[\w@.-]+)+(?::\d+(?::\d+)?)?/g,
  },
];

export function TerminalPane({
  tab,
  active,
  palette,
  fontSize,
  backgroundOpacity,
  onData,
  onExit,
  onError,
  onResumeRequested,
  onSpawnStarted,
  onSessionId,
  onBell,
  onOpenFile,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const spawnedRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const fitPausedRef = useRef(false);
  const lastDimensionsRef = useRef<TerminalDimensions | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const timingRef = useRef<{
    spawnStart?: number;
    spawnResolved?: number;
    firstByte?: boolean;
    lastInputAt?: number;
    awaitingResponse?: boolean;
  }>({});
  const callbacksRef = useRef({ onData, onExit, onError, onResumeRequested, onSpawnStarted, onSessionId, onBell, onOpenFile });

  useEffect(() => {
    callbacksRef.current = { onData, onExit, onError, onResumeRequested, onSpawnStarted, onSessionId, onBell, onOpenFile };
  }, [onData, onError, onExit, onResumeRequested, onSpawnStarted, onSessionId, onBell, onOpenFile]);

  const copySmartText = useCallback(
    (text: string) => {
      void copyTextToClipboard(text)
        .then(() => toastSuccess(`Copied ${text}`))
        .catch((error) => callbacksRef.current.onError(tab.id, String(error)));
    },
    [tab.id],
  );

  // Path links open in the editor pane when they resolve to a real text file
  // inside the workspace; anything else falls back to copy.
  const openSmartPath = useCallback(
    (text: string) => {
      if (!isTauriRuntime()) {
        copySmartText(text);
        return;
      }

      const withoutLine = text.replace(/(?::\d+)+$/, "");
      void import("@tauri-apps/api/core")
        .then(async ({ invoke }) => {
          const meta = await invoke<FileMeta>("stat_file", { sessionId: tab.id, path: withoutLine });
          if (meta.isText) {
            callbacksRef.current.onOpenFile(meta.path);
          } else {
            copySmartText(text);
          }
        })
        .catch(() => copySmartText(text));
    },
    [copySmartText, tab.id],
  );

  const fitNow = useCallback(() => {
    fitTerminal(tab.id, fitAddonRef.current, lastDimensionsRef);
  }, [tab.id]);

  const scheduleFit = useCallback(() => {
    if (fitPausedRef.current) return;
    if (fitFrameRef.current !== null) return;

    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      if (fitPausedRef.current) return;
      fitNow();
    });
  }, [fitNow]);

  useEffect(() => {
    const pauseFit = () => {
      fitPausedRef.current = true;
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
    const resumeFit = () => {
      fitPausedRef.current = false;
      scheduleFit();
    };

    window.addEventListener("sogo:window-resize-start", pauseFit);
    window.addEventListener("sogo:window-resize-end", resumeFit);
    return () => {
      window.removeEventListener("sogo:window-resize-start", pauseFit);
      window.removeEventListener("sogo:window-resize-end", resumeFit);
    };
  }, [scheduleFit]);

  const writeToPty = useCallback(
    (data: string) => {
      if (!isTauriRuntime()) return;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("write_to_session", { sessionId: tab.id, data }))
        .catch((error) => callbacksRef.current.onError(tab.id, String(error)));
    },
    [tab.id],
  );

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;
    const container = containerRef.current;

    // Resolve --cc-font-mono to a concrete family before xterm measures glyphs.
    const monoVar = getComputedStyle(document.documentElement)
      .getPropertyValue("--cc-font-mono")
      .trim();
    const terminal = new Terminal({
      fontFamily: `${monoVar ? `${monoVar}, ` : ""}"SF Mono", Menlo, Monaco, Consolas, monospace`,
      fontSize,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      scrollback: 20_000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: terminalTheme(palette, backgroundOpacity),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    const unicodeAddon = new Unicode11Addon();
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey || event.altKey) {
        copySmartText(uri);
        return;
      }
      openExternalUrl(uri);
    }));
    const smartLinkProvider = terminal.registerLinkProvider(
      createSmartLinkProvider(terminal, copySmartText, openSmartPath),
    );
    terminal.open(container);

    const bellDisposable = terminal.onBell(() => {
      callbacksRef.current.onBell(tab.id);
    });

    // Shift+Enter should add a newline inside Claude Code's prompt instead of
    // submitting. ESC+CR is the sequence Option+Enter sends, which Claude Code
    // already treats as "insert newline". preventDefault is required: when the
    // custom handler returns false, xterm skips its own preventDefault, so the
    // browser would otherwise insert a newline into the hidden textarea and
    // xterm would forward that as a stray submit.
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        writeToPty("\x1b\r");
        return false;
      }
      if (event.type === "keydown" && event.key === "f" && event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setFindOpen(true);
        window.setTimeout(() => findInputRef.current?.select(), 0);
        return false;
      }
      return true;
    });

    // xterm's paste handling forwards text only; intercept image blobs, write
    // them to a temp file, and feed the path into the PTY.
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!imageItem) return;
      event.preventDefault();
      event.stopPropagation();
      const file = imageItem.getAsFile();
      if (!file) return;
      void file
        .arrayBuffer()
        .then(async (buffer) => {
          const extension = file.type.split("/")[1] || "png";
          const { invoke } = await import("@tauri-apps/api/core");
          const path = await invoke<string>("save_pasted_image", {
            dataBase64: arrayBufferToBase64(buffer),
            extension,
          });
          writeToPty(`${quotePath(path)} `);
        })
        .catch((error) => callbacksRef.current.onError(tab.id, String(error)));
    };
    container.addEventListener("paste", handlePaste, true);

    terminal.onData((data) => {
      if (!isTauriRuntime()) return;
      const now = performance.now();
      timingRef.current.lastInputAt = now;
      timingRef.current.awaitingResponse = true;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("write_to_session", { sessionId: tab.id, data }))
        .catch((error) => callbacksRef.current.onError(tab.id, String(error)));
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    return () => {
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      container.removeEventListener("paste", handlePaste, true);
      safeDispose("bell", () => bellDisposable.dispose());
      safeDispose("smart-link-provider", () => smartLinkProvider.dispose());
      safeDispose("terminal", () => terminal.dispose());
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      lastDimensionsRef.current = null;
    };
  }, [tab.id]);

  // Files dropped onto the window are written into the active session's PTY as
  // quoted paths. Claude Code reads file and image paths directly.
  useEffect(() => {
    if (!isTauriRuntime() || !active) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        if (cancelled) return;
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled || event.payload.type !== "drop") return;
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          if (isFilesPanelDrop(event.payload.position.x, event.payload.position.y)) return;
          writeToPty(`${paths.map(quotePath).join(" ")} `);
          terminalRef.current?.focus();
        });
      })
      .catch((error) => callbacksRef.current.onError(tab.id, String(error)));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, tab.id, writeToPty]);

  // Refocus requests (after skill activation, editor close, palette actions).
  useEffect(() => {
    if (!active) return;
    const focus = () => terminalRef.current?.focus();
    window.addEventListener("sogo:focus-terminal", focus);
    return () => window.removeEventListener("sogo:focus-terminal", focus);
  }, [active]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let cancelled = false;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      if (cancelled) return;

      unlistenData = await listen<PtyDataPayload>("pty://data", (event) => {
        if (cancelled || event.payload.sessionId !== tab.id) return;
        const bytes = decodeBase64(event.payload.data);
        const timing = timingRef.current;
        const now = performance.now();

        if (!timing.firstByte) {
          timing.firstByte = true;
          const spawnDelta = timing.spawnStart ? now - timing.spawnStart : undefined;
          logTiming(tab, "first-byte", `received ${bytes.length} bytes${formatDelta("spawn", spawnDelta)}`);
        }

        if (timing.awaitingResponse && timing.lastInputAt) {
          timing.awaitingResponse = false;
        }

        terminalRef.current?.write(bytes);
        callbacksRef.current.onData(tab.id, decoderRef.current.decode(bytes, { stream: true }));
      });

      unlistenExit = await listen<PtyExitPayload>("pty://exit", (event) => {
        if (cancelled || event.payload.sessionId !== tab.id) return;
        spawnedRef.current = false;
        callbacksRef.current.onExit(tab.id);
      });
    }).catch((error) => {
      callbacksRef.current.onError(tab.id, String(error));
    });

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
    };
  }, [tab.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    terminal.options.fontSize = fontSize;
    terminal.options.theme = terminalTheme(palette, backgroundOpacity);
    if (active) {
      scheduleFit();
      terminal.focus();
    }
  }, [active, backgroundOpacity, fontSize, palette, scheduleFit]);

  useEffect(() => {
    if (tab.status === "stopped" || tab.status === "error") {
      spawnedRef.current = false;
    }
  }, [tab.status]);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });

    resizeObserver.observe(containerRef.current);
    scheduleFit();

    return () => resizeObserver.disconnect();
  }, [active, scheduleFit]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (!active) return;
    if (!terminalRef.current || spawnedRef.current) return;
    if (!tab.started) return;

    // Guard immediately — before any async work — so status changes that
    // re-trigger this effect cannot race into a second spawn.
    spawnedRef.current = true;
    let cancelled = false;

    void import("@tauri-apps/api/core").then(async (coreApi) => {
      if (cancelled) {
        spawnedRef.current = false;
        return;
      }

      timingRef.current = {
        spawnStart: performance.now(),
        firstByte: false,
      };
      logTiming(tab, "spawn-start", `cwd=${tab.cwd}`);
      callbacksRef.current.onSpawnStarted(tab.id);
      const dimensions = fitAddonRef.current?.proposeDimensions();
      // The tab id doubles as the Claude session id: the backend passes
      // --session-id on first run and --resume when the session file exists.
      const info = await coreApi.invoke<SessionInfo>("spawn_session", {
        request: {
          sessionId: tab.id,
          cwd: tab.cwd,
          cols: dimensions?.cols ?? 100,
          rows: dimensions?.rows ?? 30,
          claudeSessionId: tab.claudeSessionId ?? null,
        },
      });
      timingRef.current.spawnResolved = performance.now();
      logTiming(tab, "spawn-invoke-resolved", `resumed=${info.resumed}${formatDelta("elapsed", timingRef.current.spawnResolved - timingRef.current.spawnStart!)}`);

      if (cancelled) return;
      callbacksRef.current.onSessionId(tab.id, info.claudeSessionId);
    }).catch((error) => {
      spawnedRef.current = false;
      callbacksRef.current.onError(tab.id, String(error));
    });

    return () => {
      cancelled = true;
    };
  }, [active, tab.claudeSessionId, tab.cwd, tab.id, tab.started]);

  const sessionBlocked = (tab.status === "stopped" || tab.status === "error") && !tab.started;

  const runFind = useCallback((query: string, direction: "next" | "previous") => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !query) return;
    if (direction === "next") searchAddon.findNext(query);
    else searchAddon.findPrevious(query);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  }, []);

  return (
    <div
      className={active ? "session-terminal-shell relative h-full min-h-0 min-w-0" : "hidden"}
      data-session-id={tab.id}
    >
      <div ref={containerRef} className={`h-full min-h-0 min-w-0 ${sessionBlocked ? "pointer-events-none" : ""}`} />
      {findOpen ? (
        <div className="sogo-elevated-bg absolute right-3 top-3 z-30 flex items-center gap-1 rounded-full border border-cc-border py-1 pl-3 pr-1 shadow-lg">
          <input
            ref={findInputRef}
            className="h-6 w-44 bg-transparent font-mono text-xs text-cc-foreground outline-none placeholder:text-cc-muted"
            placeholder="Find in terminal"
            value={findQuery}
            autoFocus
            onChange={(event) => {
              setFindQuery(event.target.value);
              runFind(event.target.value, "next");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFind(findQuery, event.shiftKey ? "previous" : "next");
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <button
            className="flex h-6 w-6 items-center justify-center rounded-full text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={() => runFind(findQuery, "previous")}
            title="Previous match (⇧Enter)"
          >
            <ArrowUp size={12} />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-full text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={() => runFind(findQuery, "next")}
            title="Next match (Enter)"
          >
            <ArrowDown size={12} />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-full text-cc-muted hover:bg-cc-surface-strong hover:text-cc-foreground"
            onClick={closeFind}
            title="Close (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
      {sessionBlocked ? (
        // z-[70] and pointer-events ownership keep this above xterm's link
        // layer and every app overlay except modal dialogs.
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-cc-background/90 pointer-events-auto">
          <div className="max-w-sm text-center">
            <div className="text-sm font-medium">{tab.label}</div>
            <div className="mt-1 text-xs text-cc-muted">{tab.cwd}</div>
            <button
              className="mt-4 rounded-full bg-cc-accent px-4 py-1.5 text-xs font-medium text-cc-background shadow-sm transition-colors hover:bg-cc-accent/90"
              onClick={() => {
                console.info(`[sogo timing] ${tab.label} resume-requested`);
                onResumeRequested(tab.id);
              }}
            >
              {tab.status === "error" ? "Retry session" : "Resume session"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function logTiming(tab: SogoTab, event: string, detail: string) {
  console.info(`[sogo timing] ${tab.label} ${event}: ${detail}`);
}

function safeDispose(label: string, dispose: () => void) {
  try {
    dispose();
  } catch (error) {
    console.warn(`[sogo lifecycle] ignored ${label} dispose error`, error);
  }
}

function formatDelta(label: string, value?: number) {
  if (typeof value !== "number") return "";
  return `; ${label}=${Math.round(value)}ms`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function createSmartLinkProvider(
  terminal: Terminal,
  onCopy: (text: string) => void,
  onOpenPath: (text: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const matches = findSmartLinkMatches(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      callback(matches.map((match): ILink => ({
        text: match.text,
        range: {
          start: { x: match.index + 1, y: bufferLineNumber },
          end: { x: match.index + match.text.length, y: bufferLineNumber },
        },
        decorations: {
          pointerCursor: true,
          underline: true,
        },
        activate(event) {
          event.preventDefault();
          event.stopPropagation();
          if (match.kind === "path" && !event.metaKey && !event.ctrlKey && !event.altKey) {
            onOpenPath(match.text);
          } else {
            onCopy(match.text);
          }
        },
      })));
    },
  };
}

function findSmartLinkMatches(line: string): SmartLinkMatch[] {
  const matches: SmartLinkMatch[] = [];

  for (const { kind, regex } of SMART_LINK_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const normalized = trimSmartLink(match[0]);
      if (!normalized) continue;
      matches.push({
        kind,
        text: normalized,
        index: match.index,
      });
    }
  }

  return matches
    .filter((match, index, all) => (
      all.findIndex((candidate) => rangesOverlap(match, candidate)) === index
    ))
    .sort((a, b) => a.index - b.index);
}

function trimSmartLink(text: string) {
  return text.replace(/[),.;:!?]+$/g, "");
}

function rangesOverlap(left: SmartLinkMatch, right: SmartLinkMatch) {
  if (left === right) return true;
  const leftEnd = left.index + left.text.length;
  const rightEnd = right.index + right.text.length;
  return left.index < rightEnd && right.index < leftEnd;
}

function openExternalUrl(uri: string) {
  const newWindow = window.open();
  if (newWindow) {
    try {
      newWindow.opener = null;
    } catch {
      // no-op
    }
    newWindow.location.href = uri;
  }
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Clipboard write failed");
  }
}

function quotePath(path: string): string {
  // Single-quote so spaces survive; escape any embedded single quotes.
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function terminalTheme(palette: Palette, backgroundOpacity: number): Palette["terminal"] {
  return {
    ...palette.terminal,
    background: backgroundOpacity < 1 ? "rgba(0, 0, 0, 0)" : palette.terminal.background,
  };
}

function isFilesPanelDrop(physicalX: number, physicalY: number) {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(physicalX / scale, physicalY / scale);
  return !!element?.closest("[data-sogo-files-panel='true']");
}

function decodeBase64(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fitTerminal(
  sessionId: string,
  fitAddon: FitAddon | null,
  lastDimensionsRef: { current: TerminalDimensions | null },
) {
  if (!fitAddon) return;

  try {
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions();
    if (dimensions && isTauriRuntime()) {
      const nextDimensions = {
        cols: dimensions.cols,
        rows: dimensions.rows,
      };
      const lastDimensions = lastDimensionsRef.current;
      if (
        lastDimensions?.cols === nextDimensions.cols
        && lastDimensions.rows === nextDimensions.rows
      ) {
        return;
      }

      lastDimensionsRef.current = nextDimensions;
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke("resize_session", {
          sessionId,
          cols: nextDimensions.cols,
          rows: nextDimensions.rows,
        }).catch(() => undefined);
      });
    }
  } catch {
    // xterm cannot be measured while its container is hidden.
  }
}
