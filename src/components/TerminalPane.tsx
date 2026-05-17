import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import { isTauriRuntime } from "@/lib/runtime";
import type { Palette } from "@/stores/themeStore";
import type { SogoTab } from "@/types";

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
  onData: (tabId: string, text: string) => void;
  onExit: (tabId: string) => void;
  onError: (tabId: string, error: string) => void;
  onStarted: (tabId: string) => void;
  onSessionId: (tabId: string, claudeSessionId: string) => void;
}

export function TerminalPane({
  tab,
  active,
  palette,
  fontSize,
  onData,
  onExit,
  onError,
  onStarted,
  onSessionId,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const sessionPollRef = useRef<number | undefined>();
  const decoderRef = useRef(new TextDecoder());
  const timingRef = useRef<{
    spawnStart?: number;
    spawnResolved?: number;
    firstByte?: boolean;
    lastInputAt?: number;
    awaitingResponse?: boolean;
  }>({});
  const callbacksRef = useRef({ onData, onExit, onError, onStarted, onSessionId });

  useEffect(() => {
    callbacksRef.current = { onData, onExit, onError, onStarted, onSessionId };
  }, [onData, onError, onExit, onSessionId, onStarted]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      fontFamily: 'var(--cc-font-mono), "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      scrollback: 20_000,
      theme: palette.terminal,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);
    terminal.loadAddon(new LigaturesAddon());
    terminal.onData((data) => {
      if (!isTauriRuntime()) return;
      const now = performance.now();
      timingRef.current.lastInputAt = now;
      timingRef.current.awaitingResponse = true;
      logTiming(tab, "input", `sent ${data.length} chars`);
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("write_to_session", { sessionId: tab.id, data }))
        .catch((error) => callbacksRef.current.onError(tab.id, String(error)));
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      terminal.dispose();
      if (sessionPollRef.current) {
        window.clearInterval(sessionPollRef.current);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [tab.id]);

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
          const resolveDelta = timing.spawnResolved ? now - timing.spawnResolved : undefined;
          logTiming(
            tab,
            "first-byte",
            `received ${bytes.length} bytes${formatDelta("spawn", spawnDelta)}${formatDelta("after invoke", resolveDelta)}`,
          );
        }

        if (timing.awaitingResponse && timing.lastInputAt) {
          timing.awaitingResponse = false;
          logTiming(tab, "response-byte", `first output after input${formatDelta("latency", now - timing.lastInputAt)}`);
        }

        terminalRef.current?.write(bytes);
        callbacksRef.current.onData(tab.id, decoderRef.current.decode(bytes));
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
    terminal.options.theme = palette.terminal;
    if (active) {
      fitTerminal(tab.id, fitAddonRef.current);
      terminal.focus();
    }
  }, [active, fontSize, palette.terminal, tab.id]);

  useEffect(() => {
    if (tab.status === "stopped" || tab.status === "error") {
      spawnedRef.current = false;
    }
  }, [tab.status]);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal(tab.id, fitAddonRef.current);
    });

    resizeObserver.observe(containerRef.current);
    fitTerminal(tab.id, fitAddonRef.current);

    return () => resizeObserver.disconnect();
  }, [active, tab.id]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (!active) return;
    if (!terminalRef.current || spawnedRef.current) return;
    if (!tab.started) return;

    // Guard immediately — before any async work — so status/session ID changes
    // that re-trigger this effect cannot race into a second spawn.
    spawnedRef.current = true;
    const resumeSessionId = tab.claudeSessionId;
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
      callbacksRef.current.onStarted(tab.id);
      const dimensions = fitAddonRef.current?.proposeDimensions();
      const sinceUnixMillis = Date.now();
      await coreApi.invoke("spawn_session", {
        request: {
          sessionId: tab.id,
          cwd: tab.cwd,
          cols: dimensions?.cols ?? 100,
          rows: dimensions?.rows ?? 30,
          resumeSessionId,
        },
      });
      timingRef.current.spawnResolved = performance.now();
      logTiming(tab, "spawn-invoke-resolved", `invoke returned${formatDelta("elapsed", timingRef.current.spawnResolved - timingRef.current.spawnStart!)}`);

      if (cancelled) return;

      if (sessionPollRef.current) {
        window.clearInterval(sessionPollRef.current);
      }

      let attempts = 0;
      sessionPollRef.current = window.setInterval(() => {
        attempts += 1;
        void coreApi
          .invoke<string | null>("latest_claude_session_id", { cwd: tab.cwd, sinceUnixMillis })
          .then((claudeSessionId) => {
            if (claudeSessionId) {
              callbacksRef.current.onSessionId(tab.id, claudeSessionId);
              if (sessionPollRef.current) window.clearInterval(sessionPollRef.current);
            } else if (attempts >= 15 && sessionPollRef.current) {
              window.clearInterval(sessionPollRef.current);
            }
          })
          .catch(() => {
            if (attempts >= 15 && sessionPollRef.current) {
              window.clearInterval(sessionPollRef.current);
            }
          });
      }, 2000);
    }).catch((error) => {
      spawnedRef.current = false;
      callbacksRef.current.onError(tab.id, String(error));
    });

    return () => {
      cancelled = true;
      if (sessionPollRef.current) {
        window.clearInterval(sessionPollRef.current);
      }
    };
  }, [active, tab.cwd, tab.id, tab.started]);

  return (
    <div
      className={active ? "session-terminal-shell relative h-full min-h-0 min-w-0" : "hidden"}
      data-session-id={tab.id}
    >
      <div className="flex h-7 items-center justify-between border-b border-cc-border bg-cc-surface/75 px-3 font-mono text-[11px] text-cc-muted">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="truncate">{tab.folderChosen ? tab.cwd : "scratch terminal"}</span>
        </div>
        <span>Claude Code PTY</span>
      </div>
      <div ref={containerRef} className="h-[calc(100%-1.75rem)] min-h-0 min-w-0" />
      {(tab.status === "stopped" || tab.status === "error") && !tab.started ? (
        <div className="absolute inset-0 flex items-center justify-center bg-cc-background/90">
          <div className="max-w-sm text-center">
            <div className="text-sm font-medium">{tab.label}</div>
            <div className="mt-1 text-xs text-cc-muted">{tab.cwd}</div>
            <button
              className="mt-4 rounded-md bg-cc-accent px-3 py-1.5 text-xs font-medium text-cc-background"
              onClick={() => onStarted(tab.id)}
            >
              {tab.status === "error" ? "Retry session" : "Start session"}
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

function formatDelta(label: string, value?: number) {
  if (typeof value !== "number") return "";
  return `; ${label}=${Math.round(value)}ms`;
}

function decodeBase64(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fitTerminal(sessionId: string, fitAddon: FitAddon | null) {
  if (!fitAddon) return;

  try {
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions();
    if (dimensions && isTauriRuntime()) {
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke("resize_session", {
          sessionId,
          cols: dimensions.cols,
          rows: dimensions.rows,
        }).catch(() => undefined);
      });
    }
  } catch {
    // xterm cannot be measured while its container is hidden.
  }
}
